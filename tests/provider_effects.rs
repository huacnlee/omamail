#[path = "../src/provider_effects.rs"]
mod provider_effects;

use provider_effects::*;
use serde_json::{Value, json};
use std::sync::Mutex;

struct Context;
impl HostContext for Context {
    fn provider_for(&self, account_id: &str) -> Option<Provider> {
        match account_id {
            "me@example.test" => Some(Provider::Gmail),
            "imap:me@example.test" => Some(Provider::Imap),
            _ => None,
        }
    }
    fn source_for(&self, _: &str) -> Option<SourceContext> {
        None
    }
}
struct Runtime;
impl ImapRuntimeResolver for Runtime {
    fn runtime_for(&self, _: &str, _: std::time::Duration) -> Option<ImapRuntime> {
        Some(ImapRuntime {
            special_use: [
                ("\\archive".into(), "Server Archive".into()),
                ("\\trash".into(), "Deleted".into()),
            ]
            .into(),
            archive_folder: Some("Server Archive".into()),
            trash_folder: Some("Deleted".into()),
            supports_move: true,
        })
    }
}
struct RuntimeNoMove;
impl ImapRuntimeResolver for RuntimeNoMove {
    fn runtime_for(&self, _: &str, _: std::time::Duration) -> Option<ImapRuntime> {
        Some(ImapRuntime {
            special_use: [
                ("\\archive".into(), "Archive".into()),
                ("\\trash".into(), "Trash".into()),
            ]
            .into(),
            archive_folder: Some("Archive".into()),
            trash_folder: Some("Trash".into()),
            supports_move: false,
        })
    }
}

#[derive(Default)]
struct Gmail(Mutex<Vec<GmailCall>>);
impl GmailExecutor for Gmail {
    fn execute(&self, call: GmailCall, _: std::time::Duration) -> Result<Value, ProviderFailure> {
        self.0.lock().unwrap().push(call);
        Ok(json!({"messages":[]}))
    }
}
#[derive(Default)]
struct Imap(Mutex<Vec<ImapCall>>);
impl ImapExecutor for Imap {
    fn execute(
        &self,
        call: ImapCall,
        _: std::time::Duration,
    ) -> Result<ImapTransportPayload, ProviderFailure> {
        self.0.lock().unwrap().push(call);
        Ok(ImapTransportPayload {
            status: 0,
            response_base64: "QQ==".into(),
        })
    }
}

struct SlowRuntime;
impl ImapRuntimeResolver for SlowRuntime {
    fn runtime_for(&self, _: &str, deadline: std::time::Duration) -> Option<ImapRuntime> {
        assert!(deadline <= std::time::Duration::from_millis(100));
        std::thread::sleep(std::time::Duration::from_millis(20));
        Some(ImapRuntime {
            special_use: [("\\archive".into(), "Archive".into())].into(),
            archive_folder: Some("Archive".into()),
            trash_folder: None,
            supports_move: true,
        })
    }
}

#[derive(Default)]
struct TimedImap(Mutex<Vec<std::time::Duration>>);
impl ImapExecutor for TimedImap {
    fn execute(
        &self,
        _: ImapCall,
        deadline: std::time::Duration,
    ) -> Result<ImapTransportPayload, ProviderFailure> {
        self.0.lock().unwrap().push(deadline);
        Ok(ImapTransportPayload {
            status: 0,
            response_base64: "QQ==".into(),
        })
    }
}

fn dispatcher<'a>(gmail: &'a Gmail, imap: &'a Imap) -> ProviderDispatcher<'a> {
    ProviderDispatcher::new(&Context, gmail, imap)
}

#[test]
fn routes_closed_gmail_list_and_preserves_identity() {
    let gmail = Gmail::default();
    let imap = Imap::default();
    let reply = dispatcher(&gmail, &imap).dispatch(
        &json!({"operation":"gmail.list","deadlineMs":30000,
        "identity":{"accountId":"me@example.test","objectId":"","revision":4},
        "query":"in:inbox","maxResults":25,"pageToken":null})
        .to_string(),
    );
    assert!(reply.ok);
    assert_eq!(reply.identity.unwrap().revision, 4);
    assert!(matches!(gmail.0.lock().unwrap()[0], GmailCall::List { .. }));
}

#[test]
fn imap_runtime_is_closed_account_bound_and_returns_only_allowed_special_use() {
    let gmail = Gmail::default();
    let imap = Imap::default();
    let request = json!({"operation":"imap.runtime","deadlineMs":30000,
        "identity":{"accountId":"imap:me@example.test","objectId":"","revision":9}});
    let reply = dispatcher(&gmail, &imap)
        .with_imap_runtime(&Runtime)
        .dispatch(&request.to_string());
    assert!(reply.ok);
    assert_eq!(reply.identity.unwrap().revision, 9);
    assert_eq!(
        reply.data.unwrap(),
        json!({
            "specialUse":{"\\archive":"Server Archive","\\trash":"Deleted"},
            "supportsMove":true
        })
    );
    for hostile in [
        json!({"operation":"imap.runtime","deadlineMs":0,"identity":{"accountId":"imap:me@example.test","objectId":"","revision":1}}),
        json!({"operation":"imap.runtime","deadlineMs":1,"identity":{"accountId":"me@example.test","objectId":"","revision":1}}),
        json!({"operation":"imap.runtime","deadlineMs":1,"identity":{"accountId":"imap:me@example.test","objectId":"7:INBOX","revision":1}}),
        json!({"operation":"imap.runtime","deadlineMs":1,"identity":{"accountId":"imap:me@example.test","objectId":"","revision":1},"extra":true}),
    ] {
        assert!(
            !dispatcher(&gmail, &imap)
                .with_imap_runtime(&Runtime)
                .dispatch(&hostile.to_string())
                .ok
        );
    }
}

