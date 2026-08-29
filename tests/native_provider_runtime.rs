use omamail::provider_effects::{ImapRuntime, ImapRuntimeResolver};
use omamail::{
    host_context::GmailContext,
    native_provider_runtime::{NativeProviderBackend, NativeProviderRuntime},
    provider_effects::{
        GmailCall, GmailExecutor, Identity, ImapCall, ImapExecutor, ImapTransportPayload,
        ProviderFailure,
    },
};
use serde_json::{Value, json};
use std::{sync::Mutex, time::Duration};

#[derive(Default)]
struct Backend(Mutex<Vec<&'static str>>);
impl NativeProviderBackend for Backend {
    fn gmail(
        &self,
        _: &GmailContext,
        call: GmailCall,
        _: Duration,
    ) -> Result<Value, ProviderFailure> {
        self.0.lock().unwrap().push("gmail");
        Ok(match call {
            GmailCall::List { .. } => json!({"messages":[]}),
            _ => json!({"ok":true}),
        })
    }
    fn imap(
        &self,
        _: &omamail::host_context::ImapContext,
        call: ImapCall,
        _: Duration,
    ) -> Result<ImapTransportPayload, ProviderFailure> {
        let _ = call;
        self.0.lock().unwrap().push("imap");
        Ok(ImapTransportPayload {
            status: 0,
            response_base64: "QQ==".into(),
        })
    }
}
fn configured() -> NativeProviderRuntime<Backend> {
    let (runtime, setup) = NativeProviderRuntime::with_backend(Backend::default());
    setup.configure(r#"[{"kind":"gmail","accountId":"me@example.test","clientId":"client.apps.googleusercontent.com","grant":"gmail.modify gmail.send calendar.events"},{"kind":"imap","accountId":"imap:me@example.test","email":"me@example.test","username":"me","imapHost":"mail.example.test","imapPort":993,"smtpHost":"mail.example.test","smtpPort":465,"insecure":false}]"#).unwrap();
    runtime
}
#[derive(Default)]
struct HydrateBackend {
    calls: Mutex<Vec<(&'static str, Duration)>>,
    fail_detail: bool,
}
impl NativeProviderBackend for HydrateBackend {
    fn gmail(
        &self,
        _: &GmailContext,
        call: GmailCall,
        deadline: Duration,
    ) -> Result<Value, ProviderFailure> {
        match call {
            GmailCall::List { .. } => {
                self.calls.lock().unwrap().push(("list", deadline));
                Ok(json!({"messages":[{"id":"one"},{"id":"two"}],"nextPageToken":"next"}))
            }
            GmailCall::Detail { message_id, .. } => {
                self.calls.lock().unwrap().push(("detail", deadline));
                if self.fail_detail && message_id == "two" {
                    Err(ProviderFailure::Failed)
                } else {
                    Ok(json!({"id":message_id,"payload":{"headers":[]}}))
                }
            }
            _ => unreachable!(),
        }
    }
    fn imap(
        &self,
        _: &omamail::host_context::ImapContext,
        _: ImapCall,
        _: Duration,
    ) -> Result<ImapTransportPayload, ProviderFailure> {
        unreachable!()
    }
}
fn hydrated(fail_detail: bool) -> NativeProviderRuntime<HydrateBackend> {
    let (runtime, setup) = NativeProviderRuntime::with_backend(HydrateBackend {
        calls: Mutex::new(vec![]),
        fail_detail,
    });
    setup.configure(r#"[{"kind":"gmail","accountId":"me@example.test","clientId":"client.apps.googleusercontent.com","grant":"gmail.modify gmail.send calendar.events"}]"#).unwrap();
    runtime
}
fn list_call() -> GmailCall {
    GmailCall::List {
        identity: Identity {
            account_id: "me@example.test".into(),
            object_id: "".into(),
            revision: 7,
        },
        query: "".into(),
        max_results: 2,
        page_token: None,
    }
}

#[test]
fn gmail_list_hydrates_metadata_under_one_absolute_deadline() {
    let runtime = hydrated(false);
    let result = GmailExecutor::execute(&runtime, list_call(), Duration::from_secs(2)).unwrap();
    assert_eq!(result["messages"][0]["id"], "one");
    assert_eq!(result["nextPageToken"], "next");
    let calls = runtime.backend().calls.lock().unwrap();
    assert_eq!(
        calls.iter().map(|x| x.0).collect::<Vec<_>>(),
        ["list", "detail", "detail"]
    );
    assert!(calls[1].1 <= calls[0].1 && calls[2].1 <= calls[1].1);
}

#[test]
fn gmail_list_never_returns_partial_rows_or_a_paging_token() {
    let runtime = hydrated(true);
    assert_eq!(
        GmailExecutor::execute(&runtime, list_call(), Duration::from_secs(2)),
        Err(ProviderFailure::Failed)
    );
}

struct HostileDetail(&'static str);
impl NativeProviderBackend for HostileDetail {
    fn gmail(
        &self,
        _: &GmailContext,
        call: GmailCall,
        _: Duration,
    ) -> Result<Value, ProviderFailure> {
        Ok(match call {
            GmailCall::List { .. } if self.0 == "reserved-list" => {
                json!({"messages":[{"id":"draft:collision"}]})
            }
            GmailCall::List { .. } => json!({"messages":[{"id":"one"}]}),
            GmailCall::Detail { .. } => match self.0 {
                "nonobject" => json!("one"),
                "wrong" => json!({"id":"two","payload":{"headers":[]}}),
                "missing" => json!({"id":"one","payload":{}}),
                "hostile-header" => {
                    json!({"id":"one","payload":{"headers":[{"name":"Subject","value":"x".repeat(65_537)}]}})
                }
                _ => unreachable!(),
            },
            _ => unreachable!(),
        })
    }
    fn imap(
        &self,
        _: &omamail::host_context::ImapContext,
        _: ImapCall,
        _: Duration,
    ) -> Result<ImapTransportPayload, ProviderFailure> {
        unreachable!()
    }
}
#[test]
fn gmail_list_rejects_nonobject_swapped_and_incomplete_details() {
    for kind in [
        "nonobject",
        "wrong",
        "missing",
        "hostile-header",
        "reserved-list",
    ] {
        let (runtime, setup) = NativeProviderRuntime::with_backend(HostileDetail(kind));
        setup.configure(r#"[{"kind":"gmail","accountId":"me@example.test","clientId":"client.apps.googleusercontent.com","grant":"gmail.modify gmail.send calendar.events"}]"#).unwrap();
        assert_eq!(
            GmailExecutor::execute(&runtime, list_call(), Duration::from_secs(1)),
            Err(ProviderFailure::Failed)
        );
    }
}
#[test]
fn resolves_registered_context_before_concrete_backend() {
    let r = configured();
    let value = GmailExecutor::execute(
        &r,
        GmailCall::List {
            identity: Identity {
                account_id: "me@example.test".into(),
                object_id: "".into(),
                revision: 1,
            },
            query: "".into(),
            max_results: 1,
            page_token: None,
        },
        Duration::from_secs(1),
    )
    .unwrap();
    assert_eq!(value, json!({"messages":[]}));
    assert_eq!(r.backend().0.lock().unwrap().as_slice(), ["gmail"]);
}
#[test]
fn unknown_account_is_fixed_unavailable_and_never_reaches_backend() {
    let r = configured();
    let error = GmailExecutor::execute(
        &r,
        GmailCall::List {
            identity: Identity {
                account_id: "secret@example.test".into(),
                object_id: "".into(),
                revision: 1,
            },
            query: "".into(),
            max_results: 1,
            page_token: None,
        },
        Duration::from_secs(1),
    )
    .unwrap_err();
    assert_eq!(error, ProviderFailure::Unavailable);
    assert!(r.backend().0.lock().unwrap().is_empty());
}
#[test]
fn imap_unsupported_paging_is_honest() {
    let r = configured();
    let result = ImapExecutor::execute(
        &r,
        ImapCall::List {
            identity: Identity {
                account_id: "imap:me@example.test".into(),
                object_id: "".into(),
                revision: 1,
            },
            folder: "INBOX".into(),
            criteria: "UNSEEN".into(),
            max_results: 20,
            page_token: Some("next".into()),
        },
        Duration::from_secs(1),
    );
    assert_eq!(result.unwrap_err(), ProviderFailure::Unavailable);
    assert!(r.backend().0.lock().unwrap().is_empty());
}

#[test]
fn js_default_all_list_reaches_backend_without_faking_complex_search() {
    let r = configured();
    let result = ImapExecutor::execute(
        &r,
        ImapCall::List {
            identity: Identity {
                account_id: "imap:me@example.test".into(),
                object_id: "".into(),
                revision: 1,
            },
            folder: "INBOX".into(),
            criteria: "ALL".into(),
            max_results: 25,
            page_token: None,
        },
        Duration::from_secs(1),
    )
    .unwrap();
    assert_eq!(result.response_base64, "QQ==");
    assert_eq!(r.backend().0.lock().unwrap().as_slice(), ["imap"]);
}

struct DiscoveryBackend(std::sync::atomic::AtomicUsize);
impl NativeProviderBackend for DiscoveryBackend {
    fn gmail(&self, _: &GmailContext, _: GmailCall, _: Duration) -> Result<Value, ProviderFailure> {
        unreachable!()
    }
    fn imap(
        &self,
        _: &omamail::host_context::ImapContext,
        _: ImapCall,
        _: Duration,
    ) -> Result<ImapTransportPayload, ProviderFailure> {
        unreachable!()
    }
    fn discover_imap_runtime(
        &self,
        _: &omamail::host_context::ImapContext,
        _: Duration,
    ) -> Option<ImapRuntime> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
#[test]
fn discovery_is_exact_account_cached_and_unknown_is_refused() {
    let (runtime, setup) = NativeProviderRuntime::with_backend(DiscoveryBackend(
        std::sync::atomic::AtomicUsize::new(0),
    ));
    setup.configure(r#"[{"kind":"imap","accountId":"imap:me@example.test","email":"me@example.test","username":"me","imapHost":"mail.example.test","imapPort":993,"smtpHost":"mail.example.test","smtpPort":465,"insecure":false}]"#).unwrap();
    assert!(
        runtime
            .runtime_for("missing", Duration::from_secs(1))
            .is_none()
    );
    assert_eq!(
        runtime
            .runtime_for("imap:me@example.test", Duration::from_secs(1))
            .unwrap()
            .archive_folder
            .as_deref(),
        Some("Archive")
    );
    assert!(
        runtime
            .runtime_for("imap:me@example.test", Duration::from_secs(1))
            .is_some()
    );
    assert_eq!(
        runtime
            .backend()
            .0
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

#[test]
fn only_setup_authority_can_request_confirmed_legacy_migration() {
    let (_runtime, setup) = NativeProviderRuntime::with_backend(Backend::default());
    let key = setup
        .confirmed_legacy_imap_migration_key(
            "imap:me@example.test",
            "mail.example.test",
            993,
            "me",
            "sha256:old-endpoint",
        )
        .unwrap();
    assert_eq!(key.secret_service_lookup_attributes().len(), 2);
    assert!(
        setup
            .confirmed_legacy_imap_migration_key(
                "imap:me@example.test",
                "mail.example.test",
                993,
                "me",
                "",
            )
            .is_err()
    );
}
