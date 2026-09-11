use serde_json::Value;
use std::io::Write;
use std::process::{Command, Output, Stdio};

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
