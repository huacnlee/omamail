//! Read the desktop's account registry without exposing authentication fields.
use serde_json::{Value, json};
use std::{env, io::Read, path::PathBuf};

const MAX_CONFIG: u64 = 1024 * 1024;

pub mod conversation;
pub mod intents;
pub mod model;
pub mod senders;
mod storage;
#[cfg(test)]
mod tests;
pub mod unified;
pub use storage::call;
pub(crate) use storage::{raw_registry, raw_registry_readonly};

pub fn list() -> Result<Value, &'static str> {
    let raw = raw_registry()?;
    summarize(&serde_json::to_vec(&raw).map_err(|_| "accounts_invalid")?)
}

pub(crate) fn list_readonly() -> Result<Value, &'static str> {
    let raw = raw_registry_readonly()?;
    summarize(&serde_json::to_vec(&raw).map_err(|_| "accounts_invalid")?)
}

/// Account-specific provider withdrawals are stored in the private registry,
/// rather than the public credential-free account summary. This read-only
/// projection is deliberately narrow: callers can learn only the capability
/// keys that the account has withdrawn.
pub(crate) fn refusals_readonly(account_id: &str) -> Result<Value, &'static str> {
    let raw = raw_registry_readonly()?;
    let entries = raw["accounts"].as_array().ok_or("accounts_invalid")?;
    for entry in entries {
        let one = json!({"version":1,"activeId":"","accounts":[entry]});
        let summary = summarize(&serde_json::to_vec(&one).map_err(|_| "accounts_invalid")?)?;
        if summary["accounts"][0]["id"] == account_id {
            return Ok(if entry["refusals"].is_object() {
                entry["refusals"].clone()
            } else {
                Value::Null
            });
        }
    }
    Err("mail_account_unknown")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("").trim()
}

fn valid_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    if local.is_empty() || local.chars().any(char::is_whitespace) {
        return false;
    }
    let parts: Vec<_> = domain.split('.').collect();
    parts.len() >= 2
        && parts.iter().all(|part| {
            !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        && parts
            .last()
            .is_some_and(|part| part.len() >= 2 && part.bytes().all(|b| b.is_ascii_alphabetic()))
}

pub fn summarize(bytes: &[u8]) -> Result<Value, &'static str> {
    let raw: Value = serde_json::from_slice(bytes).map_err(|_| "accounts_invalid")?;
    if raw["version"] != 1 {
        return Err("accounts_version_unsupported");
    }
    let entries = raw["accounts"].as_array().ok_or("accounts_invalid")?;
    let mut accounts = Vec::new();
    for entry in entries.iter().filter(|entry| entry.is_object()) {
        let declared = text(&entry["provider"]).to_lowercase();
        let provider = match declared.as_str() {
            "" | "gmail" => "gmail",
            "outlook" | "hey" | "jmap" | "imap" => declared.as_str(),
            _ => continue,
        };
        let mut email = text(&entry["email"]);
        if !valid_email(email) && matches!(provider, "imap" | "outlook") {
            let username = text(&entry["imap"]["username"]);
            if valid_email(username) {
                email = username;
            }
        }
        let id = if !valid_email(email) {
            String::new()
        } else if provider == "gmail" {
            email.to_lowercase()
        } else {
            format!("{provider}:{}", email.to_lowercase())
        };
        if !id.is_empty() && accounts.iter().any(|a: &Value| a["id"] == id) {
            continue;
        }
        accounts.push(json!({"id": id, "email": email, "provider": provider,
            "label": text(&entry["label"]), "pending": entry["pending"] == true && !valid_email(email)}));
    }
    let wanted = text(&raw["activeId"]).to_lowercase();
    let active = accounts
        .iter()
        .find(|a| !wanted.is_empty() && a["id"] == wanted)
        .or_else(|| accounts.iter().find(|a| a["id"] != ""))
        .map(|a| a["id"].clone())
        .unwrap_or(json!(""));
    Ok(json!({"accounts": accounts, "activeId": active}))
}
