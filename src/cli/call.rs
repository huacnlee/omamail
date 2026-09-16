use serde_json::{Value, json};
use std::io::Read;

const MAX_PARAMS: usize = 1024 * 1024;

/// A one-shot process owns any worker it starts until delivery settles. RPC
/// sessions keep their existing asynchronous enqueue response.
pub(super) async fn dispatch(
    session: &crate::backend::Session,
    method: &str,
    params: &Value,
) -> Result<Value, &'static str> {
    // A queued Gmail mutation would die with this process: wait for it here.
    if method.starts_with("gmail.") {
        return session.gmail.call_settled(method, params).await;
    }
    let mut result = session.dispatch(method, params).await?;
    if method == "mail.send" && result["executed"] == true {
        session.finish_cli_send(&mut result).await?;
    }
    Ok(result)
}

pub(super) fn read_params(input: impl Read) -> Result<Value, &'static str> {
    let mut bytes = Vec::new();
    input
        .take(MAX_PARAMS as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "input_failed")?;
    if bytes.len() > MAX_PARAMS {
        return Err("input_too_large");
    }
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    let params: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_json")?;
    if !params.is_object() && !params.is_array() {
        return Err("invalid_params");
    }
    Ok(params)
}
