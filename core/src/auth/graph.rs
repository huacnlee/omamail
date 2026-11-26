//! Microsoft Graph submission: one fixed destination and no automatic retry.
use super::*;
pub(super) async fn send(params: &Value) -> Result<Value, &'static str> {
    let fields = params.as_object().ok_or("invalid_params")?;
    if fields
        .keys()
        .any(|k| !["accountId", "raw"].contains(&k.as_str()))
    {
        return Err("invalid_params");
    }
    let account = params["accountId"].as_str().ok_or("invalid_params")?;
    let raw = params["raw"].as_str().ok_or("invalid_params")?;
    if raw.len() > 16 * 1024 * 1024 {
        return Err("message_too_large");
    }
    // Graph's MIME endpoint consumes standard base64, never raw MIME bytes.
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| "invalid_params")?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes) != raw {
        return Err("invalid_params");
    }
    let token = access_token("outlook", account, "graph").await?;
    let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "invalid_params")?;
    authorization.set_sensitive(true);
    let response = client()?
        .post("https://graph.microsoft.com/v1.0/me/sendMail")
        .header(reqwest::header::AUTHORIZATION, authorization)
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(base64::engine::general_purpose::STANDARD.encode(bytes))
        .send()
        .await
        .map_err(|_| "outlook_send_failed")?;
    if response.status() != reqwest::StatusCode::ACCEPTED {
        return Err("outlook_send_failed");
    }
    Ok(json!({"sent":true}))
}
