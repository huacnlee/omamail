//! Loopback OAuth listener. PKCE and state never leave the pending Rust flow.
use super::*;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::Read};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
    task::JoinHandle,
};

#[derive(Default)]
pub(super) struct Flows(Mutex<HashMap<String, JoinHandle<Result<Value, &'static str>>>>);

fn random() -> Result<String, &'static str> {
    let mut bytes = [0; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|_| "auth_random_failed")?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    params[key]
        .as_str()
        .filter(|s| s.len() <= 8192 && !s.chars().any(char::is_control))
        .ok_or("invalid_params")
}

pub(super) fn form(fields: &[(&str, &str)]) -> String {
    let mut url = reqwest::Url::parse("https://localhost/").unwrap();
    url.query_pairs_mut().extend_pairs(fields.iter().copied());
    url.query().unwrap_or("").into()
}

impl Flows {
    pub async fn call(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        match method {
            "auth.begin" => self.begin(params).await,
            "auth.poll" | "auth.cancel" => {
                let id = text(params, "id")?;
                let mut flows = self.0.lock().await;
                let task = flows.get(id).ok_or("auth_flow_missing")?;
                if method == "auth.cancel" {
                    task.abort();
                    flows.remove(id);
                    return Ok(json!({"cancelled":true}));
                }
                if !task.is_finished() {
                    return Ok(json!({"pending":true}));
                }
                let task = flows.remove(id).unwrap();
                drop(flows);
                task.await.map_err(|_| "auth_cancelled")?
            }
            _ => Err("unknown_method"),
        }
    }

    async fn begin(&self, params: &Value) -> Result<Value, &'static str> {
        let id = random()?;
        let verifier = random()?;
        let state = random()?;
        let client_id = text(params, "clientId")?.to_owned();
        if client_id.is_empty() {
            return Err("invalid_params");
        }
        let secret = text(params, "clientSecret")?.to_owned();
        let hint = text(params, "loginHint")?.to_owned();
        let port = params["port"]
            .as_u64()
            .filter(|p| (1024..=65535).contains(p))
            .ok_or("invalid_params")? as u16;
        let scopes = params["scopes"].as_array().ok_or("invalid_params")?;
        if scopes.len() > 32 {
            return Err("invalid_params");
        }
        let scopes: Vec<&str> = scopes
            .iter()
            .map(|s| {
                s.as_str()
                    .filter(|s| s.len() < 512 && !s.chars().any(char::is_whitespace))
                    .ok_or("invalid_params")
            })
            .collect::<Result<_, _>>()?;
        let scope = scopes.join(" ");
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        let redirect = format!("http://127.0.0.1:{port}/oauth2callback");
        let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
        url.query_pairs_mut().extend_pairs([
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("response_type", "code"),
            ("scope", scope.as_str()),
            ("state", state.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("include_granted_scopes", "true"),
            ("login_hint", hint.as_str()),
        ]);
        let mut flows = self.0.lock().await;
        if flows.len() >= 4 {
            return Err("auth_too_many_flows");
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|_| "auth_port_unavailable")?;
        let task = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(180), async move {
                let code = receive(listener, &state, port).await?;
                let response = post(
                    client()?,
                    "https://oauth2.googleapis.com/token",
                    form(&[
                        ("client_id", &client_id),
                        ("client_secret", &secret),
                        ("code", &code),
                        ("code_verifier", &verifier),
                        ("grant_type", "authorization_code"),
                        ("redirect_uri", &redirect),
                    ]),
                )
                .await?;
                finish_google(response, &client_id).await
            })
            .await
            .map_err(|_| "auth_timeout")?
        });
        flows.insert(id.clone(), task);
        Ok(json!({"id":id,"url":url.as_str()}))
    }
}

async fn finish_google(mut response: Value, client_id: &str) -> Result<Value, &'static str> {
    if response["status"] != 200 {
        return Ok(response);
    }
    let mut token: Value =
        serde_json::from_str(response["body"].as_str().ok_or("auth_invalid_response")?)
            .map_err(|_| "auth_invalid_response")?;
    let granted = token["scope"].as_str().unwrap_or("");
    for required in [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/calendar.events",
    ] {
        if !granted.split_whitespace().any(|scope| scope == required) {
            return Err("auth_missing_scope");
        }
    }
    let access = token["access_token"]
        .as_str()
        .ok_or("auth_invalid_response")?;
    let profile = crate::providers::gmail_http::get(&["profile"], &[], access).await?;
    let account = profile["emailAddress"]
        .as_str()
        .filter(|s| {
            s.contains('@')
                && s.len() <= 1024
                && !s.chars().any(|c| c.is_control() || c.is_whitespace())
        })
        .ok_or("auth_invalid_profile")?;
    if let Some(refresh) = token["refresh_token"].as_str().filter(|s| !s.is_empty()) {
        credentials::store_google(client_id, account, refresh).await?;
        // The grant is already saved to the verified mailbox, before the UI
        // starts any mailbox requests; never create an unnamed keyring item.
        token
            .as_object_mut()
            .ok_or("auth_invalid_response")?
            .remove("refresh_token");
        response["body"] = Value::String(token.to_string());
    } else {
        return Err("auth_offline_access_missing");
    }
    response["profile"] = profile;
    Ok(response)
}

