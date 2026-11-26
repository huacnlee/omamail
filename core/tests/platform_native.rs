//! Isolated native security gate. This imports the actual platform module so
//! Windows can run its regressions independently of Unix-only legacy fixtures.
#![allow(dead_code, unused_imports)]
#[path = "../src/platform/mod.rs"]
mod platform;

#[cfg(windows)]
#[path = "../src/cache/mod.rs"]
mod cache;
#[cfg(windows)]
pub use omamail::message;

#[cfg(windows)]
#[path = "support/windows_process.rs"]
mod windows_process;

#[cfg(windows)]
#[test]
fn windows_process_command_line_query_reads_live_child_arguments() {
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let marker = format!("omamail-argv-probe-{}-{nonce}", std::process::id());
    let script = format!("Start-Sleep -Seconds 30 # {marker}");
    let child = Child(
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .spawn()
            .unwrap(),
    );
    let argv = windows_process::process_argv(child.0.id());
    assert!(
        argv.windows(marker.len())
            .any(|bytes| bytes == marker.as_bytes()),
        "queried command line omitted the child marker"
    );
}

#[cfg(all(windows, not(feature = "integration-test-credentials")))]
#[test]
fn production_directories_ignore_integration_root_hint_without_writes() {
    use omamail::platform::dirs::AppDirs;
    let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "omamail-forbidden-integration-root-{}",
        std::process::id()
    ));
    if std::env::var_os("OMAMAIL_DIRECTORY_PROBE_CHILD").is_some() {
        let hint = std::path::PathBuf::from(std::env::var_os("OMAMAIL_INTEGRATION_HOME").unwrap());
        assert!(!AppDirs::discover().unwrap().config.starts_with(&hint));
        assert!(!AppDirs::home().unwrap().starts_with(&hint));
        assert!(
            !hint.exists(),
            "the production directory lookup must not write to the hint"
        );
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "production_directories_ignore_integration_root_hint_without_writes",
        ])
        .env("OMAMAIL_DIRECTORY_PROBE_CHILD", "1")
        .env("OMAMAIL_INTEGRATION_HOME", &root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!root.exists());
}
