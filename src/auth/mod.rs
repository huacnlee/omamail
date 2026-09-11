//! Authentication network boundary. Credential destinations are fixed here.
use serde_json::{Value, json};
use std::{sync::OnceLock, time::Duration};

mod callback;
mod credentials;
mod graph;
pub use credentials::{access_token, password, settings};

#[derive(Default)]
pub struct Session {
    flows: callback::Flows,
}

static CLIENT: OnceLock<Result<reqwest::Client, &'static str>> = OnceLock::new();
const LIMIT: usize = 256 * 1024;

fn client() -> Result<&'static reqwest::Client, &'static str> {
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .https_only(true)
                .hickory_dns(true)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|_| "auth_transport_failed")
        })
        .as_ref()
        .map_err(|e| *e)
}

fn destination(params: &Value) -> Result<String, &'static str> {
    let p = params.as_object().ok_or("invalid_params")?;
    if p.keys()
        .any(|k| !["provider", "endpoint", "tenant", "body"].contains(&k.as_str()))
    {
        return Err("invalid_params");
    }
    match (params["provider"].as_str(), params["endpoint"].as_str()) {
        (Some("gmail"), Some("token")) => Ok("https://oauth2.googleapis.com/token".into()),
        (Some("outlook"), Some(endpoint @ ("token" | "device"))) => {
            let tenant = params
                .get("tenant")
                .map(|v| v.as_str().ok_or("invalid_params"))
                .transpose()?
                .unwrap_or("consumers");
            if tenant.is_empty()
                || tenant.len() > 255
                || tenant.contains("..")
                || !tenant.as_bytes()[0].is_ascii_alphanumeric()
                || !tenant
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            {
                return Err("invalid_params");
            }
            Ok(format!(
                "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/{}",
                if endpoint == "device" {
                    "devicecode"
                } else {
                    "token"
                }
            ))
        }
        _ => Err("invalid_params"),
    }
}

async fn post(client: &reqwest::Client, url: &str, body: String) -> Result<Value, &'static str> {
    post_with_deadline(client, url, body, Duration::from_secs(20)).await
}

async fn post_with_deadline(
    client: &reqwest::Client,
    url: &str,
    body: String,
    deadline: Duration,
) -> Result<Value, &'static str> {
    tokio::time::timeout(deadline, async {
        let mut response = client
            .post(url)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(body)
            .send()
            .await
            .map_err(|_| "auth_transport_failed")?;
        let status = response.status();
        if status.is_redirection() {
            return Err("auth_redirect_refused");
        }
        if response.content_length().is_some_and(|n| n > LIMIT as u64) {
            return Err("auth_response_too_large");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "auth_transport_failed")?
        {
            if chunk.len() > LIMIT - bytes.len() {
                return Err("auth_response_too_large");
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8(bytes).map_err(|_| "auth_invalid_response")?;
        let parsed: Value = serde_json::from_str(&body).map_err(|_| "auth_invalid_response")?;
        if !parsed.is_object() {
            return Err("auth_invalid_response");
        }
        Ok(json!({"status": status.as_u16(), "body": body}))
    })
    .await
    .map_err(|_| "auth_timeout")?
}

impl Session {
    pub async fn call(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        if matches!(method, "auth.store" | "auth.clear") {
            if params
                .as_object()
                .ok_or("invalid_params")?
                .keys()
                .any(|key| !["accountId", "clientId", "token"].contains(&key.as_str()))
            {
                return Err("invalid_params");
            }
            return credentials::change_outlook(params, method == "auth.clear").await;
        }
        if method == "auth.token" {
            if params
                .as_object()
                .ok_or("invalid_params")?
                .keys()
                .any(|key| !["provider", "accountId", "resource"].contains(&key.as_str()))
            {
                return Err("invalid_params");
            }
            if params["provider"] != "outlook" {
                return Err("invalid_params");
            }
            let account = params["accountId"].as_str().ok_or("invalid_params")?;
            let resource = params
                .get("resource")
                .map(|v| v.as_str().ok_or("invalid_params"))
                .transpose()?
                .unwrap_or("mail");
            let access = access_token("outlook", account, resource).await?;
            let scope = credentials::scope(resource)?;
            return Ok(json!({"access_token":access,"expires_in":60,"scope":scope}));
        }
        if method == "auth.invalidate" {
            if params
                .as_object()
                .ok_or("invalid_params")?
                .keys()
                .any(|key| key != "accountId")
            {
                return Err("invalid_params");
            }
            let account = params["accountId"].as_str().ok_or("invalid_params")?;
            credentials::invalidate(account).await?;
            return Ok(json!({"invalidated":true}));
        }
        if method == "outlook.graphSend" {
            return graph::send(params).await;
        }
        if method != "auth.form" {
            return self.flows.call(method, params).await;
        }
        let url = destination(params)?;
        let body = params["body"].as_str().ok_or("invalid_params")?;
        if body.len() > LIMIT || body.bytes().any(|b| b < 32 || b == 127) {
            return Err("invalid_params");
        }
        post(client()?, &url, body.into()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn native_deadline_cancels_a_server_that_never_answers() {
        use tokio::{io::AsyncReadExt, net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            let ended = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut request))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(ended, 0, "deadline must close the outstanding request");
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(
            post_with_deadline(
                &client,
                &format!("http://{address}"),
                "refresh_token=synthetic".into(),
                Duration::from_millis(50)
            )
            .await,
            Err("auth_timeout")
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_token_response_is_refused_before_body_collection() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket
                .write_all(
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", LIMIT + 1).as_bytes(),
                )
                .await
                .unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(
            post(
                &client,
                &format!("http://{address}"),
                "refresh_token=synthetic".into()
            )
            .await,
            Err("auth_response_too_large")
        );
        server.await.unwrap();
    }
    #[test]
    fn credentials_cannot_choose_a_destination() {
        for tenant in [
            "https://evil.test",
            "a/b",
            "a%2fb",
            "a\\b",
            "..",
            "a..b",
            "a\n",
            "a\0",
            "@evil",
        ] {
            assert!(
                destination(&json!({"provider":"outlook","endpoint":"token","tenant":tenant}))
                    .is_err()
            );
        }
        assert_eq!(
            destination(
                &json!({"provider":"outlook","endpoint":"device","tenant":"organizations"})
            )
            .unwrap(),
            "https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode"
        );
        assert!(
            destination(&json!({"provider":"gmail","endpoint":"token","url":"https://evil.test"}))
                .is_err()
        );
    }
    #[tokio::test]
    async fn redirect_never_receives_form_credentials() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(socket.read(&mut bytes).await.unwrap() > 0);
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: /stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        assert_eq!(
            post(&client, &format!("http://{addr}"), "token=synthetic".into()).await,
            Err("auth_redirect_refused")
        );
        server.await.unwrap();
    }
}
