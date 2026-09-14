use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[tokio::test]
async fn owner_submission_ack_loss_replays_one_durable_id_without_another_delivery() {
    use tokio::io::AsyncWriteExt;
    let dir = Temp::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let owner = Outbox::with_root(
        Arc::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err("outbox_delivery_unknown") })
        }),
        Some(dir.0.clone()),
    );
    owner
        .call("outbox.snapshot", &json!({"accountId":"a@example.org"}))
        .await
        .unwrap();
    let params = enqueue("lost-reply", "a@example.org", 0);
    let mut socket = crate::platform::ipc::LocalEndpoint::outbox(&dir.0)
        .unwrap()
        .connect()
        .await
        .unwrap();
    let bytes = json!({"method":"outbox.enqueue","params":params})
        .to_string()
        .into_bytes();
    socket.write_u32(bytes.len() as u32).await.unwrap();
    socket.write_all(&bytes).await.unwrap();
    // Never consume the acknowledgement. Keep the peer alive until accept has
    // authenticated it: Darwin cannot recover peer credentials after both ends
    // have been closed. Shutting the write side still sends the complete frame.
    socket.shutdown().await.unwrap();
    wait_state(&owner, "lost-reply", "a@example.org", "unknown").await;
    drop(socket);
    let submitter = Outbox::with_root(
        Arc::new(|_| Box::pin(async { panic!("submitter must never deliver") })),
        Some(dir.0.clone()),
    );
    let replay = submitter
        .shared_call("outbox.enqueue", &params)
        .await
        .unwrap();
    assert_eq!(replay["duplicate"], true);
    let result = submitter
        .wait_for_send("a@example.org", "lost-reply")
        .await
        .unwrap();
    assert_eq!(result["entries"][0]["state"], "unknown");
    assert!(result["entries"][0].get("payload").is_none());
    let stored = storage::read(&dir.0).unwrap();
    assert_eq!(stored.as_array().unwrap().len(), 1);
    assert_eq!(stored[0]["state"], "unknown");
    let mut conflicting = params;
    conflicting["payload"]["raw"] = json!("different");
    assert_eq!(
        submitter.shared_call("outbox.enqueue", &conflicting).await,
        Err("outbox_send_id_conflict")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn owner_bridge_rejects_unbounded_frames_unkeyed_mutations_and_payload_reads() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let dir = Temp::new();
    let owner = Outbox::with_root(
        Arc::new(|_| Box::pin(async { panic!("invalid bridge request must not deliver") })),
        Some(dir.0.clone()),
    );
    owner
        .call("outbox.snapshot", &json!({"accountId":"a@example.org"}))
        .await
        .unwrap();
    let before = storage::read(&dir.0).unwrap();
    for (method, params) in [
        (
            "outbox.flush",
            json!({"accountId":"a@example.org","sendId":"one"}),
        ),
        (
            "outbox.snapshot",
            json!({"accountId":"a@example.org","sendId":"one","includePayloads":true}),
        ),
        (
            "outbox.enqueue",
            json!({"accountId":"a@example.org","provider":"gmail","payload":{"raw":"private"}}),
        ),
        ("outbox.enqueue", enqueue("one\0", "a@example.org", 0)),
        ("outbox.enqueue", enqueue("one\r\n", "a@example.org", 0)),
        ("outbox.enqueue", enqueue("one\n", "a@example.org", 0)),
    ] {
        assert_eq!(
            ipc::request(&dir.0, method, &params).await,
            Err("outbox_invalid_params")
        );
    }
    for (length, bytes) in [(u32::MAX, b"".as_slice()), (1, b"{".as_slice())] {
        let mut socket = crate::platform::ipc::LocalEndpoint::outbox(&dir.0)
            .unwrap()
            .connect()
            .await
            .unwrap();
        socket.write_u32(length).await.unwrap();
        socket.write_all(bytes).await.unwrap();
        let mut reply = [0; 1];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), socket.read(&mut reply))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }
    assert_eq!(storage::read(&dir.0).unwrap(), before);
}

