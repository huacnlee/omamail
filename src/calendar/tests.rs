use super::*;

#[test]
fn google_requests_keep_calendar_identity_and_preconditions() {
    let request = prepare(&json!({"source":{"kind":"google","calendarId":"family/a?b@example.org"},
        "operation":"update","eventId":"instance/one","body":"{}","ifMatch":"\"revision\"","sendUpdates":"all"})).unwrap();
    assert_eq!(request.url.host_str(), Some("www.googleapis.com"));
    assert_eq!(
        decoded_path(&request.url),
        vec![
            b"".to_vec(),
            b"calendar".to_vec(),
            b"v3".to_vec(),
            b"calendars".to_vec(),
            b"family/a?b@example.org".to_vec(),
            b"events".to_vec(),
            b"instance/one".to_vec()
        ]
    );
    assert_eq!(request.if_match.as_deref(), Some("\"revision\""));
    assert!(
        request
            .url
            .query_pairs()
            .any(|(k, v)| k == "conferenceDataVersion" && v == "1")
    );
    assert!(
        prepare(
            &json!({"source":{"kind":"google","calendarId":".."},"operation":"get","eventId":"x"})
        )
        .is_err()
    );
    assert!(prepare(&json!({"source":{"kind":"caldav"},"operation":"move"})).is_err());
}
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[test]
fn caldav_refuses_cross_origin_and_controls_before_credentials() {
    let base = configured_url("https://calendar.example/dav/").unwrap();
    for href in [
        "https://evil.example/a",
        "//evil.example/a",
        "http://calendar.example/a",
        "https://calendar.example:444/a",
        "https://user@calendar.example/a",
        "/a\r",
        "/a\n",
        "/a\0",
        "\\evil.example/a",
    ] {
        assert!(event_url(&base, href).is_err(), "{href:?}");
    }
    assert_eq!(
        event_url(&base, "a%20b.ics").unwrap().as_str(),
        "https://calendar.example/dav/a%20b.ics"
    );
    for raw in [
        "http://calendar.example/",
        "https://calendar.example/\n",
        "https://user:password@calendar.example/",
        "https://calendar.example/#x",
    ] {
        assert!(configured_url(raw).is_err());
    }
}

#[test]
fn provider_chooses_origin_and_encodes_event_id() {
    let request = prepare(&json!({"source":{"kind":"google"},"operation":"delete","eventId":"https://evil.example/a?b"})).unwrap();
    assert_eq!(request.url.host_str(), Some("www.googleapis.com"));
    assert!(
        request
            .url
            .path()
            .ends_with("https:%2F%2Fevil.example%2Fa%3Fb")
    );
    assert!(
        prepare(&json!({"source":{"kind":"google"},"operation":"delete","eventId":".."})).is_err()
    );
}

#[test]
fn microsoft_calendar_identity_is_one_encoded_path_segment() {
    let list = prepare(&json!({
        "source":{"kind":"microsoft","calendarId":"A/B?C"},
        "operation":"list","start":"2026-09-01T00:00:00Z","end":"2026-10-01T00:00:00Z"
    }))
    .unwrap();
    assert_eq!(list.url.path(), "/v1.0/me/calendars/A%2FB%3FC/calendarView");
    let update = prepare(&json!({
        "source":{"kind":"microsoft","calendarId":"A/B?C"},
        "operation":"update","eventId":"event/one","body":"{}"
    }))
    .unwrap();
    assert_eq!(
        update.url.path(),
        "/v1.0/me/calendars/A%2FB%3FC/events/event%2Fone"
    );
}

#[test]
fn empty_microsoft_calendar_identity_keeps_the_default_calendar() {
    let request = prepare(&json!({
        "source":{"kind":"microsoft","calendarId":""},
        "operation":"list","start":"2026-09-01T00:00:00Z","end":"2026-10-01T00:00:00Z"
    }))
    .unwrap();
    assert_eq!(request.url.path(), "/v1.0/me/calendarView");
    for id in [".", ".."] {
        assert!(
            prepare(&json!({
                "source":{"kind":"microsoft","calendarId":id},
                "operation":"list","start":"a","end":"b"
            }))
            .is_err()
        );
    }
}

#[test]
fn icloud_calendar_refuses_non_apple_destinations_before_credentials() {
    assert!(
        prepare(&json!({
            "source":{"kind":"icloud","accountId":"imap:person@icloud.com",
              "url":"https://evil.example/calendars/private/"},
            "operation":"list","body":"report"
        }))
        .is_err()
    );
    assert!(
        prepare(&json!({
            "source":{"kind":"icloud","accountId":"imap:person@icloud.com",
              "url":"https://p37-caldav.icloud.com/123/calendars/private/"},
            "operation":"list","body":"report"
        }))
        .is_ok()
    );
}