impl Drop for Flows {
    fn drop(&mut self) {
        for (_, task) in self.0.get_mut().drain() {
            task.abort();
        }
    }
}

fn callback(request: &str, state: &str, port: u16) -> Result<String, &'static str> {
    let mut lines = request.split("\r\n");
    let first = lines.next().ok_or("auth_invalid_callback")?;
    let fields: Vec<_> = first.split(' ').collect();
    if fields.len() != 3
        || fields[0] != "GET"
        || !["HTTP/1.1", "HTTP/1.0"].contains(&fields[2])
        || !fields[1].starts_with("/oauth2callback?")
        || fields[1].contains('#')
    {
        return Err("auth_invalid_callback");
    }
    let hosts: Vec<_> = lines
        .filter_map(|line| line.split_once(':'))
        .filter(|(k, _)| k.eq_ignore_ascii_case("host"))
        .collect();
    if hosts.len() != 1 || hosts[0].1.trim() != format!("127.0.0.1:{port}") {
        return Err("auth_invalid_callback");
    }
    let mut raw = fields[1].bytes();
    while let Some(byte) = raw.next() {
        if byte == b'%'
            && (!raw.next().is_some_and(|b| b.is_ascii_hexdigit())
                || !raw.next().is_some_and(|b| b.is_ascii_hexdigit()))
        {
            return Err("auth_invalid_callback");
        }
    }
    let url = reqwest::Url::parse(&format!("http://127.0.0.1:{}{}", port, fields[1]))
        .map_err(|_| "auth_invalid_callback")?;
    let pairs: Vec<_> = url.query_pairs().collect();
    let states: Vec<_> = pairs.iter().filter(|(k, _)| k == "state").collect();
    let codes: Vec<_> = pairs.iter().filter(|(k, _)| k == "code").collect();
    if states.len() != 1
        || states[0].1 != state
        || codes.len() != 1
        || codes[0].1.is_empty()
        || pairs.iter().any(|(k, _)| k == "error")
        || codes[0]
            .1
            .chars()
            .any(|c| !c.is_ascii() || c.is_ascii_control() || c.is_whitespace())
    {
        return Err("auth_invalid_callback");
    }
    Ok(codes[0].1.to_string())
}

