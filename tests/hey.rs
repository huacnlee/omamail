use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
};

#[test]
fn hey_send_keeps_body_on_stdin_and_checks_identity_before_sending() {
    let temp = Command::new("mktemp").arg("-d").output().unwrap();
    assert!(temp.status.success());
    let dir = std::path::PathBuf::from(String::from_utf8(temp.stdout).unwrap().trim());
    let executable = dir.join("hey");
    let body_file = dir.join("body");
    fs::write(
        &executable,
        br#"#!/bin/sh
if [ "$*" = 'accounts list --json' ]; then
  printf '%s\n' '{"ok":true,"data":[{"id":1,"email":"a@example.org"}]}'
  exit 0
fi
[ "$#" = 6 ] || exit 8
[ "$1" = compose ] && [ "$2" = --to ] && [ "$3" = b@example.org ] || exit 8
[ "$4" = --subject ] && [ "$5" = 'Unicode world' ] && [ "$6" = --json ] || exit 8
/bin/cat > "$HEY_BODY_FILE"
printf '%s\n' '{"ok":true}'
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let body = "Private synthetic body\r\n世界\nquotes ' \" and \\\n";
    let invoke = |account: &str| {
        let params = serde_json::json!({"program":executable,"accountId":account,
            "to":"b@example.org","subject":"Unicode world","body":body});
        let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
            .args(["call", "hey.send"])
            .env("PATH", &dir)
            .env("HEY_BODY_FILE", &body_file)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(params.to_string().as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    };
    let wrong = invoke("hey:other@example.org");
    assert!(!wrong.status.success());
    assert!(
        !body_file.exists(),
        "identity mismatch must not send anything"
    );
    let output = invoke("hey:a@example.org");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(fs::read(&body_file).unwrap(), body.as_bytes());
    let answer: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(answer["result"]["ok"], true);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Private synthetic"));
    assert!(output.stderr.is_empty());
    fs::remove_file(body_file).unwrap();
    fs::remove_file(executable).unwrap();
    fs::remove_dir(dir).unwrap();
}

#[test]
fn hey_adapter_uses_official_argv_and_refuses_invalid_ids_before_process() {
    let temp = Command::new("mktemp").arg("-d").output().unwrap();
    assert!(temp.status.success());
    let dir = std::path::PathBuf::from(String::from_utf8(temp.stdout).unwrap().trim());
    let executable = dir.join("hey");
    let marker = dir.join("called");
    fs::write(&executable,b"#!/bin/sh\n[ \"$*\" = 'auth status --json' ] || exit 8\nprintf called > \"$HEY_TEST_MARKER\"\nprintf '%s\\n' '{\"ok\":true,\"data\":{\"authenticated\":true}}'\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let invoke = |method: &str, input: &[u8]| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
            .args(["call", method])
            .env("PATH", &dir)
            .env("HEY_TEST_MARKER", &marker)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        child.wait_with_output().unwrap()
    };
    let output = invoke("hey.status", b"{}");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["result"]["authenticated"], true);
    assert!(marker.exists());
    fs::remove_file(&marker).unwrap();
    let output = invoke("hey.read", b"{\"id\":\"--help:1\"}");
    assert!(!output.status.success());
    assert!(!marker.exists(), "invalid IDs must not reach hey");
    fs::write(&executable,b"#!/bin/sh\nif [ \"$*\" = 'accounts list --json' ]; then\n printf '%s\\n' '{\"ok\":true,\"data\":[{\"id\":\"all\"},{\"id\":1,\"email\":\"a@example.org\"}]}'\nelse\n printf called > \"$HEY_TEST_MARKER\"\n printf '%s\\n' '{\"ok\":true,\"data\":{\"authenticated\":true}}'\nfi\n").unwrap();
    let wrong = serde_json::json!({"program":executable,"accountId":"hey:other@example.org"});
    let output = invoke("hey.status", wrong.to_string().as_bytes());
    assert!(!output.status.success());
    assert!(
        !marker.exists(),
        "wrong account must not reach the requested operation"
    );
    let wrong = serde_json::json!({"program":"/bin/sh","accountId":"hey:a@example.org"});
    let output = invoke("hey.status", wrong.to_string().as_bytes());
    assert!(!output.status.success());
    assert!(!marker.exists(), "different executable must not run");
    let correct = serde_json::json!({"program":executable,"accountId":"hey:a@example.org"});
    assert!(
        invoke("hey.status", correct.to_string().as_bytes())
            .status
            .success()
    );
    assert!(marker.exists());
    fs::remove_file(marker).unwrap();
    fs::remove_file(executable).unwrap();
    fs::remove_dir(dir).unwrap();
}