#[tokio::test]
async fn icloud_refusal_never_contacts_an_untrusted_target() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("https://{}/calendar/", listener.local_addr().unwrap());
    let result = call(
        &json!({
            "source":{"kind":"icloud","accountId":"imap:missing@icloud.com","url":url},
            "operation":"list","body":"synthetic report"
        }),
        None,
    )
    .await;
    assert_eq!(result, Err("calendar_origin_refused"));
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}

// A Graph calendar id is base64 with `=` padding, which the request builder
// writes into the path literally while a nextLink may carry it as `%3D`. Both
// spell the same resource, so the second page must not be refused; a link that
// decodes to a different resource still is.
#[test]
fn pagination_compares_the_decoded_resource_path() {
    let list = prepare(&json!({
        "source":{"kind":"microsoft","calendarId":"AAMkAGI2AAA="},
        "operation":"list","start":"2026-09-01T00:00:00Z","end":"2026-10-01T00:00:00Z"
    }))
    .unwrap();
    assert_eq!(
        list.url.path(),
        "/v1.0/me/calendars/AAMkAGI2AAA=/calendarView"
    );
    let encoded =
        "https://graph.microsoft.com/v1.0/me/calendars/AAMkAGI2AAA%3D/calendarView?$skip=50";
    assert!(
        next_page(&list.url, &json!({"@odata.nextLink":encoded}), "value")
            .unwrap()
            .is_some()
    );
    let literal =
        "https://graph.microsoft.com/v1.0/me/calendars/AAMkAGI2AAA=/calendarView?$skip=50";
    assert!(
        next_page(&list.url, &json!({"@odata.nextLink":literal}), "value")
            .unwrap()
            .is_some()
    );
    for other in [
        "https://graph.microsoft.com/v1.0/me/calendars/AAMkAGI2AAB%3D/calendarView?$skip=50",
        "https://graph.microsoft.com/v1.0/me/calendars/AAMkAGI2AAA%3D/events?$skip=50",
        "https://graph.microsoft.com/v1.0/me/calendars/AAMkAGI2AAA%3D%2FcalendarView?$skip=50",
    ] {
        assert!(
            next_page(&list.url, &json!({"@odata.nextLink":other}), "value").is_err(),
            "{other}"
        );
    }
}

#[test]
fn pagination_cannot_change_credential_destination_or_resource() {
    let base =
        Url::parse("https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=now").unwrap();
    for next in [
        "https://evil.example/",
        "https://graph.microsoft.com/v1.0/me/messages",
        "https://user@graph.microsoft.com/v1.0/me/calendarView",
        "https://graph.microsoft.com/v1.0/me/calendarView\n",
    ] {
        assert!(next_page(&base, &json!({"@odata.nextLink":next}), "value").is_err());
    }
    assert!(next_page(&base, &json!({"@odata.nextLink":"https://graph.microsoft.com/v1.0/me/calendarView?$skip=500"}), "value").unwrap().is_some());
    let next = next_page(&base, &json!({"nextPageToken":"a&evil=value"}), "items")
        .unwrap()
        .unwrap();
    assert_eq!(
        next.query_pairs()
            .find(|(key, _)| key == "pageToken")
            .unwrap()
            .1,
        "a&evil=value"
    );
}

async fn server(response: &'static str) -> (Url, tokio::task::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; 8192];
        let n = socket.read(&mut bytes).await.unwrap();
        bytes.truncate(n);
        socket.write_all(response.as_bytes()).await.unwrap();
        bytes
    });
    (url, handle)
}

fn local_request(url: Url) -> Request {
    Request {
        if_match: None,
        url,
        method: Method::GET,
        body: String::new(),
        kind: "google".into(),
        source_id: String::new(),
        username: String::new(),
        account_id: String::new(),
    }
}

#[tokio::test]
async fn google_mutation_keeps_revision_and_never_follows_redirect() {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let response = Box::leak(format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", target.local_addr().unwrap()).into_boxed_str());
    let (url, task) = server(response).await;
    let mut request = prepare(&json!({"source":{"kind":"google","calendarId":"shared@example.org"},
        "operation":"update","eventId":"event","body":"{\"summary\":\"synthetic\"}","ifMatch":"\"revision\"","sendUpdates":"none"})).unwrap();
    request.url = url;
    assert!(
        execute(&client, request, Some("synthetic-calendar-token"), None)
            .await
            .is_err()
    );
    let bytes = String::from_utf8(task.await.unwrap())
        .unwrap()
        .to_lowercase();
    assert!(bytes.starts_with("patch "));
    assert!(bytes.contains("if-match: \"revision\""));
    assert!(bytes.contains("authorization: bearer synthetic-calendar-token"));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), target.accept())
            .await
            .is_err()
    );
    for suffix in ["\r", "\n", "\r\n", "\0"] {
        assert!(
            prepare(
                &json!({"source":{"kind":"google"},"operation":"update","eventId":"event",
            "body":"{}","ifMatch":format!("revision{suffix}")})
            )
            .is_err()
        );
    }
}

