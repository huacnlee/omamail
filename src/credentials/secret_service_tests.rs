//! Native D-Bus fixture. A private daemon keeps real credentials unreachable.
use super::*;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

fn path(value: &str) -> OwnedObjectPath {
    value.try_into().unwrap()
}

struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Service {
    denial: bool,
    missing: bool,
    /// Reports the item as present but locked, which the daemon answers over a
    /// connection that is still good.
    locked: Arc<AtomicBool>,
    unlock_denial: bool,
    unlocks: Arc<AtomicUsize>,
    /// Counts negotiated sessions, which is what tells a reused connection from
    /// one rebuilt per operation.
    sessions: Arc<AtomicUsize>,
    searches: Arc<AtomicUsize>,
    /// Searches to fail before answering, for exercising reconnection.
    failures: Arc<AtomicUsize>,
}
#[zbus::interface(name = "org.freedesktop.Secret.Service")]
impl Service {
    fn open_session(
        &self,
        _algorithm: &str,
        _input: Value<'_>,
    ) -> zbus::fdo::Result<(OwnedValue, OwnedObjectPath)> {
        if self.denial {
            return Err(zbus::fdo::Error::AccessDenied("synthetic denial".into()));
        }
        self.sessions.fetch_add(1, Ordering::SeqCst);
        Ok((
            Value::from(vec![2u8]).try_into().unwrap(),
            path("/org/freedesktop/secrets/session/one"),
        ))
    }
    fn read_alias(&self, _name: &str) -> OwnedObjectPath {
        path("/org/freedesktop/secrets/collection/default")
    }
    fn search_items(
        &self,
        _attributes: HashMap<String, String>,
    ) -> zbus::fdo::Result<(Vec<OwnedObjectPath>, Vec<OwnedObjectPath>)> {
        self.searches.fetch_add(1, Ordering::SeqCst);
        if self
            .failures
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok()
        {
            return Err(zbus::fdo::Error::Failed("synthetic failure".into()));
        }
        if self.locked.load(Ordering::SeqCst) {
            return Ok((vec![], vec![path("/org/freedesktop/secrets/item/one")]));
        }
        Ok((
            if self.missing {
                vec![]
            } else {
                vec![path("/org/freedesktop/secrets/item/one")]
            },
            vec![],
        ))
    }
    fn unlock(
        &self,
        objects: Vec<OwnedObjectPath>,
    ) -> zbus::fdo::Result<(Vec<OwnedObjectPath>, OwnedObjectPath)> {
        self.unlocks.fetch_add(1, Ordering::SeqCst);
        if self.unlock_denial {
            return Err(zbus::fdo::Error::AccessDenied(
                "synthetic unlock denial".into(),
            ));
        }
        self.locked.store(false, Ordering::SeqCst);
        Ok((objects, path("/")))
    }
}
/// The default collection, so a Put reaches CreateItem. It counts the calls
/// that actually reached the daemon, then refuses, which is the shape of a
/// write the daemon commits and the client never hears about.
struct Collection {
    creates: Arc<AtomicUsize>,
}
#[zbus::interface(name = "org.freedesktop.Secret.Collection")]
impl Collection {
    #[zbus(property)]
    fn locked(&self) -> bool {
        false
    }
    fn create_item(
        &self,
        _properties: HashMap<String, zbus::zvariant::OwnedValue>,
        _secret: (OwnedObjectPath, Vec<u8>, Vec<u8>, String),
        _replace: bool,
    ) -> zbus::fdo::Result<(OwnedObjectPath, OwnedObjectPath)> {
        self.creates.fetch_add(1, Ordering::SeqCst);
        Err(zbus::fdo::Error::Failed("synthetic write failure".into()))
    }
}
struct Item;
#[zbus::interface(name = "org.freedesktop.Secret.Item")]
impl Item {
    #[zbus(property)]
    fn locked(&self) -> bool {
        false
    }
    fn delete(&self) -> OwnedObjectPath {
        path("/org/freedesktop/secrets/prompt/stuck")
    }
}
struct Prompt(Arc<AtomicUsize>);
#[zbus::interface(name = "org.freedesktop.Secret.Prompt")]
impl Prompt {
    fn prompt(&self, _window_id: &str) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
    // Deliberately never emits Completed. This is a real signal wait inside the
    // secret-service crate, rather than a pending future substituted for it.
}

