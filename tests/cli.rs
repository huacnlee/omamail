use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

static EMPTY_HOME: AtomicU64 = AtomicU64::new(0);
static MAIL_LIST_FIXTURE: AtomicU64 = AtomicU64::new(0);

fn omamail(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_omamail"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn version_commands_have_stable_machine_readable_output() {
    let plain = omamail(&["--version"]);
    assert!(plain.status.success());
    assert_eq!(
        plain.stdout,
        format!("omamail {}\n", env!("CARGO_PKG_VERSION")).as_bytes()
    );
    assert!(plain.stderr.is_empty());

    let json = omamail(&["version", "--json"]);
    assert!(json.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&json.stdout).unwrap(),
        serde_json::json!({"version":env!("CARGO_PKG_VERSION")})
    );
    assert!(json.stderr.is_empty());
}

#[test]
fn no_arguments_print_help_without_starting_a_gui() {
    let output = omamail(&[]);
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("Usage: omamail ")
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn serve_runs_the_persistent_backend() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
        .arg("serve")
        .env_remove("HOME")
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_CACHE_HOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"system.info\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"system.quit\"}\n")
        .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let replies: Vec<Value> = output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["id"], 1);
    assert_eq!(replies[0]["result"]["name"], "omamail");
    assert_eq!(replies[1]["id"], 2);
}

