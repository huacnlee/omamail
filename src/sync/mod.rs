//! Background mailbox reads. Each account has one cancellable check loop.
mod preload;
use futures_util::future::{BoxFuture, try_join_all};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{Notify, broadcast},
    task::JoinHandle,
};

pub(crate) type Check = Arc<
    dyn Fn(String, String) -> BoxFuture<'static, Result<Value, &'static str>>
        + Send
        + std::marker::Sync,
>;

#[derive(Clone)]
pub(crate) struct Event {
    account: String,
    generation: u64,
    pub value: Value,
}

struct Watch {
    generation: u64,
    query: String,
    interval: u64,
    page_size: u64,
    preload: Option<preload::Job>,
    snapshot: Value,
    trigger: Arc<Notify>,
    checking: bool,
    task: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct State {
    watches: HashMap<String, Watch>,
    sequence: u64,
    generation: u64,
}

struct Inner {
    state: Mutex<State>,
    operations: tokio::sync::Mutex<()>,
    events: broadcast::Sender<Event>,
    check: Check,
    warm: Option<preload::Warm>,
    registry_task: Mutex<Option<JoinHandle<()>>>,
}

pub struct Sync {
    inner: Arc<Inner>,
    watch_registry: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WatchParams {
    account_id: String,
    query: String,
    interval_sec: u64,
    #[serde(default = "default_page_size")]
    page_size: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AccountParams {
    account_id: String,
}

fn default_page_size() -> u64 {
    25
}

fn account_id(value: &str) -> Result<String, &'static str> {
    if value.trim().is_empty() || value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("invalid_params");
    }
    Ok(value.to_lowercase())
}

impl Sync {
    pub fn new(
        gmail: Arc<crate::providers::gmail::Session>,
        jmap: Arc<crate::providers::jmap::Session>,
        queries: Arc<crate::cache::query::QueryCache>,
    ) -> Self {
        let warm = preload::production(gmail.clone(), jmap.clone(), queries);
        let mut sync = Self::with_checker(Arc::new(move |account, query| {
            let gmail = gmail.clone();
            let jmap = jmap.clone();
            Box::pin(async move {
                if account.starts_with("jmap:") {
                    return jmap.check(&account).await;
                }
                if account.starts_with("imap:") || account.starts_with("outlook:") {
                    let oauth = account.starts_with("outlook:");
                    let provider = if oauth { "outlook" } else { "imap" };
                    let id = account.clone();
                    let entry =
                        tokio::task::spawn_blocking(move || crate::auth::settings(provider, &id))
                            .await
                            .map_err(|_| "worker_failed")??;
                    let settings = entry["imap"].clone();
                    let secret = if oauth {
                        crate::auth::access_token(provider, &account, "mail").await?
                    } else {
                        crate::auth::password(provider, &account).await?
                    };
                    let credential = if oauth {
                        secret
                    } else {
                        format!(
                            "{}:{}",
                            settings["username"]
                                .as_str()
                                .ok_or("mail_account_invalid")?,
                            secret
                        )
                    };
                    return crate::providers::imap::call(
                        "imap.check",
                        &json!({"settings":settings,"credential":credential,"oauth":oauth}),
                    )
                    .await;
                }
                if account.starts_with("hey:") {
                    let program = crate::providers::hey_access::program()?;
                    let params = crate::providers::hey_access::checked_params(&json!({
                        "accountId":account,"program":program,"query":query,"pageSize":3,"pageToken":""
                    })).await?;
                    return crate::providers::hey::call("hey.list", &params).await;
                }
                let listing = gmail
                    .call(
                        "gmail.list",
                        &json!({
                            "accountId":account,"query":query,"pageSize":3
                        }),
                    )
                    .await?;
                let ids = listing["ids"].as_array().ok_or("gmail_invalid_response")?;
                let messages = try_join_all(ids.iter().take(3).map(|id| {
                    let gmail = &gmail;
                    let account = &account;
                    async move {
                        gmail
                            .call(
                                "gmail.read",
                                &json!({"accountId":account,"id":id,"full":false}),
                            )
                            .await
                    }
                }))
                .await?;
                Ok(json!({"estimate":listing["estimate"],"messages":messages}))
            })
        }));
        Arc::get_mut(&mut sync.inner).unwrap().warm = Some(warm);
        sync.watch_registry = true;
        sync
    }

