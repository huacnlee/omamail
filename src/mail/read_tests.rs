use super::read::{ReadAdapter, read_with};
use super::{Account, Provider, ReadRequest};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

struct RecordingAdapter {
    open_response: Value,
    conversation_response: Value,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
}

impl ReadAdapter for RecordingAdapter {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
        self.calls.lock().unwrap().push((method.to_owned(), params));
        let response = if method == "reader.open" {
            self.open_response.clone()
        } else {
            self.conversation_response.clone()
        };
        Box::pin(async move { Ok(response) })
    }
}

fn request() -> ReadRequest {
    ReadRequest {
        account: Account {
            id: "gmail:reader@example.org".into(),
            provider: Provider::Gmail,
        },
        id: "message-1".into(),
    }
}

fn cached_mime_reader_fixture() -> Value {
    let html = "<script>forbiddenScript</script><img src=\"https://tracker.example/pixel\">";
    let attachment = URL_SAFE_NO_PAD.encode("attachment-bytes");
    json!({
        "id": "message-1",
        "readerKey": "internal-reader-key",
        "payload": {
            "mimeType": "multipart/mixed",
            "parts": [
                {"mimeType":"text/plain", "body":{"data":URL_SAFE_NO_PAD.encode("Safe text")}},
                {"mimeType":"text/html", "body":{"data":URL_SAFE_NO_PAD.encode(html)}},
                {"mimeType":"application/octet-stream", "filename":"brief.txt", "body":{"data":attachment}}
            ]
        },
        "nativeSummary": {"id": "message-1"},
        "nativeContent": {
            "body": {"text": "Safe text", "source": "plain", "bodyDirection":"ltr"},
            "attachments": [{
                "attachmentId": "download-1", "filename": "brief.txt",
                "mimeType": "text/plain", "size": 14,
                "data": attachment
            }]
        },
        "nativeRender": {"document": {"type":"root","children":[]}}
    })
}

#[tokio::test]
async fn read_returns_only_safe_reader_content_without_conversation_metadata() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let result = read_with(
        request(),
        &RecordingAdapter {
            open_response: cached_mime_reader_fixture(),
            conversation_response: json!({}),
            calls: calls.clone(),
        },
    )
    .await
    .unwrap();

    assert_eq!(result["accountId"], "gmail:reader@example.org");
    assert_eq!(
        result["message"]["nativeContent"]["body"]["text"],
        "Safe text"
    );
    assert!(result["message"]["nativeContent"].get("html").is_none());
    assert!(!result.to_string().contains("forbiddenScript"));
    assert!(!result.to_string().contains("https://tracker.example/pixel"));
    assert!(!result.to_string().contains("YXR0YWNobWVudC1ieXRlcw"));
    assert!(!result.to_string().contains("internal-reader-key"));
    assert!(result["message"]["attachments"][0]["data"].is_null());
    assert_eq!(result["conversation"], json!([]));

    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "reader.open");
    assert_eq!(calls[0].1["accountId"], "gmail:reader@example.org");
    assert_eq!(calls[0].1["id"], "message-1");
    assert!(
        calls[0].1["requestId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );
    assert!(calls[0].1["now"].as_i64().is_some_and(|now| now > 0));
    assert_eq!(calls[0].1["cacheOnly"], false);
    assert_eq!(
        calls[0].1["options"],
        json!({"allowRemoteImages":false,"withReader":true})
    );
}

#[tokio::test]
async fn read_rejects_a_reader_response_for_another_message() {
    let mut response = cached_mime_reader_fixture();
    response["id"] = json!("other-message");
    let error = read_with(
        request(),
        &RecordingAdapter {
            open_response: response,
            conversation_response: json!({}),
            calls: Arc::new(Mutex::new(Vec::new())),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error, "mail_read_message_mismatch");
}

#[tokio::test]
async fn read_refuses_raw_html_that_escaped_the_reader_boundary() {
    let mut response = cached_mime_reader_fixture();
    response["nativeContent"]["html"] = json!("<script>forbiddenScript</script>");
    let error = read_with(
        request(),
        &RecordingAdapter {
            open_response: response,
            conversation_response: json!({}),
            calls: Arc::new(Mutex::new(Vec::new())),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error, "mail_read_unsafe_reader");
}

#[tokio::test]
async fn read_rejects_unrecognized_nonempty_body_metadata() {
    for (field, value) in [("source", "unknown"), ("bodyDirection", "diagonal")] {
        let mut response = cached_mime_reader_fixture();
        response["nativeContent"]["body"][field] = json!(value);
        let error = read_with(
            request(),
            &RecordingAdapter {
                open_response: response,
                conversation_response: json!({}),
                calls: Arc::new(Mutex::new(Vec::new())),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "mail_read_invalid_reader", "{field}");
    }
}

#[tokio::test]
async fn read_returns_reader_bound_conversation_members() {
    let mut response = cached_mime_reader_fixture();
    response["nativeSummary"]["thread"] =
        json!({"id":"thread-1","memberIds":["message-1", "reply-2"]});
    let calls = Arc::new(Mutex::new(Vec::new()));
    let result = read_with(
        request(),
        &RecordingAdapter {
            open_response: response,
            conversation_response: json!({"memberIds":["message-1", "reply-2"]}),
            calls: calls.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(result["conversation"], json!(["message-1", "reply-2"]));
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        ["reader.open", "account.conversation"]
    );
}

#[tokio::test]
async fn read_rejects_conversation_members_outside_the_requested_summary_thread() {
    let mut response = cached_mime_reader_fixture();
    response["nativeSummary"]["thread"] =
        json!({"id":"thread-1","memberIds":["message-1", "reply-2"]});
    let error = read_with(
        request(),
        &RecordingAdapter {
            open_response: response,
            conversation_response: json!({"memberIds":["message-1", "another-account-message"]}),
            calls: Arc::new(Mutex::new(Vec::new())),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error, "mail_read_conversation_mismatch");
}