struct Fixture {
    runtime: tokio::runtime::Runtime,
    connection: zbus::Connection,
    address: String,
    prompts: Arc<AtomicUsize>,
    sessions: Arc<AtomicUsize>,
    searches: Arc<AtomicUsize>,
    unlocks: Arc<AtomicUsize>,
    creates: Arc<AtomicUsize>,
    _daemon: Daemon,
}
impl Fixture {
    fn new(denial: bool, missing: bool) -> Self {
        Self::build(denial, missing, false, false, 0)
    }
    fn with_failures(denial: bool, missing: bool, failures: usize) -> Self {
        Self::build(denial, missing, false, false, failures)
    }
    fn with_locked_item() -> Self {
        Self::build(false, false, true, false, 0)
    }
    fn with_refused_unlock() -> Self {
        Self::build(false, false, true, true, 0)
    }
    fn build(
        denial: bool,
        missing: bool,
        locked: bool,
        unlock_denial: bool,
        failures: usize,
    ) -> Self {
        let mut daemon = Daemon(
            Command::new("dbus-daemon")
                .args([
                    "--session",
                    "--nofork",
                    "--print-address=1",
                    "--address=unix:tmpdir=/tmp",
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("native credential gate requires dbus-daemon"),
        );
        let mut address = String::new();
        BufReader::new(daemon.0.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        let address = address.trim().to_owned();
        let prompts = Arc::new(AtomicUsize::new(0));
        let sessions = Arc::new(AtomicUsize::new(0));
        let searches = Arc::new(AtomicUsize::new(0));
        let unlocks = Arc::new(AtomicUsize::new(0));
        let locked = Arc::new(AtomicBool::new(locked));
        let failures = Arc::new(AtomicUsize::new(failures));
        let creates = Arc::new(AtomicUsize::new(0));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let connection = runtime.block_on(async {
            zbus::connection::Builder::address(address.as_str())
                .unwrap()
                .name("org.freedesktop.secrets")
                .unwrap()
                .serve_at(
                    "/org/freedesktop/secrets",
                    Service {
                        denial,
                        missing,
                        locked,
                        unlock_denial,
                        unlocks: unlocks.clone(),
                        sessions: sessions.clone(),
                        searches: searches.clone(),
                        failures: failures.clone(),
                    },
                )
                .unwrap()
                .serve_at("/org/freedesktop/secrets/item/one", Item)
                .unwrap()
                .serve_at(
                    "/org/freedesktop/secrets/collection/default",
                    Collection {
                        creates: creates.clone(),
                    },
                )
                .unwrap()
                .serve_at(
                    "/org/freedesktop/secrets/prompt/stuck",
                    Prompt(prompts.clone()),
                )
                .unwrap()
                .build()
                .await
                .unwrap()
        });
        Self {
            runtime,
            connection,
            address,
            prompts,
            sessions,
            searches,
            unlocks,
            creates,
            _daemon: daemon,
        }
    }
    fn client(&self) -> impl Future<Output = Result<zbus::Connection, Error>> + use<> {
        let address = self.address.clone();
        async move {
            zbus::connection::Builder::address(address.as_str())
                .unwrap()
                .build()
                .await
                .map_err(|_| Error::Unavailable)
        }
    }
}
fn key() -> CredentialKey {
    CredentialKey {
        provider: "imap".into(),
        account_id: "imap:prompt-fixture@example.invalid".into(),
        kind: CredentialKind::ImapPassword,
    }
}

#[test]
#[ignore = "requires native dbus-daemon; mandatory in the Linux credential gate"]
fn credentials_native_linux_never_completing_prompt_releases_worker_and_connection() {
    let fixture = Fixture::new(false, false);
    let connect = fixture.client();
    let guard = Arc::new(Mutex::new(()));
    let worker_guard = guard.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let (name_sender, name_receiver) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _guard = worker_guard.lock().unwrap();
        let result = run_with(
            &key(),
            Operation::Delete,
            async {
                let connection = connect.await?;
                name_sender
                    .send(connection.unique_name().unwrap().to_string())
                    .unwrap();
                Ok(connection)
            },
            Duration::from_millis(150),
        );
        sender.send(result.map(|_| ())).unwrap();
    });
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(3)).unwrap(),
        Err(Error::Unavailable)
    );
    worker.join().unwrap();
    assert!(
        guard.try_lock().is_ok(),
        "timed-out credential worker retained the account mutex"
    );
    assert_eq!(
        fixture.prompts.load(Ordering::SeqCst),
        1,
        "fixture did not reach the native prompt signal wait"
    );
    let name = name_receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    fixture.runtime.block_on(async {
        let proxy = zbus::fdo::DBusProxy::new(&fixture.connection)
            .await
            .unwrap();
        assert!(
            !proxy
                .name_has_owner(name.as_str().try_into().unwrap())
                .await
                .unwrap(),
            "timed-out credential connection remains registered on the bus"
        );
    });
}

