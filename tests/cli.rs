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

type FixtureSnapshot = Vec<(
    std::path::PathBuf,
    (u32, (i64, i64), (i64, i64)),
    Option<Vec<u8>>,
)>;
fn fixture_snapshot(root: &Path) -> FixtureSnapshot {
    fn visit(path: &Path, snapshot: &mut FixtureSnapshot) {
        snapshot.push((
            path.to_owned(),
            metadata(path),
            path.is_file().then(|| fs::read(path).unwrap()),
        ));
        if path.is_dir() {
            for entry in fs::read_dir(path).unwrap() {
                visit(&entry.unwrap().path(), snapshot);
            }
        }
    }
    let mut snapshot = Vec::new();
    visit(root, &mut snapshot);
    snapshot.sort_by(|a, b| a.0.cmp(&b.0));
    snapshot
}

#[test]
fn malformed_provider_action_previews_refuse_without_credentials_or_writes() {
    let fixture = mail_list_fixture(9, true);
    let registry = fixture.0.join("config/omamail/accounts.json");
    let mut accounts: Value = serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
    accounts["accounts"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"provider":"hey","email":"hey@example.org"}));
    fs::write(registry, accounts.to_string()).unwrap();
    let touched = fixture.0.join("credential-touched");
    fs::write(
        fixture.0.join("bin/secret-tool"),
        format!("#!/bin/sh\n: > '{}'\nexit 1\n", touched.display()),
    )
    .unwrap();
    let before = fixture_snapshot(&fixture.0);
    for (account, bad) in [
        ("hey:hey@example.org", "1:INBOX"),
        ("hey:hey@example.org", "1:2:3"),
        ("imap:imap@example.org", "not-a-uid"),
        ("imap:imap@example.org", "0:INBOX"),
        ("outlook:outlook@example.org", "4294967296:INBOX"),
        ("outlook:outlook@example.org", "1:"),
    ] {
        for operation in ["read", "trash"] {
            let output = root_mail(
                &fixture.0,
                &["call", "mail.act", "--json"],
                serde_json::json!({"account":account,"operation":operation,"ids":[bad]})
                    .to_string()
                    .as_bytes(),
            );
            assert_eq!(output.status.code(), Some(1), "{account} {bad}: {output:?}");
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                serde_json::json!({"ok":false,"error":{"code":"invalid_params"}})
            );
            assert_eq!(fixture_snapshot(&fixture.0), before);
        }
    }
}

#[tokio::test]
async fn malformed_final_imap_action_id_prevents_all_network_and_cache_changes() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = mail_list_fixture(listener.local_addr().unwrap().port(), true);
    let seeded = root_mail(&fixture.0, &["call","cache.bodyPut","--json"],serde_json::json!({"accountId":"imap:imap@example.org","id":"1:INBOX","body":{"text":"preserve cached body"}}).to_string().as_bytes());
    assert!(seeded.status.success());
    let before = fixture_snapshot(&fixture.0);
    let (finished, completion) = tokio::sync::oneshot::channel();
    let peer = tokio::spawn(async move {
        let accepted = tokio::select! {
            socket = listener.accept() => Some(socket.unwrap().0),
            _ = completion => None,
        };
        let Some(socket) = accepted else {
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(20), listener.accept())
                    .await
                    .is_err()
            );
            return (false, 0);
        };
        let (reader, mut writer) = socket.into_split();
        let mut reader = BufReader::new(reader);
        writer.write_all(b"* OK ready\r\n").await.unwrap();
        let mut mutations = 0;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            let response = if line.starts_with("O1 LOGIN ") {
                "O1 OK login\r\n"
            } else if line == "O1 CAPABILITY\r\n" {
                "* CAPABILITY IMAP4rev1\r\nO1 OK capabilities\r\n"
            } else if line == "O1 LIST \"\" \"*\"\r\n" {
                "* LIST () \"/\" INBOX\r\nO1 OK folders\r\n"
            } else if line == "O1 SELECT \"INBOX\"\r\n" {
                "O1 OK selected\r\n"
            } else if line.starts_with("O1 UID STORE ") {
                mutations += 1;
                "O1 OK mutated\r\n"
            } else {
                panic!("unexpected request {line:?}")
            };
            writer.write_all(response.as_bytes()).await.unwrap();
        }
        (true, mutations)
    });
    let root = fixture.0.clone();
    let output = tokio::task::spawn_blocking(move || {
        let mut ids: Vec<_> = (1..=501).map(|id| format!("{id}:INBOX")).collect();
        ids.push("malformed-final-id".into());
        let mut args = vec![
            "mark",
            "read",
            "--account",
            "imap:imap@example.org",
            "--execute",
            "--json",
        ];
        args.extend(ids.iter().map(String::as_str));
        root_mail(&root, &args, b"")
    })
    .await
    .unwrap();
    let _ = finished.send(());
    let effects = peer.await.unwrap();
    assert_eq!(
        effects,
        (false, 0),
        "a malformed tail must prevent even the first mutation chunk"
    );
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        serde_json::json!({"ok":false,"error":{"code":"invalid_params"}})
    );
    assert_eq!(fixture_snapshot(&fixture.0), before);
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

