use omamail::backend::protocol::{MAX_FRAME, serve};
use serde_json::{Value, json};

fn run(input: &[u8]) -> Vec<Value> {
    let mut output = Vec::new();
    serve(input, &mut output).unwrap();
    String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn requests_correlate_and_quit_stops_dispatch() {
    let responses = run(b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"system.info\"}\n{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"system.quit\"}\n{}\n");
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["jsonrpc"], "2.0");
    assert_eq!(responses[0]["id"], 7);
    assert_eq!(responses[1]["result"]["quitReady"], true);
}

#[test]
fn errors_are_structured_and_do_not_echo_payloads() {
    for (request, code) in [
        ("secret-token", -32700),
        (
            r#"{"jsonrpc":"2.0","id":1,"id":2,"method":"system.info"}"#,
            -32600,
        ),
        (r#"{"jsonrpc":"1.0","id":1,"method":"system.info"}"#, -32600),
        (r#"{"jsonrpc":"2.0","id":1,"method":"unknown"}"#, -32601),
        (
            r#"{"jsonrpc":"2.0","id":1,"method":"system.info","params":{"secret":"secret-token"}}"#,
            -32602,
        ),
    ] {
        let replies = run(format!("{request}\n").as_bytes());
        assert_eq!(replies[0]["error"]["code"], code);
        assert!(!replies[0].to_string().contains("secret-token"));
        assert!(replies[0].get("result").is_none());
    }
}

#[test]
fn notifications_are_silent_and_batch_preserves_ids() {
    let batch = json!([
        {"jsonrpc":"2.0","method":"system.info"},
        {"jsonrpc":"2.0","method":"unknown"},
        {"jsonrpc":"2.0","id":"gui-1","method":"system.info"},
        {"jsonrpc":"2.0","id":null,"method":"system.info"},
        3
    ]);
    let replies = run(format!("{batch}\n").as_bytes());
    let replies = replies[0].as_array().unwrap();
    assert_eq!(replies.len(), 3);
    assert_eq!(replies[0]["id"], "gui-1");
    assert!(replies[1]["id"].is_null());
    assert!(replies[1].get("result").is_some());
    assert_eq!(replies[2]["error"]["code"], -32600);
    assert!(run(b"[{\"jsonrpc\":\"2.0\",\"method\":\"system.info\"}]\n").is_empty());
    assert_eq!(run(b"[]\n")[0]["error"]["code"], -32600);
}

#[test]
fn oversized_and_truncated_input_is_rejected() {
    assert_eq!(run(&vec![b'x'; MAX_FRAME + 1])[0]["error"]["code"], -32001);
    assert_eq!(run(b"{}")[0]["error"]["code"], -32700);
    assert!(run(b"").is_empty());
}