#[test]
#[ignore = "requires native dbus-daemon; mandatory in the Linux credential gate"]
fn credentials_native_linux_denial_and_unavailability_are_not_missing() {
    let denied = Fixture::new(true, false);
    assert!(matches!(
        run_with(&key(), Operation::Get, denied.client(), DEADLINE),
        Err(Error::Unavailable)
    ));
    let missing = Fixture::new(false, true);
    assert!(matches!(
        run_with(&key(), Operation::Get, missing.client(), DEADLINE),
        Err(Error::Missing)
    ));
    let failed = async {
        zbus::connection::Builder::address("unix:path=/omamail-no-such-synthetic-bus/socket")
            .unwrap()
            .build()
            .await
            .map_err(|_| Error::Unavailable)
    };
    assert!(matches!(
        run_with(&key(), Operation::Get, failed, DEADLINE),
        Err(Error::Unavailable)
    ));
}

/// The regression test for the per-operation session. Opening a session for
/// every credential read and force-closing it afterwards races
/// gnome-keyring's own handshake, which aborts the daemon holding every
/// credential on the machine. Against the unfixed code this counts three.
#[test]
#[ignore = "requires native dbus-daemon; mandatory in the Linux credential gate"]
fn credentials_native_linux_reuses_one_session_across_operations() {
    let fixture = Fixture::new(false, true);
    let shared = Shared::new().unwrap();

    for _ in 0..3 {
        assert!(matches!(
            run_on(
                &shared,
                &key(),
                Operation::Get,
                || fixture.client(),
                DEADLINE
            ),
            Err(Error::Missing)
        ));
    }

    assert_eq!(
        fixture.sessions.load(Ordering::SeqCst),
        1,
        "each credential operation negotiated its own session"
    );
}

/// A session the daemon has forgotten fails like an absent one, so the
/// operation has to survive it rather than report a failure the caller cannot
/// act on. Without the retry the first read after a daemon restart just fails.
#[test]
#[ignore = "requires native dbus-daemon; mandatory in the Linux credential gate"]
fn credentials_native_linux_reconnects_after_a_transport_failure() {
    let fixture = Fixture::with_failures(false, true, 1);
    let shared = Shared::new().unwrap();

    assert!(
        matches!(
            run_on(
                &shared,
                &key(),
                Operation::Get,
                || fixture.client(),
                DEADLINE
            ),
            Err(Error::Missing)
        ),
        "a transport failure was reported instead of being retried"
    );
    assert_eq!(
        fixture.sessions.load(Ordering::SeqCst),
        2,
        "the failed session was reused rather than replaced"
    );
}

