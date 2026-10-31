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
    time::{Duration, Instant, SystemTime},
};

#[path = "gmail_queue.rs"]
mod queue;
#[path = "gmail_resources.rs"]
mod resources;
#[cfg(test)]
#[path = "gmail_tests.rs"]
mod tests;
#[path = "gmail_threads.rs"]
mod threads;
#[path = "gmail_writes.rs"]
mod writes;
struct Token {
    value: String,
    expires: Instant,
    wall_expires: SystemTime,
}

impl Token {
    // Linux's monotonic clock stops during suspend, so a token that expired
    // while the machine slept still looks fresh to `Instant` alone. Wall time
    // catches sleep; the monotonic deadline still bounds reuse if the wall
    // clock moves backwards.
    fn fresh_at(&self, monotonic: Instant, wall: SystemTime) -> bool {
        self.expires > monotonic && self.wall_expires > wall
    }

    fn fresh(&self) -> bool {
        self.fresh_at(Instant::now(), SystemTime::now())
    }
}

// Gmail meters each user at 250 quota units per second, a moving average
// that tolerates short bursts. Every call is paced below that line here so a
// screen of trashed conversations — one 5-unit call per message — reaches
// Google as a stream rather than a burst it answers with 403 rateLimitExceeded.
// The margin leaves room for another omamail process on the same account.
const QUOTA_UNITS_PER_SECOND: f64 = 200.0;
const QUOTA_BURST: f64 = 200.0;
// A call whose turn would come after the IPC deadline fails now, as rate
// limited, instead of timing out as a mutation of unknown outcome.
const QUOTA_MAX_WAIT: Duration = Duration::from_secs(15);

struct Quota {
    units: f64,
    refilled: Instant,
}

struct AccountSession {
    valid: AtomicBool,
    token: tokio::sync::Mutex<Option<Arc<Token>>>,
    quota: tokio::sync::Mutex<Quota>,
    /// The rows of the last conversation listings, by representative id: the
    /// metadata the listing already read and the members it found, so the
    /// row's `gmail.read` is answered without asking Gmail again and carries
    /// its conversation the way a JMAP read does.
    blocks: Mutex<HashMap<String, Remembered>>,
    /// When this account last changed a message from here. A row remembered
    /// before that may carry labels the write changed, so it is read again.
    written: Mutex<Option<Instant>>,
}

struct Remembered {
    at: Instant,
    thread: String,
    query: String,
    block: Value,
    payload: Value,
}

/// How many listed rows one account remembers, and for how long. A row is
/// read right after its listing; one older than this is read from Gmail.
const MAX_BLOCKS: usize = 2000;
const BLOCK_TTL: Duration = Duration::from_secs(600);
/// The headers a summary row is built from, for messages and threads alike.
const SUMMARY_HEADERS: [&str; 5] = ["From", "To", "Subject", "Date", "List-Unsubscribe"];

impl AccountSession {
    fn new() -> Self {
        AccountSession {
            valid: AtomicBool::new(true),
            token: tokio::sync::Mutex::new(None),
            quota: tokio::sync::Mutex::new(Quota {
                units: QUOTA_BURST,
                refilled: Instant::now(),
            }),
            blocks: Mutex::new(HashMap::new()),
            written: Mutex::new(None),
        }
    }

