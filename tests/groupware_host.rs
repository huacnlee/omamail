use omamail::providers::groupware::{
    Backend, BackendCall, BackendError, GroupwareHost, HostError, Secret,
};
use serde_json::{Value, json};
use std::sync::Mutex;

const ICS: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:one\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

#[derive(Default)]
struct FakeBackend {
    calls: Mutex<Vec<BackendCall>>,
    secret_reads: Mutex<Vec<String>>,
    deadlines: Mutex<Vec<std::time::Duration>>,
}

impl Backend for FakeBackend {
    fn read_secret(&self, identity: &str) -> Result<Secret, BackendError> {
        self.secret_reads.lock().unwrap().push(identity.to_owned());
        Ok(Secret::new("credential"))
    }

    fn execute(
        &self,
        call: BackendCall,
        _secret: &Secret,
        deadline: std::time::Duration,
    ) -> Result<Value, BackendError> {
        self.calls.lock().unwrap().push(call);
        self.deadlines.lock().unwrap().push(deadline);
        Ok(json!({"accepted": true}))
    }
}

fn run(backend: &FakeBackend, value: Value) -> Result<Value, HostError> {
    GroupwareHost::new(backend).execute_json(&value.to_string())
}

#[test]
fn dispatches_send_reply_and_draft_without_putting_content_in_debug() {
    let backend = FakeBackend::default();
    for (operation, mode) in [
        ("compose.send", "new"),
        ("compose.send", "reply"),
        ("compose.draft", "forward"),
    ] {
        run(
            &backend,
            json!({
                "type": operation,
                "provider": "gmail",
                "accountId": "me@example.test",
                "deadlineMs": 2000,
                "draft": {"mode": mode, "to": "you@example.test", "cc": "", "bcc": "",
                          "subject": "private subject", "body": "private body"}
            }),
        )
        .unwrap();
    }
    let calls = backend.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert!(matches!(
        calls[0],
        BackendCall::GmailCompose { save: false, .. }
    ));
    assert!(matches!(
        calls[2],
        BackendCall::GmailCompose { save: true, .. }
    ));
    assert!(!format!("{:?}", calls[0]).contains("private"));
}

fn compose_with(attachments: Value) -> Value {
    json!({
        "type": "compose.send",
        "provider": "gmail",
        "accountId": "me@example.test",
        "deadlineMs": 2000,
        "draft": {"mode": "new", "to": "you@example.test", "cc": "", "bcc": "",
                  "subject": "Subject", "body": "Body", "attachments": attachments}
    })
}

#[test]
fn carries_a_drafts_files_as_paths_and_keeps_them_out_of_debug_output() {
    let backend = FakeBackend::default();
    run(
        &backend,
        compose_with(json!([
            {"path":"/home/person/report.pdf","filename":"report.pdf",
             "mimeType":"application/pdf","size":12},
            {"path":"/home/person/notes.txt","filename":"notes.txt"}
        ])),
    )
    .unwrap();
    let calls = backend.calls.lock().unwrap();
    let BackendCall::GmailCompose { draft, .. } = &calls[0] else {
        panic!("a compose call");
    };
    let files = draft.attachments();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].path(), "/home/person/report.pdf");
    assert_eq!(files[0].filename(), "report.pdf");
    assert_eq!(files[0].mime_type(), "application/pdf");
    assert_eq!(files[0].size(), 12);
    // A media type the request omitted stays empty here; the host that reads
    // the file supplies the default, so there is one place that decides.
    assert_eq!(files[1].mime_type(), "");
    assert!(!format!("{:?}", calls[0]).contains("report.pdf"));
    assert!(!format!("{:?}", files[0]).contains("person"));
}

