use super::*;
use crate::providers::imap::{
    line,
    tests::{params, server},
    write as send,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::oneshot,
};

const FAST: Timing = Timing {
    refresh: Duration::from_secs(3600),
    coalesce: Duration::from_millis(50),
    first_retry: Duration::from_millis(1),
    last_retry: Duration::from_millis(1),
};

/// Greeting, LOGIN and CAPABILITY, from the server's side.
async fn open(listener: &TcpListener, capabilities: &[u8]) -> Wire {
    let (socket, _) = listener.accept().await.unwrap();
    let mut w: Wire = BufReader::new(Box::new(socket));
    send(&mut w, b"* OK ready\r\n").await.unwrap();
    assert_eq!(
        line(&mut w).await.unwrap(),
        b"O1 LOGIN \"synthetic\" \"password\"\r\n"
    );
    send(&mut w, b"O1 OK login\r\n").await.unwrap();
    assert_eq!(line(&mut w).await.unwrap(), b"O1 CAPABILITY\r\n");
    send(
        &mut w,
        &[b"* CAPABILITY ", capabilities, b"\r\nO1 OK capability\r\n"].concat(),
    )
    .await
    .unwrap();
    w
}

/// EXAMINE, then the client's IDLE, read but not yet answered.
async fn examined(w: &mut Wire) {
    assert_eq!(line(w).await.unwrap(), b"O1 EXAMINE \"INBOX\"\r\n");
    // An EXISTS in the EXAMINE answer describes the mailbox, not a change.
    send(w, b"* 4 EXISTS\r\nO1 OK [READ-ONLY] examined\r\n")
        .await
        .unwrap();
    assert_eq!(line(w).await.unwrap(), b"O1 IDLE\r\n");
}

async fn idling(listener: &TcpListener) -> Wire {
    let mut w = open(listener, b"IMAP4rev1 IDLE").await;
    examined(&mut w).await;
    send(&mut w, b"+ idling\r\n").await.unwrap();
    w
}

/// The DONE that ends one IDLE, answered, and the IDLE that replaces it.
async fn refreshed(w: &mut Wire, answer: &[u8]) {
    assert_eq!(line(w).await.unwrap(), b"DONE\r\n");
    send(w, answer).await.unwrap();
    assert_eq!(line(w).await.unwrap(), b"O1 IDLE\r\n");
}

fn spawn_session(
    port: u16,
    changed: &Arc<Notify>,
    timing: Timing,
) -> tokio::task::JoinHandle<Result<Infallible>> {
    let changed = changed.clone();
    tokio::spawn(async move { session(params(port), &changed, false, timing, &mut false).await })
}

/// A stored permit: `notify_one` was called since the last `notified`.
async fn permit(changed: &Notify) -> bool {
    tokio::time::timeout(Duration::ZERO, changed.notified())
        .await
        .is_ok()
}

async fn woken(changed: &Notify) {
    tokio::time::timeout(Duration::from_secs(2), changed.notified())
        .await
        .expect("the check was not woken");
}

async fn within<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(2), future)
        .await
        .expect("timed out")
}

