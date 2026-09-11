//! Optional GUI binding to the same executable and signed-in identity it displays.
use serde_json::Value;
use std::{os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};

pub async fn checked_params(params: &Value) -> Result<Value, &'static str> {
    let mut fields = params.as_object().ok_or("invalid_params")?.clone();
    let program = fields.remove("program");
    let account = fields.remove("accountId");
    if program.is_none() && account.is_none() {
        return Ok(Value::Object(fields));
    }
    let program = program
        .as_ref()
        .and_then(Value::as_str)
        .ok_or("invalid_hey_binding")?;
    let account = account
        .as_ref()
        .and_then(Value::as_str)
        .ok_or("invalid_hey_binding")?;
    let email = account
        .strip_prefix("hey:")
        .filter(|s| s.contains('@') && !s.chars().any(char::is_control))
        .ok_or("invalid_hey_binding")?;
    let resolved = resolve_program().ok_or("hey_unavailable")?;
    let requested = std::fs::canonicalize(program).map_err(|_| "hey_program_mismatch")?;
    if requested != resolved.canonicalize().map_err(|_| "hey_unavailable")? {
        return Err("hey_program_mismatch");
    }
    let output = crate::process::async_run::run(
        resolved.to_str().ok_or("hey_program_mismatch")?,
        &["accounts".into(), "list".into(), "--json".into()],
        b"",
        Duration::from_secs(30),
        1024 * 1024,
    )
    .await?;
    if !output.success {
        return Err("invalid_hey_identity");
    }
    let response: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "invalid_hey_identity")?;
    if response["ok"] != true {
        return Err("invalid_hey_identity");
    }
    let identities = response["data"].as_array().ok_or("invalid_hey_identity")?;
    let actual = identities
        .iter()
        .filter(|v| v["id"] != "all")
        .filter_map(|v| v["email"].as_str())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .ok_or("invalid_hey_identity")?;
    if !actual.eq_ignore_ascii_case(email) {
        return Err("hey_account_mismatch");
    }
    Ok(Value::Object(fields))
}

fn resolve_program() -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let fallback = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local/bin"));
    std::env::split_paths(&path)
        .chain(fallback)
        .filter(|p| p.is_absolute())
        .find_map(|p| {
            let candidate = p.join("hey");
            let metadata = std::fs::metadata(&candidate).ok()?;
            if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
                return None;
            }
            // Multicall shims such as mise select the tool from argv[0].
            // Canonicalize only for identity checks, never for invocation.
            Some(candidate)
        })
}

pub fn program() -> Result<String, &'static str> {
    resolve_program()
        .and_then(|p| p.to_str().map(str::to_owned))
        .ok_or("hey_unavailable")
}
