use super::*;
fn stream(event: Value) -> Value {
    json!({"type":"stream_event","event":event})
}
fn delta(text: &str) -> Value {
    stream(json!({"type":"content_block_delta","delta":{"type":"text_delta","text":text}}))
}

#[test]
fn partial_text_snapshot_and_tools_preserve_owner_visible_transcript() {
    let mut parser = ClaudeStream::new(vec![json!({"role":"user","text":"Question"})]).unwrap();
    parser
        .accept(stream(json!({"type":"message_start"})))
        .unwrap();
    parser.accept(delta("Hel")).unwrap();
    parser.accept(delta("lo")).unwrap();
    parser.accept(stream(json!({"type":"content_block_start","content_block":{"type":"tool_use","name":"Read","input":{"secret":"DO NOT SHOW"}}}))).unwrap();
    parser.accept(json!({"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","name":"Read","input":{"secret":"DO NOT SHOW"}},{"type":"thinking","thinking":"HIDDEN"}]}})).unwrap();
    assert_eq!(
        parser.display()["transcript"],
        json!([{"role":"user","text":"Question"},{"role":"assistant","text":"Hello"},{"role":"status","text":"Reading a file"}])
    );
    parser.accept(json!({"type":"user","message":{"content":[{"type":"tool_result","content":"DO NOT SHOW"}]}})).unwrap();
    assert_eq!(parser.progress(), "Tool finished");
    parser.accept(json!({"type":"assistant","message":{"content":[{"type":"text","text":"Final answer"}]}})).unwrap();
    parser
        .accept(json!({"type":"result","subtype":"success","result":"Final answer"}))
        .unwrap();
    assert!(parser.final_seen());
    assert_eq!(parser.display()["complete"], true);
    assert_eq!(parser.display()["output"], "Final answer");
    assert!(!parser.display().to_string().contains("DO NOT SHOW"));
    assert!(!parser.display().to_string().contains("HIDDEN"));
}

#[test]
fn session_identity_is_uuid_and_never_changes() {
    let mut parser = ClaudeStream::new(vec![]).unwrap();
    let id = "12345678-1234-1234-1234-123456789aBc";
    parser
        .accept(json!({"type":"system","session_id":id}))
        .unwrap();
    assert_eq!(parser.session_id(), id);
    assert!(
        parser
            .accept(json!({"session_id":"12345678-1234-1234-1234-123456789abc"}))
            .is_err()
    );
    assert_eq!(parser.session_id(), id);
    for value in [
        json!(""),
        json!("../escape"),
        json!(123),
        json!("12345678-1234-1234-1234-123456789abc\n"),
    ] {
        assert!(
            ClaudeStream::new(vec![])
                .unwrap()
                .accept(json!({"session_id":value}))
                .is_err()
        );
    }
    parser.accept(json!({"parent_tool_use_id":"child","session_id":"invalid","type":"assistant","message":{"content":[{"type":"text","text":"private"}]}})).unwrap();
    assert_eq!(parser.display()["output"], "");
}

#[test]
fn invalid_controls_and_oversized_answers_leave_previous_snapshot_readable() {
    let mut parser = ClaudeStream::new(vec![]).unwrap();
    parser.accept(delta("Safe\tline\r\n中文")).unwrap();
    let before = parser.display();
    for text in ["\0", "\x1b[31m", "\u{7f}", "\u{85}", "\u{9f}"] {
        assert!(parser.accept(delta(text)).is_err());
        assert_eq!(parser.display(), before);
    }
    assert!(parser.accept(delta(&"x".repeat(RESULT_LIMIT))).is_err());
    assert_eq!(parser.display(), before);
    assert!(
        parser
            .accept(json!({"type":"result","subtype":"error","result":"unsafe\0"}))
            .is_err()
    );
    assert!(parser.final_seen());
    assert_eq!(parser.display(), before);
}

#[test]
fn transcript_count_bytes_and_history_shape_are_bounded() {
    assert!(ClaudeStream::new(vec![json!({"role":"tool","text":"x"})]).is_err());
    assert!(ClaudeStream::new(vec![json!({"role":"user","text":"x","extra":"private"})]).is_err());
    assert!(ClaudeStream::new(vec![json!({"role":"user","text":"\u{80}"})]).is_err());
    assert!(
        ClaudeStream::new(vec![
            json!({"role":"user","text":"x".repeat(TRANSCRIPT_LIMIT)})
        ])
        .is_err()
    );
    let history = vec![json!({"role":"user","text":"x"}); 200];
    let mut parser = ClaudeStream::new(history).unwrap();
    let before = parser.display();
    assert!(parser.accept(delta("new")).is_err());
    assert_eq!(parser.display(), before);
}

#[test]
fn second_snapshot_starts_a_new_answer_and_unknown_tools_have_fixed_label() {
    let mut parser = ClaudeStream::new(vec![]).unwrap();
    for answer in ["First", "Second"] {
        parser
            .accept(
                json!({"type":"assistant","message":{"content":[{"type":"text","text":answer}]}}),
            )
            .unwrap();
    }
    assert_eq!(parser.display()["transcript"].as_array().unwrap().len(), 2);
    parser.accept(stream(json!({"type":"content_block_start","content_block":{"type":"tool_use","name":"arbitrary\u{1b}secret"}}))).unwrap();
    assert_eq!(parser.progress(), "Using a tool");
}
