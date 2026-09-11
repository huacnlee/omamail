use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self::create(std::env::temp_dir().join(format!(
            "omamail-outbox-{}-{stamp}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        )))
    }
    fn create(base: PathBuf) -> Self {
        use std::os::unix::fs::DirBuilderExt;
        for attempt in 0..1024 {
            let path = if attempt == 0 {
                base.clone()
            } else {
                base.with_extension(attempt.to_string())
            };
            match std::fs::DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("could not create private test directory: {error}"),
            }
        }
        panic!("could not allocate unused test directory")
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn enqueue(id: &str, account: &str, delay: u64) -> Value {
    json!({"accountId":account,"provider":"gmail","payload":{"raw":"synthetic-private-body","draftId":"draft1"},"sendId":id,"delaySeconds":delay})
}
async fn state(outbox: &Outbox, id: &str, account: &str) -> String {
    let snapshot = outbox
        .call("outbox.snapshot", &json!({"accountId":account}))
        .await
        .unwrap();
    snapshot["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == id)
        .unwrap()["state"]
        .as_str()
        .unwrap()
        .into()
}
async fn wait_state(outbox: &Outbox, id: &str, account: &str, wanted: &str) {
    for _ in 0..100 {
        if state(outbox, id, account).await == wanted {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("state never became {wanted}");
}
#[tokio::test]
async fn delayed_undo_is_authoritative_and_never_invokes_executor() {
    let dir = Temp::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let outbox = Outbox::with_root(
        Arc::new(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(json!({})) })
        }),
        Some(dir.0.clone()),
    );
    outbox
        .call("outbox.enqueue", &enqueue("one", "a@example.org", 60))
        .await
        .unwrap();
    let result = outbox
        .call(
            "outbox.undo",
            &json!({"accountId":"a@example.org","sendId":"one"}),
        )
        .await
        .unwrap();
    assert_eq!(result["id"], "one");
    assert_eq!(state(&outbox, "one", "a@example.org").await, "cancelled");
    outbox
        .call("outbox.flush", &json!({"accountId":"a@example.org"}))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let bytes = std::fs::read(dir.0.join("omamail/outbox.json")).unwrap();
    assert!(
        String::from_utf8(bytes)
            .unwrap()
            .contains("synthetic-private-body")
    );
}
#[tokio::test]
async fn serial_order_and_duplicate_ids_do_not_send_twice() {
    let dir = Temp::new();
    let order = Arc::new(Mutex::new(vec![]));
    let observed = order.clone();
    let active = Arc::new(AtomicUsize::new(0));
    let current = active.clone();
    let outbox = Outbox::with_root(
        Arc::new(move |request| {
            let order = observed.clone();
            let current = current.clone();
            Box::pin(async move {
                assert_eq!(current.fetch_add(1, Ordering::SeqCst), 0);
                order.lock().unwrap().push(request["sendId"].clone());
                tokio::time::sleep(Duration::from_millis(20)).await;
                current.fetch_sub(1, Ordering::SeqCst);
                Ok(json!({"id":"sent","secret":"never broadcast"}))
            })
        }),
        Some(dir.0.clone()),
    );
    outbox
        .call("outbox.enqueue", &enqueue("one", "a@example.org", 60))
        .await
        .unwrap();
    let duplicate = outbox
        .call("outbox.enqueue", &enqueue("one", "a@example.org", 60))
        .await
        .unwrap();
    assert_eq!(duplicate["duplicate"], true);
    outbox
        .call("outbox.enqueue", &enqueue("two", "a@example.org", 0))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        order.lock().unwrap().is_empty(),
        "newer immediate send cannot overtake older"
    );
    outbox
        .call("outbox.flush", &json!({"accountId":"a@example.org"}))
        .await
        .unwrap();
    wait_state(&outbox, "two", "a@example.org", "sent").await;
    assert_eq!(*order.lock().unwrap(), vec![json!("one"), json!("two")]);
    let snapshot = outbox
        .call("outbox.snapshot", &json!({"accountId":"a@example.org"}))
        .await
        .unwrap();
    assert!(!snapshot.to_string().contains("synthetic-private"));
    assert!(!snapshot.to_string().contains("never broadcast"));
}
#[tokio::test]
async fn undo_cannot_recall_an_inflight_send_and_other_accounts_progress() {
    let dir = Temp::new();
    let gate = Arc::new(Notify::new());
    let opened = gate.clone();
    let outbox = Outbox::with_root(
        Arc::new(move |request| {
            let gate = opened.clone();
            Box::pin(async move {
                if request["accountId"] == "slow@example.org" {
                    gate.notified().await;
                }
                Ok(json!({}))
            })
        }),
        Some(dir.0.clone()),
    );
    outbox
        .call("outbox.enqueue", &enqueue("slow", "slow@example.org", 0))
        .await
        .unwrap();
    wait_state(&outbox, "slow", "slow@example.org", "sending").await;
    assert_eq!(
        outbox
            .call(
                "outbox.undo",
                &json!({"accountId":"slow@example.org","sendId":"slow"})
            )
            .await,
        Err("outbox_not_queued")
    );
    outbox
        .call("outbox.enqueue", &enqueue("fast", "fast@example.org", 0))
        .await
        .unwrap();
    wait_state(&outbox, "fast", "fast@example.org", "sent").await;
    gate.notify_one();
    wait_state(&outbox, "slow", "slow@example.org", "sent").await;
}
#[tokio::test]
async fn uncertain_delivery_is_not_retried_and_restart_recovers_unsent() {
    let dir = Temp::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let outbox = Outbox::with_root(
        Arc::new(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err("network_timed_out") })
        }),
        Some(dir.0.clone()),
    );
    outbox
        .call("outbox.enqueue", &enqueue("unknown", "a@example.org", 0))
        .await
        .unwrap();
    wait_state(&outbox, "unknown", "a@example.org", "unknown").await;
    outbox
        .call("outbox.enqueue", &enqueue("queued", "a@example.org", 60))
        .await
        .unwrap();
    outbox.shutdown().await.unwrap();
    drop(outbox);
    let restarted = Outbox::with_root(
        Arc::new(|_| Box::pin(async { panic!("recovery must not resend") })),
        Some(dir.0.clone()),
    );
    assert_eq!(
        state(&restarted, "unknown", "a@example.org").await,
        "unknown"
    );
    assert_eq!(
        state(&restarted, "queued", "a@example.org").await,
        "cancelled"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn unsafe_storage_and_invalid_requests_cannot_send() {
    use std::os::unix::fs::symlink;
    let dir = Temp::new();
    std::fs::create_dir(dir.0.join("omamail")).unwrap();
    let target = dir.0.join("outside");
    std::fs::write(&target, b"sentinel").unwrap();
    symlink(&target, dir.0.join("omamail/outbox.json")).unwrap();
    let outbox = Outbox::with_root(
        Arc::new(|_| Box::pin(async { panic!("unsafe storage must not send") })),
        Some(dir.0.clone()),
    );
    assert!(
        outbox
            .call("outbox.enqueue", &enqueue("one", "a@example.org", 0))
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(target).unwrap(), b"sentinel");
}

#[tokio::test]
async fn rust_timer_delivers_without_any_ui_flush_or_poll_command() {
    let dir = Temp::new();
    let (send, mut received) = tokio::sync::mpsc::channel(1);
    let outbox = Outbox::with_root(
        Arc::new(move |request| {
            let send = send.clone();
            Box::pin(async move {
                send.send(request).await.unwrap();
                Ok(json!({}))
            })
        }),
        Some(dir.0.clone()),
    );
    let start = std::time::Instant::now();
    outbox
        .call("outbox.enqueue", &enqueue("timer", "a@example.org", 1))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), received.recv())
            .await
            .is_err()
    );
    let request = tokio::time::timeout(Duration::from_secs(2), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(request["sendId"], "timer");
    assert!(start.elapsed() >= Duration::from_millis(900));
}

