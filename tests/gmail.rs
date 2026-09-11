use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
};

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
            .args(["call", method])
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
    printf x >> "$GMAIL_REFRESH_MARKER"
    printf '%s\n200' '{"access_token":"synthetic-access-token","expires_in":3600}' ;;
  *https://gmail.googleapis.com/gmail/v1/users/me/messages/abc*)
    case "$input" in *'Authorization: Bearer synthetic-access-token'*) ;; *) exit 9;; esac
    printf '%s\n200' '{"id":"abc","payload":{"headers":[]}}' ;;
  *https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX*)
    printf '%s\n200' '{"id":"INBOX","messagesUnread":3,"messagesTotal":10}' ;;
  *https://gmail.googleapis.com/gmail/v1/users/me/labels*)
    printf '%s\n200' '{"labels":[{"id":"INBOX","name":"Localized inbox","type":"system"}]}' ;;
  *https://gmail.googleapis.com/gmail/v1/users/me/profile*)
    printf '%s\n200' '{"emailAddress":"a@example.org","messagesTotal":10}' ;;
  *https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs*)
    printf '%s\n200' '{"sendAs":[{"sendAsEmail":"alias@example.org","verificationStatus":"pending"},{"sendAsEmail":"a@example.org","isPrimary":true}]}' ;;
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
        .env("GMAIL_REFRESH_MARKER", dir.join("refreshes"))
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
    let mut backend = Command::new(env!("CARGO_BIN_EXE_omamail"))
        .arg("--backend")
        .env("HOME", &dir)
        .env("XDG_CONFIG_HOME", dir.join(".config"))
        .env("PATH", &dir)
        .env("GMAIL_REFRESH_MARKER", dir.join("refreshes"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = backend.stdin.take().unwrap();
    let mut reader = BufReader::new(backend.stdout.take().unwrap());
    let mut replies = Vec::new();
    for (id, method) in ["gmail.read", "gmail.read", "gmail.invalidate", "gmail.read"]
        .iter()
        .enumerate()
    {
        let params = if *method == "gmail.invalidate" {
            serde_json::json!({"accountId":"a@example.org"})
        } else {
            serde_json::json!({"accountId":"a@example.org","id":"abc"})
        };
        writeln!(
            input,
            "{}",
            serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        replies.push(serde_json::from_str::<serde_json::Value>(&line).unwrap());
    }
    let mut resource_replies = Vec::new();
    for method in [
        "gmail.labels",
        "gmail.labelCounts",
        "gmail.profile",
        "gmail.sendAs",
    ] {
        let mut params = serde_json::json!({"accountId":"a@example.org"});
        if method == "gmail.labelCounts" {
            params["id"] = serde_json::json!("INBOX");
        }
        writeln!(
            input,
            "{}",
            serde_json::json!({"jsonrpc":"2.0","id":method,"method":method,"params":params})
        )
        .unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        resource_replies.push(serde_json::from_str::<serde_json::Value>(&line).unwrap());
    }
    drop(input);
    let backend_output = backend.wait_with_output().unwrap();
    let refreshes = fs::read(dir.join("refreshes")).unwrap();
    fs::remove_file(dir.join("refreshes")).unwrap();
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
    assert!(backend_output.status.success());
    assert!(backend_output.stderr.is_empty());
    for (id, reply) in replies.iter().enumerate() {
        assert_eq!(reply["id"], id);
        assert!(reply.get("error").is_none(), "{reply}");
        if id != 2 {
            assert_eq!(reply["result"]["id"], "abc");
        }
    }
    // One refresh in CLI, one for two cached reads, one after invalidation.
    assert_eq!(refreshes, b"xxx");
    for reply in &resource_replies {
        assert!(reply.get("error").is_none(), "{reply}");
    }
    assert_eq!(resource_replies[0]["result"][0]["name"], "Inbox");
    assert_eq!(resource_replies[1]["result"]["unread"], 3);
    assert_eq!(resource_replies[2]["result"]["email"], "a@example.org");
    assert_eq!(resource_replies[3]["result"].as_array().unwrap().len(), 1);
    assert_eq!(resource_replies[3]["result"][0]["email"], "a@example.org");
}
