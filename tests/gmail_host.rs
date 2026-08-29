#![allow(dead_code)] // The module is linked by #[path] until the root registers it.

#[path = "../src/providers/gmail.rs"]
mod gmail;

use std::{
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use gmail::{
    AccessToken, AccessTokenProvider, CalendarEvent, CalendarMoment, GmailAction, GmailError,
    GmailExecutor, GmailExecutorConfig, GmailHttpRequest, GmailHttpResponse, GmailOperation,
    GmailTransport, RequestIdentity, request_for_test,
};
use omamail::platform::secrets::{
    MemorySecretStore, Secret, SecretKey, SecretStore, SecretStoreError,
};

#[derive(Default)]
struct CountingStore(AtomicUsize);

impl SecretStore for CountingStore {
    fn get(&self, _: &SecretKey) -> Result<Option<Secret>, SecretStoreError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    }
    fn set(&self, _: &SecretKey, _: Secret) -> Result<(), SecretStoreError> {
        Ok(())
    }
    fn delete(&self, _: &SecretKey) -> Result<(), SecretStoreError> {
        Ok(())
    }
}

#[derive(Default)]
struct RecordingTransport {
    requests: Mutex<Vec<GmailHttpRequest>>,
    replies: Mutex<Vec<Result<GmailHttpResponse, GmailError>>>,
}

struct Tokens;
impl AccessTokenProvider for Tokens {
    fn access_token(&self, refresh: Secret, _: Duration) -> Result<AccessToken, GmailError> {
        assert_eq!(refresh.expose(), "refresh-token");
        Ok(AccessToken::new(Secret::new("access-token")))
    }
}
static TOKENS: Tokens = Tokens;

struct SlowTokens(Mutex<Vec<Duration>>);
impl AccessTokenProvider for SlowTokens {
    fn access_token(&self, refresh: Secret, deadline: Duration) -> Result<AccessToken, GmailError> {
        assert_eq!(refresh.expose(), "refresh-token");
        self.0.lock().unwrap().push(deadline);
        std::thread::sleep(Duration::from_millis(20));
        Ok(AccessToken::new(Secret::new("access-token")))
    }
}

impl GmailTransport for RecordingTransport {
    fn max_response_bytes(&self) -> usize {
        gmail::MAX_RESPONSE_BYTES
    }

    fn execute(
        &self,
        request: GmailHttpRequest,
        bearer: AccessToken,
    ) -> Result<GmailHttpResponse, GmailError> {
        assert_eq!(
            bearer.expose(),
            "access-token",
            "the transport receives only an access token"
        );
        self.requests.lock().unwrap().push(request);
        self.replies.lock().unwrap().remove(0)
    }
}

fn identity() -> RequestIdentity {
    RequestIdentity {
        account_id: "me@example.test".into(),
        object_id: "message-1".into(),
        revision: 8,
    }
}

fn executor<'a>(
    store: &'a MemorySecretStore,
    transport: &'a RecordingTransport,
) -> GmailExecutor<'a> {
    GmailExecutor::new(
        store,
        transport,
        &TOKENS,
        GmailExecutorConfig::new(
            "omamail",
            "old-omamail",
            "client.apps.googleusercontent.com",
            "me@example.test",
            "gmail.modify gmail.send calendar.events",
        ),
    )
    .unwrap()
}

