//! Gmail reads share authentication state between persistent IPC workers.
use super::{gmail_credentials, gmail_http};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

struct Token {
    value: String,
    expires: Instant,
}

#[derive(Default)]
pub struct Session {
    tokens: Mutex<HashMap<String, Token>>,
}

fn field<'a>(params: &'a Value, key: &str, required: bool) -> Result<&'a str, &'static str> {
    let value = match params.get(key) {
        Some(Value::String(value)) => value.as_str(),
        None if !required => "",
        _ => return Err("invalid_params"),
    };
    if value.len() > 8192
        || value.chars().any(char::is_control)
        || (required && value.trim().is_empty())
    {
        return Err("invalid_params");
    }
    Ok(value)
}

impl Session {
    fn token(&self, account: &str) -> Result<String, &'static str> {
        // Holding this lock through refresh coalesces concurrent callers rather
        // than racing a rotating refresh token. Only authentication is serialized.
        let mut tokens = self.tokens.lock().map_err(|_| "session_failed")?;
        if let Some(token) = tokens.get(account).filter(|t| t.expires > Instant::now()) {
            return Ok(token.value.clone());
        }
        let client = gmail_credentials::read_for_account(account)?;
        let refresh = gmail_credentials::lookup_refresh_token(&client, account)?;
        let answer = gmail_http::refresh(&client.client_id, &client.client_secret, &refresh)?;
        let value = answer["access_token"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 16384 && !s.chars().any(char::is_control))
            .ok_or("gmail_invalid_token")?
            .to_owned();
        let lifetime = answer["expires_in"]
            .as_u64()
            .unwrap_or(3600)
            .min(86400)
            .saturating_sub(60);
        if tokens.len() >= 32 {
            tokens.retain(|_, t| t.expires > Instant::now());
        }
        if tokens.len() >= 32 {
            return Err("gmail_session_limit");
        }
        tokens.insert(
            account.to_owned(),
            Token {
                value: value.clone(),
                expires: Instant::now() + Duration::from_secs(lifetime),
            },
        );
        Ok(value)
    }

    pub fn call(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        let allowed: &[&str] = match method {
            "gmail.list" => &["accountId", "query", "pageSize", "pageToken"],
            "gmail.read" => &["accountId", "id", "full"],
            "gmail.attachment" => &["accountId", "messageId", "attachmentId"],
            _ => return Err("unknown_method"),
        };
        if params
            .as_object()
            .ok_or("invalid_params")?
            .keys()
            .any(|k| !allowed.contains(&k.as_str()))
        {
            return Err("invalid_params");
        }
        let account = field(params, "accountId", true)?.to_lowercase();
        let mut query = Vec::new();
        let path = match method {
            "gmail.list" => {
                let size = match params.get("pageSize") {
                    None => 25,
                    Some(value) => value
                        .as_u64()
                        .filter(|n| (1..=100).contains(n))
                        .ok_or("invalid_params")?,
                };
                query.push(("q".into(), field(params, "query", false)?.trim().into()));
                query.push(("maxResults".into(), size.to_string()));
                query.push((
                    "pageToken".into(),
                    field(params, "pageToken", false)?.into(),
                ));
                vec!["messages"]
            }
            "gmail.read" => {
                let full = match params.get("full") {
                    None => true,
                    Some(Value::Bool(v)) => *v,
                    _ => return Err("invalid_params"),
                };
                query.push((
                    "format".into(),
                    if full { "full" } else { "metadata" }.into(),
                ));
                if !full {
                    for header in ["From", "To", "Subject", "Date", "List-Unsubscribe"] {
                        query.push(("metadataHeaders".into(), header.into()));
                    }
                }
                vec!["messages", field(params, "id", true)?]
            }
            _ => vec![
                "messages",
                field(params, "messageId", true)?,
                "attachments",
                field(params, "attachmentId", true)?,
            ],
        };
        // Resolve the registered provider before any credential or network read.
        let accounts = crate::account::list()?;
        if !accounts["accounts"].as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|a| a["id"] == account && a["provider"] == "gmail")
        }) {
            return Err("gmail_account_unknown");
        }
        let token = self.token(&account)?;
        let answer = gmail_http::get(&path, &query, &token)?;
        if method != "gmail.list" {
            return Ok(answer);
        }
        let messages = match answer.get("messages") {
            None => Vec::new(),
            Some(Value::Array(values)) => values.clone(),
            _ => return Err("gmail_invalid_response"),
        };
        let mut ids = Vec::new();
        let mut threads = Vec::new();
        for message in messages {
            let id = message["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("gmail_invalid_response")?;
            ids.push(id.to_owned());
            threads.push(message["threadId"].as_str().unwrap_or("").to_owned());
        }
        Ok(
            json!({"ids":ids,"threadIds":threads,"nextPageToken":answer["nextPageToken"].as_str().unwrap_or(""),"estimate":answer["resultSizeEstimate"].as_u64().unwrap_or(0)}),
        )
    }
}
