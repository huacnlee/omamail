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
