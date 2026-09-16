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
    server_sequence(vec![response], delay).await
}

// Answers the n-th request with the n-th response; the last one repeats.
async fn server_sequence(responses: Vec<Vec<u8>>, delay: Duration) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/messages/abc", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let connections = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let accepted = connections.clone();
    let served = Arc::new(AtomicUsize::new(0));
    let task = tokio::spawn(async move {
        let mut handlers = tokio::task::JoinSet::new();
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            accepted.fetch_add(1, Ordering::SeqCst);
            let seen = seen.clone();
            let responses = responses.clone();
            let served = served.clone();
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
                    let index = served
                        .fetch_add(1, Ordering::SeqCst)
                        .min(responses.len() - 1);
                    if stream.write_all(&responses[index]).await.is_err() {
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
async fn mail_send_preview_reads_google_identity_without_mutation_or_local_writes() {
    use crate::mail::tests::{account_fixture, fixture_tree, isolated};
    use serde_json::json;
    if isolated() {
        return;
    }
    let fixture = account_fixture(json!({"version":1,"activeId":"audit@example.org",
        "accounts":[{"provider":"gmail","email":"audit@example.org"}]}));
    let credentials = crate::platform::private_fs::directories(
        &fixture.config,
        &[crate::platform::dirs::APP_DIRECTORY],
        true,
    )
    .unwrap()
    .unwrap();
    crate::platform::private_fs::atomic_replace(
        &credentials,
        "credentials.json",
        json!({"installed":{
        "client_id":"123-audit.apps.googleusercontent.com",
        "client_secret":"synthetic-client-secret"}})
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    let _credential =
        crate::credentials::tests::isolated_store(crate::credentials::tests::SingleCredential {
            key: crate::credentials::CredentialKey {
                provider: "gmail".into(),
                account_id: "audit@example.org".into(),
                kind: crate::credentials::CredentialKind::GoogleRefreshToken {
                    client_id: "123-audit.apps.googleusercontent.com".into(),
                },
            },
            secret: crate::credentials::Secret::new(b"synthetic-refresh-token".to_vec()).unwrap(),
        });
    for root in [&fixture.cache, &fixture.state] {
        let directory = root.join("omamail");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("sentinel"), b"unchanged existing state").unwrap();
    }
    std::fs::write(fixture.state.join("omamail/outbox.json"), b"[]\n").unwrap();
    let attachment = fixture.root.join("quote\\工\".txt");
    std::fs::write(&attachment, b"private attachment bytes").unwrap();
    let before = fixture_tree(&fixture.root);
    let body = json!({"access_token":"synthetic-access-token","expires_in":3600,
        "sendAs":[{"sendAsEmail":"audit@example.org","displayName":"Audit 工",
        "isPrimary":true,"isDefault":true}]})
    .to_string();
    let peer = server(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes(),
        Duration::ZERO,
    )
    .await;
    let transport = client_builder().https_only(false).build().unwrap();
    let origin = peer.url.strip_suffix("/messages/abc").unwrap().to_owned();
    let session = crate::backend::Session::default();
    let params = json!({"to":["工 <one@example.org>"],"subject":"Private preview subject",
        "body":"private multiline body\nsecond\r\nمتن\tend",
        "attachments":[{"path":attachment,"name":"quote\\工\".txt","size":24}]});
    with_test_transport(transport, origin, async {
        for _ in 0..2 {
            let result = session.dispatch("mail.send", &params).await.unwrap();
            assert_eq!(result["dryRun"], true);
            assert_eq!(result["executed"], false);
            assert_eq!(result["body"], params["body"]);
            assert_eq!(result["from"], "Audit 工 <audit@example.org>");
            assert!(!result.to_string().contains("synthetic-"));
            assert_eq!(fixture_tree(&fixture.root), before);
        }
        for bad in ["bad\r", "bad\n", "bad\r\n", "bad\0", "=?utf-8?b?YQ==?="] {
            let mut invalid = params.clone();
            invalid["subject"] = json!(bad);
            assert!(session.dispatch("mail.send", &invalid).await.is_err());
            assert_eq!(fixture_tree(&fixture.root), before);
        }
    })
    .await;
    let requests = peer.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        4,
        "one refresh, two valid identity reads and one rejected encoded-header identity read"
    );
    assert!(requests[0].starts_with("POST /token HTTP/1.1\r\n"));
    assert!(!requests[0].contains("authorization:"));
    assert!(requests[0].ends_with("grant_type=refresh_token&client_id=123-audit.apps.googleusercontent.com&client_secret=synthetic-client-secret&refresh_token=synthetic-refresh-token"));
    for request in &requests[1..] {
        assert!(request.starts_with("GET /gmail/v1/users/me/settings/sendAs HTTP/1.1\r\n"));
        assert!(request.contains("\r\nauthorization: Bearer synthetic-access-token\r\n"));
        assert!(request.ends_with("\r\n\r\n"));
        assert!(!request.contains("synthetic-refresh-token"));
        assert!(!request.contains("synthetic-client-secret"));
    }
    for request in requests.iter() {
        assert!(!request.contains("private multiline body"));
        assert!(!request.contains("Private preview subject"));
        assert!(!request.contains("private attachment bytes"));
        assert!(!request.contains("/messages/send") && !request.contains("/upload"));
    }
    assert_eq!(fixture_tree(&fixture.root), before);
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
    // Gmail reports per-user rate limiting as 403 with a usageLimits reason,
    // not only as 429. Any other 403 is a permission problem.
    let limited = r#"{"error":{"errors":[{"domain":"usageLimits","reason":"userRateLimitExceeded","message":"User-rate limit exceeded. Retry after 2026-09-16T00:00:00Z"}],"code":403,"message":"User-rate limit exceeded."}}"#;
    let global = r#"{"error":{"errors":[{"domain":"usageLimits","reason":"rateLimitExceeded","message":"Rate Limit Exceeded"}],"code":403,"message":"Rate Limit Exceeded"}}"#;
    let daily = r#"{"error":{"errors":[{"domain":"usageLimits","reason":"dailyLimitExceeded","message":"Daily Limit Exceeded"}],"code":403,"message":"Daily Limit Exceeded"}}"#;
    let scope = r#"{"error":{"errors":[{"domain":"global","reason":"insufficientPermissions","message":"Insufficient Permission"}],"code":403,"message":"Insufficient Permission"}}"#;
    for (status, body, error) in [
        (401, "synthetic-secret", "gmail_unauthorized"),
        (403, "synthetic-secret", "gmail_forbidden"),
        (403, scope, "gmail_forbidden"),
        (403, daily, "gmail_forbidden"),
        (403, limited, "gmail_rate_limited"),
        (403, global, "gmail_rate_limited"),
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
        // A deadline shorter than the first backoff leaves no room to retry.
        let started = std::time::Instant::now();
        assert_eq!(
            execute(
                &client,
                local(&target, get_request()),
                Duration::from_millis(500)
            )
            .await,
            Err(error)
        );
        assert!(started.elapsed() < Duration::from_millis(400));
        assert_eq!(target.requests.lock().unwrap().len(), 1);
    }
}

// A message mutation answers with a ticket, is sent from the account's queue
// with the real credential reader, token refresh and serializer, and settles
// as a notification; the in-process caller holds the line for the answer.
#[tokio::test]
async fn queued_mutation_settles_by_notification_and_in_process() {
    use crate::mail::tests::{account_fixture, isolated};
    use serde_json::json;
    if isolated() {
        return;
    }
    let fixture = account_fixture(json!({"version":1,"activeId":"queue@example.org",
        "accounts":[{"provider":"gmail","email":"queue@example.org"}]}));
    let credentials = crate::platform::private_fs::directories(
        &fixture.config,
        &[crate::platform::dirs::APP_DIRECTORY],
        true,
    )
    .unwrap()
    .unwrap();
    crate::platform::private_fs::atomic_replace(
        &credentials,
        "credentials.json",
        json!({"installed":{
        "client_id":"123-queue.apps.googleusercontent.com",
        "client_secret":"synthetic-client-secret"}})
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    let _credential =
        crate::credentials::tests::isolated_store(crate::credentials::tests::SingleCredential {
            key: crate::credentials::CredentialKey {
                provider: "gmail".into(),
                account_id: "queue@example.org".into(),
                kind: crate::credentials::CredentialKind::GoogleRefreshToken {
                    client_id: "123-queue.apps.googleusercontent.com".into(),
                },
            },
            secret: crate::credentials::Secret::new(b"synthetic-refresh-token".to_vec()).unwrap(),
        });
    let grant = json!({"access_token":"synthetic-access-token","expires_in":3600}).to_string();
    let peer = server_sequence(
        vec![
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{grant}",
                grant.len()
            )
            .into_bytes(),
            ok(),
        ],
        Duration::ZERO,
    )
    .await;
    let transport = client_builder().https_only(false).build().unwrap();
    let origin = peer.url.strip_suffix("/messages/abc").unwrap().to_owned();
    let session = crate::backend::Session::default();
    let mut events = session.gmail.subscribe();
    let params = json!({"accountId":"queue@example.org","id":"abc"});
    with_test_transport(transport, origin, async {
        let answer = session.dispatch("gmail.trash", &params).await.unwrap();
        assert_eq!(answer["queued"], true);
        let ticket = answer["ticket"].as_str().unwrap().to_owned();
        let settled = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("settlement announced")
            .unwrap();
        assert_eq!(settled["method"], "gmail.settled");
        assert_eq!(settled["params"]["accountId"], "queue@example.org");
        assert_eq!(settled["params"]["ticket"], ticket);
        assert_eq!(settled["params"]["ok"], true);
        assert_eq!(
            session.gmail.call_settled("gmail.trash", &params).await,
            Ok(json!({"ok":true}))
        );
        assert_eq!(
            session
                .gmail
                .call_settled(
                    "gmail.trash",
                    &json!({"accountId":"other@example.org","id":"abc"})
                )
                .await,
            Err("gmail_account_unknown")
        );
    })
    .await;
    let requests = peer.requests.lock().unwrap();
    assert_eq!(requests.len(), 3, "one refresh and two sends");
    assert!(requests[0].starts_with("POST /token "));
    assert!(requests[1].starts_with("POST /gmail/v1/users/me/messages/abc/trash "));
    assert!(requests[2].starts_with("POST /gmail/v1/users/me/messages/abc/trash "));
    assert!(
        requests[1..]
            .iter()
            .all(|r| r.contains("Bearer synthetic-access-token"))
    );
}

// A rate-limited request was rejected before it ran, so resending it — even
// a mutation — cannot duplicate anything. Google asks for exponential backoff
// starting at a second; the retry budget stays inside the request deadline.
#[tokio::test]
async fn rate_limited_requests_back_off_and_resend_within_the_deadline() {
    let client = client_builder().https_only(false).build().unwrap();
    let limited = b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 2\r\n\r\n{}".to_vec();
    let target =
        server_sequence(vec![limited.clone(), limited.clone(), ok()], Duration::ZERO).await;
    let request = prepare_write(
        reqwest::Method::POST,
        &["messages", "abc", "trash"],
        None,
        "synthetic-token",
    )
    .unwrap();
    let started = std::time::Instant::now();
    assert_eq!(
        execute_with_backoff(
            &client,
            local(&target, request),
            DEADLINE,
            Duration::from_millis(20)
        )
        .await,
        Ok(serde_json::json!({"ok":true}))
    );
    // 20ms, then 40ms: exponential, not a tight loop.
    assert!(started.elapsed() >= Duration::from_millis(60));
    let requests = target.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    assert!(
        requests
            .iter()
            .all(|r| r.starts_with("POST /messages/abc "))
    );

    // Persistent limiting gives up after a bounded number of attempts.
    let target = server(limited, Duration::ZERO).await;
    assert_eq!(
        execute_with_backoff(
            &client,
            local(&target, get_request()),
            DEADLINE,
            Duration::from_millis(1)
        )
        .await,
        Err("gmail_rate_limited")
    );
    assert_eq!(
        target.requests.lock().unwrap().len(),
        1 + RATE_LIMIT_RETRIES
    );
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