    pub(crate) fn with_checker(check: Check) -> Self {
        let (events, _) = broadcast::channel(128);
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                operations: tokio::sync::Mutex::new(()),
                events,
                check,
                warm: None,
                registry_task: Mutex::new(None),
            }),
            watch_registry: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(check: Check) -> Self {
        Self::with_checker(check)
    }

    #[cfg(test)]
    pub(crate) async fn watch_for_test(&self, account: &str) {
        self.watch(account.into(), "".into(), 30).await.unwrap();
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Event> {
        let receiver = self.inner.events.subscribe();
        if self.watch_registry {
            let mut task = self
                .inner
                .registry_task
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if task.is_none() {
                let sender = self.inner.events.clone();
                *task = Some(tokio::spawn(registry_changes(
                    sender,
                    || async {
                        tokio::task::spawn_blocking(|| {
                            crate::account::call("accounts.read", &json!({}))
                        })
                        .await
                        .map_err(|_| "worker_failed")?
                    },
                    Duration::from_secs(2),
                )));
            }
        }
        receiver
    }

    pub(crate) fn is_current(&self, event: &Event) -> bool {
        if event.account.is_empty() && event.generation == 0 {
            return self
                .inner
                .registry_task
                .lock()
                .is_ok_and(|task| task.is_some());
        }
        self.inner.state.lock().is_ok_and(|state| {
            state
                .watches
                .get(&event.account)
                .is_some_and(|watch| watch.generation == event.generation)
        })
    }

    pub async fn call(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        if method == "mail.watch" {
            let request: WatchParams =
                serde_json::from_value(params.clone()).map_err(|_| "invalid_params")?;
            let account = account_id(&request.account_id)?;
            if !(1..=100).contains(&request.page_size)
                || !(30..=3600).contains(&request.interval_sec)
                || request.query.len() > 8192
                || request.query.chars().any(char::is_control)
            {
                return Err("invalid_params");
            }
            let registered = crate::account::list;
            let accounts = tokio::task::spawn_blocking(registered)
                .await
                .map_err(|_| "worker_failed")??;
            if !accounts["accounts"]
                .as_array()
                .is_some_and(|entries| entries.iter().any(|entry| entry["id"] == account))
            {
                return Err("mail_account_unknown");
            }
            return self
                .watch_with_limit(
                    account,
                    request.query,
                    request.interval_sec,
                    request.page_size,
                )
                .await;
        }
        if !matches!(method, "mail.unwatch" | "mail.check" | "mail.snapshot") {
            return Err("unknown_method");
        }
        let request: AccountParams =
            serde_json::from_value(params.clone()).map_err(|_| "invalid_params")?;
        let account = account_id(&request.account_id)?;
        if method == "mail.unwatch" {
            let _operation = self.inner.operations.lock().await;
            let watch = self
                .inner
                .state
                .lock()
                .map_err(|_| "session_failed")?
                .watches
                .remove(&account);
            if let Some(task) = watch.and_then(|watch| watch.task) {
                task.abort();
                let _ = task.await;
            }
            return Ok(json!({"unwatched":true}));
        }
        let state = self.inner.state.lock().map_err(|_| "session_failed")?;
        let watch = state.watches.get(&account).ok_or("mail_watch_unknown")?;
        if method == "mail.check" {
            if !watch.checking {
                watch.trigger.notify_one();
            }
            Ok(json!({"checking":true}))
        } else {
            Ok(watch.snapshot.clone())
        }
    }

    #[cfg(test)]
    async fn watch(
        &self,
        account: String,
        query: String,
        interval: u64,
    ) -> Result<Value, &'static str> {
        self.watch_with_limit(account, query, interval, 25).await
    }

