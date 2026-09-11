//! Session-owned query cache. Only presentation snapshots cross to the UI.
use super::*;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex as AsyncMutex;
const MAX_ACCOUNTS: usize = 16;
const MAX_STORE_BYTES: usize = 4 * 1024 * 1024;
#[derive(Default)]
pub struct QueryCache {
    root: Option<PathBuf>,
    accounts: AsyncMutex<HashMap<String, Arc<AsyncMutex<State>>>>,
    serial: AtomicU64,
}
struct State {
    store: Value,
    generation: u64,
    loaded: bool,
    dirty: bool,
    saving: bool,
    touched: u64,
}
impl Default for State {
    fn default() -> Self {
        Self {
            store: store::empty(),
            generation: 0,
            loaded: false,
            dirty: false,
            saving: false,
            touched: 0,
        }
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn metadata(value: &Value) -> Value {
    json!({"version":2,"account":value["account"],"profile":value["profile"],"labels":value["labels"],"session":value["session"]})
}
pub fn query_key(query: &str, limit: u64) -> String {
    format!("{}|{}", query.trim(), limit.max(1))
}
fn key(params: &Value) -> Result<String> {
    if let Some(key) = params["key"].as_str() {
        if key.len() > 32768 {
            return Err("cache_invalid_input");
        }
        return Ok(key.into());
    }
    let query = params["query"].as_str().unwrap_or("");
    if query.len() > 32768 {
        return Err("cache_invalid_input");
    }
    Ok(query_key(query, params["limit"].as_u64().unwrap_or(25)))
}
fn source_query(key: &str) -> &str {
    match key.rsplit_once('|') {
        Some((query, limit)) if !limit.is_empty() && limit.bytes().all(|b| b.is_ascii_digit()) => {
            query
        }
        _ => key,
    }
}
fn terms(query: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    for c in query.trim().to_lowercase().chars() {
        if c == '"' {
            quoted = !quoted
        } else if c.is_whitespace() && !quoted {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word))
            }
        } else {
            word.push(c)
        }
    }
    if !word.is_empty() {
        out.push(word)
    }
    if out.iter().any(|s| s.starts_with('-') || s.contains(':')) {
        vec![]
    } else {
        out
    }
}
fn address(value: &Value) -> String {
    ["display", "name", "email"]
        .iter()
        .filter_map(|key| value[*key].as_str())
        .collect::<Vec<_>>()
        .join(" ")
}
fn matches(row: &Value, terms: &[String]) -> bool {
    let mut text = address(&row["from"]);
    for field in ["to", "cc"] {
        if let Some(list) = row[field].as_array() {
            for item in list {
                text.push(' ');
                text.push_str(&address(item));
            }
        }
    }
    for field in ["subject", "snippet"] {
        text.push(' ');
        text.push_str(row[field].as_str().unwrap_or(""));
    }
    let text = text.to_lowercase();
    terms.iter().all(|term| text.contains(term))
}
fn eligible(provider: &str, query: &str, row: &Value) -> bool {
    if matches!(provider, "imap" | "outlook") {
        let source = query.trim();
        let Some(rest) = source.strip_prefix("folder:") else {
            return true;
        };
        let folder = if let Some(quoted) = rest.strip_prefix('"') {
            let mut name = String::new();
            let mut escaped = false;
            for ch in quoted.chars() {
                if escaped {
                    name.push(ch);
                    escaped = false
                } else if ch == '\\' {
                    escaped = true
                } else if ch == '"' {
                    break;
                } else {
                    name.push(ch)
                }
            }
            name
        } else {
            rest.split_whitespace().next().unwrap_or("").to_owned()
        };
        return folder.eq_ignore_ascii_case("INBOX");
    }
    if provider == "hey" {
        return true;
    }
    if !matches!(provider, "gmail" | "jmap") {
        return false;
    }
    if row["labelIds"].as_array().is_some_and(|labels| {
        labels.iter().any(|l| {
            l.as_str()
                .is_some_and(|l| l.eq_ignore_ascii_case("SPAM") || l.eq_ignore_ascii_case("TRASH"))
        })
    }) {
        return false;
    }
    let source = query.to_lowercase();
    !source.split_whitespace().any(|term| {
        if provider == "gmail" {
            matches!(term, "in:spam" | "in:trash")
        } else {
            matches!(term, "role:junk" | "role:trash")
        }
    })
}
fn stale(stamp: f64, now: f64, ttl: f64) -> bool {
    stamp <= 0.0 || now - stamp > ttl.max(0.0)
}
fn date(row: &Value) -> i64 {
    row["dateMs"].as_i64().unwrap_or(0)
}
fn search(value: &Value, query: &str, provider: &str) -> Vec<Value> {
    let wanted = terms(query);
    if wanted.is_empty() {
        return vec![];
    }
    let Some(queries) = value["queries"].as_object() else {
        return vec![];
    };
    let mut queries: Vec<_> = queries.iter().collect();
    queries.sort_by(|a, b| {
        b.1["at"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a.1["at"].as_f64().unwrap_or(0.0))
    });
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut rows: Vec<(Value, bool, bool)> = Vec::new();
    for (key, page) in queries {
        if let Some(entries) = page["summaries"].as_array() {
            for row in entries {
                let Some(id) = row["id"].as_str().filter(|id| !id.is_empty()) else {
                    continue;
                };
                let index = if let Some(index) = seen.get(id) {
                    *index
                } else {
                    let index = rows.len();
                    seen.insert(id.into(), index);
                    rows.push((
                        row.clone(),
                        eligible(provider, source_query(key), row),
                        false,
                    ));
                    index
                };
                if rows[index].1 && matches(row, &wanted) {
                    rows[index].2 = true;
                }
            }
        }
    }
    let mut found: Vec<_> = rows.into_iter().filter(|r| r.2).map(|r| r.0).collect();
    found.sort_by_key(|row| std::cmp::Reverse(date(row)));
    found
}
fn merge(exact: &Value, local: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut positions = HashMap::new();
    for row in exact.as_array().into_iter().flatten().chain(local.iter()) {
        let Some(id) = row["id"].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        if let Some(index) = positions.get(id) {
            out[*index] = row.clone()
        } else {
            positions.insert(id.to_owned(), out.len());
            out.push(row.clone());
        }
    }
    out.sort_by_key(|row| std::cmp::Reverse(date(row)));
    out
}
fn page(page: &Value, stamp: u64) -> Value {
    let source = page["summaries"].as_array().cloned().unwrap_or_default();
    let summaries: Vec<_> = source
        .iter()
        .take(100)
        .filter(|row| row.is_object())
        .map(|row| {
            let mut row = row.clone();
            if row.get("dateMs").is_none() {
                let ms = row["date"].as_i64().or_else(|| {
                    row["date"]
                        .as_str()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|d| d.timestamp_millis())
                });
                row["dateMs"] = json!(ms);
            }
            row.as_object_mut().unwrap().remove("date");
            row
        })
        .collect();
    json!({"summaries":summaries,"estimate":page["estimate"].as_f64().unwrap_or(0.0).floor().max(0.0),"nextPageToken":if source.len()>100{""}else{page["nextPageToken"].as_str().unwrap_or("")},"at":stamp})
}
impl QueryCache {
    #[cfg(test)]
    pub(crate) fn at(root: PathBuf) -> Self {
        Self {
            root: Some(root),
            ..Default::default()
        }
    }