#[test]
fn archive_discovery_and_execution_share_one_absolute_deadline() {
    let gmail = Gmail::default();
    let imap = TimedImap::default();
    let reply = ProviderDispatcher::new(&Context, &gmail, &imap)
        .with_imap_runtime(&SlowRuntime)
        .dispatch(
            &json!({"operation":"imap.action","deadlineMs":100,
            "identity":{"accountId":"imap:me@example.test","objectId":"7:INBOX","revision":1},
            "action":"archive","messageIds":["7:INBOX"]})
            .to_string(),
        );
    assert!(reply.ok);
    assert!(imap.0.lock().unwrap()[0] <= std::time::Duration::from_millis(80));
}

#[test]
fn rejects_unknown_fields_provider_mismatch_and_empty_object_identity() {
    let gmail = Gmail::default();
    let imap = Imap::default();
    for request in [
        json!({"operation":"gmail.list","deadlineMs":1,"identity":{"accountId":"me@example.test","objectId":"","revision":1},"query":"","maxResults":25,"pageToken":null,"extra":true}),
        json!({"operation":"gmail.detail","deadlineMs":1,"identity":{"accountId":"imap:me@example.test","objectId":"x","revision":1},"messageId":"x","full":true}),
        json!({"operation":"gmail.detail","deadlineMs":1,"identity":{"accountId":"me@example.test","objectId":"","revision":1},"messageId":"","full":true}),
    ] {
        assert!(!dispatcher(&gmail, &imap).dispatch(&request.to_string()).ok);
    }
    assert!(gmail.0.lock().unwrap().is_empty());
    assert!(imap.0.lock().unwrap().is_empty());
}

#[test]
fn routes_gmail_detail_and_closed_action() {
    let gmail = Gmail::default();
    let imap = Imap::default();
    for request in [
        json!({"operation":"gmail.detail","deadlineMs":9,"identity":{"accountId":"me@example.test","objectId":"m1","revision":2},"messageId":"m1","full":true}),
        json!({"operation":"gmail.action","deadlineMs":9,"identity":{"accountId":"me@example.test","objectId":"m1","revision":2},"action":"archive","messageIds":["m1"]}),
    ] {
        assert!(dispatcher(&gmail, &imap).dispatch(&request.to_string()).ok);
    }
    assert!(matches!(
        gmail.0.lock().unwrap()[1],
        GmailCall::Action {
            action: GmailAction::Archive,
            ..
        }
    ));
}

#[test]
fn routes_exact_gmail_attachment_identity_and_rejects_hostile_part_ids() {
    let gmail = Gmail::default();
    let imap = Imap::default();
    let request = json!({"operation":"gmail.attachment","deadlineMs":900,
        "identity":{"accountId":"me@example.test","objectId":"m1","revision":2},
        "messageId":"m1","partId":"part:1"});
    assert!(dispatcher(&gmail, &imap).dispatch(&request.to_string()).ok);
    assert!(matches!(
        gmail.0.lock().unwrap()[0],
        GmailCall::Attachment { ref message_id, ref part_id, .. }
            if message_id == "m1" && part_id == "part:1"
    ));
    for part_id in ["", "../secret", "bad\npart"] {
        let hostile = json!({"operation":"gmail.attachment","deadlineMs":900,
            "identity":{"accountId":"me@example.test","objectId":"m1","revision":2},
            "messageId":"m1","partId":part_id});
        assert!(!dispatcher(&gmail, &imap).dispatch(&hostile.to_string()).ok);
    }
}

#[test]
fn imap_reply_is_explicit_transport_data_not_parsed_messages() {
    let gmail = Gmail::default();
    let imap = Imap::default();
    let reply = dispatcher(&gmail, &imap).dispatch(
        &json!({"operation":"imap.detail","deadlineMs":20,
        "identity":{"accountId":"imap:me@example.test","objectId":"7:INBOX","revision":3},
        "messageId":"7:INBOX","full":true})
        .to_string(),
    );
    assert!(reply.ok);
    assert_eq!(
        reply.data.unwrap(),
        json!({"kind":"imap.transport","status":0,"responseBase64":"QQ=="})
    );
}