    async fn watch_with_limit(
        &self,
        account: String,
        query: String,
        interval: u64,
        page_size: u64,
    ) -> Result<Value, &'static str> {
        let _operation = self.inner.operations.lock().await;
        let old = {
            let mut state = self.inner.state.lock().map_err(|_| "session_failed")?;
            if let Some(watch) = state.watches.get(&account) {
                if watch.query == query
                    && watch.interval == interval
                    && watch.page_size == page_size
                {
                    return Ok(watch.snapshot.clone());
                }
            } else if state.watches.len() >= 32 {
                return Err("mail_watch_limit");
            }
            state.watches.remove(&account)
        };
        if let Some(task) = old.and_then(|watch| watch.task) {
            task.abort();
            let _ = task.await;
        }
        let mut state = self.inner.state.lock().map_err(|_| "session_failed")?;
        state.generation += 1;
        let generation = state.generation;
        let snapshot = json!({"accountId":account,"sequence":state.sequence,"estimate":0,"messages":[],"checkedAt":0,"error":""});
        let trigger = Arc::new(Notify::new());
        state.watches.insert(
            account.clone(),
            Watch {
                generation,
                query: query.clone(),
                interval,
                page_size,
                preload: None,
                snapshot: snapshot.clone(),
                trigger: trigger.clone(),
                checking: true,
                task: None,
            },
        );
        let inner = self.inner.clone();
        let key = account.clone();
        let task = tokio::spawn(async move {
            loop {
                {
                    let Ok(mut state) = inner.state.lock() else {
                        return;
                    };
                    let Some(watch) = state
                        .watches
                        .get_mut(&account)
                        .filter(|watch| watch.generation == generation)
                    else {
                        return;
                    };
                    watch.checking = true;
                }
                let result = tokio::time::timeout(
                    Duration::from_secs(25),
                    (inner.check)(account.clone(), query.clone()),
                )
                .await
                .unwrap_or(Err("mail_check_timeout"));
                {
                    let Ok(mut state) = inner.state.lock() else {
                        return;
                    };
                    if !state
                        .watches
                        .get(&account)
                        .is_some_and(|watch| watch.generation == generation)
                    {
                        return;
                    }
                    state.sequence += 1;
                    let sequence = state.sequence;
                    let watch = state.watches.get_mut(&account).unwrap();
                    watch.checking = false;
                    let snapshot = &mut watch.snapshot;
                    snapshot["sequence"] = json!(sequence);
                    snapshot["checkedAt"] = json!(
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64
                    );
                    match result {
                        Ok(value) => {
                            snapshot["estimate"] = value["estimate"].clone();
                            snapshot["messages"] = value["messages"].clone();
                            // Counts alone miss a new unread message replacing
                            // one just read elsewhere. Preserve provider state
                            // tokens, otherwise compare the returned previews.
                            snapshot["fingerprint"] = value["fingerprint"]
                                .as_str()
                                .filter(|value| !value.is_empty())
                                .map(|value| json!(value))
                                .unwrap_or_else(|| {
                                    let visible = json!([value["estimate"], value["messages"]]);
                                    json!(format!(
                                        "{:x}",
                                        Sha256::digest(visible.to_string().as_bytes())
                                    ))
                                });
                            snapshot["error"] = json!("");
                            let fingerprint =
                                snapshot["fingerprint"].as_str().unwrap_or("").to_owned();
                            if let Some(warm) = &inner.warm {
                                let restart = watch.preload.as_ref().is_none_or(|job| {
                                    job.fingerprint != fingerprint
                                        || job.refresh_due(interval)
                                        || (job.finished()
                                            && !job
                                                .complete
                                                .load(std::sync::atomic::Ordering::Acquire))
                                });
                                if restart {
                                    // Drop invalidates the writer guard before a replacement starts.
                                    watch.preload.take();
                                    watch.preload = Some(preload::Job::start(
                                        warm.clone(),
                                        account.clone(),
                                        page_size,
                                        fingerprint,
                                    ));
                                }
                            }
                        }
                        Err(error) => snapshot["error"] = json!(error),
                    }
                    let _ = inner.events.send(Event {
                        account: account.clone(),
                        generation,
                        value: json!({"jsonrpc":"2.0","method":"mail.updated","params":snapshot}),
                    });
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(interval)) => {},
                    _ = trigger.notified() => {},
                }
            }
        });
        state.watches.get_mut(&key).unwrap().task = Some(task);
        Ok(snapshot)
    }

    pub async fn shutdown(&self) {
        let registry = self
            .inner
            .registry_task
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(task) = registry {
            task.abort();
            let _ = task.await;
        }
        let _operation = self.inner.operations.lock().await;
        let tasks: Vec<_> = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .watches
            .drain()
            .filter_map(|(_, watch)| watch.task)
            .collect();
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
    }
}

