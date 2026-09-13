use super::{
    ActRequest, ListRequest, Mailbox, Mark, Provider, ReadRequest, SendRequest, resolve_account,
};
use serde_json::{Value, json};
use std::{
    env,
    ffi::OsString,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};

static ENVIRONMENT: Mutex<()> = Mutex::new(());
static FIXTURE_SERIAL: AtomicU64 = AtomicU64::new(0);

struct AccountFixture {
    _environment: MutexGuard<'static, ()>,
    previous: Option<OsString>,
    root: PathBuf,
}

#[derive(Debug, Eq, PartialEq)]
struct MetadataState {
    mode: u32,
    modified: (i64, i64),
    changed: (i64, i64),
}

#[derive(Debug, Eq, PartialEq)]
struct RegistryState {
    directory: MetadataState,
    registry: MetadataState,
    bytes: Vec<u8>,
}

fn metadata_state(path: &std::path::Path) -> MetadataState {
    let metadata = fs::metadata(path).unwrap();
    MetadataState {
        mode: metadata.mode(),
        modified: (metadata.mtime(), metadata.mtime_nsec()),
        changed: (metadata.ctime(), metadata.ctime_nsec()),
    }
}

fn registry_state(fixture: &AccountFixture) -> RegistryState {
    let directory = fixture.root.join("omamail");
    let registry = directory.join("accounts.json");
    RegistryState {
        directory: metadata_state(&directory),
        registry: metadata_state(&registry),
        bytes: fs::read(registry).unwrap(),
    }
}

