use std::{fs, path::Path};

use omamail::{
    COMPANION_HEARTBEAT_INTERVAL_MS, COMPANION_MAX_AGE_MS, CompanionStatus, CompanionStatusState,
    companion_status_path, write_companion_status,
};

#[test]
fn linux_companion_status_uses_xdg_state_home_when_present() {
    assert_eq!(
        companion_status_path(
            Some(Path::new("/state")),
            Some(Path::new("/home/alice")),
            "linux"
        ),
        Some(Path::new("/state/omamail/status.json").to_path_buf())
    );
    assert_eq!(
        companion_status_path(None, Some(Path::new("/home/alice")), "linux"),
        Some(Path::new("/home/alice/.local/state/omamail/status.json").to_path_buf())
    );
    assert_eq!(
        companion_status_path(Some(Path::new("")), Some(Path::new("/home/alice")), "linux"),
        Some(Path::new("/home/alice/.local/state/omamail/status.json").to_path_buf())
    );
    assert_eq!(
        companion_status_path(
            Some(Path::new("/state")),
            Some(Path::new("/home/alice")),
            "macos"
        ),
        None
    );
}

#[test]
fn heartbeat_refreshes_before_the_companion_marks_a_running_host_stale() {
    let heartbeat = std::hint::black_box(COMPANION_HEARTBEAT_INTERVAL_MS);
    let max_age = std::hint::black_box(COMPANION_MAX_AGE_MS);
    assert!(heartbeat > 0);
    assert!(heartbeat < max_age);
    assert_eq!(COMPANION_MAX_AGE_MS, 120_000);
}

#[test]
fn stopped_heartbeat_never_publishes_running_again() {
    let mut state = CompanionStatusState::running();
    state.set_unread(7);
    assert!(state.should_publish());
    assert_eq!(
        state.snapshot(100),
        CompanionStatus {
            unread: 7,
            running: true,
            updated_at: 100,
        }
    );

    state.stop();
    assert!(!state.should_publish());
    assert_eq!(
        state.snapshot(200),
        CompanionStatus {
            unread: 7,
            running: false,
            updated_at: 200,
        }
    );
}

#[test]
fn status_write_atomically_replaces_the_previous_snapshot() {
    let root = tempfile::tempdir().expect("status fixture");
    let path = root.path().join("nested/status.json");
    write_companion_status(
        &path,
        CompanionStatus {
            unread: 7,
            running: true,
            updated_at: 1_700_000_000_123,
        },
    )
    .expect("first status write");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "{\"version\":1,\"unread\":7,\"running\":true,\"updatedAt\":1700000000123}\n"
    );

    write_companion_status(
        &path,
        CompanionStatus {
            unread: 0,
            running: false,
            updated_at: 1_700_000_000_456,
        },
    )
    .expect("replacement status write");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "{\"version\":1,\"unread\":0,\"running\":false,\"updatedAt\":1700000000456}\n"
    );
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn a_desktop_with_no_bar_gets_no_companion_module_and_no_heartbeat() {
    // The bar is Omarchy's, and `companion_status_path` already answers `None`
    // anywhere else. What that has to reach is the host: a module exported
    // there would answer every `set_unread` by writing to nowhere, and a thread
    // would wake every minute to do it. `application/companion.js` reads a
    // missing module as a mailbox with no bar, which is what this is.
    let source = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"))
        .expect("read host source");
    let start = source
        .find("fn install_companion_status")
        .expect("the companion installer");
    let body = &source[start..];
    let guard = body
        .find("if path.is_none() {")
        .expect("the absent-path guard");
    for later in ["omarchy-companion", "heartbeat", "publish_companion_status"] {
        let offset = body.find(later).unwrap_or_else(|| panic!("{later}"));
        assert!(
            guard < offset,
            "{later} must come after the guard that returns without a status path"
        );
    }
}
