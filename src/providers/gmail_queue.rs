//! Gmail message mutations wait their turn here, in memory, per account.
//!
//! A screen of deletes is a burst Gmail throttles, so the request returns a
//! ticket at once and one task per account sends the queue in order, paced
//! and backed off; the outcome is announced as a `gmail.settled` notification
//! and to any caller awaiting the ticket. Nothing here survives the process:
//! an unsent entry is recoverable by the user, a lost one is not pretended.
use super::*;
use futures_util::future::BoxFuture;
use std::collections::VecDeque;
use tokio::sync::{broadcast, oneshot};

/// Queue-level waits after Gmail keeps refusing a send for rate limiting,
/// on top of the transport's own 1/2/4 s. About 100 s in all, then it fails.
const BACKOFF: [Duration; 4] = [
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(20),
    Duration::from_secs(30),
];
const MAX_PENDING: usize = 4096;

pub(super) fn queued(method: &str) -> bool {
    matches!(
        method,
        "gmail.modify" | "gmail.batchModify" | "gmail.trash" | "gmail.untrash"
    )
}

/// One send, fully described before it waits.
pub(super) struct Job {
    pub method: String,
    pub http: reqwest::Method,
    pub path: Vec<String>,
    pub body: Option<Value>,
    pub cost: u32,
}

pub(super) type Outcome = Result<Value, &'static str>;
/// One attempt: token, pacing and the HTTP round trip. The queue owns retries.
pub(super) type Sender =
    Arc<dyn Fn(Arc<AccountSession>, String, Arc<Job>) -> BoxFuture<'static, Outcome> + Send + Sync>;

struct Entry {
    ticket: u64,
    session: Arc<AccountSession>,
    job: Arc<Job>,
    waiter: Option<oneshot::Sender<Outcome>>,
}

#[derive(Default)]
struct AccountQueue {
    pending: VecDeque<Entry>,
    drainer: Option<tokio::task::JoinHandle<()>>,
}

struct Inner {
    accounts: Mutex<HashMap<String, AccountQueue>>,
    events: broadcast::Sender<Value>,
    sender: Sender,
    serial: std::sync::atomic::AtomicU64,
}

pub(super) struct Queue {
    inner: Arc<Inner>,
}

impl Queue {
    pub(super) fn new(sender: Sender) -> Self {
        Queue {
            inner: Arc::new(Inner {
                accounts: Mutex::new(HashMap::new()),
                events: broadcast::channel(256).0,
                sender,
                serial: std::sync::atomic::AtomicU64::new(0),
            }),
        }
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.inner.events.subscribe()
    }

    /// Books the job behind everything the account already has waiting and
    /// returns its ticket with the channel its outcome will arrive on.
    pub(super) fn enqueue(
        &self,
        account: &str,
        session: Arc<AccountSession>,
        job: Job,
    ) -> Result<(u64, oneshot::Receiver<Outcome>), &'static str> {
        session.check()?;
        let ticket = self.inner.serial.fetch_add(1, Ordering::Relaxed) + 1;
        let (waiter, receiver) = oneshot::channel();
        let mut accounts = self.inner.accounts.lock().map_err(|_| "session_failed")?;
        let queue = accounts.entry(account.to_owned()).or_default();
        if queue.pending.len() >= MAX_PENDING {
            return Err("gmail_queue_full");
        }
        queue.pending.push_back(Entry {
            ticket,
            session,
            job: Arc::new(job),
            waiter: Some(waiter),
        });
        if queue.drainer.as_ref().is_none_or(|task| task.is_finished()) {
            let inner = Arc::clone(&self.inner);
            let account = account.to_owned();
            #[cfg(test)]
            let transport = gmail_http::current_test_transport();
            queue.drainer = Some(tokio::spawn(async move {
                #[cfg(test)]
                if let Some((client, origin)) = transport {
                    return gmail_http::with_test_transport(client, origin, drain(inner, account))
                        .await;
                }
                drain(inner, account).await
            }));
        }
        Ok((ticket, receiver))
    }

    /// Logout: what has not been sent is refused now. A send already on the
    /// wire settles on its real answer, since it cannot be recalled.
    pub(super) fn invalidate(&self, account: &str) {
        let dropped = {
            let Ok(mut accounts) = self.inner.accounts.lock() else {
                return;
            };
            accounts
                .get_mut(account)
                .map(|queue| std::mem::take(&mut queue.pending))
                .unwrap_or_default()
        };
        for entry in dropped {
            settle(
                &self.inner,
                account,
                entry,
                Err("gmail_session_invalidated"),
            );
        }
    }

    pub(super) fn shutdown(&self) {
        let Ok(mut accounts) = self.inner.accounts.lock() else {
            return;
        };
        for queue in accounts.values_mut() {
            if let Some(task) = queue.drainer.take() {
                task.abort();
            }
        }
    }
}

