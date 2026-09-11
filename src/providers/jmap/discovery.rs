//! Server discovery and credential destinations are enforced before networking.
use super::*;
const CORE: &str = "urn:ietf:params:jmap:core";
const MAIL: &str = "urn:ietf:params:jmap:mail";
const SUBMISSION: &str = "urn:ietf:params:jmap:submission";
#[derive(Clone)]
pub(super) struct Policy {
    root: String,
    authorization: Option<header::HeaderValue>,
    origins: Vec<String>,
}
fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}
fn session_policy(
    root: &str,
    document: &Value,
    authorization: Option<header::HeaderValue>,
) -> Result<Policy, &'static str> {
    let mut origins = vec![origin(&url(root)?)];
    for key in ["apiUrl", "downloadUrl", "uploadUrl", "eventSourceUrl"] {
        if let Some(endpoint) = document[key].as_str().filter(|v| !v.is_empty()) {
            // Placeholders are only legal in the resource path/query, never in
            // the server authority that authorizes a credential destination.
            let endpoint = url(endpoint)?;
            if endpoint
                .host_str()
                .is_some_and(|host| host.contains(['{', '}']))
            {
                return Err("jmap_invalid_session");
            }
            origins.push(origin(&endpoint));
        }
    }
    Ok(Policy {
        root: root.to_owned(),
        authorization,
        origins,
    })
}
pub(super) fn verify_session(document: &Value) -> Result<&str, &'static str> {
    if !document["capabilities"][CORE].is_object() || !document["capabilities"][MAIL].is_object() {
        return Err("jmap_invalid_session");
    }
    let account = document["primaryAccounts"][MAIL]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("jmap_no_mailbox")?;
    let capability = &document["accounts"][account]["accountCapabilities"][MAIL];
    if !capability.is_object() {
        return Err("jmap_no_mailbox");
    }
    if !capability["emailQuerySortOptions"]
        .as_array()
        .is_some_and(|v| v.iter().any(|v| v == "receivedAt"))
    {
        return Err("jmap_unsupported_sort");
    }
    url(document["apiUrl"].as_str().ok_or("jmap_invalid_session")?)?;
    Ok(account)
}
fn discovery_url(address: &str, server: &str) -> Result<(String, bool), &'static str> {
    if !server.is_empty() {
        let candidate = if server.contains("://") {
            server.to_owned()
        } else {
            format!("https://{server}/jmap/session")
        };
        let mut candidate = url(&candidate)?;
        if candidate.path() == "/" && candidate.query().is_none() {
            candidate.set_path("/jmap/session");
        }
        return Ok((candidate.to_string(), true));
    }
    if address.matches('@').count() != 1 || address.chars().any(char::is_whitespace) {
        return Err("jmap_discovery_failed");
    }
    let domain = address
        .rsplit_once('@')
        .map(|(_, d)| d)
        .ok_or("jmap_discovery_failed")?;
    if domain.is_empty()
        || !domain
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err("jmap_discovery_failed");
    }
    Ok((
        url(&format!("https://{domain}/.well-known/jmap"))?.to_string(),
        false,
    ))
}
fn probe_accepts(reply: &Value) -> bool {
    let body = reply["body"].as_str().unwrap_or("");
    let document: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if reply["status"] == 200 {
        return document["capabilities"][CORE].is_object();
    }
    reply["status"] == 401
        && (body.trim() == "No Authorization header"
            || document["type"]
                .as_str()
                .is_some_and(|v| v.starts_with("urn:ietf:params:jmap:error:")))
}
impl Session {
    async fn raw(&self, params: &Value) -> Result<Value, &'static str> {
        let request = prepare(params)?;
        let client = self.client.as_ref().map_err(|e| *e)?;
        let _slot = self
            .slots
            .acquire()
            .await
            .map_err(|_| "jmap_transport_unavailable")?;
        execute(client, request).await
    }
    async fn discover(&self, mut endpoint: String) -> Result<String, &'static str> {
        let none = json!({"scheme":"none","username":"","secret":""});
        let mut probe = self
            .raw(&json!({"verb":"session","url":endpoint,"credential":none}))
            .await?;
        if matches!(probe["status"].as_u64(), Some(301 | 302 | 303 | 307 | 308)) {
            let hop = probe["redirect"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("jmap_discovery_failed")?;
            endpoint = url(hop)?.to_string();
            probe = self
                .raw(&json!({"verb":"session","url":endpoint,"credential":none}))
                .await?;
        }
        if !probe_accepts(&probe) {
            return Err("jmap_discovery_failed");
        }
        Ok(endpoint)
    }
    pub(super) async fn verify(&self, params: &Value) -> Result<Value, &'static str> {
        let address = text(params, "address")?;
        let secret = text(params, "secret")?;
        let settings = params.get("settings").ok_or("invalid_params")?;
        let username = settings["username"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or(address);
        let (mut endpoint, typed) =
            discovery_url(address, settings["sessionUrl"].as_str().unwrap_or(""))?;
        // Refuse malformed credentials before even the unauthenticated probe.
        prepare(
            &json!({"verb":"session","url":endpoint,"credential":{"scheme":"basic","username":username,"secret":secret}}),
        )?;
        if !typed {
            endpoint = self.discover(endpoint).await?;
        }
        let schemes = if settings["authScheme"] == "bearer" {
            ["bearer", "basic"]
        } else {
            ["basic", "bearer"]
        };
        for scheme in schemes {
            let credential = json!({"scheme":scheme,"username":username,"secret":secret});
            let request_params = json!({"verb":"session","url":endpoint,"credential":credential});
            let reply = self.raw(&request_params).await?;
            if reply["status"] == 401 {
                continue;
            }
            if reply["status"] != 200 {
                return Err("jmap_network_failed");
            }
            let document: Value =
                serde_json::from_str(reply["body"].as_str().ok_or("jmap_invalid_session")?)
                    .map_err(|_| "jmap_invalid_session")?;
            let account = verify_session(&document)?;
            let policy = session_policy(
                &endpoint,
                &document,
                prepare(&request_params)?.authorization,
            )?;
            let api = document["apiUrl"].as_str().ok_or("jmap_invalid_session")?;
            let body = json!({"using":[CORE,MAIL],"methodCalls":[["Mailbox/get",{"accountId":account,"ids":null,
                "properties":["id","name","parentId","role","sortOrder","isSubscribed","myRights","totalEmails","unreadEmails","totalThreads","unreadThreads"]},"0"]]});
            let reply = self.raw(&json!({"verb":"call","url":api,"credential":credential,"body":body.to_string()})).await?;
            if reply["status"] == 401 {
                return Err("jmap_unauthorized");
            }
            if reply["status"] != 200 {
                return Err("jmap_network_failed");
            }
            let result: Value =
                serde_json::from_str(reply["body"].as_str().ok_or("jmap_invalid_response")?)
                    .map_err(|_| "jmap_invalid_response")?;
            let response = result["methodResponses"]
                .as_array()
                .and_then(|v| v.iter().find(|v| v[0] == "Mailbox/get" && v[2] == "0"))
                .ok_or("jmap_method_failed")?;
            let boxes = response[1]["list"]
                .as_array()
                .ok_or("jmap_invalid_response")?;
            {
                let mut policies = self.policies.lock().map_err(|_| "session_failed")?;
                if policies.len() >= 64 {
                    policies.clear();
                }
                policies.insert(format!("jmap:{}", address.to_lowercase()), policy);
            }
            self.install_verified(
                &format!("jmap:{}", address.to_lowercase()),
                document.clone(),
                boxes.clone(),
                credential.clone(),
                address,
            )
            .await?;
            return Ok(
                json!({"session":document,"mailboxes":boxes,"sessionUrl":endpoint,"authScheme":scheme,
                "accountId":account,"canSend":document["capabilities"][SUBMISSION].is_object() && document["accounts"][account]["accountCapabilities"][SUBMISSION].is_object(),"mailboxCount":boxes.len()}),
            );
        }
        Err("jmap_unauthorized")
    }
    pub(super) fn remember(
        &self,
        params: &Value,
        request: &Request,
        reply: &Value,
    ) -> Result<(), &'static str> {
        if reply["status"] != 200 {
            return Ok(());
        }
        let document: Value =
            serde_json::from_str(reply["body"].as_str().ok_or("jmap_invalid_session")?)
                .map_err(|_| "jmap_invalid_session")?;
        verify_session(&document)?;
        let policy = session_policy(
            request.url.as_str(),
            &document,
            request.authorization.clone(),
        )?;
        let mut policies = self.policies.lock().map_err(|_| "session_failed")?;
        if policies.len() >= 64 {
            policies.clear();
        }
        policies.insert(text(params, "accountId")?.to_owned(), policy);
        Ok(())
    }
    pub(super) async fn authorize(
        &self,
        params: &Value,
        request: &Request,
    ) -> Result<(), &'static str> {
        if request.authorization.is_none() {
            // Unauthenticated discovery is owned by verify(), not the public
            // arbitrary request API. It cannot become a sender-controlled fetch.
            return Err("jmap_destination_refused");
        }
        let id = text(params, "accountId")?.to_owned();
        let lookup = id.clone();
        let account = tokio::task::spawn_blocking(move || crate::auth::settings("jmap", &lookup))
            .await
            .map_err(|_| "worker_failed")??;
        let root = account["jmap"]["sessionUrl"]
            .as_str()
            .ok_or("jmap_settings_missing")?;
        let root = url(root)?.to_string();
        if request.verb == "session" && request.url.as_str() == root {
            return Ok(());
        }
        let existing = self
            .policies
            .lock()
            .map_err(|_| "session_failed")?
            .get(&id)
            .cloned();
        let policy = if let Some(policy) = existing.filter(|p| {
            p.root == root
                && p.authorization == request.authorization
                && p.origins.contains(&origin(&request.url))
        }) {
            policy
        } else {
            let reply = self
                .raw(&json!({"verb":"session","url":root,"credential":params["credential"]}))
                .await?;
            if reply["status"] == 401 {
                return Err("jmap_unauthorized");
            }
            if reply["status"] != 200 {
                return Err("jmap_network_failed");
            }
            let document: Value =
                serde_json::from_str(reply["body"].as_str().ok_or("jmap_invalid_session")?)
                    .map_err(|_| "jmap_invalid_session")?;
            verify_session(&document)?;
            let policy = session_policy(&root, &document, request.authorization.clone())?;
            let mut policies = self.policies.lock().map_err(|_| "session_failed")?;
            if policies.len() >= 64 && !policies.contains_key(&id) {
                policies.clear();
            }
            policies.insert(id, policy.clone());
            policy
        };
        if !policy.origins.contains(&origin(&request.url)) {
            return Err("jmap_destination_refused");
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_rejects_html_or_empty_challenges_before_credentials() {
        for reply in [
            json!({"status":200,"body":"<html>marketing</html>"}),
            json!({"status":401,"body":""}),
            json!({"status":401,"body":"<html>sign in</html>"}),
        ] {
            assert!(!probe_accepts(&reply));
        }
        assert!(probe_accepts(
            &json!({"status":401,"body":"No Authorization header"})
        ));
        assert_eq!(
            discovery_url("a@example.org", "").unwrap(),
            ("https://example.org/.well-known/jmap".into(), false)
        );
        assert!(discovery_url("a@evil.test/@target", "").is_err());
    }
    #[test]
    fn session_never_authorizes_insecure_or_userinfo_destinations() {
        for endpoint in [
            "http://example.org/api",
            "https://user:pass@example.org/api",
            "https://{accountId}.example.org/api",
        ] {
            assert!(
                session_policy(
                    "https://mail.example.org/",
                    &json!({"apiUrl":endpoint}),
                    None
                )
                .is_err()
            );
        }
        let policy = session_policy("https://mail.example.org/",&json!({"apiUrl":"https://api.example.org/","downloadUrl":"https://blob.example.org/{accountId}/{blobId}"}),None).unwrap();
        assert!(policy.origins.contains(&"https://api.example.org".into()));
        assert!(
            !policy
                .origins
                .contains(&"https://attacker.example.org".into())
        );
    }
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    #[tokio::test]
    async fn html_and_empty_challenge_never_receive_credentials_or_followup_requests() {
        use std::io::{BufRead, BufReader};
        struct Peer(std::process::Child);
        impl Drop for Peer {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut peer = Peer(
            std::process::Command::new("python3")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/src/providers/jmap/discovery_tls_test.py"
                ))
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut output = BufReader::new(peer.0.stdout.take().unwrap());
        let mut port = String::new();
        output.read_line(&mut port).unwrap();
        let port: u16 = port.trim().parse().unwrap();
        let mut certificate_path = String::new();
        output.read_line(&mut certificate_path).unwrap();
        let certificate =
            reqwest::Certificate::from_pem(&std::fs::read(certificate_path.trim()).unwrap())
                .unwrap();
        let client = client_builder()
            .add_root_certificate(certificate)
            .build()
            .unwrap();
        let session = Session {
            client: Ok(client.clone()),
            ..Default::default()
        };
        for path in ["html", "empty"] {
            assert_eq!(
                session
                    .discover(format!("https://localhost:{port}/{path}"))
                    .await,
                Err("jmap_discovery_failed")
            );
        }
        let report: Value = serde_json::from_slice(
            &client
                .get(format!("https://localhost:{port}/report"))
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            report,
            json!([{"path":"/html","authorization":false},{"path":"/empty","authorization":false}])
        );
        assert!(peer.0.wait().unwrap().success());
    }
}
