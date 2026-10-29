use super::*;
use crate::calendar::{
    execute,
    tests::{local_request, server},
};
use reqwest::Client;

#[tokio::test]
async fn http_errors_keep_status_phase_and_known_reason_without_provider_text() {
    let client = Client::builder().no_proxy().build().unwrap();
    for (status, message) in [
        (400, "calendar_request_failed"),
        (401, "calendar_auth_refused"),
        (403, "calendar_auth_refused"),
        (404, "calendar_not_found"),
        (409, "calendar_request_failed"),
        (412, "calendar_conflict"),
        (429, "calendar_request_failed"),
        (503, "calendar_request_failed"),
    ] {
        let body = r#"{"error":{"message":"SECRET token/address/body","errors":[{"reason":"badRequest","location":"SECRET"}],"requestId":"SECRET"}}"#;
        let reply = Box::leak(
            format!(
                "HTTP/1.1 {status} Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .into_boxed_str(),
        );
        let (url, task) = server(reply).await;
        let (result, data) = capture(execute(
            &client,
            local_request(url),
            Some("SECRET-token"),
            None,
        ))
        .await;
        assert_eq!(result, Err(message));
        assert_eq!(
            data.unwrap(),
            json!({"provider":"google","operation":"lookup","stage":"request","httpStatus":status,"reason":"badRequest"})
        );
        task.await.unwrap();
    }
}

#[test]
fn reason_accepts_only_exact_codes_and_never_messages_or_other_provider_payloads() {
    for provider in ["google", "microsoft", "caldav", "icloud"] {
        for value in [
            "SECRET",
            "badRequest\r",
            "badRequest\n",
            "badRequest\r\n",
            "badRequest\0",
            "badRequest_private",
            "badRequest \"\\日本語",
        ] {
            let body =
                json!({"error":{"code":value,"errors":[{"reason":value}],"message":"badRequest"}})
                    .to_string();
            assert_eq!(reason(provider, body.as_bytes()), None);
        }
    }
    assert_eq!(
        reason(
            "microsoft",
            br#"{"error":{"code":"ErrorAccessDenied","message":"SECRET"}}"#
        ),
        Some("ErrorAccessDenied")
    );
    assert_eq!(
        reason(
            "caldav",
            br#"{"error":{"errors":[{"reason":"badRequest"}]}}"#
        ),
        None
    );
    assert_eq!(context("SECRET", "SECRET", "SECRET"), json!({}));
    assert_eq!(
        reason(
            "google",
            br#"{"error":{"errors":[{"reason":"participantIsNeitherOrganizerNorAttendee"}]}}"#
        ),
        Some("participantIsNeitherOrganizerNorAttendee")
    );
}

#[test]
fn google_field_hints_never_expose_free_form_error_messages() {
    for message in [
        "Invalid time zone definition for start time.",
        "Missing end time.",
    ] {
        let body = json!({"error":{"message":message}}).to_string();
        assert!(field("google", body.as_bytes()).is_some());
        for suffix in ["\r", "\n", "\r\n", "\0", " SECRET"] {
            let body = json!({"error":{"message":format!("{message}{suffix}")}}).to_string();
            assert_eq!(field("google", body.as_bytes()), None);
        }
    }
    let body = br#"{"error":{"errors":[{"location":"start.timeZone"}],"message":"SECRET"}}"#;
    assert_eq!(field("google", body), Some("start.timeZone"));
    assert_eq!(field("microsoft", body), None);
}

#[tokio::test]
async fn malformed_oversized_and_incomplete_error_bodies_preserve_original_failure() {
    let client = Client::builder().no_proxy().build().unwrap();
    for (length, body) in [(6, "SECRET"), (20000, ""), (100, "short")] {
        let reply = Box::leak(
            format!(
                "HTTP/1.1 400 Error\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}"
            )
            .into_boxed_str(),
        );
        let (url, task) = server(reply).await;
        let (result, data) =
            capture(execute(&client, local_request(url), Some("test"), None)).await;
        assert_eq!(result, Err("calendar_request_failed"));
        assert_eq!(
            data.unwrap(),
            json!({"provider":"google","operation":"lookup","stage":"request","httpStatus":400})
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn concurrent_success_failed_and_cancelled_scopes_cannot_share_details() {
    async fn request(operation: &str, status: u16) -> (Result<Value, &'static str>, Option<Value>) {
        capture(async {
            let mut details = context("google", operation, "request");
            details["httpStatus"] = json!(status);
            record("calendar_request_failed", details);
            tokio::task::yield_now().await;
            Err("calendar_request_failed")
        })
        .await
    }
    let (lookup, import) = tokio::join!(request("lookup", 429), request("import", 400));
    assert_eq!(lookup.1.unwrap()["httpStatus"], 429);
    assert_eq!(import.1.unwrap()["operation"], "import");
    let successful = capture(async {
        record(
            "calendar_request_failed",
            context("google", "lookup", "request"),
        );
        Ok(json!({}))
    })
    .await;
    assert!(
        successful.1.is_none(),
        "a recovered error must not accompany a successful RPC"
    );
    let cancelled = tokio::time::timeout(
        std::time::Duration::from_millis(10),
        capture(async {
            record(
                "calendar_request_failed",
                context("google", "import", "request"),
            );
            std::future::pending::<Result<Value, &'static str>>().await
        }),
    )
    .await;
    assert!(cancelled.is_err());
    assert!(
        capture(async { Err("calendar_request_failed") })
            .await
            .1
            .is_none()
    );
}

#[tokio::test]
async fn stalled_error_body_is_bounded_and_does_not_erase_http_status() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 8192];
        socket.read(&mut request).await.unwrap();
        socket
            .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 100\r\n\r\n")
            .await
            .unwrap();
        std::future::pending::<()>().await;
    });
    let client = Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        capture(execute(&client, local_request(url), Some("test"), None)),
    )
    .await;
    task.abort();
    let (result, data) = answer.expect("error body exceeded diagnostic deadline");
    assert_eq!(result, Err("calendar_request_failed"));
    assert_eq!(data.unwrap()["httpStatus"], 400);
}
