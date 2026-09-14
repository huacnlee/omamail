//! Native D-Bus fixture. A private daemon keeps real credentials unreachable.
use super::*;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
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
        Ok((
            Value::from(vec![2u8]).try_into().unwrap(),
            path("/org/freedesktop/secrets/session/one"),
        ))
    }
    fn search_items(
        &self,
        _attributes: HashMap<String, String>,
    ) -> (Vec<OwnedObjectPath>, Vec<OwnedObjectPath>) {
        (
            if self.missing {
                vec![]
            } else {
                vec![path("/org/freedesktop/secrets/item/one")]
            },
            vec![],
        )
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
    _daemon: Daemon,
}
impl Fixture {
    fn new(denial: bool, missing: bool) -> Self {
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
                .serve_at("/org/freedesktop/secrets", Service { denial, missing })
                .unwrap()
                .serve_at("/org/freedesktop/secrets/item/one", Item)
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
