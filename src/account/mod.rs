//! Read the desktop's account registry without exposing authentication fields.
use serde_json::{Value, json};
use std::{env, io::Read, path::PathBuf};

const MAX_CONFIG: u64 = 1024 * 1024;

mod storage;
pub mod senders;
pub mod conversation;
pub mod unified;
pub mod model;
pub mod intents;
#[cfg(test)]
mod tests;
pub use storage::call;
pub(crate) use storage::raw_registry;

pub fn list() -> Result<Value, &'static str> {
    let raw = raw_registry()?;
    summarize(&serde_json::to_vec(&raw).map_err(|_| "accounts_invalid")?)
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
        let provider = text(&entry["provider"]).to_lowercase();
        let provider = match provider.as_str() {
            "outlook" | "hey" | "jmap" | "imap" => provider.as_str(),
            _ => "gmail",
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
