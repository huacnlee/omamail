//! Gmail reads share authentication state between persistent IPC workers.
use super::{gmail_credentials, gmail_http};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[path = "gmail_resources.rs"]
mod resources;
#[cfg(test)]
#[path = "gmail_tests.rs"]
mod tests;
#[path = "gmail_writes.rs"]
mod writes;
struct Token {
    value: String,
    expires: Instant,
}

struct AccountSession {
    valid: AtomicBool,
    token: tokio::sync::Mutex<Option<Arc<Token>>>,
}

impl AccountSession {
    fn check(&self) -> Result<(), &'static str> {
        if self.valid.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err("gmail_session_invalidated")
        }
    }

    async fn token_with<F: Future<Output = Result<Value, &'static str>>>(
        &self,
        refresh: impl FnOnce() -> F,
    ) -> Result<Arc<Token>, &'static str> {
        // Refresh coalesces per account. Invalidation never waits on this lock.
        let mut cached = self.token.lock().await;
        self.check()?;
        if let Some(token) = cached.as_ref().filter(|t| t.expires > Instant::now()) {
            return Ok(Arc::clone(token));
        }
        let answer = refresh().await;
        self.check()?;
        let answer = answer?;
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
        let token = Arc::new(Token {
            value,
            expires: Instant::now() + Duration::from_secs(lifetime),
        });
        *cached = Some(Arc::clone(&token));
        Ok(token)
    }

    async fn reject(&self, rejected: &Arc<Token>) -> Result<(), &'static str> {
        let mut cached = self.token.lock().await;
        self.check()?;
        // An old 401 cannot evict a new grant, even with identical token bytes.
        if cached
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, rejected))
        {
            *cached = None;
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct Session {
    accounts: Mutex<HashMap<String, Arc<AccountSession>>>,
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
    fn account(&self, account: &str) -> Result<Arc<AccountSession>, &'static str> {
        let mut accounts = self.accounts.lock().map_err(|_| "session_failed")?;
        if let Some(session) = accounts.get(account) {
            return Ok(Arc::clone(session));
        }
        if accounts.len() >= 32 {
            accounts.retain(|_, session| {
                Arc::strong_count(session) > 1
                    || session.token.try_lock().map_or(true, |token| {
                        token
                            .as_ref()
                            .is_some_and(|token| token.expires > Instant::now())
                    })
            });
        }
        if accounts.len() >= 32 {
            return Err("gmail_session_limit");
        }
        let session = Arc::new(AccountSession {
            valid: AtomicBool::new(true),
            token: tokio::sync::Mutex::new(None),
        });
        accounts.insert(account.into(), Arc::clone(&session));
        Ok(session)
    }

    async fn get_with<R, G>(
        &self,
        account: &str,
        refresh: impl Fn() -> R,
        get: impl Fn(String) -> G,
    ) -> Result<Value, &'static str>
    where
        R: Future<Output = Result<Value, &'static str>>,
        G: Future<Output = Result<Value, &'static str>>,
    {
        let session = self.account(account)?;
        let token = session.token_with(&refresh).await?;
        session.check()?;
        let answer = get(token.value.clone()).await;
        session.check()?;
        if answer != Err("gmail_unauthorized") {
            return answer;
        }
        session.reject(&token).await?;
        let replacement = session.token_with(refresh).await?;
        session.check()?;
        let answer = get(replacement.value.clone()).await;
        session.check()?;
        if answer == Err("gmail_unauthorized") {
            session.reject(&replacement).await?;
        }
        answer
    }

    /// Native sibling services may reuse only a registered Gmail account's grant.
    pub async fn access_token(&self, account: &str) -> Result<String, &'static str> {
        let account = field(&json!({"accountId": account}), "accountId", true)?.to_lowercase();
        let accounts = tokio::task::spawn_blocking(crate::account::list)
            .await
            .map_err(|_| "session_failed")??;
        if !accounts["accounts"].as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|a| a["id"] == account && a["provider"] == "gmail")
        }) {
            return Err("gmail_account_unknown");
        }
        let session = self.account(&account)?;
        let token = session
            .token_with(|| async {
                let (client, refresh) = tokio::task::spawn_blocking(move || {
                    let client = gmail_credentials::read_for_account(&account)?;
                    let refresh = gmail_credentials::lookup_refresh_token(&client, &account)?;
                    Ok::<_, &'static str>((client, refresh))
                })
                .await
                .map_err(|_| "session_failed")??;
                gmail_http::refresh(&client.client_id, &client.client_secret, &refresh).await
            })
            .await?;
        session.check()?;
        Ok(token.value.clone())
    }

    pub async fn call(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        if writes::supports(method) {
            return self.write_call(method, params).await;
        }
        let allowed: &[&str] = match method {
            "gmail.invalidate" => &["accountId"],
            "gmail.labels" | "gmail.profile" | "gmail.sendAs" => &["accountId"],
            "gmail.labelCounts" => &["accountId", "id"],
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
        if method == "gmail.invalidate" {
            // Cache eviction, not keyring logout or an IPC ordering barrier.
            // New calls can authenticate again. In-flight HTTP cannot be recalled;
            // retired leases refuse its result and never refresh for a retry.
            if let Some(session) = self
                .accounts
                .lock()
                .map_err(|_| "session_failed")?
                .remove(&account)
            {
                session.valid.store(false, Ordering::Release);
            }
            return Ok(json!({"invalidated":true}));
        }
        let mut query = Vec::new();
        let path = match method {
            "gmail.labels" => vec!["labels"],
            "gmail.labelCounts" => vec!["labels", field(params, "id", true)?],
            "gmail.profile" => vec!["profile"],
            "gmail.sendAs" => vec!["settings", "sendAs"],
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
        let accounts = tokio::task::spawn_blocking(crate::account::list)
            .await
            .map_err(|_| "session_failed")??;
        if !accounts["accounts"].as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|a| a["id"] == account && a["provider"] == "gmail")
        }) {
            return Err("gmail_account_unknown");
        }
        let answer = self
            .get_with(
                &account,
                || async {
                    let account = account.clone();
                    let (client, refresh) = tokio::task::spawn_blocking(move || {
                        let client = gmail_credentials::read_for_account(&account)?;
                        let refresh = gmail_credentials::lookup_refresh_token(&client, &account)?;
                        Ok::<_, &'static str>((client, refresh))
                    })
                    .await
                    .map_err(|_| "session_failed")??;
                    gmail_http::refresh(&client.client_id, &client.client_secret, &refresh).await
                },
                |token| {
                    let path = &path;
                    let query = &query;
                    async move { gmail_http::get(path, query, &token).await }
                },
            )
            .await?;
        if method != "gmail.list" {
            return Ok(resources::normalize(method, answer));
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