#[cfg(unix)]
#[tokio::test]
async fn owner_socket_refuses_symlinks_and_non_socket_entries_without_removing_them() {
    use std::os::unix::fs::symlink;
    for link in [true, false] {
        let dir = Temp::new();
        std::fs::create_dir(dir.0.join("omamail")).unwrap();
        let target = dir.0.join("sentinel");
        std::fs::write(&target, b"private sentinel").unwrap();
        let socket = dir.0.join("omamail/outbox.sock");
        if link {
            symlink(&target, &socket).unwrap();
        } else {
            std::fs::write(&socket, b"socket sentinel").unwrap();
        }
        let owner = Outbox::with_root(
            Arc::new(|_| Box::pin(async { panic!("unsafe socket must not deliver") })),
            Some(dir.0.clone()),
        );
        assert_eq!(
            owner
                .call("outbox.enqueue", &enqueue("one", "a@example.org", 0))
                .await,
            Err("outbox_storage_unsafe")
        );
        assert_eq!(std::fs::read(target).unwrap(), b"private sentinel");
        assert_eq!(
            std::fs::symlink_metadata(&socket)
                .unwrap()
                .file_type()
                .is_symlink(),
            link
        );
        assert_eq!(
            std::fs::read(socket).unwrap(),
            if link {
                b"private sentinel".as_slice()
            } else {
                b"socket sentinel".as_slice()
            }
        );
    }
}

#[tokio::test]
async fn one_shot_wait_does_not_claim_a_terminal_state_when_final_persistence_fails() {
    let dir = Temp::new();
    let target = dir.0.join("omamail/outbox.json");
    let outbox = Outbox::with_root(
        Arc::new(move |_| {
            let target = target.clone();
            Box::pin(async move {
                std::fs::remove_file(&target).unwrap();
                std::fs::create_dir(&target).unwrap();
                Ok(json!({"id":"delivered"}))
            })
        }),
        Some(dir.0.clone()),
    );
    outbox.call("outbox.enqueue", &json!({"accountId":"a@example.org","provider":"gmail","payload":{"raw":"safe"},"sendId":"one","delaySeconds":0})).await.unwrap();
    assert!(
        outbox.wait_for_send("a@example.org", "one").await.is_err(),
        "a failed terminal write cannot be an authoritative sent result"
    );
}

#[tokio::test]
async fn mail_send_preview_is_write_free_and_execute_keeps_one_durable_job() {
    use crate::mail::{Account, Provider, SendRequest};
    struct Identities;
    impl crate::mail::send::IdentityLookup for Identities {
        fn identities<'a>(
            &'a self,
            _: &'a Account,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Value, &'static str>> + Send + 'a>,
        > {
            Box::pin(async {
                Ok(json!([{"email":"a@example.org","displayName":"Alias","isDefault":true}]))
            })
        }
    }
    fn request(execute: bool) -> SendRequest {
        SendRequest {
            account: Account {
                id: "a@example.org".into(),
                provider: Provider::Gmail,
            },
            from: String::new(),
            to: vec!["one@example.org".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Plan".into(),
            body: "private body\n".into(),
            attachments: vec![],
            execute,
            send_id: Some("explicit-send-1".into()),
        }
    }
    let dir = Temp::new();
    let jobs = Arc::new(Mutex::new(Vec::new()));
    let recorded = jobs.clone();
    let outbox = Outbox::with_root(
        Arc::new(move |job| {
            recorded.lock().unwrap().push(job);
            Box::pin(async { Err("outbox_delivery_unknown") })
        }),
        Some(dir.0.clone()),
    );
    let before = crate::mail::tests::fixture_tree(&dir.0);
    let preview = crate::mail::send::send_with(request(false), &Identities, &outbox)
        .await
        .unwrap();
    assert_eq!(preview["dryRun"], true);
    assert_eq!(crate::mail::tests::fixture_tree(&dir.0), before);
    assert!(jobs.lock().unwrap().is_empty());
    let result = crate::mail::send::send_with(request(true), &Identities, &outbox)
        .await
        .unwrap();
    assert_eq!(result["sendId"], "explicit-send-1");
    assert_eq!(result["outbox"]["entries"][0]["state"], "queued");
    let entry = &result["outbox"]["entries"][0];
    assert_eq!(
        entry["dueAt"].as_u64().unwrap() - entry["queuedAt"].as_u64().unwrap(),
        10_000
    );
    let duplicate = crate::mail::send::send_with(request(true), &Identities, &outbox)
        .await
        .unwrap();
    assert_eq!(duplicate["outbox"]["entries"].as_array().unwrap().len(), 1);
    let mut changed = request(true);
    changed.body = "different".into();
    assert_eq!(
        crate::mail::send::send_with(changed, &Identities, &outbox).await,
        Err("outbox_send_id_conflict")
    );
    outbox
        .call("outbox.flush", &json!({"accountId":"a@example.org"}))
        .await
        .unwrap();
    wait_state(&outbox, "explicit-send-1", "a@example.org", "unknown").await;
    let again = crate::mail::send::send_with(request(true), &Identities, &outbox)
        .await
        .unwrap();
    assert_eq!(again["outbox"]["entries"][0]["state"], "unknown");
    let jobs = jobs.lock().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["accountId"], "a@example.org");
    assert_eq!(jobs[0]["provider"], "gmail");
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(jobs[0]["payload"]["raw"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        mailparse::parse_mail(&bytes).unwrap().get_body().unwrap(),
        "private body\n"
    );
}
struct Temp(PathBuf);

#[cfg(unix)]
struct ForkedDescriptors(i32, std::os::unix::net::UnixStream);
#[cfg(unix)]
impl ForkedDescriptors {
    fn new() -> Self {
        use std::io::Read;
        use std::os::fd::AsRawFd;
        let (mut parent, child) = std::os::unix::net::UnixStream::pair().unwrap();
        let child_fd = child.as_raw_fd();
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            // Between fork and exec only async-signal-safe syscalls are allowed.
            // Keep all inherited descriptors open until the parent ends the test.
            let mut byte = 1u8;
            unsafe {
                libc::write(child_fd, (&byte as *const u8).cast(), 1);
                libc::read(child_fd, (&mut byte as *mut u8).cast(), 1);
                libc::_exit(0);
            }
        }
        let mut ready = [0];
        parent.read_exact(&mut ready).unwrap();
        Self(pid, parent)
    }
}
#[cfg(unix)]
impl Drop for ForkedDescriptors {
    fn drop(&mut self) {
        use std::io::Write;
        let _ = self.1.write_all(&[1]);
        unsafe {
            libc::waitpid(self.0, std::ptr::null_mut(), 0);
        }
    }
}