fn call(method: &str, params: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
        .args(["call", method, "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    // Oversized inputs may be rejected before the writer finishes.
    let _ = stdin.write_all(params);
    drop(stdin);
    child.wait_with_output().unwrap()
}

fn call_in_empty_home(method: &str, params: &[u8]) -> Output {
    let home = std::env::temp_dir().join(format!(
        "omamail-cli-empty-home-{}-{}",
        std::process::id(),
        EMPTY_HOME.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&home).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
        .args(["call", method, "--json"])
        .env("XDG_CONFIG_HOME", &home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(params).unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(std::fs::read_dir(&home).unwrap().next().is_none());
    std::fs::remove_dir_all(home).unwrap();
    output
}

struct MailListFixture(PathBuf);

impl Drop for MailListFixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn mail_list_fixture(imap_port: u16, keyring_succeeds: bool) -> MailListFixture {
    let root = std::env::temp_dir().join(format!(
        "omamail-cli-mail-list-{}-{}",
        std::process::id(),
        MAIL_LIST_FIXTURE.fetch_add(1, Ordering::Relaxed)
    ));
    let config = root.join("config/omamail");
    fs::create_dir_all(&config).unwrap();
    fs::write(
        config.join("accounts.json"),
        serde_json::json!({
            "version":1,
            "activeId":"gmail@example.org",
            "accounts":[
                {"provider":"gmail","email":"gmail@example.org"},
                {"provider":"imap","email":"imap@example.org","imap":{"username":"imap@example.org","imapHost":"127.0.0.1","imapPort":imap_port,"insecure":true}},
                {"provider":"jmap","email":"jmap@example.org","jmap":{"sessionUrl":"https://localhost:9/session","username":"jmap@example.org"}},
                {"provider":"outlook","email":"outlook@example.org","clientId":"synthetic-client","imap":{"tenant":"consumers"}}
            ]
        })
        .to_string(),
    )
    .unwrap();
    fs::set_permissions(&config, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(
        config.join("accounts.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let secret_tool = bin.join("secret-tool");
    fs::write(
        &secret_tool,
        if keyring_succeeds {
            "#!/bin/sh\nprintf 'synthetic\\n'\n"
        } else {
            "#!/bin/sh\nexit 1\n"
        },
    )
    .unwrap();
    fs::set_permissions(&secret_tool, fs::Permissions::from_mode(0o700)).unwrap();
    MailListFixture(root)
}

fn call_mail_list(root: &Path, account: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
        .args(["call", "mail.list", "--json"])
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("HOME", root.join("home"))
        .env("PATH", root.join("bin"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(
            serde_json::json!({"account":account})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    drop(child.stdin.take());
    child.wait_with_output().unwrap()
}

fn call_mail_read(root: &Path, account: &str, id: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
        .args(["call", "mail.read", "--json"])
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("HOME", root.join("home"))
        .env("PATH", root.join("bin"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(
            serde_json::json!({"account":account, "id":id})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    drop(child.stdin.take());
    child.wait_with_output().unwrap()
}

fn metadata(path: &Path) -> (u32, (i64, i64), (i64, i64)) {
    let metadata = fs::metadata(path).unwrap();
    (
        metadata.mode(),
        (metadata.mtime(), metadata.mtime_nsec()),
        (metadata.ctime(), metadata.ctime_nsec()),
    )
}

#[test]
fn configured_list_failures_do_not_repair_registry_metadata() {
    let fixture = mail_list_fixture(9, false);
    let directory = fixture.0.join("config/omamail");
    let registry = directory.join("accounts.json");
    let before = (
        metadata(&directory),
        metadata(&registry),
        fs::read(&registry).unwrap(),
    );
    for (account, expected_error) in [
        ("gmail@example.org", None),
        ("imap:imap@example.org", Some("auth_signed_out")),
        ("jmap:jmap@example.org", Some("auth_signed_out")),
        ("outlook:outlook@example.org", Some("auth_signed_out")),
    ] {
        let output = call_mail_list(&fixture.0, account);
        assert!(!output.status.success(), "{account}: {output:?}");
        if let Some(expected_error) = expected_error {
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap()["error"]["code"],
                expected_error,
                "{account} must stop at the synthetic keyring failure before a network request"
            );
        }
        assert_eq!(
            (
                metadata(&directory),
                metadata(&registry),
                fs::read(&registry).unwrap()
            ),
            before,
            "{account} changed the configured account registry"
        );
    }
}

#[test]
fn configured_read_failures_do_not_repair_registry_metadata() {
    let fixture = mail_list_fixture(9, false);
    let directory = fixture.0.join("config/omamail");
    let registry = directory.join("accounts.json");
    let before = (
        metadata(&directory),
        metadata(&registry),
        fs::read(&registry).unwrap(),
    );
    for (account, id, expected_error) in [
        ("gmail@example.org", "safe-message", None),
        ("imap:imap@example.org", "7:INBOX", Some("auth_signed_out")),
        (
            "jmap:jmap@example.org",
            "safe-message",
            Some("auth_signed_out"),
        ),
        (
            "outlook:outlook@example.org",
            "7:INBOX",
            Some("auth_signed_out"),
        ),
    ] {
        let output = call_mail_read(&fixture.0, account, id);
        assert!(!output.status.success(), "{account}: {output:?}");
        if let Some(expected_error) = expected_error {
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap()["error"]["code"],
                expected_error,
                "{account} must stop at the synthetic keyring failure before a network request"
            );
        }
        assert_eq!(
            (
                metadata(&directory),
                metadata(&registry),
                fs::read(&registry).unwrap()
            ),
            before,
            "{account} changed the configured account registry"
        );
    }
}

#[tokio::test]
async fn imap_adapter_lists_first_page_without_request_token() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = mail_list_fixture(listener.local_addr().unwrap().port(), true);
    let peer = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        writer.write_all(b"* OK ready\r\n").await.unwrap();
        loop {
            let mut line = Vec::new();
            reader.read_until(b'\n', &mut line).await.unwrap();
            let response = if line.starts_with(b"O1 LOGIN") {
                b"O1 OK login\r\n".as_slice()
            } else if line == b"O1 CAPABILITY\r\n" {
                b"* CAPABILITY IMAP4rev1\r\nO1 OK caps\r\n".as_slice()
            } else if line == b"O1 LIST \"\" \"*\"\r\n" {
                b"* LIST () \"/\" INBOX\r\nO1 OK folders\r\n".as_slice()
            } else if line == b"O1 SELECT \"INBOX\"\r\n" {
                b"O1 OK selected\r\n".as_slice()
            } else if line == b"O1 UID FETCH 1:* (UID)\r\n" {
                b"* 1 FETCH (UID 7)\r\nO1 OK snapshot\r\n".as_slice()
            } else if line.starts_with(b"O1 UID FETCH 7 (UID FLAGS ") {
                b"* 7 FETCH (UID 7 FLAGS () INTERNALDATE \"11-Sep-2026 12:00:00 +0000\" RFC822.SIZE 54 BODY[HEADER.FIELDS (FROM SUBJECT)] {54}\r\nFrom: Test <test@example.org>\r\nSubject: First page\r\n\r\n)\r\nO1 OK fetched\r\n".as_slice()
            } else {
                panic!(
                    "unexpected IMAP command: {:?}",
                    String::from_utf8_lossy(&line)
                );
            };
            writer.write_all(response).await.unwrap();
            if line.starts_with(b"O1 UID FETCH 7 (UID FLAGS ") {
                return;
            }
        }
    });
    let root = fixture.0.clone();
    let output =
        tokio::task::spawn_blocking(move || call_mail_list(&root, "imap:imap@example.org"))
            .await
            .unwrap();
    assert!(output.status.success(), "{output:?}");
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["result"]["messages"][0]["id"], "7:INBOX");
    peer.await.unwrap();
}

#[test]
fn generic_call_dispatches_and_defaults_empty_input() {
    let output = call("system.info", b"");
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["result"]["name"], "omamail");
}

#[test]
fn generic_call_errors_are_json_without_echoing_input() {
    for (method, input, code) in [
        (
            "system.info",
            b"{synthetic-secret".as_slice(),
            "invalid_json",
        ),
        (
            "system.info",
            b"\"synthetic-secret\"".as_slice(),
            "invalid_params",
        ),
        ("synthetic-secret", b"{}".as_slice(), "unknown_method"),
    ] {
        let output = call(method, input);
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stderr.is_empty());
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"ok": false, "error": {"code": code}})
        );
    }
}

#[test]
fn generic_call_bounds_input_before_dispatch() {
    let mut input = b"{}".to_vec();
    input.resize(1024 * 1024, b' ');
    assert!(call("system.info", &input).status.success());
    input.push(b' ');
    let output = call("system.info", &input);
    assert_eq!(output.status.code(), Some(1));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], "input_too_large");
}

