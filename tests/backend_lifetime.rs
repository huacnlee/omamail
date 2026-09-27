#![cfg(target_os = "linux")]

#[test]
fn serve_lifetime_follows_parent_and_protocol_shutdown() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let state = root.join(".worktrees/review-records/278/lifetime-tests");
    std::fs::create_dir_all(&state).unwrap();
    for mode in ["parent-death", "quit", "eof"] {
        let output = std::process::Command::new("python3")
            .arg(root.join("tests/backend_lifetime.py"))
            .arg(env!("CARGO_BIN_EXE_omamail"))
            .arg(&state)
            .arg(mode)
            .output()
            .expect("run isolated Linux lifetime harness");
        assert!(
            output.status.success(),
            "{mode}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
