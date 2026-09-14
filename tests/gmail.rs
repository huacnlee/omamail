#[cfg(unix)]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

#[cfg(target_os = "macos")]
fn config_root(home: &Path, xdg: &Path) -> PathBuf {
    let _ = xdg;
    home.join("Library/Application Support")
}
#[cfg(all(unix, not(target_os = "macos")))]
fn config_root(home: &Path, xdg: &Path) -> PathBuf {
    let _ = home;
    xdg.to_owned()
}

#[test]
fn gmail_config_directory_uses_the_shared_platform_contract() {
    let dirs = omamail::platform::dirs::AppDirs::discover().unwrap();
    assert_eq!(
        dirs.config_directory(),
        dirs.config.join(omamail::platform::dirs::APP_DIRECTORY)
    );
}

#[cfg(unix)]
#[test]
fn mail_gmail_actions_default_to_preview_and_keep_credential_failures_explicit() {
    let temp = Command::new("mktemp").arg("-d").output().unwrap();
    let dir = PathBuf::from(String::from_utf8(temp.stdout).unwrap().trim())
        .canonicalize()
        .unwrap();
    let config = config_root(&dir, &dir).join("omamail");
    fs::create_dir_all(&config).unwrap();
    fs::write(config.join("accounts.json"),br#"{"version":1,"activeId":"a@example.org","accounts":[{"provider":"gmail","email":"a@example.org"}]}"#).unwrap();
    fs::set_permissions(&config, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(
        config.join("accounts.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    // No client file is installed: execution must fail without reaching keyring.
    fs::write(
        dir.join("secret-tool"),
        b"#!/bin/sh\nprintf touched > \"$HOME/keyring-touched\"\nexit 9\n",
    )
    .unwrap();
    fs::set_permissions(dir.join("secret-tool"), fs::Permissions::from_mode(0o700)).unwrap();
    for operation in [
        "read", "unread", "star", "unstar", "archive", "trash", "spam",
    ] {
        for execute in [None, Some(false), Some(true)] {
            let mut params = serde_json::json!({"operation":operation,"ids":["m1","m2","m1"]});
            if let Some(execute) = execute {
                params["execute"] = serde_json::json!(execute);
            }
            let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
                .args(["call", "mail.act", "--json"])
                .env("XDG_CONFIG_HOME", &dir)
                .env("HOME", &dir)
                .env("XDG_CACHE_HOME", dir.join("cache"))
                .env("XDG_STATE_HOME", dir.join("state"))
                .env("PATH", &dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            write!(child.stdin.take().unwrap(), "{params}").unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.stderr.is_empty());
            let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                reply["result"]["targetIds"],
                serde_json::json!(["m1", "m2"])
            );
            assert_eq!(reply["result"]["executed"], execute == Some(true));
            if execute == Some(true) {
                assert_eq!(reply["result"]["succeededIds"], serde_json::json!([]));
                assert_eq!(
                    reply["result"]["failedIds"],
                    serde_json::json!(["m1", "m2"])
                );
            }
            assert!(!dir.join("keyring-touched").exists());
            assert!(!dir.join("cache").exists());
            assert!(!dir.join("state").exists());
        }
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn malformed_gmail_requests_are_refused_before_credentials_or_network() {
    for (method, params) in [
        (
            "gmail.read",
            serde_json::json!({"accountId":"a@example.org","id":"x\n"}),
        ),
        (
            "gmail.read",
            serde_json::json!({"accountId":"a@example.org","id":"x","full":"true"}),
        ),
        (
            "gmail.list",
            serde_json::json!({"accountId":"a@example.org","pageSize":101}),
        ),
        (
            "gmail.list",
            serde_json::json!({"accountId":"a@example.org","pageSize":0}),
        ),
        (
            "gmail.list",
            serde_json::json!({"accountId":"a@example.org","query":"x\0"}),
        ),
        (
            "gmail.attachment",
            serde_json::json!({"accountId":"a@example.org","messageId":"x","attachmentId":""}),
        ),
        (
            "gmail.read",
            serde_json::json!({"accountId":"a@example.org","id":"x","token":"synthetic-secret"}),
        ),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
            .args(["call", method, "--json"])
            .env_remove("HOME")
            .env_remove("XDG_CONFIG_HOME")
            .env("PATH", "")
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
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        let answer: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(answer["error"]["code"], "invalid_params");
        assert!(output.stderr.is_empty());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("synthetic-secret"));
    }
}

#[cfg(unix)]
#[test]
fn gmail_registry_and_private_credentials_gate_keyring_access() {
    let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "omamail-gmail-boundary-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let config = config_root(&dir, &dir.join(".config")).join("omamail");
    fs::create_dir_all(&config).unwrap();
    let accounts = config.join("accounts.json");
    fs::write(
        &accounts,
        br#"{"version":1,"accounts":[{"provider":"gmail","email":"a@example.org"},{"provider":"imap","email":"b@example.org"}]}"#,
    )
    .unwrap();
    fs::set_permissions(&config, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o600)).unwrap();
    let credentials = config.join("credentials.json");
    fs::write(&credentials, br#"{"installed":{"client_id":"123-test.apps.googleusercontent.com","client_secret":"synthetic-client-secret"}}"#).unwrap();
    fs::set_permissions(&credentials, fs::Permissions::from_mode(0o644)).unwrap();
    let keyring = dir.join("secret-tool");
    fs::write(
        &keyring,
        b"#!/bin/sh\nprintf touched > \"$HOME/keyring-touched\"\nexit 9\n",
    )
    .unwrap();
    fs::set_permissions(&keyring, fs::Permissions::from_mode(0o700)).unwrap();
    for (account, error) in [
        ("unknown@example.org", "gmail_account_unknown"),
        ("imap:b@example.org", "gmail_account_unknown"),
        ("A@example.org", "gmail_client_permissions"),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
            .args(["call", "gmail.read", "--json"])
            .env("HOME", &dir)
            .env("XDG_CONFIG_HOME", dir.join(".config"))
            .env("PATH", &dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        write!(
            child.stdin.take().unwrap(),
            "{}",
            serde_json::json!({"accountId":account,"id":"abc"})
        )
        .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        let answer: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(answer["error"]["code"], error);
        assert!(output.stderr.is_empty());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("synthetic-"));
        assert!(!dir.join("keyring-touched").exists());
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn persistent_gmail_invalidation_needs_no_credentials() {
    let mut backend = Command::new(env!("CARGO_BIN_EXE_omamail"))
        .arg("serve")
        .env_remove("HOME")
        .env_remove("XDG_CONFIG_HOME")
        .env("PATH", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = backend.stdin.take().unwrap();
    let mut reader = BufReader::new(backend.stdout.take().unwrap());
    for id in 0..2 {
        writeln!(
            input,
            "{}",
            serde_json::json!({"jsonrpc":"2.0","id":id,
            "method":"gmail.invalidate","params":{"accountId":"a@example.org"}})
        )
        .unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["id"], id);
        assert_eq!(reply["result"], serde_json::json!({"invalidated":true}));
    }
    drop(input);
    let output = backend.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
}