async fn registry_changes<F, Fut>(sender: broadcast::Sender<Event>, read: F, interval: Duration)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<Value, &'static str>>,
{
    let mut revision = String::new();
    loop {
        if let Ok(value) = read().await {
            let next = value["revision"].as_str().unwrap_or("");
            if !revision.is_empty() && next != revision {
                let _ = sender.send(Event {
                    account: String::new(), generation: 0,
                    value: json!({"jsonrpc":"2.0","method":"accounts.changed","params":{"revision":next}}),
                });
            }
            revision = next.to_owned();
        }
        tokio::time::sleep(interval).await;
    }
}

impl Drop for Sync {
    fn drop(&mut self) {
        if let Ok(mut task) = self.inner.registry_task.lock()
            && let Some(task) = task.take()
        {
            task.abort();
        }
        if let Ok(mut state) = self.inner.state.lock() {
            for (_, watch) in state.watches.drain() {
                if let Some(task) = watch.task {
                    task.abort();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Semaphore;

    async fn event(events: &mut broadcast::Receiver<Event>) -> Event {
        tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn immediate_check_snapshot_manual_check_and_errors() {
        let count = Arc::new(AtomicUsize::new(0));
        let sync = Sync::with_checker(Arc::new({
            let count = count.clone();
            move |account, query| {
                assert_eq!(account, "one");
                assert_eq!(query, "is:unread");
                let count = count.clone();
                Box::pin(async move {
                    if count.fetch_add(1, Ordering::SeqCst) == 0 {
                        Ok(json!({"estimate":7,"messages":[{"id":"new"}]}))
                    } else {
                        Err("gmail_http_failed")
                    }
                })
            }
        }));
        let mut events = sync.subscribe();
        sync.watch("one".into(), "is:unread".into(), 30)
            .await
            .unwrap();
        let first = event(&mut events).await;
        assert_eq!(first.value["method"], "mail.updated");
        assert_eq!(first.value["params"]["messages"][0]["id"], "new");
        assert_eq!(first.value["params"]["estimate"], 7);
        assert!(first.value["params"]["checkedAt"].as_u64().unwrap() > 0);
        assert_eq!(
            sync.call("mail.snapshot", &json!({"accountId":"one"}))
                .await
                .unwrap(),
            first.value["params"]
        );
        sync.call("mail.check", &json!({"accountId":"one"}))
            .await
            .unwrap();
        let second = event(&mut events).await;
        assert_eq!(second.value["params"]["error"], "gmail_http_failed");
        assert_eq!(second.value["params"]["estimate"], 7);
        assert!(
            second.value["params"]["sequence"].as_u64()
                > first.value["params"]["sequence"].as_u64()
        );
        sync.shutdown().await;
        assert!(!sync.is_current(&second));
    }

    #[tokio::test]
    async fn unchanged_count_still_reports_changed_message_identity() {
        let count = Arc::new(AtomicUsize::new(0));
        let sync = Sync::with_checker(Arc::new(move |_, _| {
            let n = count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok(json!({"estimate":1,"messages":[{"id":n / 2}]})) })
        }));
        let mut events = sync.subscribe();
        sync.watch("one".into(), "".into(), 30).await.unwrap();
        let first = event(&mut events).await.value["params"]["fingerprint"].clone();
        assert!(first.as_str().is_some_and(|s| !s.is_empty()));
        sync.call("mail.check", &json!({"accountId":"one"}))
            .await
            .unwrap();
        let same = event(&mut events).await.value["params"]["fingerprint"].clone();
        assert_eq!(first, same);
        sync.call("mail.check", &json!({"accountId":"one"}))
            .await
            .unwrap();
        let changed = event(&mut events).await.value["params"]["fingerprint"].clone();
        assert_ne!(same, changed);
        sync.shutdown().await;
    }

    struct Active(Arc<AtomicUsize>);
    impl Drop for Active {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn slow_checks_coalesce_and_replacement_cancels_old_generation() {
        let started = Arc::new(Semaphore::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let count = Arc::new(AtomicUsize::new(0));
        let sync = Sync::with_checker(Arc::new({
            let started = started.clone();
            let active = active.clone();
            let count = count.clone();
            move |_, query| {
                let started = started.clone();
                let active = active.clone();
                let count = count.clone();
                Box::pin(async move {
                    assert_eq!(
                        active.fetch_add(1, Ordering::SeqCst),
                        0,
                        "checks must not overlap"
                    );
                    let _active = Active(active);
                    count.fetch_add(1, Ordering::SeqCst);
                    started.add_permits(1);
                    if query == "slow" {
                        std::future::pending::<()>().await;
                    }
                    Ok(json!({"estimate":1,"messages":[{"id":query}]}))
                })
            }
        }));
        let mut events = sync.subscribe();
        sync.watch("one".into(), "slow".into(), 30).await.unwrap();
        started.acquire().await.unwrap().forget();
        for _ in 0..5 {
            sync.call("mail.check", &json!({"accountId":"one"}))
                .await
                .unwrap();
        }
        tokio::task::yield_now().await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
        sync.watch("one".into(), "replacement".into(), 30)
            .await
            .unwrap();
        let replacement = event(&mut events).await;
        assert_eq!(
            replacement.value["params"]["messages"][0]["id"],
            "replacement"
        );
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert!(events.try_recv().is_err());
        sync.call("mail.unwatch", &json!({"accountId":"one"}))
            .await
            .unwrap();
        assert!(!sync.is_current(&replacement));
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(
            sync.call("mail.snapshot", &json!({"accountId":"one"}))
                .await,
            Err("mail_watch_unknown")
        );
    }

    #[tokio::test]
    async fn slow_account_does_not_stall_fast_account_and_shutdown_cancels() {
        let active = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Semaphore::new(0));
        let sync = Sync::with_checker(Arc::new({
            let active = active.clone();
            let started = started.clone();
            move |account, _| {
                let active = active.clone();
                let started = started.clone();
                Box::pin(async move {
                    active.fetch_add(1, Ordering::SeqCst);
                    let _active = Active(active);
                    if account == "slow" {
                        started.add_permits(1);
                        std::future::pending::<()>().await;
                    }
                    Ok(json!({"estimate":0,"messages":[]}))
                })
            }
        }));
        let mut events = sync.subscribe();
        sync.watch("slow".into(), "".into(), 30).await.unwrap();
        started.acquire().await.unwrap().forget();
        sync.watch("fast".into(), "".into(), 30).await.unwrap();
        assert_eq!(
            event(&mut events).await.value["params"]["accountId"],
            "fast"
        );
        sync.shutdown().await;
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn malformed_watches_are_refused_before_configuration_access() {
        let sync = Sync::with_checker(Arc::new(|_, _| panic!("must not check")));
        for params in [
            json!({"accountId":"one","query":"","intervalSec":29}),
            json!({"accountId":"one","query":"","intervalSec":3601}),
            json!({"accountId":"one","query":"bad\n","intervalSec":30}),
            json!({"accountId":"one\u{0000}","query":"","intervalSec":30}),
            json!({"accountId":"one","query":"","intervalSec":30,"url":"https://example.org"}),
        ] {
            assert_eq!(
                sync.call("mail.watch", &params).await,
                Err("invalid_params")
            );
        }
    }

    #[tokio::test]
    async fn watch_limit_and_identical_updates_do_not_restart() {
        let sync = Sync::with_checker(Arc::new(|_, _| Box::pin(std::future::pending())));
        for i in 0..32 {
            sync.watch(i.to_string(), "".into(), 30).await.unwrap();
        }
        assert_eq!(
            sync.watch("extra".into(), "".into(), 30).await,
            Err("mail_watch_limit")
        );
        let before = sync.inner.state.lock().unwrap().generation;
        sync.watch("0".into(), "".into(), 30).await.unwrap();
        assert_eq!(sync.inner.state.lock().unwrap().generation, before);
        sync.shutdown().await;
    }

    #[tokio::test]
    async fn periodic_check_runs_without_a_manual_trigger() {
        let sync = Sync::with_checker(Arc::new(|_, _| {
            Box::pin(async { Ok(json!({"estimate":0,"messages":[]})) })
        }));
        let mut events = sync.subscribe();
        // Private seam accelerates the interval; the RPC boundary still requires 30 seconds.
        sync.watch("one".into(), "".into(), 1).await.unwrap();
        let first = event(&mut events).await;
        let second = event(&mut events).await;
        assert!(
            second.value["params"]["sequence"].as_u64()
                > first.value["params"]["sequence"].as_u64()
        );
        sync.shutdown().await;
    }
    #[tokio::test]
    async fn registry_watcher_emits_only_revision_on_change_and_stops_on_shutdown() {
        let revision = Arc::new(AtomicUsize::new(1));
        let reads = Arc::new(AtomicUsize::new(0));
        let sync = Sync::with_checker(Arc::new(|_, _| Box::pin(std::future::pending())));
        let mut events = sync.subscribe();
        let task = tokio::spawn(registry_changes(
            sync.inner.events.clone(),
            {
                let revision = revision.clone();
                let reads = reads.clone();
                move || {
                    let revision = revision.clone();
                    let reads = reads.clone();
                    async move {
                        reads.fetch_add(1, Ordering::SeqCst);
                        Ok(
                            json!({"revision":revision.load(Ordering::SeqCst).to_string(),"registry":{"clientSecret":"must never be an event"}}),
                        )
                    }
                }
            },
            Duration::from_millis(10),
        ));
        *sync.inner.registry_task.lock().unwrap() = Some(task);
        while reads.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(events.try_recv().is_err());
        revision.store(2, Ordering::SeqCst);
        let changed = event(&mut events).await;
        assert_eq!(
            changed.value,
            json!({"jsonrpc":"2.0","method":"accounts.changed","params":{"revision":"2"}})
        );
        assert!(sync.is_current(&changed));
        sync.shutdown().await;
        assert!(!sync.is_current(&changed));
        let before = reads.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(reads.load(Ordering::SeqCst), before);
    }
}

#[cfg(test)]
mod preload_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Semaphore;

    fn fake(check: Check, warm: preload::Warm) -> Sync {
        let mut sync = Sync::with_checker(check);
        Arc::get_mut(&mut sync.inner).unwrap().warm = Some(warm);
        sync
    }
    async fn started(semaphore: &Semaphore) {
        tokio::time::timeout(Duration::from_secs(2), semaphore.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
    async fn checked(events: &mut broadcast::Receiver<Event>) {
        tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
    }
    #[tokio::test]
    async fn initial_preload_uses_page_size_and_unchanged_checks_do_not_duplicate_it() {
        let calls = Arc::new(AtomicUsize::new(0));
        let signal = Arc::new(Semaphore::new(0));
        let sync = fake(
            Arc::new(|_, _| {
                Box::pin(async { Ok(json!({"estimate":1,"messages":[{"id":"one"}]})) })
            }),
            Arc::new({
                let calls = calls.clone();
                let signal = signal.clone();
                move |account, limit, live| {
                    assert_eq!(account, "one");
                    assert_eq!(limit, 37);
                    let calls = calls.clone();
                    let signal = signal.clone();
                    Box::pin(async move {
                        assert!(*live.lock().unwrap());
                        calls.fetch_add(1, Ordering::SeqCst);
                        signal.add_permits(1);
                        Ok(())
                    })
                }
            }),
        );
        let mut events = sync.subscribe();
        sync.watch_with_limit("one".into(), "unread".into(), 30, 37)
            .await
            .unwrap();
        checked(&mut events).await;
        started(&signal).await;
        for _ in 0..3 {
            sync.call("mail.check", &json!({"accountId":"one"}))
                .await
                .unwrap();
            checked(&mut events).await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        sync.shutdown().await;
    }
    #[tokio::test]
    async fn changed_mail_and_replacement_cancel_old_preload_before_any_commit() {
        let revision = Arc::new(AtomicUsize::new(1));
        let calls = Arc::new(AtomicUsize::new(0));
        let commits = Arc::new(AtomicUsize::new(0));
        let signal = Arc::new(Semaphore::new(0));
        let held = Arc::new(Mutex::new(Vec::<preload::Live>::new()));
        let sync = fake(
            Arc::new({
                let revision = revision.clone();
                move |_, _| {
                    let n = revision.load(Ordering::SeqCst);
                    Box::pin(async move { Ok(json!({"estimate":1,"messages":[{"id":n}]})) })
                }
            }),
            Arc::new({
                let calls = calls.clone();
                let commits = commits.clone();
                let signal = signal.clone();
                let held = held.clone();
                move |_, _, live| {
                    held.lock().unwrap().push(live.clone());
                    let n = calls.fetch_add(1, Ordering::SeqCst);
                    let signal = signal.clone();
                    let commits = commits.clone();
                    Box::pin(async move {
                        signal.add_permits(1);
                        if n == 0 {
                            std::future::pending::<()>().await;
                        }
                        if *live.lock().unwrap() {
                            commits.fetch_add(1, Ordering::SeqCst);
                        }
                        Ok(())
                    })
                }
            }),
        );
        let mut events = sync.subscribe();
        sync.watch("one".into(), "unread".into(), 30).await.unwrap();
        checked(&mut events).await;
        started(&signal).await;
        revision.store(2, Ordering::SeqCst);
        sync.call("mail.check", &json!({"accountId":"one"}))
            .await
            .unwrap();
        checked(&mut events).await;
        assert!(!*held.lock().unwrap()[0].lock().unwrap());
        started(&signal).await;
        assert_eq!(commits.load(Ordering::SeqCst), 1);
        sync.call("mail.unwatch", &json!({"accountId":"one"}))
            .await
            .unwrap();
        assert!(
            held.lock()
                .unwrap()
                .iter()
                .all(|live| !*live.lock().unwrap())
        );
        sync.shutdown().await;
    }
    #[tokio::test]
    async fn slow_preload_never_blocks_mail_checks_and_shutdown_invalidates_writers() {
        let signal = Arc::new(Semaphore::new(0));
        let held = Arc::new(Mutex::new(None::<preload::Live>));
        let sync = fake(
            Arc::new(|_, _| Box::pin(async { Ok(json!({"estimate":0,"messages":[]})) })),
            Arc::new({
                let signal = signal.clone();
                let held = held.clone();
                move |_, _, live| {
                    *held.lock().unwrap() = Some(live);
                    let signal = signal.clone();
                    Box::pin(async move {
                        signal.add_permits(1);
                        std::future::pending().await
                    })
                }
            }),
        );
        let mut events = sync.subscribe();
        sync.watch("one".into(), "unread".into(), 30).await.unwrap();
        checked(&mut events).await;
        started(&signal).await;
        sync.call("mail.check", &json!({"accountId":"one"}))
            .await
            .unwrap();
        checked(&mut events).await;
        sync.shutdown().await;
        assert!(!*held.lock().unwrap().as_ref().unwrap().lock().unwrap());
    }
}