impl Drop for AccountFixture {
    fn drop(&mut self) {
        unsafe {
            if let Some(previous) = &self.previous {
                env::set_var("XDG_CONFIG_HOME", previous);
            } else {
                env::remove_var("XDG_CONFIG_HOME");
            }
        }
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn account_fixture(registry: Value) -> AccountFixture {
    let environment = ENVIRONMENT
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let root = env::temp_dir().join(format!(
        "omamail-mail-tests-{}-{}",
        std::process::id(),
        FIXTURE_SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(root.join("omamail")).unwrap();
    fs::write(root.join("omamail/accounts.json"), registry.to_string()).unwrap();
    fs::set_permissions(root.join("omamail"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(
        root.join("omamail/accounts.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let previous = env::var_os("XDG_CONFIG_HOME");
    unsafe { env::set_var("XDG_CONFIG_HOME", &root) };
    AccountFixture {
        _environment: environment,
        previous,
        root,
    }
}

fn request_error<T>(result: Result<T, &'static str>) -> &'static str {
    match result {
        Ok(_) => panic!("request unexpectedly parsed"),
        Err(error) => error,
    }
}

#[test]
fn omitted_account_uses_active_and_explicit_account_never_falls_back() {
    let _env = account_fixture(json!({
        "version": 1,
        "activeId": "imap:active@example.org",
        "accounts": [
            {"provider":"gmail","email":"other@example.org"},
            {"provider":"imap","email":"active@example.org","imap":{"username":"active@example.org"}}
        ]
    }));
    assert_eq!(resolve_account("").unwrap().id, "imap:active@example.org");
    assert_eq!(
        resolve_account("OTHER@EXAMPLE.ORG").unwrap().id,
        "other@example.org"
    );
    assert_eq!(
        resolve_account("missing@example.org"),
        Err("mail_account_unknown")
    );
}

#[test]
fn account_resolution_never_changes_registry_or_directory_metadata() {
    let fixture = account_fixture(json!({
        "version": 1,
        "activeId": "active@example.org",
        "accounts": [{"provider":"gmail","email":"active@example.org"}]
    }));
    let before = registry_state(&fixture);
    assert_eq!(resolve_account("").unwrap().id, "active@example.org");
    assert_eq!(registry_state(&fixture), before);

    assert_eq!(
        resolve_account("missing@example.org"),
        Err("mail_account_unknown")
    );
    assert_eq!(registry_state(&fixture), before);
}

#[test]
fn empty_or_pending_only_registries_never_resolve_an_empty_account_id() {
    for registry in [
        json!({"version":1, "activeId":"", "accounts":[]}),
        json!({
            "version": 1,
            "activeId": "",
            "accounts": [{"provider":"hey", "email":"", "pending":true}]
        }),
    ] {
        let _fixture = account_fixture(registry);
        assert_eq!(resolve_account(""), Err("mail_account_unknown"));
        assert_eq!(
            resolve_account("missing@example.org"),
            Err("mail_account_unknown")
        );
    }
}

#[test]
fn public_vocabulary_is_closed() {
    assert_eq!(Mailbox::try_from("starred").unwrap(), Mailbox::Starred);
    assert_eq!(Mailbox::try_from("all"), Err("mail_mailbox_unknown"));
    for (text, expected) in [
        ("read", Mark::Read),
        ("unread", Mark::Unread),
        ("star", Mark::Star),
        ("unstar", Mark::Unstar),
    ] {
        assert_eq!(Mark::try_from(text).unwrap(), expected);
    }
    assert_eq!(Mark::try_from("starred"), Err("mail_mark_unknown"));
}

#[test]
fn provider_vocabulary_is_closed() {
    assert_eq!(Provider::try_from("jmap").unwrap().id(), "jmap");
    assert_eq!(Provider::try_from("JMAP"), Err("mail_provider_unknown"));
}

#[test]
fn request_parsers_resolve_an_omitted_account_and_preserve_canonical_values() {
    let _env = account_fixture(json!({
        "version": 1,
        "activeId": "active@example.org",
        "accounts": [{"provider":"gmail","email":"active@example.org"}]
    }));
    let list = ListRequest::try_from(&json!({
        "mailbox":"unread", "query":"from:one@example.org", "limit":25, "pageToken":"next"
    }))
    .unwrap();
    assert_eq!(list.account.id, "active@example.org");
    assert_eq!(list.mailbox, Mailbox::Unread);
    assert_eq!(list.query, "from:one@example.org");
    assert_eq!(list.limit, 25);
    assert_eq!(list.page_token, "next");

    let read = ReadRequest::try_from(&json!({"id":"opaque:message"})).unwrap();
    assert_eq!(read.account.id, "active@example.org");
    assert_eq!(read.id, "opaque:message");

    let action =
        ActRequest::try_from(&json!({"operation":"archive", "ids":["one", "two"]})).unwrap();
    assert_eq!(action.account.id, "active@example.org");
    assert_eq!(action.operation, "archive");
    assert_eq!(action.ids, ["one", "two"]);
    assert!(!action.execute);

    let send = SendRequest::try_from(&json!({
        "to":["one@example.org"], "cc":[], "bcc":[], "subject":"Plan", "body":"Line one\nLine two\n",
        "attachments":[{"path":"/tmp/brief.txt", "name":"brief.txt", "size":5}]
    }))
    .unwrap();
    assert_eq!(send.account.id, "active@example.org");
    assert_eq!(send.to, ["one@example.org"]);
    assert_eq!(send.body, "Line one\nLine two\n");
    assert_eq!(send.attachments[0].path, PathBuf::from("/tmp/brief.txt"));
    assert_eq!(send.attachments[0].name, "brief.txt");
    assert_eq!(send.attachments[0].size, 5);
    assert!(!send.execute);
}

#[test]
fn request_parsers_reject_wrong_shapes_unknown_fields_and_unsafe_bounds() {
    let _env = account_fixture(json!({
        "version": 1,
        "activeId": "active@example.org",
        "accounts": [{"provider":"gmail","email":"active@example.org"}]
    }));
    for value in [
        json!([]),
        json!({"mailbox":"inbox", "limit":"25"}),
        json!({"mailbox":"inbox", "extra":true}),
        json!({"mailbox":"inbox", "query":"x".repeat(32 * 1024 + 1)}),
        json!({"mailbox":"inbox", "pageToken":"x\n"}),
        json!({"mailbox":"inbox", "limit":0}),
        json!({"mailbox":"inbox", "limit":101}),
    ] {
        assert_eq!(
            request_error(ListRequest::try_from(&value)),
            "invalid_params"
        );
    }
    for value in [
        json!({"id":""}),
        json!({"id":"one\r\ntwo"}),
        json!({"id":1}),
    ] {
        assert_eq!(
            request_error(ReadRequest::try_from(&value)),
            "invalid_params"
        );
    }
    for value in [
        json!({"operation":"archive", "ids":[]}),
        json!({"operation":"archive", "ids":["one\0two"]}),
        json!({"operation":"archive", "ids":vec!["one"; 1001]}),
        json!({"operation":"archive", "ids":[1]}),
        json!({"operation":"archive", "ids":["one"], "execute":"false"}),
        json!({"operation":"archive", "ids":["one"], "extra":true}),
    ] {
        assert_eq!(
            request_error(ActRequest::try_from(&value)),
            "invalid_params"
        );
    }
    for value in [
        json!({"to":"one@example.org"}),
        json!({"to":["one@example.org"], "subject":false}),
        json!({"to":["one@example.org"], "attachments":[{"path":"/tmp/a", "name":"a", "size":"5"}]}),
        json!({"to":["one\ntwo@example.org"]}),
        json!({"to":["one@example.org"], "extra":true}),
    ] {
        assert_eq!(
            request_error(SendRequest::try_from(&value)),
            "invalid_params"
        );
    }
}