fn settle(inner: &Inner, account: &str, mut entry: Entry, outcome: Outcome) {
    let _ = inner.events.send(json!({
        "jsonrpc": "2.0",
        "method": "gmail.settled",
        "params": {
            "accountId": account,
            "ticket": entry.ticket.to_string(),
            "method": entry.job.method,
            "ok": outcome.is_ok(),
            "error": outcome.as_ref().err().copied().unwrap_or(""),
        }
    }));
    if let Some(waiter) = entry.waiter.take() {
        let _ = waiter.send(outcome);
    }
}

async fn drain(inner: Arc<Inner>, account: String) {
    loop {
        let entry = {
            let Ok(mut accounts) = inner.accounts.lock() else {
                return;
            };
            let Some(queue) = accounts.get_mut(&account) else {
                return;
            };
            match queue.pending.pop_front() {
                Some(entry) => entry,
                None => {
                    queue.drainer = None;
                    return;
                }
            }
        };
        let outcome = send(&inner, &account, &entry).await;
        settle(&inner, &account, entry, outcome);
    }
}

async fn send(inner: &Inner, account: &str, entry: &Entry) -> Outcome {
    for wait in BACKOFF.iter().map(Some).chain(std::iter::once(None)) {
        entry.session.check()?;
        let answer = (inner.sender)(
            Arc::clone(&entry.session),
            account.to_owned(),
            Arc::clone(&entry.job),
        )
        .await;
        match (answer, wait) {
            (Err("gmail_rate_limited"), Some(wait)) => tokio::time::sleep(*wait).await,
            (answer, _) => return answer,
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Instant;

    fn scripted(answers: Vec<Outcome>, sent: Arc<Mutex<Vec<(String, Instant)>>>) -> Sender {
        let answers = Arc::new(Mutex::new(answers));
        Arc::new(move |_, account, job: Arc<Job>| {
            let answers = Arc::clone(&answers);
            let sent = Arc::clone(&sent);
            Box::pin(async move {
                sent.lock()
                    .unwrap()
                    .push((job.path.join("/"), Instant::now()));
                let mut answers = answers.lock().unwrap();
                if answers.is_empty() {
                    Ok(json!({"account":account}))
                } else {
                    answers.remove(0)
                }
            })
        })
    }

    fn job(id: &str) -> Job {
        Job {
            method: "gmail.trash".into(),
            http: reqwest::Method::POST,
            path: vec!["messages".into(), id.into(), "trash".into()],
            body: None,
            cost: 5,
        }
    }

    async fn next(events: &mut broadcast::Receiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .expect("settlement announced")
            .unwrap()["params"]
            .clone()
    }

    #[tokio::test(start_paused = true)]
    async fn sends_in_order_backs_off_rate_limits_and_announces_each_outcome() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let queue = Queue::new(scripted(
            vec![
                Err("gmail_rate_limited"),
                Ok(json!({})),
                Err("gmail_http_failed"),
            ],
            Arc::clone(&sent),
        ));
        let mut events = queue.subscribe();
        let session = Arc::new(AccountSession::new());
        let started = Instant::now();
        let (first, wait_first) = queue
            .enqueue("one", Arc::clone(&session), job("a"))
            .unwrap();
        let (second, _) = queue
            .enqueue("one", Arc::clone(&session), job("b"))
            .unwrap();
        assert!(second > first);
        assert_eq!(wait_first.await.unwrap(), Ok(json!({})));
        let settled = next(&mut events).await;
        assert_eq!(settled["ticket"], first.to_string());
        assert_eq!(settled["ok"], true);
        assert_eq!(settled["method"], "gmail.trash");
        let settled = next(&mut events).await;
        assert_eq!(settled["ticket"], second.to_string());
        assert_eq!(settled["ok"], false);
        assert_eq!(settled["error"], "gmail_http_failed");
        let sent = sent.lock().unwrap();
        assert_eq!(
            sent.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(),
            ["messages/a/trash", "messages/a/trash", "messages/b/trash"]
        );
        assert!(
            sent[1].1 - started >= BACKOFF[0],
            "the resend waited the first backoff"
        );
        assert!(sent[2].1 >= sent[1].1, "b went out only after a settled");
    }

    #[tokio::test(start_paused = true)]
    async fn persistent_rate_limiting_fails_after_the_last_backoff() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let queue = Queue::new(scripted(
            vec![Err("gmail_rate_limited"); BACKOFF.len() + 4],
            Arc::clone(&sent),
        ));
        let session = Arc::new(AccountSession::new());
        let started = Instant::now();
        let (_, outcome) = queue.enqueue("one", session, job("a")).unwrap();
        assert_eq!(outcome.await.unwrap(), Err("gmail_rate_limited"));
        assert_eq!(sent.lock().unwrap().len(), BACKOFF.len() + 1);
        let total: Duration = BACKOFF.iter().sum();
        assert!(started.elapsed() >= total);
    }

    #[tokio::test(start_paused = true)]
    async fn invalidation_refuses_unsent_entries_and_accounts_do_not_share_a_line() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let queue = Queue::new(scripted(vec![Err("gmail_rate_limited")], Arc::clone(&sent)));
        let mut events = queue.subscribe();
        let one = Arc::new(AccountSession::new());
        let two = Arc::new(AccountSession::new());
        let (_, head) = queue.enqueue("one", Arc::clone(&one), job("a")).unwrap();
        let (_, behind) = queue.enqueue("one", Arc::clone(&one), job("b")).unwrap();
        let (_, other) = queue.enqueue("two", two, job("c")).unwrap();
        // The other account's send is not behind this one's backoff.
        assert_eq!(other.await.unwrap(), Ok(json!({"account":"two"})));
        assert_eq!(next(&mut events).await["accountId"], "two");
        tokio::task::yield_now().await;
        one.valid.store(false, Ordering::Release);
        queue.invalidate("one");
        assert_eq!(behind.await.unwrap(), Err("gmail_session_invalidated"));
        assert_eq!(
            next(&mut events).await["error"],
            "gmail_session_invalidated"
        );
        // The head was mid-backoff: it is refused before its resend, not resent.
        assert_eq!(head.await.unwrap(), Err("gmail_session_invalidated"));
        assert_eq!(
            sent.lock()
                .unwrap()
                .iter()
                .filter(|(p, _)| p == "messages/a/trash")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn a_full_line_refuses_new_entries_and_a_dropped_waiter_is_fine() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let queue = Queue::new(scripted(vec![], Arc::clone(&sent)));
        let session = Arc::new(AccountSession::new());
        // Fill without draining by never yielding to the drainer.
        {
            let mut accounts = queue.inner.accounts.lock().unwrap();
            let line = accounts.entry("one".into()).or_default();
            for _ in 0..MAX_PENDING {
                line.pending.push_back(Entry {
                    ticket: 0,
                    session: Arc::clone(&session),
                    job: Arc::new(job("x")),
                    waiter: None,
                });
            }
        }
        assert_eq!(
            queue.enqueue("one", Arc::clone(&session), job("y")).err(),
            Some("gmail_queue_full")
        );
        let mut events = queue.subscribe();
        let (_, receiver) = queue.enqueue("two", session, job("z")).unwrap();
        drop(receiver);
        assert_eq!(next(&mut events).await["ok"], true);
    }
}
