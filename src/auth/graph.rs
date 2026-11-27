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
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(refusal(status, &body));
    }
    Ok(json!({"sent":true}))
}

/// Graph caps a sendMail request near 4 MB, and the MIME goes up base64 encoded
/// once more, so a message of a few MB is refused for its size. That refusal is
/// `message_too_large`, which the outbox knows was never sent; any other answer
/// keeps `outlook_send_failed`, whose delivery stays unknown.
fn refusal(status: u16, body: &str) -> &'static str {
    const TOO_LARGE: [&str; 4] = [
        "ErrorMessageSizeExceeded",
        "RequestBodyTooLarge",
        "MaxRequestBodySize",
        "RequestEntityTooLarge",
    ];
    let refused = (400..500).contains(&status);
    if status == 413 || (refused && TOO_LARGE.iter().any(|code| body.contains(code))) {
        "message_too_large"
    } else {
        "outlook_send_failed"
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn size_refusals_are_told_apart_from_other_failures() {
        assert_eq!(super::refusal(413, ""), "message_too_large");
        for code in [
            "ErrorMessageSizeExceeded",
            "RequestBodyTooLarge",
            "MaxRequestBodySize",
        ] {
            let body = format!(r#"{{"error":{{"code":"{code}","message":"too big"}}}}"#);
            assert_eq!(super::refusal(400, &body), "message_too_large", "{code}");
        }
        assert_eq!(
            super::refusal(400, r#"{"error":{"code":"ErrorInvalidRecipients"}}"#),
            "outlook_send_failed"
        );
        assert_eq!(super::refusal(500, ""), "outlook_send_failed");
        // A server error that mentions a size code is not Graph's refusal.
        assert_eq!(
            super::refusal(503, "MaxRequestBodySize"),
            "outlook_send_failed"
        );
        assert_eq!(super::refusal(403, "Forbidden"), "outlook_send_failed");
    }
}