    /// Spends `cost` quota units, waiting for its turn when the bucket is in
    /// debt. The debt is booked under the lock and slept off outside it, so
    /// each caller's wait is its position in the whole queue, not just its
    /// own deficit — which is what lets a hopeless tail fail now.
    async fn pace(&self, cost: u32) -> Result<(), &'static str> {
        self.pace_within(cost, QUOTA_MAX_WAIT).await
    }

    /// The queue drainer has no request deadline to protect and waits it out.
    async fn pace_within(&self, cost: u32, max_wait: Duration) -> Result<(), &'static str> {
        let cost = f64::from(cost).min(QUOTA_BURST);
        let wait = {
            let mut quota = self.quota.lock().await;
            let now = Instant::now();
            let refill = now.duration_since(quota.refilled).as_secs_f64() * QUOTA_UNITS_PER_SECOND;
            quota.units = (quota.units + refill).min(QUOTA_BURST);
            quota.refilled = now;
            let debt = cost - quota.units;
            let wait = Duration::from_secs_f64(debt.max(0.0) / QUOTA_UNITS_PER_SECOND);
            if wait > max_wait {
                return Err("gmail_rate_limited");
            }
            quota.units -= cost;
            wait
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        Ok(())
    }

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
        self.token_with_clock(refresh, || (Instant::now(), SystemTime::now()))
            .await
    }

    /// `token_with` on a supplied clock, so tests can sleep the machine.
    async fn token_with_clock<F: Future<Output = Result<Value, &'static str>>>(
        &self,
        refresh: impl FnOnce() -> F,
        clock: impl Fn() -> (Instant, SystemTime),
    ) -> Result<Arc<Token>, &'static str> {
        // Refresh coalesces per account. Invalidation never waits on this lock.
        let mut cached = self.token.lock().await;
        self.check()?;
        let (monotonic, wall) = clock();
        if let Some(token) = cached.as_ref().filter(|t| t.fresh_at(monotonic, wall)) {
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
        let lifetime = Duration::from_secs(lifetime);
        let (monotonic, wall) = clock();
        let token = Arc::new(Token {
            value,
            expires: monotonic + lifetime,
            wall_expires: wall + lifetime,
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

pub struct Session {
    accounts: Mutex<HashMap<String, Arc<AccountSession>>>,
    queue: queue::Queue,
}

impl Default for Session {
    fn default() -> Self {
        Session {
            accounts: Mutex::default(),
            queue: queue::Queue::new(Arc::new(|session, account, job| {
                Box::pin(async move { send_job(&session, &account, &job).await })
            })),
        }
    }
}

/// A fresh access token for a registered account's stored grant.
async fn refresh_grant(account: String) -> Result<Value, &'static str> {
    let (client, refresh) = tokio::task::spawn_blocking(move || {
        let client = gmail_credentials::read_for_account(&account)?;
        let refresh = gmail_credentials::lookup_refresh_token(&client, &account)?;
        Ok::<_, &'static str>((client, refresh))
    })
    .await
    .map_err(|_| "session_failed")??;
    gmail_http::refresh(&client.client_id, &client.client_secret, &refresh).await
}

/// One queued send: token, quota turn, the round trip, and one fresh grant
/// after a 401 — a refused request never ran, so resending cannot double it.
async fn send_job(
    session: &AccountSession,
    account: &str,
    job: &queue::Job,
) -> Result<Value, &'static str> {
    let path: Vec<&str> = job.path.iter().map(String::as_str).collect();
    let mut token = session
        .token_with(|| refresh_grant(account.to_owned()))
        .await?;
    for retry in [true, false] {
        session.pace_within(job.cost, Duration::MAX).await?;
        session.check()?;
        let answer =
            gmail_http::write(job.http.clone(), &path, job.body.as_ref(), &token.value).await;
        session.check()?;
        if answer != Err("gmail_unauthorized") {
            return answer;
        }
        session.reject(&token).await?;
        if retry {
            token = session
                .token_with(|| refresh_grant(account.to_owned()))
                .await?;
        }
    }
    Err("gmail_unauthorized")
}

fn field<'a>(params: &'a Value, key: &str, required: bool) -> Result<&'a str, &'static str> {
    let value = match params.get(key) {
        Some(Value::String(value)) => value.as_str(),
        None if !required => "",
        _ => return Err("invalid_params"),
    };
    validate_field(value, required)?;
    Ok(value)
}

fn validate_field(value: &str, required: bool) -> Result<(), &'static str> {
    if value.len() > 8192
        || value.chars().any(char::is_control)
        || (required && value.trim().is_empty())
    {
        return Err("invalid_params");
    }
    Ok(())
}

/// Quota units Google charges per call, from the Gmail API usage limits.
fn quota_cost(method: &str) -> u32 {
    match method {
        "gmail.labels" | "gmail.labelCounts" | "gmail.profile" => 1,
        "gmail.batchModify" => 50,
        "gmail.send" => 100,
        "gmail.saveDraft" | "gmail.deleteDraft" => 10,
        "gmail.updateDraft" => 15,
        _ => 5,
    }
}

pub(crate) fn validate_message_id(id: &str) -> Result<(), &'static str> {
    validate_field(id, true)?;
    super::gmail_http::validate_path_part(id).map_err(|_| "invalid_params")
}