#[test]
fn imap_and_outlook_destination_previews_require_readonly_credentials() {
    let fixture = mail_list_fixture(9, false);
    let directory = fixture.0.join("config/omamail");
    let registry = directory.join("accounts.json");
    let before = (
        metadata(&directory),
        metadata(&registry),
        fs::read(&registry).unwrap(),
    );
    for account in ["imap:imap@example.org", "outlook:outlook@example.org"] {
        for operation in ["archive", "trash"] {
            let output = root_mail(
                &fixture.0,
                &[operation, "7:INBOX", "--account", account, "--json"],
                b"",
            );
            assert_eq!(output.status.code(), Some(1));
            let value: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                value["error"]["code"], "auth_signed_out",
                "{account}: {operation}"
            );
            assert_eq!(
                (
                    metadata(&directory),
                    metadata(&registry),
                    fs::read(&registry).unwrap()
                ),
                before
            );
            for name in ["cache", "state", "home"] {
                assert!(!fixture.0.join(name).exists());
            }
        }
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
fn jmap_planning_helpers_are_not_public_methods() {
    for method in ["jmap.actionAvailability", "jmap.actionRows"] {
        let output = call(method, b"{}");
        assert_eq!(output.status.code(), Some(1));
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["error"]["code"], "method_not_found", "{method}");
    }
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

fn root_mail(root: &Path, args: &[&str], body: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
        .args(args)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("HOME", root.join("home"))
        .env("PATH", root.join("bin"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if args.contains(&"send") {
        let argv = fs::read(format!("/proc/{}/cmdline", child.id())).unwrap();
        assert!(
            !argv
                .windows(b"private body".len())
                .any(|text| text == b"private body")
        );
        assert!(
            !argv
                .windows(b"synthetic".len())
                .any(|text| text == b"synthetic")
        );
    }
    let _ = child.stdin.take().unwrap().write_all(body);
    child.wait_with_output().unwrap()
}

#[test]
fn task_commands_have_only_the_approved_vocabulary_and_execute_switch() {
    let help = String::from_utf8(omamail(&["--help"]).stdout).unwrap();
    for name in ["list", "read", "mark", "archive", "trash", "spam", "send"] {
        assert!(
            help.lines()
                .any(|line| line.split_whitespace().next() == Some(name)),
            "missing {name}"
        );
        let output = omamail(&[name, "--help"]);
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("--account"));
        assert_eq!(text.contains("--execute"), !matches!(name, "list" | "read"));
    }
    for args in [
        vec!["mail", "list"],
        vec!["unstar", "m1"],
        vec!["star", "m1"],
        vec!["unread", "m1"],
        vec!["show", "m1"],
        vec!["mark", "starred", "m1"],
        vec!["mark", "read"],
        vec!["archive"],
        vec!["list", "--execute"],
        vec!["read", "m1", "--execute"],
        vec!["send", "--body", "secret"],
    ] {
        assert_eq!(omamail(&args).status.code(), Some(2), "{args:?}");
    }
}

#[test]
fn root_mutations_preview_exact_intent_and_never_touch_storage_or_credentials() {
    let fixture = mail_list_fixture(9, false);
    let config = fixture.0.join("config/omamail/accounts.json");
    let before = (metadata(&config), fs::read(&config).unwrap());
    let sentinel = fixture.0.join("credential-touched");
    fs::write(
        fixture.0.join("bin/secret-tool"),
        format!("#!/bin/sh\n: > '{}'\nexit 1\n", sentinel.display()),
    )
    .unwrap();
    for operation in [
        "read", "unread", "star", "unstar", "archive", "trash", "spam",
    ] {
        let mut args = if matches!(operation, "read" | "unread" | "star" | "unstar") {
            vec!["mark", operation]
        } else {
            vec![operation]
        };
        args.extend(["one", "two", "one"]);
        for before_command in [true, false] {
            let mut args = args.clone();
            if before_command {
                args.insert(0, "--json");
            } else {
                args.push("--json");
            }
            let output = root_mail(&fixture.0, &args, b"ignored stdin");
            assert!(output.status.success(), "{args:?}: {output:?}");
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                serde_json::json!({"ok":true,"result":{
                    "dryRun":true,"executed":false,"operation":operation,"accountId":"gmail@example.org",
                    "requestedIds":["one","two","one"],"targetIds":["one","two"]
                }})
            );
            assert!(output.stderr.is_empty());
        }
    }
    assert_eq!((metadata(&config), fs::read(&config).unwrap()), before);
    assert!(!sentinel.exists());
    for name in ["cache", "state", "home"] {
        assert!(!fixture.0.join(name).exists());
    }
}

#[test]
fn root_mail_errors_use_stable_envelopes_and_never_fall_back_accounts() {
    let fixture = mail_list_fixture(9, false);
    for args in [
        vec!["list"],
        vec!["read", "one"],
        vec!["mark", "read", "one"],
        vec!["archive", "one"],
        vec!["trash", "one"],
        vec!["spam", "one"],
        vec!["send"],
    ] {
        for before in [true, false] {
            let mut args = args.clone();
            args.extend(["--account", "missing@example.org"]);
            if before {
                args.insert(0, "--json");
            } else {
                args.push("--json");
            }
            let output = root_mail(&fixture.0, &args, b"");
            assert_eq!(output.status.code(), Some(1), "{args:?}: {output:?}");
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                serde_json::json!({"ok":false,"error":{"code":"mail_account_unknown"}})
            );
            assert!(output.stderr.is_empty());
        }
    }
    let output = root_mail(&fixture.0, &["read", "secret\nvalue"], b"");
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"omamail: invalid_params\n");
}