#[test]
fn oauth_refresh_and_transport_share_one_absolute_deadline() {
    let store = MemorySecretStore::default();
    let transport = RecordingTransport::default();
    let tokens = SlowTokens(Mutex::new(vec![]));
    let key = SecretKey::gmail(
        "omamail",
        "old-omamail",
        "client.apps.googleusercontent.com",
        "me@example.test",
        "gmail.modify gmail.send calendar.events",
    )
    .unwrap();
    store.set(&key, Secret::new("refresh-token")).unwrap();
    transport
        .replies
        .lock()
        .unwrap()
        .push(Ok(GmailHttpResponse::json(
            200,
            br#"{"messages":[]}"#.to_vec(),
        )));
    let host = GmailExecutor::new(
        &store,
        &transport,
        &tokens,
        GmailExecutorConfig::new(
            "omamail",
            "old-omamail",
            "client.apps.googleusercontent.com",
            "me@example.test",
            "gmail.modify gmail.send calendar.events",
        ),
    )
    .unwrap();
    let mut list_identity = identity();
    list_identity.object_id.clear();
    host.execute(
        list_identity,
        GmailOperation::List {
            query: "".into(),
            max_results: 1,
            page_token: None,
        },
        Duration::from_millis(100),
    )
    .unwrap();
    let refresh_budget = tokens.0.lock().unwrap()[0];
    let transport_budget = transport.requests.lock().unwrap()[0].deadline();
    assert!(refresh_budget <= Duration::from_millis(100));
    assert!(transport_budget < refresh_budget);
    assert!(transport_budget <= Duration::from_millis(80));
}