async fn receive(listener: TcpListener, state: &str, port: u16) -> Result<String, &'static str> {
    loop {
        let (mut socket, peer) = listener
            .accept()
            .await
            .map_err(|_| "auth_listener_failed")?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let result = tokio::time::timeout(Duration::from_secs(3), async {
            let mut request = Vec::new();
            let mut byte = [0];
            while request.len() < 16384 {
                if socket
                    .read(&mut byte)
                    .await
                    .map_err(|_| "auth_invalid_callback")?
                    == 0
                {
                    break;
                }
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            if !request.ends_with(b"\r\n\r\n") {
                return Err("auth_invalid_callback");
            }
            callback(
                std::str::from_utf8(&request).map_err(|_| "auth_invalid_callback")?,
                state,
                port,
            )
        })
        .await
        .unwrap_or(Err("auth_invalid_callback"));
        let body = "Sign-in received. You can close this page and return to Omamail.";
        let response = if result.is_ok() {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        } else {
            "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
        };
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            socket.write_all(response.as_bytes()),
        )
        .await;
        if let Ok(code) = result {
            return Ok(code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn listener_closes(address: std::net::SocketAddr, deadline: Duration) -> bool {
        tokio::time::timeout(deadline, async {
            loop {
                match tokio::net::TcpStream::connect(address).await {
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => return,
                    Err(error) => panic!("Unexpected callback closure probe error: {error}"),
                    Ok(socket) => drop(socket),
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok()
    }

    #[tokio::test]
    async fn listener_closure_probe_refuses_a_still_open_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(!listener_closes(address, Duration::from_millis(60)).await);
        drop(listener);
        assert!(listener_closes(address, Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn loopback_ignores_forged_callback_and_accepts_the_real_state() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task =
            tokio::spawn(async move { receive(listener, "synthetic-state", address.port()).await });
        for (state, expected) in [("forged", "400 Bad Request"), ("synthetic-state", "200 OK")] {
            let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
            socket.write_all(format!("GET /oauth2callback?code=synthetic-code&state={state} HTTP/1.1\r\nHost: {address}\r\n\r\n").as_bytes()).await.unwrap();
            let mut bytes = Vec::new();
            socket.read_to_end(&mut bytes).await.unwrap();
            assert!(std::str::from_utf8(&bytes).unwrap().contains(expected));
        }
        assert_eq!(task.await.unwrap().unwrap(), "synthetic-code");
        // Parallel tests spawn Node and transport fixtures. Between fork and
        // exec a child briefly retains the listener despite CLOEXEC, even
        // after this task has dropped its own descriptor. Require actual
        // connection refusal within a bound, not closure at one scheduling
        // instant. The separate live-listener regression prevents this probe
        // from treating a timeout or a successful connection as closure.
        assert!(listener_closes(address, Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn cancelled_flow_releases_its_listener_and_does_not_exchange_a_code() {
        let flows = Flows::default();
        // Port zero chooses a candidate, not a reservation that can survive
        // closing it. Other parallel listeners or fork-before-exec children
        // can own that port before begin binds it. Retry only admission's
        // explicit busy-port error and require a real bound flow to proceed.
        let (port, answer) = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let reservation=TcpListener::bind("127.0.0.1:0").await.unwrap();
                let port=reservation.local_addr().unwrap().port();
                drop(reservation);
                let params=json!({"clientId":"synthetic-client", "clientSecret":"synthetic-secret", "loginHint":"", "port":port, "scopes":["openid"]});
                match flows.begin(&params).await {
                    Ok(answer)=>return (port,answer),
                    Err("auth_port_unavailable")=>{
                        assert!(flows.0.lock().await.is_empty(),"Refused admission cannot register a flow");
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    Err(error)=>panic!("Unexpected OAuth flow admission failure: {error}"),
                }
            }
        }).await.expect("Could not obtain a loopback OAuth test port");
        let url = answer["url"].as_str().unwrap();
        assert!(!url.contains("synthetic-secret"));
        assert!(!url.contains("code_verifier"));
        assert!(
            TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                .await
                .is_err()
        );
        flows
            .call("auth.cancel", &json!({"id":answer["id"]}))
            .await
            .unwrap();
        // Task abortion and a parallel child's fork/exec descriptor window
        // are asynchronous. Require an actual successful rebind, bounded in
        // time; an unrelated bind error must never count as released.
        let rebound = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await {
                    Ok(listener) => return listener,
                    Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {}
                    Err(error) => panic!("Unexpected callback rebind error: {error}"),
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Cancelled OAuth flow must release its listener");
        assert_eq!(rebound.local_addr().unwrap().port(), port);
    }

    #[tokio::test]
    async fn occupied_port_refuses_admission_without_registering_a_flow() {
        let reservation = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = reservation.local_addr().unwrap().port();
        let flows = Flows::default();
        let result=flows.begin(&json!({"clientId":"synthetic-client","clientSecret":"synthetic-secret","loginHint":"","port":port,"scopes":["openid"]})).await;
        assert_eq!(result.unwrap_err(), "auth_port_unavailable");
        assert!(flows.0.lock().await.is_empty());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), reservation.accept())
                .await
                .is_err()
        );
    }

    #[test]
    fn callback_checks_exact_route_host_and_single_state() {
        let req = |path: &str, host: &str| format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n");
        assert_eq!(
            callback(
                &req(
                    "/oauth2callback?code=good&state=expected",
                    "127.0.0.1:53682"
                ),
                "expected",
                53682
            )
            .unwrap(),
            "good"
        );
        for path in [
            "/oauth2callback?code=good&state=wrong",
            "/oauth2callback?code=good&state=expected&state=expected",
            "/oauth2callback?code=x&code=y&state=expected",
            "/oauth2callback/../?code=x&state=expected",
            "/oauth2callback?code=%00&state=expected",
        ] {
            assert!(callback(&req(path, "127.0.0.1:53682"), "expected", 53682).is_err());
        }
        assert!(
            callback(
                &req("/oauth2callback?code=good&state=expected", "evil.test"),
                "expected",
                53682
            )
            .is_err()
        );
    }
}