#[tokio::test]
async fn a_burst_of_changes_wakes_the_check_once() {
    let (listener, port) = server().await;
    let changed = Arc::new(Notify::new());
    let server = tokio::spawn(async move {
        let mut w = idling(&listener).await;
        send(
            &mut w,
            b"* 5 EXISTS\r\n* OK Still here\r\n* 6 EXISTS\r\n* 5 FETCH (FLAGS (\\Seen))\r\n",
        )
        .await
        .unwrap();
        line(&mut w).await.ok();
    });
    let client = spawn_session(port, &changed, FAST);
    woken(&changed).await;
    // Several coalescing periods later, nothing further is waiting.
    tokio::time::sleep(FAST.coalesce * 4).await;
    assert!(!permit(&changed).await);
    client.abort();
    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_that_never_stops_sending_cannot_hold_off_the_wake_or_the_refresh() {
    let (listener, port) = server().await;
    let changed = Arc::new(Notify::new());
    let (done_seen, done) = oneshot::channel();
    let server = tokio::spawn(async move {
        let w = idling(&listener).await;
        let (mut read, mut write) = tokio::io::split(w);
        let flood = tokio::spawn(async move {
            let burst = b"* 1 EXISTS\r\n".repeat(64);
            while write.write_all(&burst).await.is_ok() {}
        });
        // Anything the client sends while idling can only be DONE.
        let mut first = [0u8; 4];
        read.read_exact(&mut first).await.unwrap();
        assert_eq!(&first, b"DONE");
        done_seen.send(()).unwrap();
        flood.abort();
    });
    let client = spawn_session(
        port,
        &changed,
        Timing {
            refresh: Duration::from_millis(300),
            ..FAST
        },
    );
    woken(&changed).await;
    within(done).await.unwrap();
    client.abort();
    server.abort();
}

#[tokio::test]
async fn idle_is_reissued_each_refresh_and_keepalives_wake_nothing() {
    let (listener, port) = server().await;
    let changed = Arc::new(Notify::new());
    let (reissued, done) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut w = idling(&listener).await;
        send(&mut w, b"* OK Still here\r\n").await.unwrap();
        for _ in 0..2 {
            // Status atoms are case-insensitive.
            refreshed(&mut w, b"O1 ok idle done\r\n").await;
            send(&mut w, b"+ idling\r\n").await.unwrap();
        }
        reissued.send(()).unwrap();
        line(&mut w).await.ok();
    });
    let client = spawn_session(
        port,
        &changed,
        Timing {
            refresh: Duration::from_millis(20),
            // Shorter than a refresh, so a keepalive taken for a change would
            // have woken the check before the first DONE.
            coalesce: Duration::from_millis(1),
            ..FAST
        },
    );
    within(done).await.unwrap();
    assert!(!permit(&changed).await);
    client.abort();
    server.abort();
}

#[tokio::test]
async fn a_change_during_done_wakes_the_check_from_the_next_idle() {
    let (listener, port) = server().await;
    let changed = Arc::new(Notify::new());
    let server = tokio::spawn(async move {
        let mut w = idling(&listener).await;
        refreshed(&mut w, b"* 7 EXISTS\r\nO1 OK idle done\r\n").await;
        send(&mut w, b"+ idling\r\n").await.unwrap();
        line(&mut w).await.ok();
    });
    let client = spawn_session(
        port,
        &changed,
        Timing {
            refresh: Duration::from_millis(20),
            // Due well before the next refresh ends this IDLE too.
            coalesce: Duration::from_millis(1),
            ..FAST
        },
    );
    woken(&changed).await;
    client.abort();
    server.abort();
}

#[tokio::test]
async fn a_server_ending_idle_unasked_fails_the_session_instead_of_looping() {
    let (listener, port) = server().await;
    let server = tokio::spawn(async move {
        let mut w = idling(&listener).await;
        send(&mut w, b"O1 OK idle ended\r\n").await.unwrap();
        // No second IDLE: the connection is closed instead.
        assert!(line(&mut w).await.is_err());
    });
    let client = spawn_session(port, &Arc::new(Notify::new()), FAST);
    let Err(error) = within(client).await.unwrap();
    assert_eq!(error, "mail_connection_closed");
    server.await.unwrap();
}

#[tokio::test]
async fn a_refused_idle_after_a_working_session_is_retried_not_given_up() {
    let (listener, port) = server().await;
    let server = tokio::spawn(async move {
        let mut w = idling(&listener).await;
        refreshed(&mut w, b"O1 OK idle done\r\n").await;
        send(&mut w, b"O1 BAD [UNAVAILABLE] try later\r\n")
            .await
            .unwrap();
        line(&mut w).await.ok();
    });
    let mut worked = false;
    let Err(error) = within(session(
        params(port),
        &Notify::new(),
        false,
        Timing {
            refresh: Duration::from_millis(20),
            ..FAST
        },
        &mut worked,
    ))
    .await;
    assert_eq!(error, "imap_command_failed");
    assert!(worked);
    assert!(Backoff::new(FAST).after(error, worked).is_some());
    server.await.unwrap();
}