#[test]
fn send_previews_repeatable_inputs_and_strict_bounded_utf8_without_writes() {
    let fixture = mail_list_fixture(9, false);
    let attachment = fixture.0.join("quoted\\工\".txt");
    fs::write(&attachment, b"private attachment").unwrap();
    let second = fixture.0.join("second.txt");
    fs::write(&second, b"two").unwrap();
    let args = [
        "send",
        "--account",
        "imap:imap@example.org",
        "--to",
        "one@example.org",
        "--to",
        "two@example.org",
        "--cc",
        "three@example.org",
        "--bcc",
        "four@example.org",
        "--subject",
        "Unicode 工",
        "--attach",
        attachment.to_str().unwrap(),
        "--attach",
        second.to_str().unwrap(),
        "--json",
    ];
    let body = "private body 工\nsecond\r\nthird\tline";
    let output = root_mail(&fixture.0, &args, body.as_bytes());
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        serde_json::json!({"ok":true,"result":{
            "dryRun":true,"executed":false,"accountId":"imap:imap@example.org","from":"imap@example.org",
            "to":["one@example.org","two@example.org"],"cc":["three@example.org"],"bcc":["four@example.org"],
            "subject":"Unicode 工","body":body,"attachments":[{"name":"quoted\\工\".txt","size":18},{"name":"second.txt","size":3}]
        }})
    );
    for body in [
        b"private\xffsecret".to_vec(),
        b"private\0secret".to_vec(),
        vec![b'x'; 16 * 1024 * 1024 + 1],
    ] {
        let output = root_mail(&fixture.0, &args, &body);
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            serde_json::json!({"ok":false,"error":{"code":"mail_send_invalid_body"}})
        );
        assert!(output.stderr.is_empty());
    }
    for name in ["cache", "state", "home"] {
        assert!(!fixture.0.join(name).exists());
    }
}

