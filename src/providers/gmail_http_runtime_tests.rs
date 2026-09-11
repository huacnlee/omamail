//! Real native HTTP against synthetic loopback servers. Only test code changes origins.
use super::*;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    connections: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server(response: Vec<u8>, delay: Duration) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/messages/abc", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let connections = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let accepted = connections.clone();
    let task = tokio::spawn(async move {
        let mut handlers = tokio::task::JoinSet::new();
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            accepted.fetch_add(1, Ordering::SeqCst);
            let seen = seen.clone();
            let response = response.clone();
            handlers.spawn(async move {
                loop {
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        let Ok(byte) = stream.read_u8().await else {
                            return;
                        };
                        request.push(byte);
                        assert!(request.len() <= MAX_INPUT * 2);
                    }
                    let headers = String::from_utf8(request.clone()).unwrap();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    assert!(length <= MAX_INPUT);
                    let mut body = vec![0; length];
                    if stream.read_exact(&mut body).await.is_err() {
                        return;
                    }
                    request.extend(body);
                    seen.lock()
                        .unwrap()
                        .push(String::from_utf8(request).unwrap());
                    tokio::time::sleep(delay).await;
                    if stream.write_all(&response).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    Server {
        url,
        requests,
        connections,
        task,
    }
}

fn ok() -> Vec<u8> {
    b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}".to_vec()
}
fn local(server: &Server, mut request: Request) -> Request {
    request.url = server.url.clone();
    request
}
fn get_request() -> Request {
    prepare_get(&["messages", "abc"], &[], "synthetic-token").unwrap()
}

#[tokio::test]
async fn native_headers_form_and_keepalive() {
    let server = server(ok(), Duration::ZERO).await;
    let client = client_builder().https_only(false).build().unwrap();
    for request in [
        get_request(),
        prepare_refresh("id", "quote\"\\", "é+&=").unwrap(),
    ] {
        assert_eq!(
            execute(&client, local(&server, request), DEADLINE)
                .await
                .unwrap()["ok"],
            true
        );
    }
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        server.connections.load(Ordering::SeqCst),
        1,
        "reuse TCP connection"
    );
    assert!(requests[0].starts_with("GET /messages/abc HTTP/1.1\r\n"));
    assert!(requests[0].contains("\r\nauthorization: Bearer synthetic-token\r\n"));
    assert!(requests[1].contains("\r\ncontent-type: application/x-www-form-urlencoded\r\n"));
    assert!(requests[1].ends_with("grant_type=refresh_token&client_id=id&client_secret=quote%22%5C&refresh_token=%C3%A9%2B%26%3D"));
    assert!(!requests[1].contains("authorization:"));
}

#[tokio::test]
async fn native_concurrency_overlaps_response_waits() {
    let server = server(ok(), Duration::from_millis(150)).await;
    let client = client_builder().https_only(false).build().unwrap();
    let started = std::time::Instant::now();
    let mut work = tokio::task::JoinSet::new();
    for _ in 0..4 {
        let client = client.clone();
        let request = local(&server, get_request());
        work.spawn(async move { execute(&client, request, DEADLINE).await });
    }
    // All four requests arrive before the server releases the first response.
    tokio::time::timeout(Duration::from_secs(2), async {
        while server.requests.lock().unwrap().len() != 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    while let Some(result) = work.join_next().await {
        assert!(result.unwrap().is_ok());
    }
    eprintln!(
        "four concurrent 150ms responses completed in {:?} (serial floor 600ms)",
        started.elapsed()
    );
    assert!(started.elapsed() < Duration::from_millis(550));
}

#[tokio::test]
async fn redirect_never_contacts_second_origin_or_discloses_token() {
    let forbidden = server(ok(), Duration::ZERO).await;
    let redirect = format!(
        "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\n\r\n",
        forbidden.url
    );
    let first = server(redirect.into_bytes(), Duration::ZERO).await;
    let client = client_builder().https_only(false).build().unwrap();
    for request in [
        get_request(),
        prepare_refresh("id", "secret", "token").unwrap(),
    ] {
        assert_eq!(
            execute(&client, local(&first, request), DEADLINE).await,
            Err("gmail_http_failed")
        );
    }
    assert_eq!(first.requests.lock().unwrap().len(), 2);
    assert_eq!(forbidden.connections.load(Ordering::SeqCst), 0);
    assert!(forbidden.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn timeout_and_response_bounds_are_enforced_on_actual_streams() {
    let client = client_builder().https_only(false).build().unwrap();
    let stalled = server(ok(), Duration::from_secs(2)).await;
    assert_eq!(
        execute(
            &client,
            local(&stalled, get_request()),
            Duration::from_millis(40)
        )
        .await,
        Err("gmail_timeout")
    );
    for chunked in [false, true] {
        let bytes = if chunked {
            let mut bytes = format!(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
                MAX_RESPONSE + 1
            )
            .into_bytes();
            bytes.resize(bytes.len() + MAX_RESPONSE + 1, b' ');
            bytes.extend_from_slice(b"\r\n0\r\n\r\n");
            bytes
        } else {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_RESPONSE + 1
            )
            .into_bytes()
        };
        let large = server(bytes, Duration::ZERO).await;
        assert_eq!(
            execute(&client, local(&large, get_request()), DEADLINE).await,
            Err("gmail_response_too_large")
        );
    }
}

#[tokio::test]
async fn auth_and_invalid_json_return_only_static_errors() {
    let client = client_builder().https_only(false).build().unwrap();
    for (status, body, error) in [
        (401, "synthetic-secret", "gmail_unauthorized"),
        (403, "synthetic-secret", "gmail_forbidden"),
        (411, "synthetic-secret", "gmail_length_required"),
        (429, "synthetic-secret", "gmail_rate_limited"),
        (200, "[]", "gmail_invalid_response"),
        (200, "synthetic-secret", "gmail_invalid_response"),
    ] {
        let target = server(
            format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .into_bytes(),
            Duration::ZERO,
        )
        .await;
        assert_eq!(
            execute(&client, local(&target, get_request()), DEADLINE).await,
            Err(error)
        );
    }
}

#[tokio::test]
async fn invalid_bytes_are_refused_before_network() {
    let target = server(ok(), Duration::ZERO).await;
    let client = client_builder().https_only(false).build().unwrap();
    for bad in ["x\n", "x\r", "x\r\n", "x\0", "x\u{7f}", "x\t"] {
        let attempts = [
            prepare_get(&["messages"], &[], bad),
            prepare_get(&[bad], &[], "valid"),
            prepare_refresh("id", "secret", bad),
            prepare_refresh(bad, "secret", "token"),
            prepare_refresh("id", bad, "token"),
            prepare_get(&["messages"], &[(bad.into(), "value".into())], "token"),
            prepare_get(&["messages"], &[("q".into(), bad.into())], "token"),
        ];
        for attempt in attempts {
            let result = match attempt {
                Ok(request) => execute(&client, local(&target, request), DEADLINE).await,
                Err(error) => Err(error),
            };
            assert_eq!(result, Err("gmail_invalid_input"));
        }
    }
    assert_eq!(target.connections.load(Ordering::SeqCst), 0);
    for path in [vec![".."], vec!["."], vec![""]] {
        assert!(prepare_get(&path, &[], "token").is_err());
    }
    let request = prepare_get(
        &["messages", "x/y?z#@"],
        &[("q".into(), "from:a+b@example.org &主题".into())],
        "token",
    )
    .unwrap();
    assert_eq!(
        request.url,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/x%2Fy%3Fz%23%40?q=from%3Aa%2Bb%40example.org%20%26%E4%B8%BB%E9%A2%98"
    );
}

#[tokio::test]
async fn production_client_refuses_plain_http_before_connecting() {
    let target = server(ok(), Duration::ZERO).await;
    assert_eq!(
        execute(client().unwrap(), local(&target, get_request()), DEADLINE).await,
        Err("gmail_http_failed")
    );
    assert_eq!(target.connections.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn real_tls_rejects_untrusted_certificate_before_sending_credentials() {
    use std::io::{BufRead, BufReader};
    let mut peer = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/providers/gmail_http_tls_test.py"
        ))
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
    // First reject the untrusted issuer; then trust that issuer and independently
    // reject the mismatched IP hostname (the certificate only names localhost).
    for (client, host) in [(client().unwrap(), "localhost"), (&trusted, "127.0.0.1")] {
        let mut request = get_request();
        request.url = format!("https://{host}:{port}/messages/abc");
        assert_eq!(
            execute(client, request, DEADLINE).await,
            Err("gmail_http_failed")
        );
        let mut report = String::new();
        output.read_line(&mut report).unwrap();
        assert_eq!(report.trim(), "tls-refused-no-http");
    }
    // A successful trusted, matching-host control proves that the previous
    // rejection was hostname verification, not a malformed CA/end-entity cert.
    let mut request = get_request();
    request.url = format!("https://localhost:{port}/messages/abc");
    assert_eq!(
        execute(&trusted, request, DEADLINE).await.unwrap(),
        serde_json::json!({"ok":true})
    );
    let mut report = String::new();
    output.read_line(&mut report).unwrap();
    assert_eq!(report.trim(), "http-received");
    assert!(peer.wait().unwrap().success());
}

#[test]
fn pending_dns_obeys_deadline_and_does_not_block_runtime_shutdown() {
    struct PendingResolver {
        started: Arc<AtomicUsize>,
        cancelled: Arc<AtomicUsize>,
    }
    struct ResolutionGuard(Arc<AtomicUsize>);
    impl Drop for ResolutionGuard {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    impl reqwest::dns::Resolve for PendingResolver {
        fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
            self.started.fetch_add(1, Ordering::SeqCst);
            let guard = ResolutionGuard(self.cancelled.clone());
            Box::pin(async move {
                let _guard = guard;
                std::future::pending().await
            })
        }
    }
    let started = Arc::new(AtomicUsize::new(0));
    let cancelled = Arc::new(AtomicUsize::new(0));
    let resolver = PendingResolver {
        started: started.clone(),
        cancelled: cancelled.clone(),
    };
    let (finished, completion) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(async {
            let client = client_builder()
                .dns_resolver(Arc::new(resolver))
                .build()
                .unwrap();
            // Retain the real fixed HTTPS URL: the only injected seam is a DNS
            // future that never yields an address, so no connection is possible.
            execute(&client, get_request(), Duration::from_millis(40)).await
        });
        drop(runtime);
        finished.send(result).unwrap();
    });
    // Receive only after normal runtime destruction, not shutdown_timeout or a
    // leaked runtime: lingering blocking DNS work would fail this assertion.
    let result = completion
        .recv_timeout(Duration::from_secs(2))
        .expect("pending DNS must not hang request or runtime shutdown");
    worker.join().unwrap();
    assert_eq!(result, Err("gmail_timeout"));
    assert_eq!(started.load(Ordering::SeqCst), 1);
    assert_eq!(cancelled.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn native_mutations_preserve_verbs_bodies_and_accept_empty_success() {
    let peer = server(
        b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n".to_vec(),
        Duration::ZERO,
    )
    .await;
    let client = client_builder().https_only(false).build().unwrap();
    for method in [
        reqwest::Method::POST,
        reqwest::Method::PUT,
        reqwest::Method::PATCH,
        reqwest::Method::DELETE,
    ] {
        let payload = serde_json::json!({"name":"Quotes \\\" 日本語\nsecond line"});
        let request = prepare_write(
            method.clone(),
            &["labels", "a/b"],
            Some(&payload),
            "synthetic-token",
        )
        .unwrap();
        assert!(request.url.ends_with("/labels/a%2Fb"));
        assert_eq!(
            execute(&client, local(&peer, request), DEADLINE)
                .await
                .unwrap(),
            serde_json::json!({})
        );
        let requests = peer.requests.lock().unwrap();
        let raw = requests.last().unwrap();
        assert!(raw.starts_with(&format!("{method} ")));
        let (_, body) = raw.split_once("\r\n\r\n").unwrap();
        assert_eq!(serde_json::from_str::<Value>(body).unwrap(), payload);
    }
    assert_eq!(peer.requests.lock().unwrap().len(), 4);
    assert_eq!(peer.connections.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn native_mutation_redirect_never_replays_body_or_credentials() {
    let target = server(ok(), Duration::ZERO).await;
    let redirect = format!(
        "HTTP/1.1 307 Temporary Redirect\r\nLocation: {}\r\nContent-Length: 0\r\n\r\n",
        target.url
    );
    let source = server(redirect.into_bytes(), Duration::ZERO).await;
    let client = client_builder().https_only(false).build().unwrap();
    let request = prepare_write(
        reqwest::Method::POST,
        &["messages", "send"],
        Some(&serde_json::json!({"raw":"YQ"})),
        "synthetic-token",
    )
    .unwrap();
    assert_eq!(
        execute(&client, local(&source, request), DEADLINE).await,
        Err("gmail_http_failed")
    );
    assert_eq!(source.requests.lock().unwrap().len(), 1);
    assert!(target.requests.lock().unwrap().is_empty());
    assert_eq!(target.connections.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn mutation_timeout_does_not_retry_an_accepted_request() {
    let peer = server(ok(), Duration::from_millis(100)).await;
    let client = client_builder().https_only(false).build().unwrap();
    let request = prepare_write(
        reqwest::Method::POST,
        &["messages", "send"],
        Some(&serde_json::json!({"raw":"YQ"})),
        "synthetic-token",
    )
    .unwrap();
    assert_eq!(
        execute(&client, local(&peer, request), Duration::from_millis(30)).await,
        Err("gmail_timeout")
    );
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(peer.requests.lock().unwrap().len(), 1);
    assert_eq!(peer.connections.load(Ordering::SeqCst), 1);
}

// Model a gateway which rejects unframed POSTs with 411, before any mutation.
async fn strict_empty_post_server() -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let connections = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let accepted = connections.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            accepted.fetch_add(1, Ordering::SeqCst);
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                bytes.push(stream.read_u8().await.unwrap());
                assert!(bytes.len() < 8192);
            }
            let request = String::from_utf8(bytes).unwrap();
            let framed = request
                .to_ascii_lowercase()
                .contains("\r\ncontent-length: 0\r\n");
            seen.lock().unwrap().push(request);
            let response = if framed {
                "HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"id\":\"chosen\"}"
            } else {
                "HTTP/1.1 411 Length Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            };
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    Server {
        url,
        requests,
        connections,
        task,
    }
}

#[tokio::test]
async fn gmail_bodyless_trash_posts_exact_id_with_explicit_empty_length() {
    let client = client_builder().https_only(false).build().unwrap();
    for action in ["trash", "untrash"] {
        let peer = strict_empty_post_server().await;
        let mut request = prepare_write(
            reqwest::Method::POST,
            &["messages", "chosen", action],
            None,
            "synthetic-token",
        )
        .unwrap();
        assert!(request.url.ends_with(&format!("/messages/chosen/{action}")));
        request.url = format!("{}/messages/chosen/{action}", peer.url);
        let result = execute(&client, request, DEADLINE).await;
        assert_eq!(
            peer.connections.load(Ordering::SeqCst),
            1,
            "never retry a mutation"
        );
        let requests = peer.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with(&format!("POST /messages/chosen/{action} HTTP/1.1\r\n")));
        assert_eq!(result.unwrap()["id"], "chosen");
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("\r\ncontent-length: 0\r\n")
        );
    }
}
