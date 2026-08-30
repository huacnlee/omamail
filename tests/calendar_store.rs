//! The calendar list the window reads at start-up and writes back.
//!
//! What is asserted here is the part a unit of the window cannot: that the
//! bytes on disk are the ones `CalendarController.qml` would have written, that
//! only the user can read them, and that a password has no way through this
//! door into a file.

use std::{fs, path::Path};

use omamail::{
    calendar_store::{CalendarSourceList, CalendarStore},
    calendars_path, oauth_client_path,
    platform::secrets::{MemorySecretStore, SecretKey, SecretStore},
};

const SERVICE: &str = "omamail";

fn store(root: &Path) -> CalendarStore<MemorySecretStore> {
    CalendarStore::new(
        root.join("omamail/calendars.json"),
        MemorySecretStore::default(),
    )
}

fn caldav_payload() -> String {
    String::from(
        r#"{"version":1,"sources":[{"id":"caldav:nextcloud-example-dav-me-personal",
        "kind":"caldav","name":"Personal",
        "url":"https://nextcloud.example/remote.php/dav/calendars/me/personal/",
        "username":"me","remoteCalendarId":"","accountId":"","enabled":true,
        "readOnly":false,"colorKey":"blue"}]}"#,
    )
}

#[test]
fn the_calendar_list_sits_beside_the_oauth_client() {
    let home = Path::new("/home/alice");
    let calendars = calendars_path(Some(home)).expect("a config home");
    let client = oauth_client_path(Some(home)).expect("a config home");
    assert_eq!(calendars.file_name().unwrap(), "calendars.json");
    assert_eq!(calendars.parent(), client.parent());
    assert_eq!(
        calendars.parent().unwrap().file_name().unwrap(),
        "omamail",
        "the QML plugin reads the same directory"
    );
}

#[test]
fn a_list_nobody_has_written_reads_as_an_empty_one() {
    let directory = tempfile::tempdir().unwrap();
    let store = store(directory.path());
    assert_eq!(store.read().unwrap(), CalendarSourceList::default());
    let reply: serde_json::Value =
        serde_json::from_str(&store.dispatch(r#"{"operation":"calendars.read"}"#)).unwrap();
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["text"], "{\"version\":1,\"sources\":[]}\n");
}

#[test]
fn a_written_list_reads_back_as_itself() {
    let directory = tempfile::tempdir().unwrap();
    let store = store(directory.path());
    let written = store.write(&caldav_payload()).unwrap();
    assert_eq!(
        store.read().unwrap(),
        CalendarSourceList::parse(&written).unwrap()
    );
    let source = &store.read().unwrap().sources[0];
    assert_eq!(source.id, "caldav:nextcloud-example-dav-me-personal");
    assert_eq!(source.kind, "caldav");
    assert_eq!(source.color_key, "blue");
    assert!(source.enabled);
    assert!(!source.read_only);
}

/// `config-store.sh` writes one line and a newline, and the QML `FileView`
/// reads whatever is there. The two clients share the file, so the bytes are
/// part of the contract rather than an implementation detail of this writer.
#[test]
fn the_file_is_one_line_of_json() {
    let directory = tempfile::tempdir().unwrap();
    let store = store(directory.path());
    store.write(&caldav_payload()).unwrap();
    let text = fs::read_to_string(directory.path().join("omamail/calendars.json")).unwrap();
    assert!(text.ends_with('\n'));
    assert_eq!(text.trim_end().lines().count(), 1);
    assert!(text.starts_with("{\"version\":1,\"sources\":["));
}

/// A calendar list written before `remoteCalendarId` existed carries nine keys.
/// Reading it as corrupt and answering with an empty list would lose every
/// calendar the user had configured.
#[test]
fn a_list_missing_a_newer_field_still_loads() {
    let list = CalendarSourceList::parse(
        r#"{"version":1,"sources":[{"id":"google:someone@example.com","kind":"google",
        "name":"Work","url":"","username":"","accountId":"someone@example.com",
        "enabled":true,"readOnly":true,"colorKey":"green"}]}"#,
    )
    .unwrap();
    assert_eq!(list.sources.len(), 1);
    assert_eq!(list.sources[0].remote_calendar_id, "");
    assert!(list.sources[0].read_only);
    // And a source that says nothing about being switched off is switched on,
    // which is `Sources.makeSource`'s own default.
    let defaulted =
        CalendarSourceList::parse(r#"{"version":1,"sources":[{"id":"x","kind":"caldav"}]}"#)
            .unwrap();
    assert!(defaulted.sources[0].enabled);
}

