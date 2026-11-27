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