    /// Flush accepted mutations after RPC and background producers have stopped.
    pub async fn shutdown(&self) -> Result<()> {
        let accounts: Vec<_> = self
            .accounts
            .lock()
            .await
            .iter()
            .map(|(account, state)| (account.clone(), state.clone()))
            .collect();
        let mut failure = None;
        for (account, state) in accounts {
            if let Err(error) = persist(self.root.clone(), &account, &mut *state.lock().await).await
            {
                failure = Some(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    /// Background population does not rotate the UI's account generation.
    pub async fn prefetch(
        &self,
        account: &str,
        query: &str,
        limit: u64,
        value: &Value,
        live: Arc<Mutex<bool>>,
    ) -> Result<()> {
        let params = json!({"accountId":account,"query":query,"limit":limit});
        validate_params(&params, false)?;
        let key = key(&params)?;
        let account = account.to_lowercase();
        let shared = self.account(&account).await?;
        let mut state = shared.lock().await;
        if !state.loaded {
            let p = json!({"accountId":account});
            let root = self.root.clone();
            state.store = tokio::task::spawn_blocking(move || disk(root, "cache.storeRead", &p))
                .await
                .map_err(|_| "cache_unavailable")?
                .unwrap_or_else(|_| store::empty());
            let expected = account
                .split_once(':')
                .map(|(_, email)| email)
                .unwrap_or(&account);
            if state.store["account"]
                .as_str()
                .is_some_and(|stored| !stored.is_empty() && !stored.eq_ignore_ascii_case(expected))
            {
                state.store = store::empty();
            }
            state.loaded = true;
        }
        if !*live.lock().map_err(|_| "cache_unavailable")? {
            return Err("cache_cancelled");
        }
        let mut next = state.store.clone();
        next["queries"][key] = page(value, now());
        next = store::normalize_store(&next);
        if serde_json::to_vec(&next)
            .map_err(|_| "cache_invalid_input")?
            .len()
            > MAX_STORE_BYTES
        {
            return Err("cache_store_too_large");
        }
        // A background snapshot cannot join the UI debounce: that timer can
        // outlive its watch, or carry cancelled data into an unrelated UI save.
        // Hold the same cancellation mutex through the actual atomic disk
        // commit, then publish only the successfully committed snapshot.
        let p = json!({"accountId":account,"store":next});
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            let guard = live.lock().map_err(|_| "cache_unavailable")?;
            if !*guard {
                return Err("cache_cancelled");
            }
            disk(root, "cache.storePut", &p).map(|_| ())
        })
        .await
        .map_err(|_| "cache_unavailable")??;
        state.store = next;
        state.dirty = false;
        state.touched = now();
        Ok(())
    }
    async fn account(&self, account: &str) -> Result<Arc<AsyncMutex<State>>> {
        let mut map = self.accounts.lock().await;
        if let Some(state) = map.get(account) {
            return Ok(state.clone());
        }
        if map.len() >= MAX_ACCOUNTS {
            let mut oldest = None;
            for (key, state) in map.iter() {
                if Arc::strong_count(state) == 1
                    && let Ok(state) = state.try_lock()
                    && !state.dirty
                    && !state.saving
                    && oldest.as_ref().is_none_or(|(_, at)| state.touched < *at)
                {
                    oldest = Some((key.clone(), state.touched));
                }
            }
            if let Some((key, _)) = oldest {
                map.remove(&key);
            } else {
                return Err("cache_busy");
            }
        }
        let state = Arc::new(AsyncMutex::new(State::default()));
        map.insert(account.into(), state.clone());
        Ok(state)
    }
    pub async fn call(&self, method: &str, params: &Value) -> Result<Value> {
        validate_params(params, false)?;
        let account = field(params, "accountId")?.to_lowercase();
        let shared = self.account(&account).await?;
        let mut state = shared.lock().await;
        state.touched = now();
        if method == "cache.queryRestore" {
            if !state.loaded {
                let p = json!({"accountId":account});
                let root = self.root.clone();
                state.store =
                    match tokio::task::spawn_blocking(move || disk(root, "cache.storeRead", &p))
                        .await
                    {
                        Ok(Ok(value)) => value,
                        _ => store::empty(),
                    };
                let expected = account
                    .split_once(':')
                    .map(|(_, email)| email)
                    .unwrap_or(&account);
                let stored = state.store["account"].as_str().unwrap_or("");
                if !stored.is_empty() && !stored.eq_ignore_ascii_case(expected) {
                    state.store = store::empty();
                }
                state.loaded = true;
            }
            state.generation = self.serial.fetch_add(1, Ordering::Relaxed) + 1;
            return Ok(json!({"generation":state.generation,"store":metadata(&state.store)}));
        }
        if !state.loaded || params["generation"].as_u64() != Some(state.generation) {
            return Err("cache_stale_generation");
        }
        if method == "cache.queryGet" {
            let key = key(params)?;
            let entry = state.store["queries"]
                .get(&key)
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or(Value::Null);
            let provider = if account.starts_with("imap:") {
                "imap"
            } else if account.starts_with("outlook:") {
                "outlook"
            } else if account.starts_with("jmap:") {
                "jmap"
            } else if account.starts_with("hey:") {
                "hey"
            } else {
                "gmail"
            };
            let local = search(
                &state.store,
                params["search"].as_str().unwrap_or(""),
                provider,
            );
            let stamp = entry["at"].as_f64().unwrap_or(0.0);
            let ttl = params["ttlMs"].as_f64().unwrap_or(300000.0).max(0.0);
            return Ok(
                json!({"key":key,"entry":entry,"summaries":merge(&entry["summaries"],&local),"local":local,"stale":stale(stamp,now() as f64,ttl)}),
            );
        }
        if method == "cache.querySnapshot" {
            return Ok(json!({"generation":state.generation,"store":state.store}));
        }
        if method == "cache.querySessionGet" {
            let entry = &state.store["session"];
            return Ok(
                if entry["url"] == params["url"] && entry["session"].is_object() {
                    entry.clone()
                } else {
                    Value::Null
                },
            );
        }
        if method == "cache.queryFlush" {
            persist(self.root.clone(), &account, &mut state).await?;
            return Ok(json!({"stored":true}));
        }
        let mut next = state.store.clone();
        let result = match method {
            "cache.queryPut" => {
                let key = key(params)?;
                let entry = page(&params["page"], now());
                next["queries"][&key] = entry.clone();
                json!({"key":key,"entry":entry})
            }
            "cache.queryLabels" => {
                next["labels"] = params["labels"]
                    .as_array()
                    .cloned()
                    .map(Value::Array)
                    .unwrap_or(json!([]));
                json!({"labels":next["labels"]})
            }
            "cache.queryProfile" => {
                next["profile"] = if params["profile"].is_object() {
                    params["profile"].clone()
                } else {
                    Value::Null
                };
                if let Some(email) = next["profile"]["email"].as_str().filter(|s| !s.is_empty()) {
                    next["account"] = json!(email)
                }
                json!({"profile":next["profile"],"account":next["account"]})
            }
            "cache.querySession" => {
                next["session"] = if params["session"].is_object() {
                    json!({"url":params["url"].as_str().unwrap_or(""),"state":params["state"].as_str().unwrap_or(""),"session":params["session"],"at":now()})
                } else {
                    Value::Null
                };
                json!({"session":next["session"]})
            }
            "cache.queryBind" => {
                let email = params["email"].as_str().unwrap_or("");
                if !email.is_empty() {
                    let current = next["account"].as_str().unwrap_or("");
                    if !current.is_empty() && !current.eq_ignore_ascii_case(email) {
                        next = store::empty();
                    }
                    next["account"] = json!(email)
                }
                json!({"store":metadata(&next)})
            }
            "cache.queryClear" => {
                next = store::empty();
                json!({"store":metadata(&next)})
            }
            "cache.queryInvalidate" => {
                let ids = params["ids"]
                    .as_array()
                    .ok_or("cache_invalid_input")?
                    .iter()
                    .map(|id| {
                        id.as_str()
                            .filter(|id| !id.is_empty())
                            .ok_or("cache_invalid_input")
                    })
                    .collect::<Result<HashSet<_>>>()?;
                let entries = next["queries"]
                    .as_object_mut()
                    .ok_or("cache_invalid_input")?;
                entries.retain(|_, page| {
                    !ids.is_empty()
                        && !page["summaries"].as_array().is_some_and(|rows| {
                            rows.iter()
                                .any(|row| row["id"].as_str().is_some_and(|id| ids.contains(id)))
                        })
                });
                json!({"invalidated":true})
            }
            _ => return Err("method_not_found"),
        };
        next = store::normalize_store(&next);
        if serde_json::to_vec(&next)
            .map_err(|_| "cache_invalid_input")?
            .len()
            > MAX_STORE_BYTES
        {
            return Err("cache_store_too_large");
        }
        state.store = next;
        state.dirty = true;
        if !state.saving {
            state.saving = true;
            let entry = shared.clone();
            let account = account.clone();
            let root = self.root.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(800)).await;
                let mut state = entry.lock().await;
                let _ = persist(root, &account, &mut state).await;
                state.saving = false;
            });
        }
        Ok(result)
    }
}
fn disk(root: Option<PathBuf>, method: &str, params: &Value) -> Result<Value> {
    if let Some(root) = root {
        super::call_at(&root, method, params)
    } else {
        super::call(method, params)
    }
}
async fn persist(root: Option<PathBuf>, account: &str, state: &mut State) -> Result<()> {
    if !state.dirty {
        return Ok(());
    }
    let p = json!({"accountId":account,"store":state.store});
    tokio::task::spawn_blocking(move || disk(root, "cache.storePut", &p))
        .await
        .map_err(|_| "cache_unavailable")??;
    state.dirty = false;
    Ok(())
}
#[cfg(test)]
mod tests;