impl Session {
    /// Internal, read-only thread context. Never accepts a caller-selected URL.
    pub(crate) async fn thread_resources(
        &self,
        account: &str,
        id: &str,
    ) -> Result<Vec<Value>, &'static str> {
        if id.is_empty()
            || id.len() > 256
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("invalid_params");
        }
        let accounts = tokio::task::spawn_blocking(crate::account::list_readonly)
            .await
            .map_err(|_| "session_failed")??;
        if !accounts["accounts"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|a| a["id"] == account && a["provider"] == "gmail")
        }) {
            return Err("gmail_account_unknown");
        }
        self.account(account)?.pace(10).await?;
        let answer = self
            .get_with(
                account,
                || refresh_grant(account.to_owned()),
                |token| async move {
                    gmail_http::get(
                        &["threads", id],
                        &[("format".into(), "full".into())],
                        &token,
                    )
                    .await
                },
            )
            .await?;
        let rows = answer["messages"]
            .as_array()
            .filter(|rows| rows.len() <= 100)
            .ok_or("agent_context_too_large")?;
        Ok(rows
            .iter()
            .cloned()
            .map(|row| resources::normalize("gmail.read", row))
            .collect())
    }
    fn account(&self, account: &str) -> Result<Arc<AccountSession>, &'static str> {
        let mut accounts = self.accounts.lock().map_err(|_| "session_failed")?;
        if let Some(session) = accounts.get(account) {
            return Ok(Arc::clone(session));
        }
        if accounts.len() >= 32 {
            accounts.retain(|_, session| {
                Arc::strong_count(session) > 1
                    || session.token.try_lock().map_or(true, |token| {
                        token.as_ref().is_some_and(|token| token.fresh())
                    })
            });
        }
        if accounts.len() >= 32 {
            return Err("gmail_session_limit");
        }
        let session = Arc::new(AccountSession::new());
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
        let token = session.token_with(|| refresh_grant(account)).await?;
        session.check()?;
        Ok(token.value.clone())
    }

    /// Settlements of queued mutations, as `gmail.settled` notifications.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Value> {
        self.queue.subscribe()
    }

    pub fn shutdown(&self) {
        self.queue.shutdown();
    }

    /// The RPC surface: a message mutation answers with a ticket at once.
    /// The in-process surface: a message mutation answers when it has landed.
    pub async fn call_settled(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        if !queue::queued(method) {
            return self.call(method, params).await;
        }
        self.note_write(params);
        let (_, outcome) = self.enqueue_write(method, params).await?;
        outcome.await.map_err(|_| "gmail_queue_dropped")?
    }

    pub async fn call(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        if queue::queued(method) || writes::supports(method) {
            self.note_write(params);
        }
        if queue::queued(method) {
            let (ticket, _outcome) = self.enqueue_write(method, params).await?;
            return Ok(json!({"queued":true,"ticket":ticket.to_string()}));
        }
        if writes::supports(method) {
            return self.write_call(method, params).await;
        }
        let allowed: &[&str] = match method {
            "gmail.invalidate" => &["accountId"],
            "gmail.labels" | "gmail.profile" | "gmail.sendAs" => &["accountId"],
            "gmail.labelCounts" => &["accountId", "id"],
            "gmail.list" => &["accountId", "query", "pageSize", "pageToken", "threads"],
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
            self.queue.invalidate(&account);
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
                let by_thread = match params.get("threads") {
                    None => false,
                    Some(Value::Bool(v)) => *v,
                    _ => return Err("invalid_params"),
                };
                if by_thread && threads::applies(field(params, "query", false)?) {
                    vec!["threads"]
                } else {
                    vec!["messages"]
                }
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
                    for header in SUMMARY_HEADERS {
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
        let accounts = tokio::task::spawn_blocking(crate::account::list_readonly)
            .await
            .map_err(|_| "session_failed")??;
        if !accounts["accounts"].as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|a| a["id"] == account && a["provider"] == "gmail")
        }) {
            return Err("gmail_account_unknown");
        }
        if method == "gmail.read"
            && params.get("full") == Some(&Value::Bool(false))
            && let Some(answer) = self
                .remembered_read(&account, field(params, "id", true)?)
                .await
        {
            return Ok(answer);
        }
        // Gmail bills a thread listing at twice a message listing.
        let cost = if path == ["threads"] {
            10
        } else {
            quota_cost(method)
        };
        self.account(&account)?.pace(cost).await?;
        let answer = self
            .get_with(
                &account,
                || refresh_grant(account.clone()),
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
        if path == ["threads"] {
            return self
                .conversation_page(&account, field(params, "query", false)?.trim(), answer)
                .await;
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

    /// One page of conversations: each listed thread read with its summary
    /// headers, in parallel, then answered in the shape of a message page whose
    /// ids are the representatives, so every caller of `gmail.list` reads it
    /// unchanged. The representatives' metadata is kept for their reads, which
    /// therefore cost nothing more. A thread that can no longer be read (purged
    /// between the two calls, say) is left out rather than failing the page.
    async fn conversation_page(
        &self,
        account: &str,
        query: &str,
        answer: Value,
    ) -> Result<Value, &'static str> {
        let listed: Vec<String> = match answer.get("threads") {
            None => Vec::new(),
            Some(Value::Array(values)) => values
                .iter()
                .map(|t| {
                    t["id"]
                        .as_str()
                        .filter(|id| gmail_http::validate_path_part(id).is_ok())
                        .map(str::to_owned)
                        .ok_or("gmail_invalid_response")
                })
                .collect::<Result<_, _>>()?,
            _ => return Err("gmail_invalid_response"),
        };
        let reads = listed.iter().map(|id| self.thread_metadata(account, id));
        let mut read = Vec::new();
        let mut failure = None;
        for result in futures_util::future::join_all(reads).await {
            match result {
                Ok(thread) => read.push(thread),
                Err(error) => failure = failure.or(Some(error)),
            }
        }
        if read.is_empty()
            && let Some(error) = failure
        {
            return Err(error);
        }
        let mut ids = Vec::new();
        let mut thread_ids = Vec::new();
        let mut rows = Vec::new();
        for thread in &read {
            let Some((representative, block)) = threads::block(thread, query) else {
                continue;
            };
            let Some((payload, _)) = threads::member(thread, query, &representative) else {
                continue;
            };
            ids.push(representative.clone());
            thread_ids.push(block["id"].clone());
            rows.push((representative, block, payload));
        }
        let now = Instant::now();
        let thread_of = |block: &Value| block["id"].as_str().unwrap_or("").to_owned();
        self.remember(
            account,
            rows.into_iter()
                .map(|(id, block, payload)| {
                    let thread = thread_of(&block);
                    (
                        id,
                        Remembered {
                            at: now,
                            thread,
                            query: query.to_owned(),
                            block,
                            payload,
                        },
                    )
                })
                .collect(),
        )?;
        Ok(json!({
            "ids": ids,
            "threadIds": thread_ids,
            "nextPageToken": answer["nextPageToken"].as_str().unwrap_or(""),
            "estimate": answer["resultSizeEstimate"].as_u64().unwrap_or(0),
        }))
    }

    async fn thread_metadata(&self, account: &str, id: &str) -> Result<Value, &'static str> {
        self.account(account)?.pace(10).await?;
        let mut query: Vec<(String, String)> = vec![("format".into(), "metadata".into())];
        for header in SUMMARY_HEADERS {
            query.push(("metadataHeaders".into(), header.into()));
        }
        self.get_with(
            account,
            || refresh_grant(account.to_owned()),
            |token| {
                let query = &query;
                async move { gmail_http::get(&["threads", id], query, &token).await }
            },
        )
        .await
    }

    /// Keeps listed rows, dropping expired ones first and then the oldest, so
    /// a listing never takes away the rows another listing is still reading.
    fn remember(&self, account: &str, rows: Vec<(String, Remembered)>) -> Result<(), &'static str> {
        let session = self.account(account)?;
        let mut known = session.blocks.lock().map_err(|_| "session_failed")?;
        known.retain(|_, row| row.at.elapsed() < BLOCK_TTL);
        let room = MAX_BLOCKS.saturating_sub(rows.len().min(MAX_BLOCKS));
        if known.len() > room {
            let mut ages: Vec<(Instant, String)> =
                known.iter().map(|(id, row)| (row.at, id.clone())).collect();
            ages.sort();
            for (_, id) in ages.into_iter().take(known.len() - room) {
                known.remove(&id);
            }
        }
        known.extend(rows.into_iter().take(MAX_BLOCKS));
        Ok(())
    }

    fn note_write(&self, params: &Value) {
        let Ok(account) = field(params, "accountId", true) else {
            return;
        };
        if let Ok(session) = self.account(&account.to_lowercase())
            && let Ok(mut written) = session.written.lock()
        {
            *written = Some(Instant::now());
        }
    }

    /// A listed row's metadata read: kept from the listing while nothing was
    /// written since, otherwise the thread is read again so the labels and the
    /// conversation are current. `None` for a message no listing remembers.
    async fn remembered_read(&self, account: &str, id: &str) -> Option<Value> {
        let session = self.account(account).ok()?;
        let (fresh, thread, query, answer) = {
            let known = session.blocks.lock().ok()?;
            let row = known.get(id)?;
            let written = *session.written.lock().ok()?;
            let fresh = row.at.elapsed() < BLOCK_TTL && written.is_none_or(|at| at < row.at);
            let mut answer = row.payload.clone();
            answer["thread"] = row.block.clone();
            (fresh, row.thread.clone(), row.query.clone(), answer)
        };
        if fresh {
            return Some(answer);
        }
        let reread = self.thread_metadata(account, &thread).await.ok();
        let current = reread.as_ref().and_then(|t| threads::member(t, &query, id));
        let mut known = session.blocks.lock().ok()?;
        let Some((payload, block)) = current else {
            known.remove(id);
            return None;
        };
        let mut answer = payload.clone();
        answer["thread"] = block.clone();
        known.insert(
            id.to_owned(),
            Remembered {
                at: Instant::now(),
                thread,
                query,
                block,
                payload,
            },
        );
        Some(answer)
    }
}
