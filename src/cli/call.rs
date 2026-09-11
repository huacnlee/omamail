use serde_json::{Value, json};
use std::io::Read;

const MAX_PARAMS: usize = 1024 * 1024;

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