#[tokio::test]
async fn shutdown_marks_wire_inflight_unknown_and_refuses_new_sends() {
    let dir = Temp::new();
    let outbox = Outbox::with_root(
        Arc::new(|_| {
            Box::pin(async {
                std::future::pending::<()>().await;
                Ok(json!({}))
            })
        }),
        Some(dir.0.clone()),
    );
    outbox
        .call("outbox.enqueue", &enqueue("inflight", "a@example.org", 0))
        .await
        .unwrap();
    wait_state(&outbox, "inflight", "a@example.org", "sending").await;
    outbox.shutdown().await.unwrap();
    assert_eq!(state(&outbox, "inflight", "a@example.org").await, "unknown");
    assert_eq!(
        outbox
            .call("outbox.enqueue", &enqueue("late", "a@example.org", 0))
            .await,
        Err("outbox_stopping")
    );
    drop(outbox);
    let restarted = Outbox::with_root(
        Arc::new(|_| Box::pin(async { panic!("must never resume delivery") })),
        Some(dir.0.clone()),
    );
    assert_eq!(
        state(&restarted, "inflight", "a@example.org").await,
        "unknown"
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(dir.0.join("omamail/outbox.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[tokio::test]
async fn competing_backend_cannot_own_the_same_queue() {
    let dir = Temp::new();
    let executor: Executor = Arc::new(|_| Box::pin(async { panic!("must not send") }));
    let first = Outbox::with_root(executor.clone(), Some(dir.0.clone()));
    first
        .call("outbox.snapshot", &json!({"accountId":"a@example.org"}))
        .await
        .unwrap();
    let second = Outbox::with_root(executor, Some(dir.0.clone()));
    assert_eq!(
        second
            .call("outbox.enqueue", &enqueue("duplicate", "a@example.org", 0))
            .await,
        Err("outbox_in_use")
    );
}

#[tokio::test]
async fn cancellation_cannot_regress_newer_disk_state_or_release_writer_lease() {
    let dir = Temp::new();
    let root = dir.0.clone();
    let lease = Arc::new(storage::lease(&root).unwrap());
    let writer = Arc::new(storage::Writer::default());
    let old_sequence = writer.reserve();
    let new_sequence = writer.reserve();
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let (entered, ready) = tokio::sync::oneshot::channel();
    let gate_old = gate.clone();
    let old_writer = writer.clone();
    let old_root = root.clone();
    let old_lease = lease.clone();
    let old = tokio::spawn(async move {
        tokio::task::spawn_blocking(move||{
            let _lease=old_lease;let _=entered.send(());
            let (lock,wake)=&*gate_old;let mut released=lock.lock().unwrap();while !*released{released=wake.wait(released).unwrap();}
            old_writer.write(old_sequence,&old_root,&json!([{"id":"one","accountId":"a@example.org","provider":"gmail","state":"queued"}])).unwrap();
        }).await.unwrap();
    });
    ready.await.unwrap();
    old.abort();
    let _ = old.await;
    let newer = json!([{"id":"one","accountId":"a@example.org","provider":"gmail","state":"sent"}]);
    writer.write(new_sequence, &root, &newer).unwrap();
    drop(lease);
    assert!(
        matches!(storage::lease(&root), Err("outbox_in_use")),
        "cancelled caller must not release an active blocking writer's lease"
    );
    let (lock, wake) = &*gate;
    *lock.lock().unwrap() = true;
    wake.notify_one();
    for _ in 0..100 {
        if storage::lease(&root).is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let _lease = storage::lease(&root).unwrap();
    assert_eq!(
        storage::read(&root).unwrap(),
        newer,
        "old queued checkpoint must not overwrite confirmed sent receipt"
    );
}

#[tokio::test]
async fn successful_receipts_are_compact_and_do_not_fill_the_active_queue() {
    let dir = Temp::new();
    let mut old = Vec::new();
    for i in 0..129 {
        old.push(json!({"id":format!("old{i}"),"accountId":"a@example.org","provider":"gmail","payload":{"raw":"old private body"},"state":"sent"}));
    }
    storage::write(&dir.0, &json!(old)).unwrap();
    let outbox = Outbox::with_root(
        Arc::new(|_| Box::pin(async { Ok(json!({})) })),
        Some(dir.0.clone()),
    );
    outbox
        .call("outbox.enqueue", &enqueue("new", "a@example.org", 0))
        .await
        .unwrap();
    wait_state(&outbox, "new", "a@example.org", "sent").await;
    outbox
        .call(
            "outbox.forget",
            &json!({"accountId":"a@example.org","sendId":"new"}),
        )
        .await
        .unwrap();
    let duplicate = outbox
        .call("outbox.enqueue", &enqueue("new", "a@example.org", 0))
        .await
        .unwrap();
    assert_eq!(
        duplicate["duplicate"], true,
        "acknowledgement cannot erase no-resend identity"
    );
    let bytes = std::fs::read_to_string(dir.0.join("omamail/outbox.json")).unwrap();
    assert!(!bytes.contains("old private body"));
    assert!(!bytes.contains("synthetic-private-body"));
}

#[tokio::test]
async fn queue_preserves_large_composed_payload_without_the_old_sixteen_megabyte_cutoff() {
    let dir = Temp::new();
    let outbox = Outbox::with_root(
        Arc::new(|_| Box::pin(async { panic!("queued fixture must never send") })),
        Some(dir.0.clone()),
    );
    // A 20 MiB binary attachment grows twice through MIME and outer base64url.
    let raw = "A".repeat(38 * 1024 * 1024);
    let params = json!({"accountId":"large@example.org","provider":"gmail","payload":{"raw":raw},"sendId":"large","delaySeconds":60});
    outbox.call("outbox.enqueue", &params).await.unwrap();
    let snapshot = outbox
        .call(
            "outbox.snapshot",
            &json!({"accountId":"large@example.org","includePayloads":true,"sendId":"large"}),
        )
        .await
        .unwrap();
    assert_eq!(
        snapshot["entries"][0]["payload"]["raw"]
            .as_str()
            .unwrap()
            .len(),
        38 * 1024 * 1024
    );
    outbox.shutdown().await.unwrap();
}

#[test]
fn test_directories_retry_collisions_without_reusing_or_removing_existing_data() {
    use std::os::unix::fs::PermissionsExt;
    let parent = Temp::new();
    let base = parent.0.join("occupied");
    std::fs::create_dir(&base).unwrap();
    std::fs::write(base.join("sentinel"), b"preserve").unwrap();
    let allocated = Temp::create(base.clone());
    assert_ne!(allocated.0, base);
    assert_eq!(std::fs::read(base.join("sentinel")).unwrap(), b"preserve");
    assert_eq!(
        std::fs::metadata(&allocated.0)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}
