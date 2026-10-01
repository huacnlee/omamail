//! Microsoft Graph Device Flow OAuth. Public client (no secret).
//! Users authenticate via device code on any browser; backend polls for token.
//! This module follows the same pattern as callback.rs but for Device Flow instead of PKCE.
use super::*;
use base64::Engine;
use std::collections::HashMap;
use std::time::{SystemTime, Duration};
use tokio::sync::Mutex;

/// omarchylook Azure App Registration (public client, multi-tenant)
/// Shared across omamail and omarchylook for unified Azure governance.
const PUBLIC_CLIENT_ID: &str = "9c277d6f-edb2-4f82-bda5-901b4c11c457";

/// Flow state: pending device code → token exchange
#[derive(Clone)]
struct DeviceFlow {
    device_code: String,
    expires_at: SystemTime,
}

static FLOWS: std::sync::OnceLock<Mutex<HashMap<String, DeviceFlow>>> = std::sync::OnceLock::new();

fn flows() -> &'static Mutex<HashMap<String, DeviceFlow>> {
    FLOWS.get_or_init(Default::default)
}

// Push sender: set at server start so the poll task can push notifications to QML.
// Held weakly: a strong clone in a static would keep the response channel open
// after the protocol loop ends, so the writer thread would never finish.
static PUSH_SENDER: std::sync::Mutex<Option<tokio::sync::mpsc::WeakSender<serde_json::Value>>> =
    std::sync::Mutex::new(None);

pub fn set_push_sender(sender: tokio::sync::mpsc::Sender<serde_json::Value>) {
    if let Ok(mut slot) = PUSH_SENDER.lock() {
        *slot = Some(sender.downgrade());
    }
}

fn push_sender() -> Option<tokio::sync::mpsc::Sender<serde_json::Value>> {
    PUSH_SENDER.lock().ok()?.as_ref()?.upgrade()
}

fn random() -> Result<String, &'static str> {
    use std::io::Read;
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

fn url_encode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}

fn validate_tenant(tenant: &str) -> Result<(), &'static str> {
    if tenant.is_empty() || tenant.len() > 255 {
        return Err("invalid_params");
    }
    // Allow: common, consumers, organizations, or UUID-like patterns
    if tenant.contains("..")
        || tenant.starts_with('.')
        || tenant.contains(' ')
        || tenant.contains('\n')
        || tenant.contains('\r')
        || tenant.contains('\0')
    {
        return Err("invalid_params");
    }
    // Prevent URL injection
    if tenant.starts_with("http") || tenant.contains('/') || tenant.contains('\\') {
        return Err("invalid_params");
    }
    Ok(())
}

fn validate_scopes(scopes: &Value) -> Result<(), &'static str> {
    let arr = scopes.as_array().ok_or("invalid_params")?;
    if arr.is_empty() || arr.len() > 32 {
        return Err("invalid_params");
    }

    let allowed = [
        "https://graph.microsoft.com/Mail.Read",
        "https://graph.microsoft.com/Mail.ReadWrite",
        "https://graph.microsoft.com/Mail.Send",
        "https://graph.microsoft.com/User.Read",
        "https://graph.microsoft.com/Calendars.ReadWrite",
        "https://outlook.office.com/IMAP.AccessAsUser.All",
        "https://outlook.office.com/SMTP.Send",
        "offline_access",
        "openid",
    ];

    for scope in arr {
        let s = scope
            .as_str()
            .filter(|s| s.len() < 512 && !s.chars().any(char::is_whitespace))
            .ok_or("invalid_params")?;
        if !allowed.contains(&s) {
            return Err("invalid_params");
        }
    }
    Ok(())
}

/// Initiate Device Flow. User receives code; client receives flow ID for polling.
/// Returns {id, userCode, verificationUri, expiresIn}.
pub(super) async fn begin(params: &Value) -> Result<Value, &'static str> {
    let id = random()?;
    let tenant = text(params, "tenant").unwrap_or("common");
    validate_tenant(tenant)?;
    validate_scopes(&params["scopes"])?;

    // Optional: account ID and client ID for automatic token storage on success
    let account_id = params["accountId"].as_str().unwrap_or("").to_owned();
    let client_id_param = params["clientId"].as_str().unwrap_or("").to_owned();

    let scope_str = params["scopes"]
        .as_array()
        .ok_or("invalid_params")?
        .iter()
        .map(|s| s.as_str().unwrap_or(""))
        .collect::<Vec<_>>()
        .join(" ");

    let device_auth_url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/devicecode",
        tenant
    );

    let form_body = format!(
        "client_id={}&scope={}",
        url_encode(PUBLIC_CLIENT_ID),
        url_encode(&scope_str)
    );

    let device_response = post(client()?, &device_auth_url, form_body)
        .await
        .map_err(|_| "auth_device_code_failed")?;

    let body_str = device_response["body"].as_str().ok_or("auth_invalid_response")?;
    let parsed: serde_json::Value =
        serde_json::from_str(body_str).map_err(|_| "auth_invalid_response")?;

    let device_code = parsed["device_code"]
        .as_str()
        .ok_or("auth_invalid_response")?
        .to_owned();
    let user_code = parsed["user_code"]
        .as_str()
        .ok_or("auth_invalid_response")?
        .to_owned();
    let verification_uri = parsed["verification_uri"]
        .as_str()
        .ok_or("auth_invalid_response")?
        .to_owned();
    let expires_in = parsed["expires_in"]
        .as_u64()
        .filter(|n| *n > 0 && *n < 86400)
        .ok_or("auth_invalid_response")? as u64;

    let flow = DeviceFlow {
        device_code,
        expires_at: SystemTime::now() + Duration::from_secs(expires_in),
    };

    flows().lock().await.insert(id.clone(), flow);

    // Spawn a background task that polls until the user authenticates,
    // then pushes an unsolicited auth.microsoft.done notification to QML.
    // This survives QML component recreation — the notification arrives
    // on the backend's response channel regardless of which QML object is listening.
    let task_id = id.clone();
    let task_tenant = tenant.to_owned();
    let task_account = account_id.clone();
    let task_client = client_id_param.clone();
    tokio::spawn(async move {
        let poll_params = json!({ "id": task_id, "tenant": task_tenant });
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            match poll(&poll_params).await {
                Ok(result) if result.get("pending").and_then(|v| v.as_bool()).unwrap_or(false) => {
                    continue;
                }
                Ok(result) => {
                    // Store the refresh token in the exchange keyring before notifying QML
                    if !task_account.is_empty() && !task_client.is_empty() {
                        if let Some(rt) = result["refreshToken"].as_str() {
                            if !rt.is_empty() {
                                let _ = crate::auth::store_exchange_token(
                                    &task_account,
                                    &task_client,
                                    rt,
                                ).await;
                            }
                        }
                    }
                    if let Some(sender) = push_sender() {
                        let notification = json!({
                            "method": "auth.microsoft.done",
                            "params": result,
                        });
                        let _ = sender.send(notification).await;
                    }
                    break;
                }
                Err(_) => {
                    if let Some(sender) = push_sender() {
                        let notification = json!({
                            "method": "auth.microsoft.done",
                            "params": { "error": "auth_poll_failed" },
                        });
                        let _ = sender.send(notification).await;
                    }
                    break;
                }
            }
        }
    });

    Ok(json!({
        "id": id,
        "userCode": user_code,
        "verificationUri": verification_uri,
        "expiresIn": expires_in,
    }))
}

