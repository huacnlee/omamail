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
    assert_eq!(plain.stdout, b"omamail 0.8.2\n");
    assert!(plain.stderr.is_empty());

    let json = omamail(&["version", "--json"]);
    assert!(json.status.success());
    assert_eq!(json.stdout, b"{\"version\":\"0.8.2\"}\n");
    assert!(json.stderr.is_empty());
}

#[test]
fn no_arguments_print_help_without_starting_a_gui() {
    let output = omamail(&[]);
    assert!(output.status.success());
    assert!(output.stdout.starts_with(b"Usage: omamail "));
    assert!(output.stderr.is_empty());
}

#[test]
fn serve_runs_the_persistent_backend() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
        .arg("serve")
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
        .args(["call", method])
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