#[test]
fn errors_are_fixed_and_never_echo_input() {
    let gmail = Gmail::default();
    let imap = Imap::default();
    let reply = dispatcher(&gmail, &imap).dispatch("refresh_token=top-secret");
    assert_eq!(reply.error.as_deref(), Some("invalid provider request"));
    assert!(!format!("{reply:?}").contains("top-secret"));
    let _errors = [
        ProviderFailure::Unavailable,
        ProviderFailure::SignedOut,
        ProviderFailure::TimedOut,
        ProviderFailure::Failed,
        ProviderFailure::Uncertain,
    ];
    assert!(Context.source_for("missing").is_none());
    let _source_shape = SourceContext {
        source_id: "work".into(),
        account_id: "me@example.test".into(),
        kind: "google".into(),
        url: None,
    };
}

#[test]
fn imap_move_destination_comes_only_from_runtime_discovery() {
    let gmail = Gmail::default();
    let imap = Imap::default();
    let request = json!({"operation":"imap.action","deadlineMs":20,
        "identity":{"accountId":"imap:me@example.test","objectId":"7:INBOX","revision":3},
        "action":"archive","messageIds":["7:INBOX"]})
    .to_string();
    let unavailable = dispatcher(&gmail, &imap).dispatch(&request);
    assert_eq!(
        unavailable.error.as_deref(),
        Some("provider capability unavailable")
    );
    let ready = ProviderDispatcher::new(&Context, &gmail, &imap)
        .with_imap_runtime(&Runtime)
        .dispatch(&request);
    assert!(ready.ok);
    assert!(
        matches!(&imap.0.lock().unwrap()[0], ImapCall::Action { destination: Some(value), .. } if value == "Server Archive")
    );
    let fallback = ProviderDispatcher::new(&Context, &gmail, &imap)
        .with_imap_runtime(&RuntimeNoMove)
        .dispatch(&request);
    assert!(fallback.ok);
    assert!(matches!(
        &imap.0.lock().unwrap()[1],
        ImapCall::Action {
            move_strategy: Some(ImapMoveStrategy::CopyStoreUidExpunge),
            ..
        }
    ));
}

#[test]
fn rejects_non_base64_transport_and_non_js_revision() {
    struct BadImap;
    impl ImapExecutor for BadImap {
        fn execute(
            &self,
            _: ImapCall,
            _: std::time::Duration,
        ) -> Result<ImapTransportPayload, ProviderFailure> {
            Ok(ImapTransportPayload {
                status: 0,
                response_base64: "secret:not-base64".into(),
            })
        }
    }
    let gmail = Gmail::default();
    let bad = ProviderDispatcher::new(&Context, &gmail, &BadImap).dispatch(&json!({"operation":"imap.detail","deadlineMs":1,
        "identity":{"accountId":"imap:me@example.test","objectId":"7:INBOX","revision":1},"messageId":"7:INBOX","full":true}).to_string());
    assert!(!bad.ok);
    assert!(!format!("{bad:?}").contains("secret"));
    let imap = Imap::default();
    let revision = dispatcher(&gmail, &imap).dispatch(&json!({"operation":"gmail.list","deadlineMs":1,
        "identity":{"accountId":"me@example.test","objectId":"","revision":9007199254740992u64},"query":"","maxResults":1,"pageToken":null}).to_string());
    assert!(!revision.ok);
}

#[test]
fn production_adapter_scaffolds_delegate_typed_calls() {
    let gmail = GmailExecutorAdapter(|_: GmailCall, _: std::time::Duration| Ok(json!({})));
    assert!(
        gmail
            .execute(
                GmailCall::List {
                    identity: Identity {
                        account_id: "a".into(),
                        object_id: "".into(),
                        revision: 1
                    },
                    query: "".into(),
                    max_results: 1,
                    page_token: None
                },
                std::time::Duration::from_secs(1)
            )
            .is_ok()
    );
    let imap = ImapExecutorAdapter(|_: ImapCall, _: std::time::Duration| {
        Ok(ImapTransportPayload {
            status: 0,
            response_base64: "".into(),
        })
    });
    assert!(
        imap.execute(
            ImapCall::Detail {
                identity: Identity {
                    account_id: "a".into(),
                    object_id: "1:I".into(),
                    revision: 1
                },
                message_id: "1:I".into(),
                full: true
            },
            std::time::Duration::from_secs(1)
        )
        .is_ok()
    );
}

#[test]
fn root_route_splits_groupware_without_fake_provider_variants() {
    assert_eq!(
        root_route(r#"{"operation":"gmail.list"}"#),
        Ok(RootRoute::Provider)
    );
    assert_eq!(
        root_route(r#"{"type":"compose.send"}"#),
        Ok(RootRoute::Groupware)
    );
    assert_eq!(
        root_route(r#"{"type":"calendar.list"}"#),
        Ok(RootRoute::Groupware)
    );
    assert!(root_route(r#"{"operation":"gmail.list","type":"compose.send"}"#).is_err());
    let oversized = format!(
        r#"{{"operation":"gmail.list","padding":"{}"}}"#,
        "x".repeat(1_048_576)
    );
    assert!(root_route(&oversized).is_err());
}