/// Poll for token. Returns {pending: true} until success or timeout.
/// On success: {accessToken, refreshToken, expiresIn}.
pub(super) async fn poll(params: &Value) -> Result<Value, &'static str> {
    let flow_id = text(params, "id")?;
    let tenant = text(params, "tenant").unwrap_or("common");
    validate_tenant(tenant)?;

    let flows_lock = flows().lock().await;
    let flow = flows_lock
        .get(flow_id)
        .ok_or("auth_flow_missing")?
        .clone();
    drop(flows_lock);

    if SystemTime::now() >= flow.expires_at {
        flows().lock().await.remove(flow_id);
        return Err("auth_flow_expired");
    }

    let token_url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        tenant
    );

    let form_body = format!(
        "grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id={}&device_code={}",
        url_encode(PUBLIC_CLIENT_ID),
        url_encode(&flow.device_code)
    );

    let token_response = post(client()?, &token_url, form_body)
        .await
        .map_err(|_| "auth_device_token_failed")?;

    let body_str = token_response["body"].as_str().ok_or("auth_device_token_failed")?;
    let token_parsed: serde_json::Value =
        serde_json::from_str(body_str).map_err(|_| "auth_device_token_failed")?;

    // Microsoft returns 400 with error code while user hasn't authenticated yet
    if token_parsed.get("error").is_some() {
        let error = token_parsed["error"].as_str().unwrap_or("");
        match error {
            "authorization_pending" => return Ok(json!({"pending": true})),
            "expired_token" => {
                flows().lock().await.remove(flow_id);
                return Err("auth_flow_expired");
            }
            "access_denied" => {
                flows().lock().await.remove(flow_id);
                return Err("auth_user_denied");
            }
            _ => return Err("auth_device_token_failed"),
        }
    }

    // Success: extract tokens
    let access_token = token_parsed["access_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 16384)
        .ok_or("auth_invalid_response")?
        .to_owned();
    let refresh_token = token_parsed["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 16384)
        .ok_or("auth_invalid_response")?
        .to_owned();
    let expires_in = token_parsed["expires_in"]
        .as_u64()
        .filter(|n| *n > 0 && *n < 86400)
        .unwrap_or(3600);

    flows().lock().await.remove(flow_id);

    Ok(json!({
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresIn": expires_in,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tenant_validation_rejects_injection() {
        for bad in &[
            "../../../evil",
            "a/b",
            "a\\b",
            "a..b",
            "http://evil.com",
            "a\n",
            "a\0",
            ".hidden",
            "a ",
        ] {
            assert!(validate_tenant(bad).is_err(), "tenant {} should be rejected", bad);
        }
        for ok in &["common", "consumers", "organizations", "12345678-1234-1234-1234-123456789012"] {
            assert!(validate_tenant(ok).is_ok(), "tenant {} should be accepted", ok);
        }
    }

    #[test]
    fn scope_validation_allows_known_graph_scopes() {
        let valid = json!(["https://graph.microsoft.com/Mail.Read", "offline_access"]);
        assert!(validate_scopes(&valid).is_ok());

        let invalid = json!(["https://graph.microsoft.com/User.Readwrite.All"]);
        assert!(validate_scopes(&invalid).is_err());

        let empty = json!([]);
        assert!(validate_scopes(&empty).is_err());

        let too_many: Vec<&str> = vec!["https://graph.microsoft.com/Mail.Read"; 33];
        assert!(validate_scopes(&json!(too_many)).is_err());
    }

    #[test]
    fn url_encode_preserves_safe_characters() {
        assert_eq!(url_encode("hello-world.txt"), "hello-world.txt");
        assert_eq!(url_encode("a b"), "a%20b");
        assert_eq!(url_encode("a/b"), "a%2Fb");
    }
}
