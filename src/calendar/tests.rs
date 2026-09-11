use super::*;
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
        url,
        method: Method::GET,
        body: String::new(),
        kind: "google".into(),
        source_id: String::new(),
        username: String::new(),
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