#[test]
fn invalid_send_inputs_never_reach_credentials_or_outbox_even_with_execute() {
    use std::os::unix::fs::symlink;
    let fixture = mail_list_fixture(9, false);
    let file = fixture.0.join("file.txt");
    fs::write(&file, b"bytes").unwrap();
    let link = fixture.0.join("link.txt");
    symlink(&file, &link).unwrap();
    let fifo = fixture.0.join("pipe.txt");
    let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let sentinel = fixture.0.join("credential-touched");
    fs::write(
        fixture.0.join("bin/secret-tool"),
        format!("#!/bin/sh\n: > '{}'\nexit 1\n", sentinel.display()),
    )
    .unwrap();
    for extra in [
        vec!["--subject", "secret\r"],
        vec!["--subject", "secret\n"],
        vec!["--subject", "secret\r\n"],
        vec!["--to", "secret\t@example.org"],
        vec!["--from", "secret\n@example.org"],
        vec!["--attach", "relative.txt"],
        vec!["--attach", link.to_str().unwrap()],
        vec!["--attach", fifo.to_str().unwrap()],
        vec!["--attach", fixture.0.to_str().unwrap()],
    ] {
        for execute in [false, true] {
            let mut args = vec![
                "send",
                "--account",
                "imap:imap@example.org",
                "--to",
                "one@example.org",
                "--json",
            ];
            args.extend(extra.iter().copied());
            if execute {
                args.push("--execute");
            }
            let output = root_mail(&fixture.0, &args, b"private body");
            assert_eq!(output.status.code(), Some(1), "{args:?}: {output:?}");
            let value: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(value["ok"], false);
            assert!(value["error"]["code"].is_string());
            assert!(!String::from_utf8_lossy(&output.stdout).contains("secret"));
            assert!(!String::from_utf8_lossy(&output.stdout).contains("private body"));
            assert!(output.stderr.is_empty());
        }
    }
    assert!(!sentinel.exists());
    for name in ["cache", "state", "home"] {
        assert!(!fixture.0.join(name).exists());
    }
}

#[test]
fn only_send_consumes_stdin_and_human_previews_escape_untrusted_text() {
    let fixture = mail_list_fixture(9, false);
    for args in [
        vec!["list"],
        vec!["read", "one"],
        vec!["mark", "read", "one"],
        vec!["archive", "one"],
        vec!["trash", "one"],
        vec!["spam", "one"],
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
            .args(args)
            .env("XDG_CONFIG_HOME", fixture.0.join("config"))
            .env("HOME", fixture.0.join("home"))
            .env("PATH", fixture.0.join("bin"))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("read-only/action command consumed stdin");
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        drop(input);
    }
    let output = root_mail(
        &fixture.0,
        &[
            "send",
            "--account",
            "imap:imap@example.org",
            "--to",
            "one@example.org",
        ],
        "line\n\x1b[31mred\r\t|row\u{202e}工".as_bytes(),
    );
    assert!(output.status.success(), "{output:?}");
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(
        !text.contains('\x1b')
            && !text.contains('\r')
            && !text.contains('\t')
            && !text.contains('\u{202e}')
    );
    assert!(text.contains("\\u{1b}") && text.contains("\\u{202e}") && text.contains("\\|row"));
}

#[test]
fn failed_execution_retains_target_results_and_exits_one() {
    let fixture = mail_list_fixture(9, false);
    let output = root_mail(
        &fixture.0,
        &[
            "mark",
            "read",
            "7:INBOX",
            "8:INBOX",
            "--account",
            "imap:imap@example.org",
            "--execute",
            "--json",
        ],
        b"",
    );
    assert_eq!(output.status.code(), Some(1));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"ok":false,"error":{"code":"mail_action_failed"},"result":{
            "dryRun":false,"executed":true,"accountId":"imap:imap@example.org","operation":"read",
            "requestedIds":["7:INBOX","8:INBOX"],"targetIds":["7:INBOX","8:INBOX"],"succeededIds":[],"failedIds":["7:INBOX","8:INBOX"]
        }})
    );
    assert!(output.stderr.is_empty());
}

#[tokio::test]
async fn one_shot_send_owns_delivery_until_durable_terminal_result() {
    for (generic, acknowledge) in [(false, true), (true, false)] {
        real_smtp_send(generic, acknowledge, false, false).await;
    }
}

#[tokio::test]
async fn concurrent_send_uses_idle_serve_owner_and_survives_owner_crash_or_smtp_ack_loss() {
    for (acknowledge, crash) in [(true, false), (false, false), (false, true)] {
        real_smtp_send(false, acknowledge, true, crash).await;
    }
}