/// The one property this writer exists to hold. `Sources.serialize` builds the
/// payload and carries no secret, but "the caller is careful" is not a
/// guarantee — the writer's own shape is.
#[test]
fn a_password_in_the_payload_never_reaches_the_file() {
    let directory = tempfile::tempdir().unwrap();
    let store = store(directory.path());
    let written = store
        .write(
            r#"{"version":1,"sources":[{"id":"caldav:host-dav","kind":"caldav","name":"Shared",
            "url":"https://host.example/dav/","username":"someone","password":"hunter2",
            "secret":"hunter2","enabled":true}]}"#,
        )
        .unwrap();
    assert!(!written.contains("hunter2"));
    assert!(!written.contains("password"));
    let text = fs::read_to_string(directory.path().join("omamail/calendars.json")).unwrap();
    assert!(!text.contains("hunter2"));
    assert!(!text.contains("password"));
    assert!(text.contains("\"username\":\"someone\""));
}

#[test]
fn a_list_that_is_not_one_is_refused_rather_than_written() {
    let directory = tempfile::tempdir().unwrap();
    let store = store(directory.path());
    store.write(&caldav_payload()).unwrap();
    for payload in [
        "not json",
        r#"{"version":1}"#,
        r#"{"version":1,"sources":[{"kind":"caldav"}]}"#,
        r#"{"version":1,"sources":[{"id":"   ","kind":"caldav"}]}"#,
    ] {
        assert!(store.write(payload).is_err(), "{payload} was accepted");
    }
    assert_eq!(
        store.read().unwrap().sources.len(),
        1,
        "a refused write leaves the stored list alone"
    );
}

/// A file that will not parse is reported rather than answered with an empty
/// list: the window writes what it was told the stored list is, so answering
/// "no calendars" is how a configuration disappears.
#[test]
fn a_corrupt_file_is_reported_rather_than_emptied() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir_all(directory.path().join("omamail")).unwrap();
    fs::write(directory.path().join("omamail/calendars.json"), "{oops").unwrap();
    let store = store(directory.path());
    assert!(store.read().is_err());
    let reply: serde_json::Value =
        serde_json::from_str(&store.dispatch(r#"{"operation":"calendars.read"}"#)).unwrap();
    assert_eq!(reply["ok"], false);
    assert!(!reply["error"].as_str().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn the_list_and_its_directory_are_the_users_alone() {
    use std::os::unix::fs::PermissionsExt as _;
    let directory = tempfile::tempdir().unwrap();
    let store = store(directory.path());
    store.write(&caldav_payload()).unwrap();
    let file = fs::metadata(directory.path().join("omamail/calendars.json")).unwrap();
    let parent = fs::metadata(directory.path().join("omamail")).unwrap();
    assert_eq!(file.permissions().mode() & 0o777, 0o600);
    assert_eq!(parent.permissions().mode() & 0o777, 0o700);
    // The rename leaves nothing behind for another process to read.
    let leftovers = fs::read_dir(directory.path().join("omamail"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(leftovers, 0);
}

#[test]
fn a_password_goes_to_the_keyring_under_the_identity_caldav_reads_it_by() {
    let directory = tempfile::tempdir().unwrap();
    let secrets = MemorySecretStore::default();
    let path = directory.path().join("omamail/calendars.json");
    let store = CalendarStore::new(path.clone(), secrets);
    let reply: serde_json::Value = serde_json::from_str(&store.dispatch(
        r#"{"operation":"calendars.savePassword","sourceId":"caldav:host-dav","password":"hunter2"}"#,
    ))
    .unwrap();
    assert_eq!(reply["ok"], true);
    // Nothing was written beside it: the list and the secret are two stores.
    assert!(!path.exists());
}

#[test]
fn the_stored_password_is_the_one_the_transport_looks_up() {
    let directory = tempfile::tempdir().unwrap();
    let secrets = MemorySecretStore::default();
    let key = SecretKey::caldav(SERVICE, "caldav:host-dav").unwrap();
    {
        let store = CalendarStore::new(
            directory.path().join("omamail/calendars.json"),
            &secrets as &dyn SecretStore,
        );
        store
            .save_password("caldav:host-dav", String::from("hunter2"))
            .unwrap();
    }
    assert_eq!(
        secrets
            .get(&key)
            .unwrap()
            .map(|value| value.expose().to_owned()),
        Some(String::from("hunter2"))
    );
}

#[test]
fn an_empty_password_or_calendar_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let store = store(directory.path());
    assert!(store.save_password("", String::from("hunter2")).is_err());
    assert!(
        store
            .save_password("caldav:host-dav", String::new())
            .is_err()
    );
    assert!(
        store
            .save_password("caldav:host-dav", "x".repeat(4096))
            .is_err()
    );
}

#[test]
fn a_request_this_host_does_not_answer_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let store = store(directory.path());
    for request in [
        "{}",
        r#"{"operation":"calendars.delete"}"#,
        r#"{"operation":"calendars.write"}"#,
        r#"{"operation":"calendars.read","path":"/etc/passwd"}"#,
    ] {
        let reply: serde_json::Value = serde_json::from_str(&store.dispatch(request)).unwrap();
        assert_eq!(reply["ok"], false, "{request} was accepted");
    }
}
