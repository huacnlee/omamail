//! Per-request read cancellation. Mutation futures are never detached or cancelled here.
use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
struct Entry {
    aborted: AtomicBool,
    notify: tokio::sync::Notify,
    since: Instant,
}
static READS: OnceLock<tokio::sync::Mutex<HashMap<String, Arc<Entry>>>> = OnceLock::new();
fn key(p: &Value) -> Result<Option<String>> {
    let Some(token) = p["requestToken"].as_str() else {
        return Ok(None);
    };
    if token.is_empty() || token.len() > 128 || !safe(token) {
        return Err("invalid_params");
    }
    let account = p["accountId"].as_str().unwrap_or("");
    if account.len() > 1024 || !safe(account) {
        return Err("invalid_params");
    }
    Ok(Some(json!([account, token]).to_string()))
}
async fn entry(key: &str) -> Result<Arc<Entry>> {
    let mut reads = READS.get_or_init(Default::default).lock().await;
    reads.retain(|_, entry| {
        Arc::strong_count(entry) > 1 || entry.since.elapsed() < Duration::from_secs(60)
    });
    if let Some(entry) = reads.get(key) {
        return Ok(entry.clone());
    }
    if reads.len() >= 1024 {
        return Err("too_many_requests");
    }
    let entry = Arc::new(Entry {
        aborted: AtomicBool::new(false),
        notify: Default::default(),
        since: Instant::now(),
    });
    reads.insert(key.into(), entry.clone());
    Ok(entry)
}
pub(super) async fn cancel(p: &Value) -> Result<Value> {
    let key = key(p)?.ok_or("invalid_params")?;
    let entry = entry(&key).await?;
    entry.aborted.store(true, Ordering::SeqCst);
    entry.notify.notify_waiters();
    Ok(json!({"cancelled":true}))
}
pub(super) async fn run(
    p: &Value,
    future: impl std::future::Future<Output = Result<Value>>,
) -> Result<Value> {
    let Some(key) = key(p)? else {
        return future.await;
    };
    let entry = entry(&key).await?;
    // Notify is registered before reading the flag, closing cancel-before-poll races.
    let notified = entry.notify.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    if entry.aborted.load(Ordering::SeqCst) {
        return Err("request_cancelled");
    }
    let result = tokio::select! {result=future=>result,_=notified=>Err("request_cancelled")};
    let mut reads = READS.get_or_init(Default::default).lock().await;
    // Keep aborted entries briefly so an already queued continuation cannot revive a read.
    // Map + this reader are two references. Any additional reader (including
    // one that just registered) must retain this cancellation identity.
    if !entry.aborted.load(Ordering::SeqCst) && Arc::strong_count(&entry) == 2 {
        reads.remove(&key);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_drops_pending_work_and_refuses_queued_continuation() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst)
            }
        }
        let p = json!({"accountId":"imap:cancel@example.org","requestToken":"one"});
        let q = p.clone();
        let dropped = Arc::new(AtomicBool::new(false));
        let marker = Dropped(dropped.clone());
        let task = tokio::spawn(async move {
            run(&q, async move {
                let _marker = marker;
                std::future::pending().await
            })
            .await
        });
        tokio::task::yield_now().await;
        cancel(&p).await.unwrap();
        assert_eq!(task.await.unwrap(), Err("request_cancelled"));
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(
            run(&p, async {
                panic!("cancelled continuation must not execute")
            })
            .await,
            Err("request_cancelled")
        );
        let other = json!({"accountId":"imap:other@example.org","requestToken":"one"});
        assert_eq!(
            run(&other, async { Ok(json!({"ok":true})) }).await.unwrap()["ok"],
            true
        );
    }
    #[tokio::test]
    async fn cancelling_folder_read_closes_the_actual_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let reached = Arc::new(tokio::sync::Notify::new());
        let ready = reached.clone();
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut w: Wire = BufReader::new(Box::new(socket));
            write(&mut w, b"* OK ready\r\n").await.unwrap();
            line(&mut w).await.unwrap();
            write(&mut w, b"O1 OK login\r\n").await.unwrap();
            for _ in 0..2 {
                assert_eq!(line(&mut w).await.unwrap(), b"O1 CAPABILITY\r\n");
                write(&mut w, b"* CAPABILITY IMAP4rev1\r\nO1 OK caps\r\n")
                    .await
                    .unwrap();
            }
            assert_eq!(line(&mut w).await.unwrap(), b"O1 LIST \"\" \"*\"\r\n");
            ready.notify_one();
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), w.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let p = json!({"requestToken":"socket-close-test","settings":{"imapHost":"127.0.0.1","imapPort":port,"username":"synthetic","insecure":true},"credential":"synthetic:secret"});
        let q = p.clone();
        let request = tokio::spawn(async move { super::super::call("imap.folders", &q).await });
        reached.notified().await;
        super::super::call("imap.cancel", &p).await.unwrap();
        assert_eq!(request.await.unwrap(), Err("request_cancelled"));
        peer.await.unwrap();
    }
    #[tokio::test]
    async fn first_completion_keeps_shared_token_registered_for_second_reader() {
        let p = json!({"accountId":"imap:shared@example.org","requestToken":"shared-active"});
        let first_ready = Arc::new(tokio::sync::Notify::new());
        let second_ready = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let a = p.clone();
        let ready = first_ready.clone();
        let gate = release.clone();
        let first = tokio::spawn(async move {
            run(&a, async move {
                ready.notify_one();
                gate.notified().await;
                Ok(json!({"first":true}))
            })
            .await
        });
        first_ready.notified().await;
        let b = p.clone();
        let ready = second_ready.clone();
        let second = tokio::spawn(async move {
            run(&b, async move {
                ready.notify_one();
                std::future::pending().await
            })
            .await
        });
        second_ready.notified().await;
        release.notify_one();
        assert_eq!(first.await.unwrap().unwrap()["first"], true);
        cancel(&p).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), second)
                .await
                .unwrap()
                .unwrap(),
            Err("request_cancelled")
        );
    }
}