async fn real_smtp_send(generic: bool, acknowledge: bool, owner: bool, crash: bool) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = mail_list_fixture(9, true);
    let config = fixture.0.join("config/omamail/accounts.json");
    let mut registry: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    registry["accounts"][1]["imap"]["smtpHost"] = serde_json::json!("127.0.0.1");
    registry["accounts"][1]["imap"]["smtpPort"] =
        serde_json::json!(listener.local_addr().unwrap().port());
    fs::write(&config, registry.to_string()).unwrap();
    let mut desktop = if owner {
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_omamail"))
            .arg("serve")
            .env("XDG_CONFIG_HOME", fixture.0.join("config"))
            .env("XDG_STATE_HOME", fixture.0.join("state"))
            .env("XDG_CACHE_HOME", fixture.0.join("cache"))
            .env("HOME", fixture.0.join("home"))
            .env("PATH", fixture.0.join("bin"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        child.stdin.as_mut().unwrap().write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"outbox.snapshot\",\"params\":{\"accountId\":\"imap:imap@example.org\"}}\n").await.unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            output.read_line(&mut line),
        )
        .await
        .unwrap()
        .unwrap();
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert!(
            reply["result"]["entries"].as_array().unwrap().is_empty(),
            "{reply}"
        );
        // Consume notifications while stdin remains idle and open.
        tokio::spawn(async move {
            loop {
                let mut line = String::new();
                if output.read_line(&mut line).await.unwrap_or(0) == 0 {
                    break;
                }
            }
        });
        Some(child)
    } else {
        None
    };
    let (accepted, acceptance) = tokio::sync::oneshot::channel();
    let (finished, completion) = tokio::sync::oneshot::channel();
    let peer = tokio::spawn(async move {
        let (stream, _) =
            tokio::time::timeout(std::time::Duration::from_secs(20), listener.accept())
                .await
                .unwrap()
                .unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        writer.write_all(b"220 ready\r\n").await.unwrap();
        for (prefix, reply) in [
            ("EHLO omamail", "250 ready\r\n"),
            ("AUTH PLAIN ", "235 authenticated\r\n"),
            ("MAIL FROM:<imap@example.org>", "250 sender\r\n"),
            ("RCPT TO:<one@example.org>", "250 recipient\r\n"),
            ("DATA", "354 go\r\n"),
        ] {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(line.starts_with(prefix), "{line:?}");
            writer.write_all(reply.as_bytes()).await.unwrap();
        }
        let mut message = Vec::new();
        loop {
            let mut line = Vec::new();
            assert!(reader.read_until(b'\n', &mut line).await.unwrap() > 0);
            if line == b".\r\n" {
                break;
            }
            message.extend(line);
        }
        let parsed = mailparse::parse_mail(&message).unwrap();
        assert_eq!(
            parsed.get_body().unwrap().trim_end(),
            "private body 工\nsecond line"
        );
        if acknowledge {
            writer.write_all(b"250 accepted\r\n").await.unwrap();
        }
        accepted.send(()).unwrap();
        if crash {
            let mut line = String::new();
            let _ = reader.read_line(&mut line).await;
        }
        drop(writer);
        drop(reader);
        tokio::select! {
            _ = listener.accept() => panic!("delivery was retried before the CLI settled"),
            _ = completion => (),
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "uncertain delivery was retried"
        );
    });
    let root = fixture.0.clone();
    let sending = tokio::task::spawn_blocking(move || {
        let (args, body) = if generic {
            (vec!["call", "mail.send", "--json"], serde_json::json!({"account":"imap:imap@example.org","to":["one@example.org"],"body":"private body 工\nsecond line","execute":true}).to_string().into_bytes())
        } else {
            (
                vec![
                    "send",
                    "--account",
                    "imap:imap@example.org",
                    "--to",
                    "one@example.org",
                    "--execute",
                    "--json",
                ],
                "private body 工\nsecond line".as_bytes().to_vec(),
            )
        };
        root_mail(&root, &args, &body)
    });
    if crash {
        tokio::time::timeout(std::time::Duration::from_secs(20), acceptance)
            .await
            .unwrap()
            .unwrap();
        desktop.as_mut().unwrap().kill().await.unwrap();
        desktop.as_mut().unwrap().wait().await.unwrap();
    }
    let output = sending.await.unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["result"]["outbox"]["entries"][0]["state"],
        if acknowledge { "sent" } else { "unknown" },
        "{output:?}"
    );
    assert_eq!(output.status.code(), Some(if acknowledge { 0 } else { 1 }));
    assert_eq!(value["ok"], acknowledge);
    if !acknowledge {
        assert_eq!(value["error"]["code"], "outbox_delivery_unknown");
    }
    let durable: Value =
        serde_json::from_slice(&fs::read(fixture.0.join("state/omamail/outbox.json")).unwrap())
            .unwrap();
    assert_eq!(durable.as_array().unwrap().len(), 1);
    assert_eq!(
        durable[0]["state"],
        value["result"]["outbox"]["entries"][0]["state"]
    );
    assert_eq!(durable[0]["id"], value["result"]["sendId"]);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("private body"));
    assert!(output.stderr.is_empty());
    finished.send(()).unwrap();
    peer.await.unwrap();
    if let Some(mut child) = desktop {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

#[tokio::test]
async fn partial_batch_reports_confirmed_ids_and_does_not_retry_failed_chunk() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = mail_list_fixture(listener.local_addr().unwrap().port(), true);
    let peer = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        writer.write_all(b"* OK ready\r\n").await.unwrap();
        let mut stores = 0;
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).await.unwrap() > 0);
            let response = if line.starts_with("O1 LOGIN ") {
                "O1 OK login\r\n"
            } else if line == "O1 CAPABILITY\r\n" {
                "* CAPABILITY IMAP4rev1\r\nO1 OK caps\r\n"
            } else if line == "O1 LIST \"\" \"*\"\r\n" {
                "* LIST () \"/\" INBOX\r\nO1 OK folders\r\n"
            } else if line == "O1 SELECT \"INBOX\"\r\n" {
                "O1 OK selected\r\n"
            } else if line.starts_with("O1 UID STORE ") {
                stores += 1;
                if stores == 1 {
                    assert!(line.starts_with("O1 UID STORE 1,2,3,"));
                    assert!(line.ends_with(",500 +FLAGS.SILENT (\\Seen)\r\n"));
                    "O1 OK stored\r\n"
                } else {
                    assert_eq!(line, "O1 UID STORE 501 +FLAGS.SILENT (\\Seen)\r\n");
                    "O1 NO refused\r\n"
                }
            } else {
                panic!("unexpected mutation command: {line:?}");
            };
            writer.write_all(response.as_bytes()).await.unwrap();
            if stores == 2 {
                break;
            }
        }
        drop(writer);
        drop(reader);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
    let root = fixture.0.clone();
    let output = tokio::task::spawn_blocking(move || {
        let ids: Vec<_> = (1..=501).map(|id| format!("{id}:INBOX")).collect();
        let mut args = vec![
            "mark",
            "read",
            "--account",
            "imap:imap@example.org",
            "--execute",
            "--json",
        ];
        args.extend(ids.iter().map(String::as_str));
        root_mail(&root, &args, b"")
    })
    .await
    .unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["code"], "mail_action_failed");
    assert_eq!(
        value["result"]["succeededIds"].as_array().unwrap().len(),
        500
    );
    assert_eq!(value["result"]["succeededIds"][0], "1:INBOX");
    assert_eq!(value["result"]["succeededIds"][499], "500:INBOX");
    assert_eq!(
        value["result"]["failedIds"],
        serde_json::json!(["501:INBOX"])
    );
    assert!(output.stderr.is_empty());
    peer.await.unwrap();
}

