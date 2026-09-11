use serde_json::Value;
use std::io::Write;
use std::process::{Command, Output, Stdio};

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
