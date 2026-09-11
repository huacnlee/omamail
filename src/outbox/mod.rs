//! Durable delayed sends. Every delivery is attempted once, in account order.
//! A restart never resumes a send: queued mail is recoverable and an interrupted
//! delivery is unknown, because a lost acknowledgement cannot prove non-delivery.
use futures_util::{FutureExt, future::BoxFuture};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Notify, broadcast};
pub mod delivery;
mod storage;
#[cfg(test)]
mod tests;
pub type Executor =
    Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Value, &'static str>> + Send + Sync>;
static SERIAL: AtomicU64 = AtomicU64::new(0);
const MAX_ENTRIES: usize = 65536;
const MAX_RECOVERABLE: usize = 128;
struct State {
    entries: Vec<Value>,
    loaded: bool,
    workers: HashSet<String>,
    revision: u64,
}
struct Inner {
    state: tokio::sync::Mutex<State>,
    executor: Executor,
    events: broadcast::Sender<Value>,
    wake: Notify,
    stopping: AtomicBool,
    root: Option<PathBuf>,
    lease: Mutex<Option<Arc<std::fs::File>>>,
    writer: Arc<storage::Writer>,
}
pub struct Outbox {
    inner: Arc<Inner>,
    jobs: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 1024 && !v.chars().any(char::is_control))
        .ok_or("outbox_invalid_params")
}
fn terminal(state: &str) -> bool {
    matches!(state, "sent" | "failed" | "unknown" | "cancelled")
}
fn summary(entry: &Value, payload: bool) -> Value {
    let mut copy = entry.clone();
    if !payload {
        copy.as_object_mut().unwrap().remove("payload");
    }
    copy
}
fn snapshot(state: &State, account: &str, payload: bool) -> Value {
    json!({"accountId":account,"revision":state.revision,"entries":state.entries.iter().filter(|entry|entry["accountId"]==account&&(payload||entry["acknowledged"]!=true)).map(|entry|summary(entry,payload)).collect::<Vec<_>>()})
}
fn emit(inner: &Inner, state: &State, account: &str) {
    let _ = inner.events.send(
        json!({"jsonrpc":"2.0","method":"outbox.changed","params":snapshot(state,account,false)}),
    );
}
async fn save(inner: &Inner, entries: &[Value]) -> Result<(), &'static str> {
    let root = inner.root.clone().map(Ok).unwrap_or_else(storage::home)?;
    let value = json!(entries);
    let writer = inner.writer.clone();
    let sequence = writer.reserve();
    let lease = inner
        .lease
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or("outbox_storage_unavailable")?;
    tokio::task::spawn_blocking(move || {
        let _lease = lease;
        writer.write(sequence, &root, &value)
    })
    .await
    .map_err(|_| "outbox_storage_unavailable")?
}
async fn load(inner: &Inner, state: &mut State) -> Result<(), &'static str> {
    if state.loaded {
        return Ok(());
    }
    let root = inner.root.clone().map(Ok).unwrap_or_else(storage::home)?;
    let existing = inner
        .lease
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let (lease, value) = tokio::task::spawn_blocking(move || {
        let lease = match existing {
            Some(lease) => lease,
            None => Arc::new(storage::lease(&root)?),
        };
        let value = storage::read(&root)?;
        Ok::<_, &'static str>((lease, value))
    })
    .await
    .map_err(|_| "outbox_storage_unavailable")??;
    let entries = value
        .as_array()
        .filter(|entries| entries.len() <= MAX_ENTRIES)
        .ok_or("outbox_storage_invalid")?;
    let mut recovered = Vec::new();
    let mut ids = HashSet::new();
    for entry in entries {
        text(entry, "accountId")?;
        text(entry, "provider")?;
        let id = text(entry, "id")?;
        if !ids.insert((entry["accountId"].clone().to_string(), id.to_owned())) {
            return Err("outbox_storage_invalid");
        }
        let mut entry = entry.clone();
        if entry.get("digest").is_none()
            && let Some(payload) = entry.get("payload")
        {
            entry["digest"] = digest(payload);
        }
        if entry["state"] == "sent" {
            entry.as_object_mut().unwrap().remove("payload");
        }
        match entry["state"].as_str() {
            Some("queued") => {
                entry["state"] = json!("cancelled");
                entry["error"] = json!("outbox_recovered_unsent");
            }
            Some("sending") => {
                entry["state"] = json!("unknown");
                entry["error"] = json!("outbox_delivery_unknown");
            }
            Some(state) if terminal(state) => (),
            _ => return Err("outbox_storage_invalid"),
        }
        recovered.push(entry);
    }
    *inner.lease.lock().unwrap_or_else(|e| e.into_inner()) = Some(lease);
    save(inner, &recovered).await?;
    state.entries = recovered;
    state.loaded = true;
    Ok(())
}
impl Outbox {
    pub fn new(executor: Executor) -> Self {
        Self::with_root(executor, None)
    }
    fn with_root(executor: Executor, root: Option<PathBuf>) -> Self {
        let (events, _) = broadcast::channel(128);
        Self {
            inner: Arc::new(Inner {
                state: tokio::sync::Mutex::new(State {
                    entries: vec![],
                    loaded: false,
                    workers: HashSet::new(),
                    revision: 0,
                }),
                executor,
                events,
                wake: Notify::new(),
                stopping: AtomicBool::new(false),
                root,
                lease: Mutex::new(None),
                writer: Arc::new(storage::Writer::default()),
            }),
            jobs: Mutex::new(vec![]),
        }
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.inner.events.subscribe()
    }
    pub async fn call(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        let account = text(params, "accountId")?.to_owned();
        let fields = params.as_object().ok_or("outbox_invalid_params")?;
        let allowed: &[&str] = match method {
            "outbox.enqueue" => &[
                "accountId",
                "provider",
                "payload",
                "sendId",
                "order",
                "delaySeconds",
            ],
            "outbox.snapshot" => &["accountId", "includePayloads", "sendId"],
            "outbox.undo" | "outbox.forget" => &["accountId", "sendId"],
            "outbox.flush" | "outbox.abandon" => &["accountId"],
            _ => return Err("outbox_unknown_method"),
        };
        if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err("outbox_invalid_params");
        }
        let mut state = self.inner.state.lock().await;
        load(&self.inner, &mut state).await?;
        if method == "outbox.snapshot" {
            if params
                .get("includePayloads")
                .is_some_and(|v| !v.is_boolean())
            {
                return Err("outbox_invalid_params");
            }
            let wanted = params
                .get("sendId")
                .map(|_| text(params, "sendId"))
                .transpose()?;
            if params["includePayloads"] == true && wanted.is_none() {
                return Err("outbox_payload_id_required");
            }
            return Ok(if let Some(id) = wanted {
                json!({"accountId":account,"revision":state.revision,"entries":state.entries.iter().filter(|entry|entry["accountId"]==account&&entry["id"]==id).map(|entry|summary(entry,params["includePayloads"]==true)).collect::<Vec<_>>()})
            } else {
                snapshot(&state, &account, false)
            });
        }
        if self.inner.stopping.load(Ordering::Acquire) {
            return Err("outbox_stopping");
        }
        let mut next = state.entries.clone();
        let mut selected = String::new();
        match method {
            "outbox.enqueue" => {
                let provider = text(params, "provider")?;
                if !["gmail", "outlook", "imap", "jmap", "hey"].contains(&provider) {
                    return Err("outbox_invalid_provider");
                }
                let payload = params
                    .get("payload")
                    .filter(|value| value.is_object())
                    .ok_or("outbox_invalid_params")?;
                if payload.as_object().unwrap().keys().any(|key| {
                    !["raw", "threadId", "draftId", "attachments", "sendId"].contains(&key.as_str())
                }) {
                    return Err("outbox_invalid_payload");
                }
                if serde_json::to_vec(payload)
                    .map_err(|_| "outbox_invalid_params")?
                    .len()
                    > 48 * 1024 * 1024
                {
                    return Err("outbox_message_too_large");
                }
                let delay = match params.get("delaySeconds") {
                    None => 10,
                    Some(value) => value
                        .as_u64()
                        .filter(|v| *v <= 60)
                        .ok_or("outbox_invalid_delay")?,
                };
                let stamp = now();
                selected = match params.get("sendId") {
                    None => format!(
                        "send-{stamp}-{}-{}",
                        std::process::id(),
                        SERIAL.fetch_add(1, Ordering::Relaxed)
                    ),
                    Some(_) => text(params, "sendId")?.into(),
                };
                if let Some(existing) = next
                    .iter()
                    .find(|entry| entry["accountId"] == account && entry["id"] == selected)
                {
                    if existing["digest"] != digest(payload) || existing["provider"] != provider {
                        return Err("outbox_send_id_conflict");
                    }
                    return Ok(
                        json!({"id":selected,"duplicate":true,"snapshot":snapshot(&state,&account,false)}),
                    );
                }
                if next.len() >= MAX_ENTRIES
                    || next
                        .iter()
                        .filter(|entry| entry.get("payload").is_some())
                        .count()
                        >= MAX_RECOVERABLE
                {
                    return Err("outbox_full");
                }
                let order = params
                    .get("order")
                    .map(|v| v.as_u64().ok_or("outbox_invalid_params"))
                    .transpose()?
                    .unwrap_or(stamp);
                next.push(json!({"id":selected,"accountId":account,"provider":provider,"payload":payload,"digest":digest(payload),"state":"queued","queuedAt":stamp,"dueAt":stamp.saturating_add(delay*1000),"order":order,"draftId":payload.get("draftId").and_then(Value::as_str).unwrap_or("")}));
            }
            "outbox.undo" => {
                let wanted = params
                    .get("sendId")
                    .map(|_| text(params, "sendId"))
                    .transpose()?;
                let entry = next
                    .iter_mut()
                    .rev()
                    .find(|entry| {
                        entry["accountId"] == account
                            && entry["state"] == "queued"
                            && wanted.is_none_or(|id| entry["id"] == id)
                    })
                    .ok_or("outbox_not_queued")?;
                selected = entry["id"].as_str().unwrap().into();
                entry["state"] = json!("cancelled");
            }
            "outbox.flush" => {
                for entry in &mut next {
                    if entry["accountId"] == account && entry["state"] == "queued" {
                        entry["dueAt"] = json!(0);
                    }
                }
            }
            "outbox.abandon" => {
                for entry in &mut next {
                    if entry["accountId"] == account && entry["state"] == "queued" {
                        entry["state"] = json!("cancelled");
                    }
                }
            }
            "outbox.forget" => {
                let id = text(params, "sendId")?;
                let entry = next
                    .iter()
                    .find(|entry| entry["accountId"] == account && entry["id"] == id)
                    .ok_or("outbox_not_found")?;
                if !terminal(entry["state"].as_str().unwrap_or("")) {
                    return Err("outbox_not_finished");
                }
                let entry = next
                    .iter_mut()
                    .find(|entry| entry["accountId"] == account && entry["id"] == id)
                    .unwrap();
                entry.as_object_mut().unwrap().remove("payload");
                entry["acknowledged"] = json!(true);
            }
            _ => unreachable!(),
        }
        save(&self.inner, &next).await?;
        state.entries = next;
        state.revision += 1;
        emit(&self.inner, &state, &account);
        if state
            .entries
            .iter()
            .any(|entry| entry["accountId"] == account && entry["state"] == "queued")
            && state.workers.insert(account.clone())
        {
            let inner = self.inner.clone();
            let worker_account = account.clone();
            let job = tokio::spawn(async move {
                worker(inner, worker_account).await;
            });
            let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
            jobs.retain(|job| !job.is_finished());
            jobs.push(job);
        }
        self.inner.wake.notify_waiters();
        Ok(json!({"id":selected,"snapshot":snapshot(&state,&account,false)}))
    }
    pub async fn shutdown(&self) -> Result<(), &'static str> {
        self.inner.stopping.store(true, Ordering::Release);
        self.inner.wake.notify_waiters();
        let jobs = std::mem::take(&mut *self.jobs.lock().unwrap_or_else(|e| e.into_inner()));
        for job in jobs {
            job.abort();
            let _ = job.await;
        }
        let mut state = self.inner.state.lock().await;
        if !state.loaded {
            return Ok(());
        }
        for entry in &mut state.entries {
            if entry["state"] == "queued" {
                entry["state"] = json!("cancelled");
                entry["error"] = json!("outbox_stopped_unsent");
            } else if entry["state"] == "sending" {
                entry["state"] = json!("unknown");
                entry["error"] = json!("outbox_delivery_unknown");
            }
        }
        save(&self.inner, &state.entries).await
    }
}
impl Drop for Outbox {
    fn drop(&mut self) {
        self.inner.stopping.store(true, Ordering::Release);
        self.inner.wake.notify_waiters();
        for job in self
            .jobs
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
        {
            job.abort();
        }
    }
}
async fn worker(inner: Arc<Inner>, account: String) {
    loop {
        // Register before reading state so a concurrent undo/flush cannot lose a wake.
        let notified = inner.wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let mut state = inner.state.lock().await;
        if inner.stopping.load(Ordering::Acquire) {
            state.workers.remove(&account);
            return;
        }
        let Some(index) = state
            .entries
            .iter()
            .position(|entry| entry["accountId"] == account && entry["state"] == "queued")
        else {
            state.workers.remove(&account);
            return;
        };
        let due = state.entries[index]["dueAt"].as_u64().unwrap_or(0);
        if due > now() {
            let delay = Duration::from_millis(due.saturating_sub(now()).min(60000));
            drop(state);
            tokio::select! {_=tokio::time::sleep(delay)=>(),_=&mut notified=>()};
            continue;
        }
        let mut next = state.entries.clone();
        next[index]["state"] = json!("sending");
        if save(&inner, &next).await.is_err() {
            state.entries[index]["state"] = json!("failed");
            state.entries[index]["error"] = json!("outbox_storage_unavailable");
            state.revision += 1;
            emit(&inner, &state, &account);
            state.workers.remove(&account);
            return;
        }
        state.entries = next;
        state.revision += 1;
        let entry = state.entries[index].clone();
        emit(&inner, &state, &account);
        drop(state);
        let request = json!({"accountId":account,"provider":entry["provider"],"payload":entry["payload"],"sendId":entry["id"]});
        let delivery = std::panic::AssertUnwindSafe((inner.executor)(request)).catch_unwind();
        let result = tokio::time::timeout(Duration::from_secs(60), async {
            delivery.await.unwrap_or(Err("outbox_delivery_unknown"))
        })
        .await;
        let mut state = inner.state.lock().await;
        let Some(index) = state
            .entries
            .iter()
            .position(|current| current["accountId"] == account && current["id"] == entry["id"])
        else {
            continue;
        };
        match result {
            Ok(Ok(answer)) => {
                state.entries[index]["state"] = json!("sent");
                state.entries[index]
                    .as_object_mut()
                    .unwrap()
                    .remove("payload");
                state.entries[index]["result"] = delivery_result(&answer);
            }
            Ok(Err(error)) if definitely_refused(error) => {
                state.entries[index]["state"] = json!("failed");
                state.entries[index]["error"] = json!("outbox_send_refused");
            }
            _ => {
                state.entries[index]["state"] = json!("unknown");
                state.entries[index]["error"] = json!("outbox_delivery_unknown");
            }
        }
        // If this write fails, disk still says sending and restart recovers unknown.
        // No retry is safe, regardless of whether the acknowledgement was received.
        state.revision += 1;
        let _ = save(&inner, &state.entries).await;
        emit(&inner, &state, &account);
    }
}
fn definitely_refused(error: &str) -> bool {
    matches!(
        error,
        "invalid_params"
            | "outbox_invalid_provider"
            | "outbox_account_unavailable"
            | "outbox_invalid_payload"
            | "gmail_auth_required"
            | "gmail_invalid_params"
            | "gmail_send_rejected"
            | "jmap_send_rejected"
            | "smtp_recipient_refused"
    )
}

fn delivery_result(answer: &Value) -> Value {
    let mut result = json!({});
    for key in ["id", "threadId", "draftId"] {
        if let Some(value) = answer
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| v.len() <= 1024 && !v.chars().any(char::is_control))
        {
            result[key] = json!(value);
        }
    }
    if answer["draftRemoved"] == true {
        result["draftRemoved"] = json!(true);
    }
    if answer
        .get("warning")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
    {
        result["warning"] = json!("Sent, but a follow-up operation failed");
    }
    result
}

fn digest(value: &Value) -> Value {
    use sha2::{Digest, Sha256};
    json!(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).unwrap_or_default())
    ))
}