#[tokio::test]
async fn imap_action_preview_requires_discovered_destinations_and_execution_uses_them() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    for operation in ["archive", "trash"] {
        for available in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let fixture = mail_list_fixture(listener.local_addr().unwrap().port(), true);
            let config = fixture.0.join("config/omamail/accounts.json");
            let before = (
                metadata(&config),
                fs::read(&config).unwrap(),
                metadata(config.parent().unwrap()),
            );
            let peer = tokio::spawn(async move {
                for execute in if available {
                    vec![false, true]
                } else {
                    vec![false]
                } {
                    let (stream, _) = listener.accept().await.unwrap();
                    let (reader, mut writer) = stream.into_split();
                    let mut reader = BufReader::new(reader);
                    writer.write_all(b"* OK ready\r\n").await.unwrap();
                    let mut lists = 0;
                    let mut moves = 0;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap() == 0 {
                            break;
                        }
                        let response = if line.starts_with("O1 LOGIN ") {
                            "O1 OK login\r\n".to_owned()
                        } else if line == "O1 CAPABILITY\r\n" {
                            "* CAPABILITY IMAP4rev1 MOVE\r\nO1 OK caps\r\n".to_owned()
                        } else if line == "O1 LIST \"\" \"*\"\r\n" {
                            lists += 1;
                            assert_eq!(lists, 1, "execution must consume its planned folder");
                            let special = if operation == "archive" {
                                "\\Archive"
                            } else {
                                "\\Trash"
                            };
                            if available {
                                format!(
                                    "* LIST () \"/\" INBOX\r\n* LIST ({special}) \"/\" \"Shared \\\"store\\\"\"\r\nO1 OK folders\r\n"
                                )
                            } else {
                                "* LIST () \"/\" INBOX\r\nO1 OK folders\r\n".to_owned()
                            }
                        } else if execute && line == "O1 SELECT \"INBOX\"\r\n" {
                            "O1 OK selected\r\n".to_owned()
                        } else if execute && line == "O1 UID MOVE 7 \"Shared \\\"store\\\"\"\r\n" {
                            moves += 1;
                            "O1 OK moved\r\n".to_owned()
                        } else {
                            panic!("unplanned or forbidden command: {line:?}");
                        };
                        writer.write_all(response.as_bytes()).await.unwrap();
                    }
                    assert_eq!(lists, 1);
                    assert_eq!(moves, usize::from(execute));
                }
            });
            for execute in if available {
                vec![false, true]
            } else {
                vec![false]
            } {
                let root = fixture.0.clone();
                let output = tokio::task::spawn_blocking(move || {
                    let mut args = vec![
                        operation,
                        "7:INBOX",
                        "--account",
                        "imap:imap@example.org",
                        "--json",
                    ];
                    if execute {
                        args.push("--execute");
                    }
                    root_mail(&root, &args, b"")
                })
                .await
                .unwrap();
                let value: Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(output.status.success(), available, "{operation}: {value}");
                if available {
                    assert_eq!(value["result"]["targetIds"], serde_json::json!(["7:INBOX"]));
                    if execute {
                        assert_eq!(
                            value["result"]["succeededIds"],
                            serde_json::json!(["7:INBOX"])
                        );
                    }
                } else {
                    assert_eq!(
                        value["error"]["code"],
                        "mail_action_destination_unavailable"
                    );
                }
                if !execute {
                    assert_eq!(
                        (
                            metadata(&config),
                            fs::read(&config).unwrap(),
                            metadata(config.parent().unwrap())
                        ),
                        before
                    );
                    for name in ["cache", "state", "home"] {
                        assert!(!fixture.0.join(name).exists());
                    }
                }
            }
            peer.await.unwrap();
        }
    }
}