#[tokio::test]
async fn a_literal_cannot_end_idle_or_the_connection() {
    let (listener, port) = server().await;
    let changed = Arc::new(Notify::new());
    let (answered, done) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut w = idling(&listener).await;
        let forged = b"O1 OK\r\n* BYE forged\r\n";
        send(
            &mut w,
            &[
                format!("* 5 FETCH (BODY[HEADER] {{{}}}\r\n", forged.len()).as_bytes(),
                forged,
                b")\r\n",
            ]
            .concat(),
        )
        .await
        .unwrap();
        assert_eq!(line(&mut w).await.unwrap(), b"DONE\r\n");
        send(&mut w, b"O1 OK idle done\r\n").await.unwrap();
        answered.send(()).unwrap();
        line(&mut w).await.ok();
    });
    let client = spawn_session(
        port,
        &changed,
        Timing {
            refresh: Duration::from_millis(200),
            ..FAST
        },
    );
    woken(&changed).await;
    within(done).await.unwrap();
    assert!(!client.is_finished());
    client.abort();
    server.abort();
}

#[tokio::test]
async fn lines_and_literals_split_by_a_timeout_are_read_whole() {
    let (client, mut server) = tokio::io::duplex(64);
    let mut w: Wire = BufReader::new(Box::new(client));
    let mut lines = Lines::default();
    let interrupted = async |lines: &mut Lines, w: &mut Wire| {
        tokio::time::timeout(Duration::from_millis(20), lines.next(w))
            .await
            .is_err()
    };
    server.write_all(b"* 5 EXI").await.unwrap();
    assert!(interrupted(&mut lines, &mut w).await);
    server.write_all(b"STS\r\n").await.unwrap();
    assert_eq!(lines.next(&mut w).await.unwrap(), b"* 5 EXISTS\r\n");

    server
        .write_all(b"* 6 FETCH (BODY[] {10}\r\n12345")
        .await
        .unwrap();
    assert!(interrupted(&mut lines, &mut w).await);
    server.write_all(b"67890)\r\n* 7 EXISTS\r\n").await.unwrap();
    assert_eq!(
        lines.next(&mut w).await.unwrap(),
        b"* 6 FETCH (BODY[] {10}\r\n"
    );
    assert_eq!(lines.next(&mut w).await.unwrap(), b"* 7 EXISTS\r\n");
}