#[test]
fn refuses_every_attachment_shape_that_could_reach_a_file_or_a_header_unchecked() {
    let backend = FakeBackend::default();
    let big = 20 * 1024 * 1024;
    let cases: Vec<(&str, Value)> = vec![
        (
            "a relative path",
            json!([{"path":"report.pdf","filename":"report.pdf"}]),
        ),
        (
            "a path with a walk in it",
            json!([{"path":"/home/person/../../etc/passwd","filename":"passwd"}]),
        ),
        (
            "a path with a newline",
            json!([{"path":"/home/person/a\nb.pdf","filename":"a.pdf"}]),
        ),
        (
            "a path with a NUL",
            json!([{"path":"/home/person/a\u{0}b.pdf","filename":"a.pdf"}]),
        ),
        ("an empty path", json!([{"path":"","filename":"a.pdf"}])),
        (
            "a quoted filename",
            json!([{"path":"/home/person/a.pdf","filename":"a\".pdf"}]),
        ),
        (
            "a filename with a backslash",
            json!([{"path":"/home/person/a.pdf","filename":"a\\b.pdf"}]),
        ),
        (
            "a filename starting a parameter",
            json!([{"path":"/home/person/a.pdf","filename":"a.pdf; x=1"}]),
        ),
        (
            "a filename that is a path",
            json!([{"path":"/home/person/a.pdf","filename":"../a.pdf"}]),
        ),
        (
            "a filename with a newline",
            json!([{"path":"/home/person/a.pdf","filename":"a\r\nBcc: x@y.test"}]),
        ),
        (
            "an empty filename",
            json!([{"path":"/home/person/a.pdf","filename":""}]),
        ),
        ("no filename at all", json!([{"path":"/home/person/a.pdf"}])),
        (
            "a media type with a parameter",
            json!([{"path":"/home/person/a.pdf","filename":"a.pdf","mimeType":"application/pdf; boundary=x"}]),
        ),
        (
            "a media type that is not one",
            json!([{"path":"/home/person/a.pdf","filename":"a.pdf","mimeType":"application"}]),
        ),
        (
            "a file over the size limit",
            json!([{"path":"/home/person/a.pdf","filename":"a.pdf","size":big + 1}]),
        ),
        (
            "files over the size limit together",
            json!([
            {"path":"/home/person/a.pdf","filename":"a.pdf","size":big},
            {"path":"/home/person/b.pdf","filename":"b.pdf","size":1}]),
        ),
        (
            "a field nobody declared",
            json!([{"path":"/home/person/a.pdf","filename":"a.pdf","data":"AAAA"}]),
        ),
        (
            "a file with bytes and no path",
            json!([{"filename":"a.pdf","data":"AAAA"}]),
        ),
        (
            "a list that is not one",
            json!({"path":"/home/person/a.pdf","filename":"a.pdf"}),
        ),
        ("a bare string", json!(["/home/person/a.pdf"])),
    ];
    for (name, attachments) in cases {
        assert!(
            run(&backend, compose_with(attachments)).is_err(),
            "{name} must not reach the backend"
        );
    }
    let many: Vec<Value> = (0..21)
        .map(|index| json!({"path":format!("/home/person/{index}.pdf"),"filename":format!("{index}.pdf")}))
        .collect();
    assert!(run(&backend, compose_with(json!(many))).is_err());
    assert!(
        backend.calls.lock().unwrap().is_empty(),
        "nothing refused here may reach the backend"
    );
    assert!(
        backend.secret_reads.lock().unwrap().is_empty(),
        "and no credential is read to find out"
    );
}

#[test]
fn dispatches_closed_gmail_draft_delete() {
    let backend = FakeBackend::default();
    run(&backend, json!({"type":"compose.draft.delete","provider":"gmail","accountId":"me@example.test","deadlineMs":1000,"draftId":"draft-1"})).unwrap();
    assert!(
        matches!(backend.calls.lock().unwrap().as_slice(), [BackendCall::GmailDraftDelete { account_id, draft_id }] if account_id == "me@example.test" && draft_id == "draft-1")
    );
}