#[tokio::test]
async fn imap_archive_keeps_confirmed_folder_results_when_later_select_refuses() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = mail_list_fixture(listener.local_addr().unwrap().port(), true);
    let seeded = root_mail(&fixture.0, &["call", "cache.bodyPut", "--json"],
        serde_json::json!({"accountId":"imap:imap@example.org","id":"7:INBOX","body":{"text":"cached body"}}).to_string().as_bytes());
    assert!(seeded.status.success(), "{seeded:?}");
    let read_cache = || {
        let output = root_mail(
            &fixture.0,
            &["call", "cache.bodyRead", "--json"],
            serde_json::json!({"accountId":"imap:imap@example.org","id":"7:INBOX"})
                .to_string()
                .as_bytes(),
        );
        assert!(output.status.success(), "{output:?}");
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["result"].clone()
    };
    assert_eq!(read_cache()["text"], "cached body");
    let peer = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        writer.write_all(b"* OK ready\r\n").await.unwrap();
        let mut commands = Vec::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            let response = if line.starts_with("O1 LOGIN ") {
                "O1 OK login\r\n"
            } else if line == "O1 CAPABILITY\r\n" {
                "* CAPABILITY IMAP4rev1 MOVE\r\nO1 OK caps\r\n"
            } else if line == "O1 LIST \"\" \"*\"\r\n" {
                "* LIST () \"/\" INBOX\r\n* LIST () \"/\" ZOther\r\n* LIST (\\Archive) \"/\" Archive\r\nO1 OK folders\r\n"
            } else {
                commands.push(line.clone());
                match line.as_str() {
                    "O1 SELECT \"INBOX\"\r\n" | "O1 UID MOVE 7 \"Archive\"\r\n" => "O1 OK done\r\n",
                    "O1 SELECT \"ZOther\"\r\n" => "O1 NO refused\r\n",
                    _ => panic!("unexpected or repeated mutation: {line:?}"),
                }
            };
            writer.write_all(response.as_bytes()).await.unwrap();
        }
        assert_eq!(
            commands,
            [
                "O1 SELECT \"INBOX\"\r\n",
                "O1 UID MOVE 7 \"Archive\"\r\n",
                "O1 SELECT \"ZOther\"\r\n"
            ]
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "acknowledged IDs must not be retried"
        );
    });
    let root = fixture.0.clone();
    let output = tokio::task::spawn_blocking(move || {
        root_mail(
            &root,
            &[
                "archive",
                "7:INBOX",
                "8:ZOther",
                "--account",
                "imap:imap@example.org",
                "--execute",
                "--json",
            ],
            b"",
        )
    })
    .await
    .unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(value["error"]["code"], "mail_action_failed");
    assert_eq!(
        value["result"]["succeededIds"],
        serde_json::json!(["7:INBOX"]),
        "{value}"
    );
    assert_eq!(
        value["result"]["failedIds"],
        serde_json::json!(["8:ZOther"])
    );
    let cached = read_cache();
    assert!(
        cached.is_null(),
        "confirmed success must invalidate cache: {cached}"
    );
    peer.await.unwrap();
}

