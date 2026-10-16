use super::*;
use serde_json::json;

#[test]
fn durable_confirmation_never_accepts_a_different_stale_or_failed_session() {
    let mut stream = started(Provider::OpenCode);
    stream
        .accept(text(Provider::OpenCode, "1", "Synthetic answer"))
        .unwrap();
    let confirmed = json!({"data":{"id":"ses_123Abc","outcome":"succeeded","time":{"idle":2000}}});
    for bad in [
        json!(null),
        json!({"data":{"id":"ses_123Abc","outcome":"succeeded"}}),
        json!({"data":{"id":"ses_other","outcome":"succeeded","time":{"idle":2000}}}),
        json!({"data":{"id":"ses_123Abc","outcome":"failed","time":{"idle":2000}}}),
    ] {
        assert!(stream.confirm_opencode(&bad, 1).is_err());
        assert!(!stream.final_seen());
    }
    assert!(stream.confirm_opencode(&confirmed, 2001).is_err());
    stream.confirm_opencode(&confirmed, 1).unwrap();
    assert!(stream.final_seen());
    assert!(
        started(Provider::OpenCode)
            .confirm_opencode(&confirmed, 1)
            .is_err()
    );
    assert!(
        started(Provider::Codex)
            .confirm_opencode(&confirmed, 1)
            .is_err()
    );
}

fn started(provider: Provider) -> ProviderStream {
    let mut stream =
        ProviderStream::new(provider, vec![json!({"role":"user","text":"Question"})]).unwrap();
    if provider == Provider::OpenCode {
        stream
            .accept(json!({"type":"step_start","sessionID":"ses_123Abc"}))
            .unwrap();
    } else {
        stream
            .accept(
                json!({"type":"thread.started","thread_id":"11111111-2222-3333-4444-555555555555"}),
            )
            .unwrap();
        stream.accept(json!({"type":"turn.started"})).unwrap();
    }
    stream
}
fn text(provider: Provider, id: &str, value: &str) -> Value {
    if provider == Provider::OpenCode {
        json!({"type":"text","sessionID":"ses_123Abc","part":{"id":id,"type":"text","text":value}})
    } else {
        json!({"type":"item.completed","item":{"id":id,"type":"agent_message","text":value}})
    }
}
fn finish(provider: Provider) -> Value {
    if provider == Provider::OpenCode {
        json!({"type":"step_finish","part":{"reason":"stop"}})
    } else {
        json!({"type":"turn.completed"})
    }
}

#[test]
fn public_answers_keep_unicode_and_drop_reasoning_tool_inputs_and_raw_errors() {
    for provider in [Provider::OpenCode, Provider::Codex] {
        let mut stream = started(provider);
        for event in [
            json!({"type":"reasoning","part":{"text":"SECRET reasoning"}}),
            json!({"type":"item.completed","item":{"type":"reasoning","text":"SECRET reasoning"}}),
            json!({"type":"tool_use","part":{"state":{"input":"SECRET tool","output":"SECRET result"}}}),
            json!({"type":"item.started","item":{"type":"command_execution","command":"SECRET argv"}}),
        ] {
            stream.accept(event).unwrap();
        }
        stream
            .accept(text(provider, "1", "Hello مرحبا\n\"quoted\" \\"))
            .unwrap();
        assert!(!stream.final_seen());
        stream.accept(finish(provider)).unwrap();
        assert!(stream.final_seen());
        assert_eq!(stream.display()["complete"], true);
        assert_eq!(stream.display()["output"], "Hello مرحبا\n\"quoted\" \\");
        assert!(!stream.display().to_string().contains("SECRET"));
        assert_eq!(
            stream.accept(json!({"type":"error","error":{"message":"SECRET failure"}})),
            Err(FAILED)
        );
    }
}