#[cfg(unix)]
#[test]
fn forked_child_drop_cannot_unlock_its_parent_lease() {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    if crate::mail::tests::isolated() {
        return;
    }
    let dir = Temp::new();
    let lease = storage::lease(&dir.0).unwrap();
    let (mut parent, child) = std::os::unix::net::UnixStream::pair().unwrap();
    let child_fd = child.as_raw_fd();
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0);
    if pid == 0 {
        // Lease/File destruction uses only getpid/flock/close, not allocation.
        drop(lease);
        let byte = 1u8;
        unsafe {
            libc::write(child_fd, (&byte as *const u8).cast(), 1);
            libc::_exit(0);
        }
    }
    drop(child);
    let mut ready = [0];
    parent.read_exact(&mut ready).unwrap();
    unsafe {
        libc::waitpid(pid, std::ptr::null_mut(), 0);
    }
    assert!(
        matches!(storage::lease(&dir.0), Err("outbox_in_use")),
        "a child destructor must not release its parent's lease"
    );
    drop(lease);
    assert!(storage::lease(&dir.0).is_ok());
}

#[cfg(unix)]
#[test]
fn forked_child_descriptor_cannot_extend_the_last_owner_lease() {
    use std::os::fd::AsRawFd;
    if crate::mail::tests::isolated() {
        return;
    }
    let dir = Temp::new();
    let lease = Arc::new(storage::lease(&dir.0).unwrap());
    let writer = lease.clone();
    let fd = lease.as_raw_fd();
    assert_ne!(
        unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
    let _child = ForkedDescriptors::new();
    #[cfg(target_os = "linux")]
    let inherited = format!("/proc/{}/fd/{fd}", _child.0);
    #[cfg(target_os = "linux")]
    let lock_path = dir.0.join("omamail/outbox.lock");
    #[cfg(target_os = "linux")]
    assert_eq!(std::fs::read_link(&inherited).unwrap(), lock_path);
    drop(lease);
    assert!(
        matches!(storage::lease(&dir.0), Err("outbox_in_use")),
        "an active writer must retain exclusivity"
    );
    drop(writer);
    assert_eq!(
        unsafe { libc::fcntl(fd, libc::F_GETFD) },
        -1,
        "parent closed its final descriptor"
    );
    #[cfg(target_os = "linux")]
    assert_eq!(
        std::fs::read_link(&inherited).unwrap(),
        lock_path,
        "the pre-exec child still holds its inherited descriptor"
    );
    let successor = storage::lease(&dir.0);
    assert!(
        successor.is_ok(),
        "the child retained the parent's flock after its final legitimate owner closed: {:?}",
        successor.err()
    );
}

#[tokio::test]
async fn mail_send_idempotency_survives_sent_payload_removal_and_restart() {
    use crate::mail::{Account, Provider, SendRequest};
    fn prepared() -> crate::mail::send::Prepared {
        crate::mail::send::prepare(
            &SendRequest {
                account: Account {
                    id: "a@example.org".into(),
                    provider: Provider::Gmail,
                },
                from: String::new(),
                to: vec!["one@example.org".into()],
                cc: vec![],
                bcc: vec![],
                subject: "Plan".into(),
                body: "body".into(),
                attachments: vec![],
                execute: true,
                send_id: Some("replay".into()),
            },
            &json!([{"email":"a@example.org"}]),
        )
        .unwrap()
    }
    let dir = Temp::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let executor: Executor = Arc::new(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(json!({"id":"delivered"})) })
    });
    let outbox = Outbox::with_root(executor.clone(), Some(dir.0.clone()));
    let (first, concurrent) = tokio::join!(
        outbox.enqueue_mail(prepared(), Some("replay")),
        outbox.enqueue_mail(prepared(), Some("replay"))
    );
    assert_eq!(first.unwrap()["sendId"], "replay");
    assert_eq!(
        concurrent.unwrap()["outbox"]["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    outbox
        .call("outbox.flush", &json!({"accountId":"a@example.org"}))
        .await
        .unwrap();
    wait_state(&outbox, "replay", "a@example.org", "sent").await;
    let stored = outbox
        .call(
            "outbox.snapshot",
            &json!({"accountId":"a@example.org","sendId":"replay","includePayloads":true}),
        )
        .await
        .unwrap();
    assert!(stored["entries"][0].get("payload").is_none());
    outbox.shutdown().await.unwrap();
    drop(outbox);
    let reopened = Outbox::with_root(executor, Some(dir.0.clone()));
    let duplicate = reopened
        .enqueue_mail(prepared(), Some("replay"))
        .await
        .unwrap();
    assert_eq!(duplicate["outbox"]["entries"][0]["state"], "sent");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
impl Temp {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self::create(std::env::temp_dir().canonicalize().unwrap().join(format!(
            "omamail-outbox-{}-{stamp}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        )))
    }
    fn create(base: PathBuf) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::DirBuilderExt;
        for attempt in 0..1024 {
            let path = if attempt == 0 {
                base.clone()
            } else {
                base.with_extension(attempt.to_string())
            };
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            builder.mode(0o700);
            match builder.create(&path) {
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
        .and_then(|entry| entry["state"].as_str())
        .unwrap_or("")
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
#[cfg(unix)]
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

#[cfg(unix)]
#[tokio::test]
async fn shutdown_marks_wire_inflight_unknown_and_refuses_new_sends() {
    #[cfg(target_os = "linux")]
    use std::os::fd::AsRawFd;
    if crate::mail::tests::isolated() {
        return;
    }
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
    #[cfg(target_os = "linux")]
    let lease_fd = outbox
        .inner
        .lease
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .as_raw_fd();
    let _child = ForkedDescriptors::new();
    #[cfg(target_os = "linux")]
    let inherited = format!("/proc/{}/fd/{lease_fd}", _child.0);
    #[cfg(target_os = "linux")]
    let lock_path = dir.0.join("omamail/outbox.lock");
    #[cfg(target_os = "linux")]
    assert_eq!(std::fs::read_link(&inherited).unwrap(), lock_path);
    outbox.shutdown().await.unwrap();
    assert_eq!(state(&outbox, "inflight", "a@example.org").await, "unknown");
    assert_eq!(
        outbox
            .call("outbox.enqueue", &enqueue("late", "a@example.org", 0))
            .await,
        Err("outbox_stopping")
    );
    drop(outbox);
    #[cfg(target_os = "linux")]
    assert_eq!(
        std::fs::read_link(&inherited).unwrap(),
        lock_path,
        "reopen must work even while a pre-exec child keeps the original lease descriptor"
    );
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

#[cfg(unix)]
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
