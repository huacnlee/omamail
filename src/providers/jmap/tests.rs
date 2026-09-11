use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

fn params() -> Value {
    json!({"verb":"session", "url":"https://mail.example.test/session", "credential":{"scheme":"basic","username":"a@example.test", "secret":"synthetic"}})
}
#[test]
fn refuses_invalid_destinations_and_credentials_before_network() {
    for value in [
        "http://mail.example.test/",
        "https://user:password@mail.example.test/",
        "https://mail.example.test/#fragment",
        " https://mail.example.test/",
        "https://mail.example.test/\n",
        "https://mail.example.test\\@other.test/",
    ] {
        let mut p = params();
        p["url"] = json!(value);
        assert!(prepare(&p).is_err(), "{value:?}");
    }
    for value in [
        "secret\r",
        "secret\n",
        "secret\r\n",
        "secret\0",
        "secret\u{7f}",
    ] {
        let mut p = params();
        p["credential"]["secret"] = json!(value);
        assert!(prepare(&p).is_err());
    }
    let mut p = params();
    p["credential"]["secret"] = json!("valid \\\" Unicode 密码");
    assert!(prepare(&p).is_ok());
}
#[test]
fn parser_bounds_partial_events_and_normalizes_newlines() {
    for separator in ["\r", "\n", "\r\n"] {
        let mut parser = stream::Parser::default();
        let mut blocks = Vec::new();
        for byte in format!("event: state{separator}data: {{}}{separator}{separator}").bytes() {
            if let Some(block) = parser.push(byte).unwrap() {
                blocks.push(block);
            }
        }
        assert_eq!(blocks, ["event: state\ndata: {}\n"]);
    }
    let mut parser = stream::Parser::default();
    for _ in 0..65536 {
        parser.push(b'x').unwrap();
    }
    assert_eq!(parser.push(b'x'), Err("jmap_event_too_large"));
}
#[tokio::test]
async fn never_follows_redirect_or_leaks_credential() {
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source_addr = source.local_addr().unwrap();
    let target_addr = target.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = source.accept().await.unwrap();
        let mut data = [0; 4096];
        let n = socket.read(&mut data).await.unwrap();
        assert!(n > 0);
        assert!(String::from_utf8_lossy(&data[..n]).contains("authorization: Basic "));
        socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: http://{target_addr}/stolen\r\nContent-Length: 0\r\n\r\n").as_bytes()).await.unwrap();
    });
    let mut request = prepare(&params()).unwrap();
    request.url = Url::parse(&format!("http://{source_addr}/")).unwrap();
    let result = execute(&client_builder().build().unwrap(), request)
        .await
        .unwrap();
    assert_eq!(result["status"], 302);
    assert_eq!(result["redirect"], "");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), target.accept())
            .await
            .is_err()
    );
    server.await.unwrap();
}
#[tokio::test]
async fn concurrent_requests_overlap_and_sequential_requests_reuse_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let connections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let accepted = connections.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            accepted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::spawn(async move {
                let mut buffer = [0; 4096];
                loop {
                    let n = socket.read(&mut buffer).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
    });
    let mut request = prepare(&params()).unwrap();
    request.url = Url::parse(&format!("http://{address}/")).unwrap();
    let client = client_builder().build().unwrap();
    execute(&client, request.clone()).await.unwrap();
    execute(&client, request.clone()).await.unwrap();
    assert_eq!(connections.load(std::sync::atomic::Ordering::SeqCst), 1);
    let started = std::time::Instant::now();
    let results =
        futures_util::future::join_all((0..6).map(|_| execute(&client, request.clone()))).await;
    assert!(results.iter().all(Result::is_ok));
    assert!(started.elapsed() < Duration::from_millis(450));
    server.abort();
}
#[tokio::test]
async fn response_limit_refuses_body_and_stream_close_aborts_task() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = [0; 4096];
        assert!(socket.read(&mut data).await.unwrap() > 0);
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 33554433\r\n\r\n")
            .await
            .unwrap();
    });
    let mut request = prepare(&params()).unwrap();
    request.url = Url::parse(&format!("http://{address}/")).unwrap();
    assert_eq!(
        execute(&client_builder().build().unwrap(), request).await,
        Err("jmap_response_too_large")
    );
    server.await.unwrap();
    let session = Session::default();
    let mut p = params();
    p["verb"] = json!("stream");
    p["streamId"] = json!("test");
    let (sender, receiver) = mpsc::channel(8);
    let task = tokio::spawn(async move {
        let _sender = sender;
        std::future::pending::<()>().await;
    });
    session.streams.lock().unwrap().insert(
        "test".into(),
        Stream {
            task,
            receiver: std::sync::Arc::new(tokio::sync::Mutex::new(receiver)),
        },
    );
    let task = session
        .streams
        .lock()
        .unwrap()
        .get("test")
        .unwrap()
        .task
        .abort_handle();
    session.call("jmap.stream.close", &p).await.unwrap();
    tokio::task::yield_now().await;
    assert!(task.is_finished());
}

#[tokio::test]
async fn invalid_tls_certificate_and_hostname_never_receive_credentials() {
    use std::io::{BufRead, BufReader};
    let mut peer = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/providers/gmail_http_tls_test.py"
        ))
        .arg("3")
        .arg("3")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(peer.stdout.take().unwrap());
    let mut port = String::new();
    output.read_line(&mut port).unwrap();
    let port: u16 = port.trim().parse().unwrap();
    let mut certificate_path = String::new();
    output.read_line(&mut certificate_path).unwrap();
    let certificate =
        reqwest::Certificate::from_pem(&std::fs::read(certificate_path.trim()).unwrap()).unwrap();
    let trusted = client_builder()
        .add_root_certificate(certificate)
        .build()
        .unwrap();
    let untrusted = client_builder().build().unwrap();
    for (client, host) in [(&untrusted, "localhost"), (&trusted, "127.0.0.1")] {
        let mut request = prepare(&params()).unwrap();
        request.url = Url::parse(&format!("https://{host}:{port}/")).unwrap();
        assert_eq!(execute(client, request).await, Err("jmap_network_failed"));
        let mut report = String::new();
        output.read_line(&mut report).unwrap();
        assert_eq!(report.trim(), "tls-refused-no-http");
    }
    let mut request = prepare(&params()).unwrap();
    request.url = Url::parse(&format!("https://localhost:{port}/")).unwrap();
    assert_eq!(execute(&trusted, request).await.unwrap()["status"], 200);
    let mut report = String::new();
    output.read_line(&mut report).unwrap();
    assert_eq!(report.trim(), "http-received");
    assert!(peer.wait().unwrap().success());
}

#[tokio::test]
async fn cancelling_a_pending_native_request_closes_the_socket_without_retrying() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0; 4096];
        assert!(socket.read(&mut buffer).await.unwrap() > 0);
        // The server never supplies a response. Dropping the request future
        // must release the connection instead of leaving a blocked curl child.
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), socket.read(&mut buffer))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
    let mut request = prepare(&params()).unwrap();
    request.url = Url::parse(&format!("http://{address}/")).unwrap();
    let client = client_builder().build().unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), execute(&client, request))
            .await
            .is_err()
    );
    server.await.unwrap();
}