#[test]
fn invalid_controls_duplicate_parts_and_oversize_leave_last_good_projection() {
    for provider in [Provider::OpenCode, Provider::Codex] {
        let mut stream = started(provider);
        stream.accept(text(provider, "1", "Safe answer")).unwrap();
        let before = stream.display();
        for bad in [
            text(provider, "2", "\u{1b}SECRET"),
            text(provider, "1", "duplicate"),
            text(provider, "2", &"x".repeat(65537)),
            json!(null),
            json!({}),
        ] {
            assert!(stream.accept(bad).is_err());
            assert_eq!(stream.display(), before);
        }
        assert!(
            stream
                .accept(json!({"type":"error","message":"x".repeat(524289)}))
                .is_err()
        );
    }
}

#[test]
fn completion_requires_identity_and_last_step_success() {
    for provider in [Provider::OpenCode, Provider::Codex] {
        // A protocol can complete with only an accepted draft proposal. The
        // worker separately requires persisted content before making it ready.
        let mut empty = started(provider);
        empty.accept(finish(provider)).unwrap();
        assert!(empty.final_seen());
        assert_eq!(empty.display()["output"], "");
        let mut unidentified = ProviderStream::new(provider, vec![]).unwrap();
        let mut answer = text(provider, "a", "answer");
        answer.as_object_mut().unwrap().remove("sessionID");
        unidentified.accept(answer).unwrap();
        assert!(unidentified.accept(finish(provider)).is_err());
    }
    let mut stream = started(Provider::OpenCode);
    stream
        .accept(text(Provider::OpenCode, "a", "Partial"))
        .unwrap();
    stream
        .accept(json!({"type":"step_finish","part":{"reason":"tool-calls"}}))
        .unwrap();
    assert!(!stream.final_seen());
    stream
        .accept(json!({"type":"step_start","sessionID":"ses_123Abc"}))
        .unwrap();
    assert_eq!(stream.display()["output"], "");
    assert!(
        stream
            .accept(json!({"type":"step_finish","part":{"reason":"length"}}))
            .is_err()
    );
    assert!(stream.accept(json!({"type":"text","sessionID":"ses_other","part":{"id":"b","type":"text","text":"Wrong session"}})).is_err());
    assert_eq!(stream.session_id(), "ses_123Abc");
}

/// Real v0.22.1 one-shot ids are `local-` plus 64 hex digits. Init leaves the id empty.
const HERMES_SESSION: &str =
    "local-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn hermes() -> ProviderStream {
    let mut stream = ProviderStream::new(
        Provider::Hermes,
        vec![json!({"role":"user","text":"Question"})],
    )
    .unwrap();
    stream
        .accept(json!({
            "type": "system",
            "subtype": "init",
            "model": "grok-4.7",
            "session_id": "",
            "timestamp": 1
        }))
        .unwrap();
    assert!(stream.session_id().is_empty());
    stream
}