#[test]
fn generic_call_uses_stateful_session_dispatcher() {
    let output = call("upload.begin", b"{\"size\":0}");
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["ok"], true);
    assert!(value["result"]["upload"].is_string());
}

#[test]
fn list_without_a_configured_account_is_a_stable_json_error() {
    let output = call_in_empty_home("mail.list", b"{}");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        serde_json::json!({"ok":false,"error":{"code":"mail_account_unknown"}})
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn read_rejects_unknown_accounts_and_unsafe_message_ids_without_writing_config() {
    let unknown = call_in_empty_home(
        "mail.read",
        b"{\"account\":\"missing@example.org\",\"id\":\"one\"}",
    );
    assert_eq!(unknown.status.code(), Some(1));
    assert_eq!(
        serde_json::from_slice::<Value>(&unknown.stdout).unwrap(),
        serde_json::json!({"ok":false,"error":{"code":"mail_account_unknown"}})
    );

    let fixture = mail_list_fixture(9, false);
    let unsafe_id = call_mail_read(&fixture.0, "gmail@example.org", "one\ntwo");
    assert_eq!(unsafe_id.status.code(), Some(1));
    assert_eq!(
        serde_json::from_slice::<Value>(&unsafe_id.stdout).unwrap(),
        serde_json::json!({"ok":false,"error":{"code":"invalid_params"}})
    );
}

#[test]
fn default_output_is_a_table_and_json_is_global() {
    let pretty = omamail(&["info"]);
    assert!(pretty.status.success());
    let text = String::from_utf8(pretty.stdout).unwrap();
    assert!(text.contains("| Field"), "{text}");
    assert!(text.contains("omamail"));
    assert!(serde_json::from_str::<Value>(&text).is_err());
    for args in [["--json", "info"], ["info", "--json"]] {
        let output = omamail(&args);
        assert!(output.status.success());
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["name"], "omamail");
        for method in value["methods"].as_array().unwrap() {
            assert!(
                text.lines()
                    .any(|line| { line.trim_matches('|').trim() == method.as_str().unwrap() }),
                "method needs its own row: {method}\n{text}"
            );
        }
    }
    let providers = omamail(&["providers", "list"]);
    assert!(providers.status.success());
    let text = String::from_utf8(providers.stdout).unwrap();
    assert!(text.contains("Gmail") && text.contains("|"));
}

#[test]
fn clap_help_and_invalid_commands_do_not_start_the_backend() {
    for args in [
        ["--backend"].as_slice(),
        ["serve", "--json"].as_slice(),
        ["nonsense"].as_slice(),
    ] {
        assert_eq!(omamail(args).status.code(), Some(2));
    }
    let help = omamail(&["accounts", "--help"]);
    assert!(help.status.success());
    assert!(String::from_utf8(help.stdout).unwrap().contains("list"));
}

#[test]
fn pretty_call_errors_go_to_stderr() {
    let output = omamail(&["call", "unknown"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"omamail: unknown_method\n");
}
