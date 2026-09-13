use super::list::{ListAdapter, list_with};
use super::{Account, ListRequest, Mailbox, Provider};
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

struct RecordingAdapter {
    seen: Arc<Mutex<Vec<Value>>>,
    response: Value,
}

impl ListAdapter for RecordingAdapter {
    fn list<'a>(
        &'a self,
        request: &'a ListRequest,
        provider_query: String,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
        self.seen.lock().unwrap().push(json!({
            "accountId": request.account.id,
            "query": provider_query,
            "limit": request.limit,
            "pageToken": request.page_token,
        }));
        Box::pin(async { Ok(self.response.clone()) })
    }
}

fn account(provider: Provider) -> Account {
    Account {
        id: format!("{}:a@example.org", provider.id()),
        provider,
    }
}

fn message(id: &str) -> Value {
    json!({"id":id,"subject":"A safe summary","snippet":"plain text"})
}

fn recording_adapter(seen: Arc<Mutex<Vec<Value>>>, response: Value) -> RecordingAdapter {
    RecordingAdapter { seen, response }
}

#[tokio::test]
async fn list_translates_canonical_mailbox_and_returns_summaries() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let result = list_with(
        ListRequest {
            account: account(Provider::Imap),
            mailbox: Mailbox::Unread,
            query: String::new(),
            limit: 25,
            page_token: String::new(),
        },
        &recording_adapter(
            seen.clone(),
            json!({
                "ids":["7:INBOX"], "messages":[message("7:INBOX")],
                "nextPageToken":"next", "estimate":1
            }),
        ),
    )
    .await
    .unwrap();
    assert_eq!(seen.lock().unwrap()[0]["query"], "folder:INBOX UNSEEN");
    assert_eq!(result["accountId"], "imap:a@example.org");
    assert_eq!(result["mailbox"], "unread");
    assert_eq!(result["messages"][0]["id"], "7:INBOX");
    assert_eq!(result["nextPageToken"], "next");
}

#[tokio::test]
async fn list_uses_explicit_provider_mappings_and_preserves_continuation() {
    for (provider, mailbox, expected) in [
        (
            Provider::Gmail,
            Mailbox::Archive,
            "in:anywhere -in:spam -in:trash",
        ),
        (Provider::Hey, Mailbox::Unread, "box:imbox unseen"),
        (Provider::Jmap, Mailbox::Archive, "role:archive"),
        (Provider::Outlook, Mailbox::Sent, "folder:\\Sent"),
        (Provider::Imap, Mailbox::Inbox, "folder:INBOX"),
    ] {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let result = list_with(
            ListRequest {
                account: account(provider),
                mailbox,
                query: String::new(),
                limit: 12,
                page_token: "opaque-provider-token".into(),
            },
            &recording_adapter(
                seen.clone(),
                json!({
                    "ids":["one"], "messages":[message("one")],
                    "nextPageToken":"opaque-next", "estimate":24
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(seen.lock().unwrap()[0]["query"], expected, "{provider:?}");
        assert_eq!(
            seen.lock().unwrap()[0]["pageToken"],
            "opaque-provider-token"
        );
        assert_eq!(result["nextPageToken"], "opaque-next");
    }
}

#[tokio::test]
async fn list_search_overrides_the_selected_mailbox() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    list_with(
        ListRequest {
            account: account(Provider::Jmap),
            mailbox: Mailbox::Trash,
            query: "project orbital".into(),
            limit: 25,
            page_token: String::new(),
        },
        &recording_adapter(
            seen.clone(),
            json!({"ids":["one"],"messages":[message("one")],"nextPageToken":"","estimate":1}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(seen.lock().unwrap()[0]["query"], "text:project orbital");
}

#[tokio::test]
async fn list_rejects_a_mailbox_without_an_explicit_provider_mapping() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let error = list_with(
        ListRequest {
            account: account(Provider::Hey),
            mailbox: Mailbox::Archive,
            query: String::new(),
            limit: 25,
            page_token: String::new(),
        },
        &recording_adapter(seen.clone(), json!({})),
    )
    .await
    .unwrap_err();
    assert_eq!(error, "mail_mailbox_unavailable");
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn list_rejects_a_continuation_when_the_provider_omits_a_listed_summary() {
    let error = list_with(
        ListRequest {
            account: account(Provider::Imap),
            mailbox: Mailbox::Inbox,
            query: String::new(),
            limit: 25,
            page_token: String::new(),
        },
        &recording_adapter(
            Arc::new(Mutex::new(Vec::new())),
            json!({
                "ids":["one", "two"], "messages":[message("one")],
                "nextPageToken":"would-skip-two", "estimate":2
            }),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(error, "mail_list_incomplete");
}

#[tokio::test]
async fn list_rejects_raw_provider_resources_in_place_of_summaries() {
    let error = list_with(
        ListRequest {
            account: account(Provider::Gmail),
            mailbox: Mailbox::Inbox,
            query: String::new(),
            limit: 25,
            page_token: String::new(),
        },
        &recording_adapter(
            Arc::new(Mutex::new(Vec::new())),
            json!({
                "ids":["one"],
                "messages":[{"id":"one","payload":{"mimeType":"text/html","body":{"data":"PHNjcmlwdD4"}}}],
                "nextPageToken":"", "estimate":1
            }),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(error, "mail_list_incomplete");
}