/// Missing is an answer, not a transport failure: it must neither drop the
/// session nor spend the retry, or every absent credential would cost a
/// reconnection and a second search.
#[test]
#[ignore = "requires native dbus-daemon; mandatory in the Linux credential gate"]
fn credentials_native_linux_keeps_the_session_when_an_item_is_missing() {
    let fixture = Fixture::new(false, true);
    let shared = Shared::new().unwrap();

    assert!(matches!(
        run_on(
            &shared,
            &key(),
            Operation::Get,
            || fixture.client(),
            DEADLINE
        ),
        Err(Error::Missing)
    ));

    assert_eq!(
        fixture.searches.load(Ordering::SeqCst),
        1,
        "a missing item was retried as though the transport had failed"
    );
    assert_eq!(fixture.sessions.load(Ordering::SeqCst), 1);
}

/// A write is never repeated. A request already on the socket cannot be
/// retracted, so a `CreateItem` the daemon committed before the connection
/// failed would be made a second time, leaving two items with the same
/// attributes; `find` answers `Ambiguous` for both from then on, and the
/// credential can no longer be read or deleted by Omamail at all. The daemon
/// counts the calls that reached it, so this asserts the forbidden effect did
/// not happen rather than only that an error came back.
#[test]
#[ignore = "requires native dbus-daemon; mandatory in the Linux credential gate"]
fn credentials_native_linux_a_failed_write_reaches_the_daemon_once() {
    let fixture = Fixture::new(false, true);
    let shared = Shared::new().unwrap();

    assert!(matches!(
        run_on(
            &shared,
            &key(),
            Operation::Put(b"synthetic"),
            || fixture.client(),
            DEADLINE
        ),
        Err(Error::Unavailable)
    ));
    assert_eq!(
        fixture.creates.load(Ordering::SeqCst),
        1,
        "the daemon was asked to create the item twice for one put"
    );
}

/// A locked keyring is an answer, not a broken connection. Dropping the session
/// for it would renegotiate a session on every read in exactly the state where
/// the daemon is least able to survive one.
#[test]
#[ignore = "requires native dbus-daemon; mandatory in the Linux credential gate"]
fn credentials_native_linux_a_refused_unlock_keeps_the_session() {
    let fixture = Fixture::with_refused_unlock();
    let shared = Shared::new().unwrap();

    for _ in 0..2 {
        assert!(matches!(
            run_on(
                &shared,
                &key(),
                Operation::Get,
                || fixture.client(),
                DEADLINE
            ),
            Err(Error::Unavailable)
        ));
    }

    assert_eq!(
        fixture.sessions.load(Ordering::SeqCst),
        1,
        "a locked item was treated as a failed connection and renegotiated"
    );
    assert_eq!(fixture.searches.load(Ordering::SeqCst), 2);
}

/// A locked result is still the matching credential. Blank-password Secret
/// Service collections unlock without a prompt, so the item must be returned
/// from the same search instead of being discarded as unavailable.
#[test]
#[ignore = "requires native dbus-daemon; mandatory in the Linux credential gate"]
fn credentials_native_linux_silently_unlocks_a_locked_item() {
    let fixture = Fixture::with_locked_item();
    let attrs: HashMap<_, _> = key().attributes().unwrap().into_iter().collect();

    let found = fixture.runtime.block_on(async {
        let connection = fixture.client().await.unwrap();
        let service = SecretService::connect_with_existing(EncryptionType::Dh, connection)
            .await
            .unwrap();
        find(&service, &attrs).await.map(|item| item.is_some())
    });

    assert!(matches!(found, Ok(true)));
    assert_eq!(fixture.unlocks.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.searches.load(Ordering::SeqCst), 1);
}

/// One operation costs the caller one deadline. Opening the session and running
/// the operation share a single budget, so a connect that never answers cannot
/// be waited for once and then waited for again.
#[test]
fn credentials_native_linux_a_stalled_connect_costs_one_deadline() {
    let shared = Shared::new().unwrap();
    let deadline = Duration::from_millis(300);

    let started = std::time::Instant::now();
    let result = run_on(
        &shared,
        &key(),
        Operation::Get,
        || async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Err(Error::Unavailable)
        },
        deadline,
    );
    let elapsed = started.elapsed();

    assert!(matches!(result, Err(Error::Unavailable)));
    assert!(
        elapsed < deadline + deadline / 2,
        "one credential operation waited {elapsed:?} for a {deadline:?} deadline"
    );
}
