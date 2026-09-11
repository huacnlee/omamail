use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
};

#[test]
fn gmail_read_uses_private_credentials_and_returns_only_message() {
    let temp = Command::new("mktemp").arg("-d").output().unwrap();
    assert!(temp.status.success());
    let dir = std::path::PathBuf::from(String::from_utf8(temp.stdout).unwrap().trim());
    let config = dir.join(".config/omamail");
    fs::create_dir_all(&config).unwrap();
    fs::write(
        config.join("accounts.json"),
        br#"{"version":1,"accounts":[{"provider":"gmail","email":"a@example.org"}]}"#,
    )
    .unwrap();
    let credentials = config.join("credentials.json");
    fs::write(&credentials, br#"{"installed":{"client_id":"123-test.apps.googleusercontent.com","client_secret":"synthetic-client-secret"}}"#).unwrap();
    fs::set_permissions(&credentials, fs::Permissions::from_mode(0o600)).unwrap();
    let keyring = dir.join("secret-tool");
    fs::write(&keyring, br#"#!/bin/sh
[ "$*" = 'lookup service omamail kind refresh-token client-id 123-test.apps.googleusercontent.com account a@example.org grant calendar-events-v1' ] || exit 9
printf '%s\n' synthetic-refresh-token
"#).unwrap();
    fs::set_permissions(&keyring, fs::Permissions::from_mode(0o700)).unwrap();
    let curl = dir.join("curl");
    fs::write(
        &curl,
        br#"#!/bin/sh
[ "$1" = -q ] || exit 9
case "$*" in *synthetic*) exit 9;; esac
input=$(/bin/cat)
case "$*" in
  *https://oauth2.googleapis.com/token*)
    case "$input" in *synthetic-refresh-token*) ;; *) exit 9;; esac
    printf '%s\n200' '{"access_token":"synthetic-access-token","expires_in":3600}' ;;
  *https://gmail.googleapis.com/gmail/v1/users/me/messages/abc*)
    case "$input" in *'Authorization: Bearer synthetic-access-token'*) ;; *) exit 9;; esac
    printf '%s\n200' '{"id":"abc","payload":{"headers":[]}}' ;;
  *) exit 9;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(&curl, fs::Permissions::from_mode(0o700)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
        .args(["call", "gmail.read"])
        .env("HOME", &dir)
        .env("XDG_CONFIG_HOME", dir.join(".config"))
        .env("PATH", &dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"accountId":"a@example.org","id":"abc"}"#)
        .unwrap();
    let output = child.wait_with_output().unwrap();
    // Clean synthetic fixtures even when the assertion is red.
    for path in [credentials, config.join("accounts.json"), keyring, curl] {
        fs::remove_file(path).unwrap();
    }
    fs::remove_dir(config).unwrap();
    fs::remove_dir(dir.join(".config")).unwrap();
    fs::remove_dir(dir).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["result"]["id"], "abc");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("synthetic-"));
    assert!(output.stderr.is_empty());
}
