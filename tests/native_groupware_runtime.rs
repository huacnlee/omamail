use std::{sync::Mutex, time::Duration};

use omamail::{
    host_context::{CalendarContext, GmailContext, ImapContext},
    native_groupware_runtime::{NativeGroupwareOps, NativeGroupwareRuntime},
    providers::groupware::{BackendCall, BackendError, GroupwareHost},
};
use serde_json::{Value, json};

#[derive(Default)]
struct Ops(Mutex<Vec<BackendCall>>);
impl NativeGroupwareOps for Ops {
    fn execute(
        &self,
        call: BackendCall,
        account: Option<GmailContext>,
        imap: Option<ImapContext>,
        source: Option<CalendarContext>,
        deadline: Duration,
    ) -> Result<Value, BackendError> {
        assert_eq!(deadline, Duration::from_secs(2));
        match &call {
            BackendCall::GmailCompose { .. } => {
                assert_eq!(account.unwrap().account_id(), "me@example.test")
            }
            BackendCall::ImapCompose { account_id, .. } => {
                assert_eq!(imap.unwrap().account_id(), account_id)
            }
            BackendCall::GoogleCalendarList { source_id, .. } => {
                assert_eq!(source.unwrap().source_id(), source_id);
                assert_eq!(account.unwrap().account_id(), "me@example.test");
            }
            _ => {}
        }
        self.0.lock().unwrap().push(call);
        Ok(json!({"accepted":true}))
    }
}
fn configured() -> NativeGroupwareRuntime<Ops> {
    let (runtime, setup) = NativeGroupwareRuntime::with_ops(Ops::default());
    setup.configure(r#"[{"kind":"gmail","accountId":"me@example.test","clientId":"client.apps.googleusercontent.com","grant":"gmail.modify gmail.send calendar.events"},{"kind":"imap","accountId":"imap:me@example.test","email":"me@example.test","username":"me","imapHost":"mail.example.test","imapPort":993,"smtpHost":"mail.example.test","smtpPort":465,"insecure":false},{"kind":"calendar","sourceId":"primary","accountId":"me@example.test","provider":"google","sourceUrl":""}]"#).unwrap();
    runtime
}

#[test]
fn imap_reply_uses_exact_context_and_closed_thread_headers() {
    let runtime = configured();
    GroupwareHost::new(&runtime).execute_json(r#"{"type":"compose.send","provider":"imap","accountId":"imap:me@example.test","deadlineMs":2000,"draft":{"mode":"replyAll","to":["you@example.test"],"cc":["copy@example.test"],"subject":"Re: Hi","body":"Body","inReplyTo":"<message@example.test>","references":"<root@example.test> <message@example.test>"}}"#).unwrap();
    assert!(
        matches!(runtime.ops().0.lock().unwrap().as_slice(), [BackendCall::ImapCompose { account_id, .. }] if account_id == "imap:me@example.test")
    );
}

#[test]
fn groupware_host_routes_compose_and_calendar_through_exact_context() {
    let runtime = configured();
    let host = GroupwareHost::new(&runtime);
    host.execute_json(r#"{"type":"compose.send","provider":"gmail","accountId":"me@example.test","deadlineMs":2000,"draft":{"mode":"new","to":["you@example.test"],"subject":"Hi","body":"Body"}}"#).unwrap();
    host.execute_json(r#"{"type":"calendar.list","provider":"google","sourceId":"primary","deadlineMs":2000,"range":{"startMs":1,"endMs":2}}"#).unwrap();
    assert_eq!(runtime.ops().0.lock().unwrap().len(), 2);
}

#[test]
fn mismatched_google_account_fails_before_ops() {
    let runtime = configured();
    let error = GroupwareHost::new(&runtime).execute_json(r#"{"type":"calendar.google.write","sourceId":"primary","accountId":"other@example.test","deadlineMs":2000,"eventId":"","payload":{"summary":"x","start":{"date":"2026-08-01"},"end":{"date":"2026-08-02"}}}"#).unwrap_err();
    assert_eq!(error.to_string(), "groupware provider is unavailable");
    assert!(runtime.ops().0.lock().unwrap().is_empty());
}

#[test]
fn reply_without_thread_metadata_is_honestly_unsupported() {
    let runtime = configured();
    let error = GroupwareHost::new(&runtime).execute_json(r#"{"type":"compose.send","provider":"gmail","accountId":"me@example.test","deadlineMs":2000,"draft":{"mode":"reply","to":["you@example.test"],"subject":"Re: Hi","body":"Body"}}"#).unwrap_err();
    assert_eq!(error.to_string(), "groupware provider is unsupported");
}

#[test]
fn reply_with_closed_thread_metadata_reaches_the_gmail_runtime() {
    let runtime = configured();
    GroupwareHost::new(&runtime).execute_json(r#"{"type":"compose.send","provider":"gmail","accountId":"me@example.test","deadlineMs":2000,"draft":{"mode":"replyAll","to":["you@example.test"],"cc":["copy@example.test"],"subject":"Re: Hi","body":"Body","threadId":"thread-1","messageId":"message-1","inReplyTo":"<message-1@example.test>","references":"<root@example.test> <message-1@example.test>"}}"#).unwrap();
    assert_eq!(runtime.ops().0.lock().unwrap().len(), 1);
}