#[tokio::test]
async fn a_server_without_idle_is_asked_once() {
    let (listener, port) = server().await;
    let server = tokio::spawn(async move {
        let mut w = open(&listener, b"IMAP4rev1").await;
        // Nothing follows CAPABILITY: no EXAMINE, no IDLE, no second login.
        assert!(line(&mut w).await.is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
    within(supervise(
        || async move { Ok(params(port)) },
        &Notify::new(),
        FAST,
    ))
    .await;
    server.await.unwrap();
}

#[tokio::test]
async fn only_the_first_session_of_a_watch_skips_the_check() {
    let (listener, port) = server().await;
    let changed = Arc::new(Notify::new());
    let (first_idle, first_idle_seen) = oneshot::channel();
    let (end_first, first_ended) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let mut first = open(&listener, b"IMAP4rev1 IDLE").await;
        // The client has sent IDLE, so any announcement has already happened.
        examined(&mut first).await;
        first_idle.send(()).unwrap();
        first_ended.await.unwrap();
        send(&mut first, b"+ idling\r\n* BYE going away\r\n")
            .await
            .unwrap();
        drop(first);
        let mut second = idling(&listener).await;
        line(&mut second).await.ok();
    });
    let supervisor = tokio::spawn({
        let changed = changed.clone();
        async move { supervise(|| async move { Ok(params(port)) }, &changed, FAST).await }
    });
    first_idle_seen.await.unwrap();
    assert!(
        !permit(&changed).await,
        "the first session announced itself"
    );
    end_first.send(()).unwrap();
    woken(&changed).await;
    supervisor.abort();
    server.abort();
}

#[tokio::test]
async fn a_first_session_after_failed_attempts_asks_for_a_check() {
    let (listener, port) = server().await;
    let changed = Arc::new(Notify::new());
    let server = tokio::spawn(async move {
        let mut w = idling(&listener).await;
        line(&mut w).await.ok();
    });
    let attempts = Arc::new(AtomicUsize::new(0));
    let supervisor = tokio::spawn({
        let changed = changed.clone();
        let attempts = attempts.clone();
        async move {
            supervise(
                || {
                    let offline = attempts.fetch_add(1, Ordering::SeqCst) == 0;
                    async move {
                        if offline {
                            Err("mail_dns_failed")
                        } else {
                            Ok(params(port))
                        }
                    }
                },
                &changed,
                FAST,
            )
            .await
        }
    });
    woken(&changed).await;
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    supervisor.abort();
    server.abort();
}

#[test]
fn backoff_doubles_to_its_ceiling_resets_after_a_refresh_and_stops_only_for_missing_idle() {
    let timing = Timing {
        first_retry: Duration::from_secs(5),
        last_retry: Duration::from_secs(60),
        ..TIMING
    };
    let mut backoff = Backoff::new(timing);
    let delays: Vec<_> = (0..6)
        .map(|_| backoff.after("mail_network_failed", false).unwrap())
        .map(|delay| delay.as_secs())
        .collect();
    assert_eq!(delays, [5, 10, 20, 40, 60, 60]);
    assert_eq!(
        backoff.after("mail_connection_closed", true),
        Some(timing.first_retry)
    );
    // A session that never completed a refresh does not reset it.
    assert_eq!(
        backoff.after("mail_connection_closed", false),
        Some(Duration::from_secs(10))
    );
    for credential in ["mail_auth_failed", "auth_signed_out", "auth_refresh_failed"] {
        assert_eq!(backoff.after(credential, false), Some(timing.last_retry));
    }
    assert_eq!(
        backoff.after("imap_command_failed", false),
        Some(timing.last_retry)
    );
    assert_eq!(backoff.after("imap_idle_unsupported", true), None);
}

#[test]
fn jitter_adds_at_most_a_fifth() {
    for delay in [Duration::from_millis(1), Duration::from_secs(5)] {
        let jittered = jitter(delay);
        assert!(jittered >= delay && jittered < delay + delay / 5 + Duration::from_nanos(1));
    }
}

#[test]
fn a_wall_clock_jump_past_two_checks_means_the_machine_slept() {
    let last = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    assert!(!resumed(last, last + RESUME_CHECK));
    assert!(!resumed(last, last + RESUME_CHECK * 2));
    assert!(resumed(
        last,
        last + RESUME_CHECK * 2 + Duration::from_secs(1)
    ));
    // A clock set backwards is not a sleep.
    assert!(!resumed(last, last - Duration::from_secs(3600)));
}

#[test]
fn only_this_clients_tagged_ok_is_ok() {
    assert_eq!(tagged(b"O1 OK idle done\r\n"), Some(true));
    assert_eq!(tagged(b"O1 ok\r\n"), Some(true));
    assert_eq!(tagged(b"O1 OKAY\r\n"), Some(false));
    assert_eq!(tagged(b"O1 NO [LIMIT]\r\n"), Some(false));
    assert_eq!(tagged(b"O1 BAD\r\n"), Some(false));
    assert_eq!(tagged(b"* OK Still here\r\n"), None);
    assert_eq!(tagged(b"O2 OK\r\n"), None);
}

#[test]
fn only_numbered_exists_expunge_and_fetch_are_changes() {
    for change in [
        &b"* 12 EXISTS\r\n"[..],
        b"* 3 expunge\r\n",
        b"* 7 FETCH (FLAGS (\\Seen))\r\n",
    ] {
        assert_eq!(changes_inbox(change), Ok(true));
    }
    for quiet in [
        &b"* OK Still here\r\n"[..],
        b"* 4 RECENT\r\n",
        b"* FLAGS (\\Seen)\r\n",
        b"* EXISTS\r\n",
        b"+ idling\r\n",
        b"",
    ] {
        assert_eq!(changes_inbox(quiet), Ok(false));
    }
    assert_eq!(
        changes_inbox(b"* BYE idle timeout\r\n"),
        Err("mail_connection_closed")
    );
}