#[test]
fn hermes_stream_keeps_deltas_drops_tool_payloads_and_requires_its_session() {
    let mut stream = hermes();
    stream
        .accept(json!({"type":"text","text":"Hello ","timestamp":2}))
        .unwrap();
    stream
        .accept(json!({"type":"delta","delta":"there ","timestamp":3}))
        .unwrap();
    stream
        .accept(json!({
            "type": "tool_use",
            "name": "terminal",
            "tool_call_id": "call-1",
            "input": "SECRET tool",
            "timestamp": 4
        }))
        .unwrap();
    stream
        .accept(json!({
            "type": "tool_result",
            "name": "terminal",
            "tool_call_id": "call-1",
            "output": "SECRET result",
            "duration_ms": 4,
            "is_error": false,
            "timestamp": 5
        }))
        .unwrap();
    stream
        .accept(json!({"type":"text","text":"مرحبا","timestamp":6}))
        .unwrap();
    let partial = stream.display();
    assert!(
        stream
            .accept(json!({
                "type": "result",
                "session_id": HERMES_SESSION,
                "exit_code": 0,
                "text": "Not the answer",
                "tokens": {"input": 1, "output": 1, "total": 2, "cache_read": 0, "cache_write": 0},
                "duration_ms": 8
            }))
            .is_err()
    );
    assert_eq!(stream.display(), partial);
    assert!(stream.session_id().is_empty());
    stream
        .accept(json!({
            "type": "result",
            "session_id": HERMES_SESSION,
            "exit_code": 0,
            "text": "Hello there مرحبا",
            "tokens": {"input": 1, "output": 2, "total": 3, "cache_read": 0, "cache_write": 0},
            "duration_ms": 9
        }))
        .unwrap();
    assert!(stream.final_seen());
    assert_eq!(stream.display()["output"], "Hello there مرحبا");
    assert_eq!(stream.session_id(), HERMES_SESSION);
    let shown = stream.display();
    let answers: Vec<_> = shown["transcript"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["role"] == "assistant")
        .collect();
    assert_eq!(answers.len(), 1);
    assert_eq!(answers[0]["text"], "Hello there مرحبا");
    assert!(stream.display().to_string().contains("Using a tool"));
    assert!(!stream.display().to_string().contains("SECRET"));
    assert_eq!(
        stream.accept(json!({"type":"text","text":"more"})),
        Err(INVALID)
    );
    assert_eq!(stream.display()["output"], "Hello there مرحبا");

    let mut failed = hermes();
    failed.accept(json!({"type":"text","text":"Safe"})).unwrap();
    let before = failed.display();
    assert_eq!(
        failed.accept(json!({"type":"result","session_id":HERMES_SESSION,"exit_code":1,"error":"SECRET failure","text":"SECRET"})),
        Err(FAILED)
    );
    assert_eq!(failed.display(), before);
    assert!(!failed.display().to_string().contains("SECRET"));

    let mut unidentified = ProviderStream::new(Provider::Hermes, vec![]).unwrap();
    unidentified
        .accept(json!({"type":"system","subtype":"init","session_id":"","model":"grok-4.7"}))
        .unwrap();
    unidentified
        .accept(json!({"type":"text","text":"answer"}))
        .unwrap();
    assert_eq!(
        unidentified.accept(json!({"type":"result","session_id":"","exit_code":0,"text":"answer"})),
        Err(FAILED)
    );
    assert!(!unidentified.final_seen());
    assert!(unidentified.session_id().is_empty());
    assert_eq!(
        ProviderStream::new(Provider::Hermes, vec![])
            .unwrap()
            .accept(json!({"type":"system","subtype":"init","session_id":"latest"})),
        Err("The AI returned an invalid session ID.")
    );
    let mut local = ProviderStream::new(Provider::Hermes, vec![]).unwrap();
    local
        .accept(json!({"type":"system","subtype":"init","session_id":"","model":"grok-4.7"}))
        .unwrap();
    assert!(!local.note_stdout_session("not-a-session").unwrap());
    assert!(local.session_id().is_empty());
    assert!(local.note_stdout_session(HERMES_SESSION).unwrap());
    assert_eq!(local.session_id(), HERMES_SESSION);
    assert_eq!(
        local.note_stdout_session(
            "local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ),
        Err("The AI changed session identity unexpectedly.")
    );
    assert_eq!(local.session_id(), HERMES_SESSION);
    local.accept(json!({"type":"text","text":"Hi"})).unwrap();
    local
        .accept(json!({"type":"result","session_id":"","exit_code":0,"text":"Hi"}))
        .unwrap();
    assert!(local.final_seen());

    let mut clash = hermes();
    assert!(clash.note_stdout_session(HERMES_SESSION).unwrap());
    assert_eq!(
        clash.accept(json!({
            "type": "result",
            "session_id": "local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "exit_code": 0,
            "text": ""
        })),
        Err("The AI changed session identity unexpectedly.")
    );
    assert_eq!(clash.session_id(), HERMES_SESSION);
    assert!(!clash.final_seen());
}