#[tokio::test]
async fn root_list_and_read_use_active_account_and_safe_provider_results() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    for read in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = mail_list_fixture(listener.local_addr().unwrap().port(), true);
        let config = fixture.0.join("config/omamail/accounts.json");
        let mut registry: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        registry["activeId"] = serde_json::json!("imap:imap@example.org");
        fs::write(&config, registry.to_string()).unwrap();
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            writer.write_all(b"* OK ready\r\n").await.unwrap();
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).await.unwrap() > 0);
                let response = if line.starts_with("O1 LOGIN ") {
                    "O1 OK login\r\n".into()
                } else if line == "O1 CAPABILITY\r\n" {
                    "* CAPABILITY IMAP4rev1\r\nO1 OK caps\r\n".into()
                } else if line == "O1 LIST \"\" \"*\"\r\n" {
                    "* LIST () \"/\" INBOX\r\nO1 OK folders\r\n".into()
                } else if line == "O1 SELECT \"INBOX\"\r\n" {
                    "O1 OK selected\r\n".into()
                } else if line == "O1 UID FETCH 1:* (UID)\r\n" {
                    "* 1 FETCH (UID 7)\r\nO1 OK snapshot\r\n".into()
                } else if line.starts_with("O1 UID FETCH 7 (UID FLAGS ") {
                    assert!(line.contains("BODY.PEEK["));
                    assert_eq!(line.contains("BODY.PEEK[]"), read);
                    let raw = "From: Writer <writer@example.org>\r\nSubject: Safe root result\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nsafe body 工";
                    format!(
                        "* 7 FETCH (UID 7 FLAGS () INTERNALDATE \"11-Sep-2026 12:00:00 +0000\" RFC822.SIZE {} BODY[] {{{}}}\r\n{}\r\n)\r\nO1 OK fetched\r\n",
                        raw.len(),
                        raw.len(),
                        raw
                    )
                } else {
                    panic!("unexpected read command: {line:?}");
                };
                writer.write_all(response.as_bytes()).await.unwrap();
                if line.starts_with("O1 UID FETCH 7 (UID FLAGS ") {
                    break;
                }
            }
        });
        let root = fixture.0.clone();
        let output = tokio::task::spawn_blocking(move || {
            root_mail(
                &root,
                if read {
                    &["read", "7:INBOX", "--json"]
                } else {
                    &["list", "--json"]
                },
                b"",
            )
        })
        .await
        .unwrap();
        assert!(output.status.success(), "{output:?}");
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["accountId"], "imap:imap@example.org");
        if read {
            assert_eq!(value["result"]["message"]["id"], "7:INBOX");
            assert_eq!(
                value["result"]["message"]["nativeContent"]["body"]["text"],
                "safe body 工"
            );
        } else {
            assert_eq!(value["result"]["messages"][0]["id"], "7:INBOX");
            assert_eq!(value["result"]["mailbox"], "inbox");
            assert_eq!(value["result"]["nextPageToken"], "");
        }
        assert!(output.stderr.is_empty());
        peer.await.unwrap();
    }
}