#[test]
fn refuses_imap_draft_before_reading_secrets_or_calling_the_backend() {
    let backend = FakeBackend::default();
    let result = run(
        &backend,
        json!({
            "type": "compose.draft",
            "provider": "imap",
            "accountId": "imap:me@example.test",
            "deadlineMs": 1000,
            "draft": {
                "mode": "new",
                "to": [],
                "cc": [],
                "bcc": [],
                "subject": "Draft",
                "body": "Body"
            }
        }),
    );

    assert_eq!(result.unwrap_err(), HostError::Unsupported);
    assert!(backend.secret_reads.lock().unwrap().is_empty());
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[test]
fn dispatches_google_list_create_and_update_effect_payloads() {
    let backend = FakeBackend::default();
    run(
        &backend,
        json!({"type":"calendar.list", "provider":"google", "sourceId":"primary",
        "deadlineMs":3000, "range":{"startMs":1,"endMs":2}}),
    )
    .unwrap();
    for event_id in ["", "event-7"] {
        run(
            &backend,
            json!({"type":"calendar.google.write", "sourceId":"primary",
            "accountId":"me@example.test", "deadlineMs":3000, "eventId":event_id,
            "payload":{"summary":"Appointment","description":"","location":"",
                "start":{"dateTime":"2026-08-29T01:00:00Z"},
                "end":{"dateTime":"2026-08-29T02:00:00Z"}}}),
        )
        .unwrap();
    }
    let calls = backend.calls.lock().unwrap();
    assert!(matches!(calls[0], BackendCall::GoogleCalendarList { .. }));
    assert!(matches!(
        calls[1],
        BackendCall::GoogleCalendarWrite { create: true, .. }
    ));
    assert!(matches!(
        calls[2],
        BackendCall::GoogleCalendarWrite { create: false, .. }
    ));
}

#[test]
fn caldav_rejects_cross_origin_before_secret_access() {
    let backend = FakeBackend::default();
    let result = run(
        &backend,
        json!({"type":"calendar.caldav.write", "sourceId":"work",
        "sourceUrl":"https://calendar.example.test/users/me/", "deadlineMs":3000,
        "url":"https://evil.example.test/events/1.ics", "payload":ICS}),
    );
    assert_eq!(result.unwrap_err(), HostError::OriginRefused);
    assert!(backend.secret_reads.lock().unwrap().is_empty());
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[test]
fn dispatches_google_and_caldav_delete_effects() {
    let backend = FakeBackend::default();
    run(
        &backend,
        json!({"type":"calendar.google.delete", "sourceId":"primary",
            "accountId":"me@example.test", "deadlineMs":3000, "eventId":"event-7"}),
    )
    .unwrap();
    run(
        &backend,
        json!({"type":"calendar.caldav.delete", "sourceId":"work",
            "sourceUrl":"https://calendar.example.test/users/me/", "deadlineMs":3000,
            "url":"events/1.ics"}),
    )
    .unwrap();
    let calls = backend.calls.lock().unwrap();
    assert!(matches!(calls[0], BackendCall::GoogleCalendarDelete { .. }));
    assert!(matches!(calls[1], BackendCall::CaldavDelete { .. }));
}

#[test]
fn caldav_resolves_same_origin_relative_urls_then_reads_secret() {
    let backend = FakeBackend::default();
    run(
        &backend,
        json!({"type":"calendar.caldav.write", "sourceId":"work",
        "sourceUrl":"https://calendar.example.test/users/me/", "deadlineMs":3000,
        "url":"events/1.ics", "payload":ICS}),
    )
    .unwrap();
    assert_eq!(&*backend.secret_reads.lock().unwrap(), &["caldav:work"]);
    let calls = backend.calls.lock().unwrap();
    assert!(matches!(&calls[0], BackendCall::CaldavWrite { url, .. }
        if url == "https://calendar.example.test/users/me/events/1.ics"));
}

#[test]
fn dispatches_caldav_list_create_and_update() {
    let backend = FakeBackend::default();
    run(
        &backend,
        json!({"type":"calendar.list", "provider":"caldav", "sourceId":"work",
            "sourceUrl":"https://calendar.example.test/users/me/", "deadlineMs":3000,
            "range":{"startMs":1,"endMs":2}}),
    )
    .unwrap();
    // A create and an update are the same request to the same kind of address:
    // the client names the resource, `collection + uid + ".ics"`, because that
    // is what a CalDAV create is.
    for url in [
        "https://calendar.example.test/users/me/omamail-1756000000000.ics",
        "https://calendar.example.test/users/me/event-1.ics",
    ] {
        run(
            &backend,
            json!({"type":"calendar.caldav.write", "sourceId":"work",
                "sourceUrl":"https://calendar.example.test/users/me/", "deadlineMs":3000,
                "url":url, "payload":ICS}),
        )
        .unwrap();
    }
    let calls = backend.calls.lock().unwrap();
    assert!(matches!(calls[0], BackendCall::CaldavList { .. }));
    assert!(matches!(&calls[1], BackendCall::CaldavWrite { url, .. }
        if url == "https://calendar.example.test/users/me/omamail-1756000000000.ics"));
    assert!(matches!(&calls[2], BackendCall::CaldavWrite { url, .. }
        if url == "https://calendar.example.test/users/me/event-1.ics"));
}

// A PUT at the collection is not how an event is created, and a server that
// answered one would answer it by replacing the collection. The address
// arriving as the collection means the client did not know where the event
// goes, so nothing is sent and no credential is read.
#[test]
fn caldav_refuses_a_write_aimed_at_the_collection() {
    let backend = FakeBackend::default();
    for url in [
        "https://calendar.example.test/users/me/",
        "https://calendar.example.test/users/me",
    ] {
        assert_eq!(
            run(
                &backend,
                json!({"type":"calendar.caldav.write", "sourceId":"work",
                    "sourceUrl":"https://calendar.example.test/users/me/", "deadlineMs":3000,
                    "url":url, "payload":ICS}),
            )
            .unwrap_err(),
            HostError::InvalidRequest
        );
    }
    assert!(backend.secret_reads.lock().unwrap().is_empty());
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[test]
fn rejects_unsupported_providers_bad_headers_deadlines_and_oversized_payloads() {
    let backend = FakeBackend::default();
    let base = |provider: &str, subject: &str, deadline: u64| {
        json!({
            "type":"compose.send", "provider":provider, "accountId":"a", "deadlineMs":deadline,
            "draft":{"mode":"new","to":"x@example.test","cc":"","bcc":"",
                     "subject":subject,"body":"body"}
        })
    };
    assert_eq!(
        run(&backend, base("unknown", "ok", 1000)).unwrap_err(),
        HostError::Unsupported
    );
    assert_eq!(
        run(&backend, base("gmail", "hello\r\nBcc: victim", 1000)).unwrap_err(),
        HostError::InvalidRequest
    );
    let mut injected_reference = base("gmail", "ok", 1000);
    injected_reference["draft"]["inReplyTo"] =
        json!("<message@example.test>\r\nBcc: victim@example.test");
    assert_eq!(
        run(&backend, injected_reference).unwrap_err(),
        HostError::InvalidRequest
    );
    assert_eq!(
        run(&backend, base("gmail", "ok", 0)).unwrap_err(),
        HostError::InvalidDeadline
    );
    assert_eq!(
        run(&backend, base("gmail", "ok", 120_001)).unwrap_err(),
        HostError::InvalidDeadline
    );
    let mut huge = base("gmail", "ok", 1000);
    huge["draft"]["body"] = Value::String("x".repeat(1_100_000));
    assert_eq!(run(&backend, huge).unwrap_err(), HostError::RequestTooLarge);
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[test]
fn errors_and_secrets_are_redacted() {
    let secret = Secret::new("dont-print-me");
    assert_eq!(secret.expose(), "dont-print-me");
    assert_eq!(format!("{secret:?}"), "Secret([REDACTED])");
    assert_eq!(
        HostError::BackendFailed.to_string(),
        "groupware operation failed"
    );
    let _classified_backend_errors = [
        BackendError::Unsupported,
        BackendError::AuthRequired,
        BackendError::Unavailable,
        BackendError::TimedOut,
        BackendError::Failed,
    ];
}

#[test]
fn google_event_payload_is_closed_typed_and_bounded() {
    let backend = FakeBackend::default();
    let request = |payload| {
        json!({"type":"calendar.google.write", "sourceId":"primary",
        "accountId":"me@example.test", "deadlineMs":4321, "eventId":"", "payload":payload})
    };
    let valid = json!({"summary":"Appointment", "description":"Notes", "location":"Desk",
        "start":{"dateTime":"2026-08-29T01:00:00Z"}, "end":{"dateTime":"2026-08-29T02:00:00Z"}});
    run(&backend, request(valid)).unwrap();
    assert_eq!(
        &*backend.deadlines.lock().unwrap(),
        &[std::time::Duration::from_millis(4321)]
    );

    for invalid in [
        json!({"summary":"x","start":{"dateTime":"a"},"end":{"dateTime":"b"},"attendees":[]}),
        json!({"summary":7,"start":{"dateTime":"a"},"end":{"dateTime":"b"}}),
        json!({"summary":"x","start":{"date":"2026-01-01","dateTime":"a"},"end":{"date":"2026-01-02"}}),
        json!({"summary":"x","start":{"dateTime":"a"},"end":{"dateTime":"b"},"description":"x".repeat(70_000)}),
    ] {
        assert_eq!(
            run(&backend, request(invalid)).unwrap_err(),
            HostError::InvalidRequest
        );
    }
}

#[test]
fn refuses_empty_recipients_and_control_or_oversized_identities() {
    let backend = FakeBackend::default();
    let compose = |to: &str, account: &str| {
        json!({"type":"compose.send", "provider":"gmail",
        "accountId":account, "deadlineMs":1000,
        "draft":{"mode":"new","to":to,"cc":"","bcc":"","subject":"x","body":"x"}})
    };
    assert_eq!(
        run(&backend, compose("", "me@example.test")).unwrap_err(),
        HostError::InvalidRequest
    );
    assert_eq!(
        run(&backend, compose("x@example.test", "bad\nidentity")).unwrap_err(),
        HostError::InvalidRequest
    );
    assert_eq!(
        run(&backend, compose("x@example.test", &"x".repeat(5000))).unwrap_err(),
        HostError::InvalidRequest
    );
    let event = |source: &str, event: &str| {
        json!({"type":"calendar.google.write",
        "sourceId":source, "accountId":"me@example.test", "deadlineMs":1000,
        "eventId":event, "payload":{"summary":"x","start":{"date":"2026-01-01"},
        "end":{"date":"2026-01-02"}}})
    };
    assert_eq!(
        run(&backend, event("bad\0source", "")).unwrap_err(),
        HostError::InvalidRequest
    );
    assert_eq!(
        run(&backend, event("primary", "bad\nevent")).unwrap_err(),
        HostError::InvalidRequest
    );
    assert!(backend.secret_reads.lock().unwrap().is_empty());
}

#[test]
fn draft_allows_no_recipient_but_send_requires_structured_addresses() {
    let backend = FakeBackend::default();
    let effect = |kind: &str, to: Value| {
        json!({"type":kind, "provider":"gmail",
        "accountId":"me@example.test", "deadlineMs":1000,
        "draft":{"mode":"new","to":to,"cc":[],"bcc":[],"subject":"x","body":"x"}})
    };
    run(&backend, effect("compose.draft", json!([]))).unwrap();
    assert_eq!(
        run(&backend, effect("compose.send", json!([]))).unwrap_err(),
        HostError::InvalidRequest
    );
    run(
        &backend,
        effect("compose.send", json!(["you@example.test"])),
    )
    .unwrap();
    for address in [
        "not-an-address",
        "a@example.test\nBcc:x@y.test",
        "a@@example.test",
    ] {
        assert_eq!(
            run(&backend, effect("compose.send", json!([address]))).unwrap_err(),
            HostError::InvalidRequest
        );
    }
    assert_eq!(
        run(
            &backend,
            json!({"type":"compose.send", "provider":"gmail",
        "accountId":"not-an-email", "deadlineMs":1000,
        "draft":{"mode":"new","to":["you@example.test"],"cc":[],"bcc":[],"subject":"x","body":"x"}})
        )
        .unwrap_err(),
        HostError::InvalidRequest
    );
}

#[test]
fn google_event_validates_moments_order_and_text_controls() {
    let backend = FakeBackend::default();
    let request = |payload| {
        json!({"type":"calendar.google.write", "sourceId":"primary",
        "accountId":"me@example.test", "deadlineMs":1000, "eventId":"", "payload":payload})
    };
    let event = |start: Value, end: Value, summary: &str| {
        json!({"summary":summary,
        "description":"", "location":"", "start":start, "end":end})
    };
    for invalid in [
        event(
            json!({"date":"2026-02-30"}),
            json!({"date":"2026-03-01"}),
            "x",
        ),
        event(
            json!({"date":"2026-03-02"}),
            json!({"date":"2026-03-01"}),
            "x",
        ),
        event(
            json!({"dateTime":"2026-08-29 01:00:00"}),
            json!({"dateTime":"2026-08-29T02:00:00Z"}),
            "x",
        ),
        event(
            json!({"dateTime":"2026-08-29T03:00:00+01:00"}),
            json!({"dateTime":"2026-08-29T01:30:00Z"}),
            "x",
        ),
        event(
            json!({"date":"2026-08-29"}),
            json!({"date":"2026-08-30"}),
            "bad\nsummary",
        ),
    ] {
        assert_eq!(
            run(&backend, request(invalid)).unwrap_err(),
            HostError::InvalidRequest
        );
    }
}

#[test]
fn oversized_caldav_ics_is_rejected_before_secret_access() {
    let backend = FakeBackend::default();
    let result = run(
        &backend,
        json!({"type":"calendar.caldav.write", "sourceId":"work",
        "sourceUrl":"https://calendar.example.test/me/", "deadlineMs":1000,
        "url":"event.ics", "payload":"x".repeat(65_537)}),
    );
    assert_eq!(result.unwrap_err(), HostError::InvalidRequest);
    assert!(backend.secret_reads.lock().unwrap().is_empty());
}

#[test]
fn unicode_dates_are_rejected_without_panicking() {
    let backend = FakeBackend::default();
    let result = run(
        &backend,
        json!({"type":"calendar.google.write", "sourceId":"primary",
        "accountId":"me@example.test", "deadlineMs":1000, "eventId":"",
        "payload":{"summary":"x","start":{"date":"💥026-01-01"},"end":{"date":"2026-01-02"}}}),
    );
    assert_eq!(result.unwrap_err(), HostError::InvalidRequest);
    let datetime = run(
        &backend,
        json!({"type":"calendar.google.write", "sourceId":"primary",
        "accountId":"me@example.test", "deadlineMs":1000, "eventId":"",
        "payload":{"summary":"x","start":{"dateTime":"2026-08-29T💥1:00:00Z"},
        "end":{"dateTime":"2026-08-29T02:00:00Z"}}}),
    );
    assert_eq!(datetime.unwrap_err(), HostError::InvalidRequest);
}

#[test]
fn caldav_requires_a_closed_calendar_event_document() {
    let backend = FakeBackend::default();
    for payload in [
        "hello",
        "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nbad\0value\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR",
    ] {
        let result = run(
            &backend,
            json!({"type":"calendar.caldav.write", "sourceId":"work",
            "sourceUrl":"https://calendar.example.test/me/", "deadlineMs":1000,
            "url":"event.ics", "payload":payload}),
        );
        assert_eq!(result.unwrap_err(), HostError::InvalidRequest);
    }
    assert!(backend.secret_reads.lock().unwrap().is_empty());
}