#[tokio::test]
async fn native_http_returns_body_and_refuses_redirects() {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let (url, task) =
        server("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await;
    assert_eq!(
        execute(&client, local_request(url), Some("synthetic-token"), None)
            .await
            .unwrap()["body"],
        "{}"
    );
    let raw = String::from_utf8(task.await.unwrap()).unwrap();
    assert!(
        raw.to_lowercase()
            .contains("authorization: bearer synthetic-token")
    );
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let response=Box::leak(format!("HTTP/1.1 302 Found\r\nLocation: http://{}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",target.local_addr().unwrap()).into_boxed_str());
    let (url, task) = server(response).await;
    assert_eq!(
        execute(&client, local_request(url), Some("synthetic-token"), None)
            .await
            .unwrap_err(),
        "calendar_request_failed"
    );
    task.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), target.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn native_http_bounds_downloads() {
    let client = Client::builder().no_proxy().build().unwrap();
    let (url, task) =
        server("HTTP/1.1 200 OK\r\nContent-Length: 16777217\r\nConnection: close\r\n\r\n").await;
    assert_eq!(
        execute(&client, local_request(url), Some("test"), None)
            .await
            .unwrap_err(),
        "calendar_response_too_large"
    );
    task.await.unwrap();
}

#[tokio::test]
async fn google_move_sends_explicit_zero_content_length() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut request = prepare(&json!({"source":{"kind":"google","calendarId":"family@example.test"},
        "operation":"move","eventId":"meeting","destination":"owner@example.test","sendUpdates":"none"})).unwrap();
    assert_eq!(request.method, Method::POST);
    assert!(request.url.path().ends_with("/events/meeting/move"));
    assert!(
        request
            .url
            .query_pairs()
            .any(|(key, value)| key == "destination" && value == "owner@example.test")
    );
    request.url.set_scheme("http").unwrap();
    request.url.set_host(Some("127.0.0.1")).unwrap();
    request
        .url
        .set_port(Some(listener.local_addr().unwrap().port()))
        .unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut headers = Vec::new();
        loop {
            let mut byte = [0];
            socket.read_exact(&mut byte).await.unwrap();
            headers.push(byte[0]);
            if headers.ends_with(b"\r\n\r\n") {
                break;
            }
            assert!(headers.len() < 16384);
        }
        let text = String::from_utf8(headers).unwrap().to_lowercase();
        let framed = text.contains("\r\ncontent-length: 0\r\n");
        let reply = if framed {
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
        } else {
            "HTTP/1.1 411 Length Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        };
        socket.write_all(reply.as_bytes()).await.unwrap();
        assert!(framed, "empty Google POST must state its content length");
    });
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    assert!(
        execute(&client, request, Some("synthetic-token"), None)
            .await
            .is_ok()
    );
    server.await.unwrap();
}

#[tokio::test]
async fn independent_calendar_requests_progress_concurrently() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    // No response until all three requests arrived: a serial transport cannot
    // finish this exchange. The timeout only prevents a regression hanging CI.
    let server = tokio::spawn(async move {
        let mut sockets = Vec::new();
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(socket.read(&mut bytes).await.unwrap() > 0);
            sockets.push(socket);
        }
        for mut socket in sockets {
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        }
    });
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let (one, two, three) = tokio::join!(
        execute(&client, local_request(url.clone()), Some("test"), None),
        execute(&client, local_request(url.clone()), Some("test"), None),
        execute(&client, local_request(url), Some("test"), None)
    );
    assert!(one.is_ok() && two.is_ok() && three.is_ok());
    server.await.unwrap();
}

#[tokio::test]
async fn credentials_failure_sends_no_calendar_network_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let params = json!({"source":{"kind":"caldav","id":"synthetic-source", "username":"synthetic-user",
        "url":format!("https://{}/dav/", listener.local_addr().unwrap())},
        "operation":"list", "body":"<calendar/>"});
    for (error, expected) in [
        (
            crate::credentials::Error::Missing,
            "calendar_password_missing",
        ),
        (
            crate::credentials::Error::Unavailable,
            "calendar_keyring_failed",
        ),
    ] {
        let result = call_inner_with(&params, None, |key| async move {
            assert_eq!(key.provider, "caldav");
            assert_eq!(key.account_id, "synthetic-source");
            Err(error)
        })
        .await;
        assert_eq!(result, Err(expected));
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err(),
            "failed credential lookup connected to the calendar server"
        );
    }
}

#[tokio::test]
async fn credentials_are_not_read_for_a_cross_origin_calendar_href() {
    let params = json!({"source":{"kind":"caldav","id":"synthetic-source", "username":"synthetic-user",
        "url":"https://calendar.example/dav/"}, "operation":"delete", "href":"https://attacker.example/event.ics"});
    assert!(
        call_inner_with(&params, None, |_| async {
            panic!("invalid origin accessed credentials")
        })
        .await
        .is_err()
    );
}