#[test]
fn missing_saved_grant_returns_auth_required_without_contacting_transport() {
    let store = MemorySecretStore::default();
    let transport = RecordingTransport::default();

    let error = executor(&store, &transport)
        .execute(
            identity(),
            GmailOperation::List {
                query: "in:inbox".into(),
                max_results: 25,
                page_token: None,
            },
            Duration::from_secs(5),
        )
        .unwrap_err();

    assert_eq!(error, GmailError::AuthRequired);
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn real_executor_allows_empty_list_identity_but_not_empty_object_identity() {
    let store = MemorySecretStore::default();
    let transport = RecordingTransport::default();
    let key = SecretKey::gmail(
        "omamail",
        "old-omamail",
        "client.apps.googleusercontent.com",
        "me@example.test",
        "gmail.modify gmail.send calendar.events",
    )
    .unwrap();
    store.set(&key, Secret::new("refresh-token")).unwrap();
    transport
        .replies
        .lock()
        .unwrap()
        .push(Ok(GmailHttpResponse::json(
            200,
            br#"{"messages":[]}"#.to_vec(),
        )));
    let mut list_identity = identity();
    list_identity.object_id.clear();
    assert!(
        executor(&store, &transport)
            .execute(
                list_identity.clone(),
                GmailOperation::List {
                    query: "in:inbox".into(),
                    max_results: 25,
                    page_token: None
                },
                Duration::from_secs(5)
            )
            .is_ok()
    );
    assert_eq!(
        executor(&store, &transport)
            .execute(
                list_identity,
                GmailOperation::Detail {
                    message_id: "message-1".into(),
                    full: true
                },
                Duration::from_secs(5)
            )
            .unwrap_err(),
        GmailError::InvalidRequest
    );
}

#[test]
fn rejects_a_stale_identity_for_another_account_before_loading_or_sending_a_token() {
    let store = MemorySecretStore::default();
    let transport = RecordingTransport::default();
    let mut stale = identity();
    stale.account_id = "other@example.test".into();

    let error = executor(&store, &transport)
        .execute(stale, GmailOperation::CalendarList, Duration::from_secs(5))
        .unwrap_err();

    assert_eq!(error, GmailError::InvalidRequest);
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn list_uses_closed_google_endpoint_and_keeps_token_out_of_request_debug() {
    let store = MemorySecretStore::default();
    let transport = RecordingTransport::default();
    let key = SecretKey::gmail(
        "omamail",
        "old-omamail",
        "client.apps.googleusercontent.com",
        "me@example.test",
        "gmail.modify gmail.send calendar.events",
    )
    .unwrap();
    store.set(&key, Secret::new("refresh-token")).unwrap();
    transport
        .replies
        .lock()
        .unwrap()
        .push(Ok(GmailHttpResponse::json(
            200,
            br#"{"messages":[]}"#.to_vec(),
        )));

    let reply = executor(&store, &transport)
        .execute(
            identity(),
            GmailOperation::List {
                query: "in:inbox newer:2026/01/01".into(),
                max_results: 500,
                page_token: Some("next page".into()),
            },
            Duration::from_secs(5),
        )
        .unwrap();

    assert_eq!(reply.identity, identity());
    let request = transport.requests.lock().unwrap().pop().unwrap();
    assert_eq!(request.method(), "GET");
    assert_eq!(
        request.url(),
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in%3Ainbox+newer%3A2026%2F01%2F01&maxResults=100&pageToken=next+page"
    );
    assert!(request.body().is_none());
    assert!(!format!("{request:?}").contains("refresh-token"));
}

#[test]
fn action_send_and_calendar_are_closed_requests_with_stale_identity_preserved() {
    let store = MemorySecretStore::default();
    let transport = RecordingTransport::default();
    let key = SecretKey::gmail(
        "omamail",
        "old-omamail",
        "client.apps.googleusercontent.com",
        "me@example.test",
        "gmail.modify gmail.send calendar.events",
    )
    .unwrap();
    store.set(&key, Secret::new("refresh-token")).unwrap();
    transport.replies.lock().unwrap().extend([
        Ok(GmailHttpResponse::json(200, b"{}".to_vec())),
        Ok(GmailHttpResponse::json(200, b"{}".to_vec())),
        Ok(GmailHttpResponse::json(200, b"{}".to_vec())),
    ]);
    let host = executor(&store, &transport);

    let reply = host
        .execute(
            identity(),
            GmailOperation::Action {
                action: GmailAction::Archive,
                message_ids: vec!["one".into(), "two".into()],
            },
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(reply.identity.revision, 8);
    host.execute(
        identity(),
        GmailOperation::Send {
            raw: "cmF3".into(),
            thread_id: Some("thread-1".into()),
        },
        Duration::from_secs(5),
    )
    .unwrap();
    host.execute(
        identity(),
        GmailOperation::CalendarWrite {
            calendar_id: "primary".into(),
            event: CalendarEvent {
                summary: "Review".into(),
                description: "".into(),
                location: "".into(),
                start: CalendarMoment::DateTime("2026-08-29T10:00:00Z".into()),
                end: CalendarMoment::DateTime("2026-08-29T11:00:00Z".into()),
                recurrence: vec![],
            },
        },
        Duration::from_secs(5),
    )
    .unwrap();

    let requests = transport.requests.lock().unwrap();
    assert_eq!(
        requests[0].url(),
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify"
    );
    assert_eq!(
        requests[0].body(),
        Some("{\"ids\":[\"one\",\"two\"],\"addLabelIds\":[],\"removeLabelIds\":[\"INBOX\"]}")
    );
    assert_eq!(
        requests[1].url(),
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
    );
    assert_eq!(
        requests[2].url(),
        "https://www.googleapis.com/calendar/v3/calendars/primary/events"
    );
}

#[test]
fn calendar_event_and_draft_operations_use_exact_google_methods_and_endpoints() {
    let deadline = Duration::from_secs(5);
    let list = request_for_test(
        GmailOperation::CalendarEventsList {
            calendar_id: "primary".into(),
            time_min: "2026-08-01T00:00:00Z".into(),
            time_max: "2026-09-01T00:00:00Z".into(),
        },
        deadline,
    )
    .unwrap();
    assert_eq!(list.method(), "GET");
    assert!(list.url().contains("/calendars/primary/events?"));
    assert!(list.url().contains("timeMin=2026-08-01T00%3A00%3A00Z"));
    let draft =
        request_for_test(GmailOperation::DraftCreate { raw: "cmF3".into() }, deadline).unwrap();
    assert_eq!(
        draft.url(),
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts"
    );
    assert_eq!(draft.body(), Some(r#"{"message":{"raw":"cmF3"}}"#));
    let update = request_for_test(
        GmailOperation::DraftUpdate {
            draft_id: "draft-1".into(),
            raw: "cmF3".into(),
        },
        deadline,
    )
    .unwrap();
    assert_eq!(update.method(), "PUT");
    assert!(update.url().ends_with("/users/me/drafts/draft-1"));
    let send = request_for_test(
        GmailOperation::DraftSend {
            draft_id: "draft-1".into(),
            raw: "cmF3".into(),
        },
        deadline,
    )
    .unwrap();
    assert_eq!(
        send.url(),
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send"
    );
    assert!(send.body().unwrap().contains("draft-1"));
    let delete = request_for_test(
        GmailOperation::DraftDelete {
            draft_id: "draft-1".into(),
        },
        deadline,
    )
    .unwrap();
    assert_eq!(delete.method(), "DELETE");
    assert!(delete.url().ends_with("/users/me/drafts/draft-1"));
    let list = request_for_test(
        GmailOperation::DraftList {
            max_results: 25,
            page_token: Some("next".into()),
        },
        deadline,
    )
    .unwrap();
    assert!(
        list.url()
            .contains("/users/me/drafts?maxResults=25&pageToken=next")
    );
    let get = request_for_test(
        GmailOperation::DraftGet {
            draft_id: "draft-1".into(),
            full: true,
        },
        deadline,
    )
    .unwrap();
    assert!(get.url().ends_with("/users/me/drafts/draft-1?format=full"));
}

#[test]
fn attachment_uses_the_exact_message_and_part_endpoint() {
    let request = request_for_test(
        GmailOperation::Attachment {
            message_id: "message-1".into(),
            part_id: "part:1".into(),
        },
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(request.method(), "GET");
    assert_eq!(
        request.url(),
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/message-1/attachments/part%3A1"
    );
    assert!(
        !format!(
            "{:?}",
            GmailOperation::Attachment {
                message_id: "secret-message".into(),
                part_id: "secret-part".into()
            }
        )
        .contains("secret-message")
    );
}

#[test]
fn invalid_payload_is_rejected_before_secret_access_and_request_debug_hides_query() {
    let store = CountingStore::default();
    let transport = RecordingTransport::default();
    let host = GmailExecutor::new(
        &store,
        &transport,
        &TOKENS,
        GmailExecutorConfig::new(
            "omamail",
            "old-omamail",
            "client.apps.googleusercontent.com",
            "me@example.test",
            "gmail.modify gmail.send calendar.events",
        ),
    )
    .unwrap();
    let error = host
        .execute(
            identity(),
            GmailOperation::Send {
                raw: "x".repeat(gmail::MAX_REQUEST_BYTES + 1),
                thread_id: None,
            },
            Duration::from_secs(5),
        )
        .unwrap_err();
    assert_eq!(error, GmailError::InvalidRequest);
    assert_eq!(store.0.load(Ordering::SeqCst), 0);
    assert!(transport.requests.lock().unwrap().is_empty());

    let request = gmail::request_for_test(
        GmailOperation::List {
            query: "private search".into(),
            max_results: 1,
            page_token: Some("private-page".into()),
        },
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(!format!("{request:?}").contains("private"));
}

#[test]
fn calendar_event_is_closed_and_executor_configuration_never_panics() {
    let store = MemorySecretStore::default();
    let transport = RecordingTransport::default();
    assert!(matches!(
        GmailExecutor::new(
            &store,
            &transport,
            &TOKENS,
            GmailExecutorConfig::new("", "old", "client", "account", "grant")
        ),
        Err(GmailError::InvalidRequest)
    ));
    let invalid = GmailOperation::CalendarWrite {
        calendar_id: "primary".into(),
        event: CalendarEvent {
            summary: "".into(),
            description: "".into(),
            location: "".into(),
            start: CalendarMoment::Date("2026-08-29".into()),
            end: CalendarMoment::Date("2026-08-30".into()),
            recurrence: vec![],
        },
    };
    assert_eq!(
        gmail::request_for_test(invalid, Duration::from_secs(5)),
        Err(GmailError::InvalidRequest)
    );
}

#[test]
fn calendar_event_requires_nonempty_start_and_end_moments() {
    let invalid = GmailOperation::CalendarWrite {
        calendar_id: "primary".into(),
        event: CalendarEvent {
            summary: "Review".into(),
            description: "".into(),
            location: "".into(),
            start: CalendarMoment::Date("".into()),
            end: CalendarMoment::DateTime("2026-08-29T11:00:00Z".into()),
            recurrence: vec![],
        },
    };
    assert_eq!(
        gmail::request_for_test(invalid, Duration::from_secs(5)),
        Err(GmailError::InvalidRequest)
    );
}

#[test]
fn configured_and_request_identities_are_bounded_before_secret_access() {
    let transport = RecordingTransport::default();
    let invalid_store = CountingStore::default();
    assert!(matches!(
        GmailExecutor::new(
            &invalid_store,
            &transport,
            &TOKENS,
            GmailExecutorConfig::new(
                "omamail",
                "old-omamail",
                "client.apps.googleusercontent.com",
                "not-an-email",
                "gmail.modify"
            ),
        ),
        Err(GmailError::InvalidRequest)
    ));

    let store = CountingStore::default();
    let host = GmailExecutor::new(
        &store,
        &transport,
        &TOKENS,
        GmailExecutorConfig::new(
            "omamail",
            "old-omamail",
            "client.apps.googleusercontent.com",
            "me@example.test",
            "gmail.modify",
        ),
    )
    .unwrap();
    for stale in [
        RequestIdentity {
            account_id: "me@example.test\nother".into(),
            object_id: "x".into(),
            revision: 1,
        },
        RequestIdentity {
            account_id: "me@example.test".into(),
            object_id: "x".repeat(2049),
            revision: 1,
        },
        RequestIdentity {
            account_id: "me@example.test".into(),
            object_id: "x".into(),
            revision: 9_007_199_254_740_992,
        },
    ] {
        assert_eq!(
            host.execute(stale, GmailOperation::CalendarList, Duration::from_secs(5))
                .unwrap_err(),
            GmailError::InvalidRequest
        );
    }
    assert_eq!(store.0.load(Ordering::SeqCst), 0);
}

#[test]
fn rejects_zero_deadline_and_oversized_or_non_json_output_without_echoing_secrets() {
    let store = MemorySecretStore::default();
    let transport = RecordingTransport::default();
    let key = SecretKey::gmail(
        "omamail",
        "old-omamail",
        "client.apps.googleusercontent.com",
        "me@example.test",
        "gmail.modify gmail.send calendar.events",
    )
    .unwrap();
    store.set(&key, Secret::new("refresh-token")).unwrap();
    let host = executor(&store, &transport);

    assert_eq!(
        host.execute(identity(), GmailOperation::CalendarList, Duration::ZERO)
            .unwrap_err(),
        GmailError::InvalidRequest
    );
    transport
        .replies
        .lock()
        .unwrap()
        .push(Ok(GmailHttpResponse::json(
            200,
            vec![b'x'; gmail::MAX_RESPONSE_BYTES + 1],
        )));
    assert_eq!(
        host.execute(
            identity(),
            GmailOperation::CalendarList,
            Duration::from_secs(5)
        )
        .unwrap_err(),
        GmailError::OutputTooLarge
    );
    transport
        .replies
        .lock()
        .unwrap()
        .push(Ok(GmailHttpResponse::json(500, b"refresh-token".to_vec())));
    let error = host
        .execute(
            identity(),
            GmailOperation::CalendarList,
            Duration::from_secs(5),
        )
        .unwrap_err();
    assert_eq!(error, GmailError::RemoteFailure);
    assert!(!format!("{error:?}").contains("refresh-token"));
}
