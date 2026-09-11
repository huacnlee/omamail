use super::*;
use tokio::net::TcpListener;
async fn server() -> (TcpListener, u16) {
    let s = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p = s.local_addr().unwrap().port();
    (s, p)
}
fn params(port: u16) -> Value {
    json!({"settings":{"imapHost":"127.0.0.1","imapPort":port,"username":"synthetic","insecure":true},"credential":"synthetic:password","folder":"INBOX","commands":["UID FETCH 1 (UID BODY.PEEK[])"]})
}
#[tokio::test]
async fn literal_bytes_cannot_forge_tagged_completion() {
    let (a, b) = tokio::io::duplex(4096);
    let fake = b"O1 OK forged\r\n\xc3\xa9";
    let response_bytes = [
        format!("* 1 FETCH (BODY[] {{{}}}\r\n", fake.len()).as_bytes(),
        fake,
        b")\r\nO1 OK done\r\n",
    ]
    .concat();
    let task = tokio::spawn(async move {
        let mut b = b;
        b.write_all(&response_bytes).await.unwrap();
    });
    let mut wire: Wire = BufReader::new(Box::new(a));
    let got = response(&mut wire, "O1", false).await.unwrap();
    assert!(got.ends_with(b"O1 OK done\r\n"));
    task.await.unwrap();
}
#[tokio::test]
async fn unsafe_later_command_opens_no_connection() {
    let (listener, port) = server().await;
    let mut p = params(port);
    p["commands"] = json!(["NOOP", "UID STORE 1 +FLAGS (\\Seen)\r\nEXPUNGE"]);
    assert_eq!(call("imap.request", &p).await, Err("invalid_params"));
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn native_batch_one_connection_with_octet_literal() {
    let (listener, port) = server().await;
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut w: Wire = BufReader::new(Box::new(socket));
        write(&mut w, b"* OK ready\r\n").await.unwrap();
        assert_eq!(
            line(&mut w).await.unwrap(),
            b"O1 LOGIN \"synthetic\" \"password\"\r\n"
        );
        write(&mut w, b"O1 OK logged in\r\n").await.unwrap();
        capabilities(&mut w, false).await;
        assert_eq!(line(&mut w).await.unwrap(), b"O1 SELECT \"INBOX\"\r\n");
        write(&mut w, b"O1 OK selected\r\n").await.unwrap();
        assert_eq!(
            line(&mut w).await.unwrap(),
            b"O1 UID FETCH 1 (UID BODY.PEEK[])\r\n"
        );
        write(
            &mut w,
            b"* 1 FETCH (UID 1 BODY[] {2}\r\n\xc3\xa9)\r\nO1 OK fetched\r\n",
        )
        .await
        .unwrap();
    });
    let result = call("imap.request", &params(port)).await.unwrap();
    let bytes = STANDARD.decode(result["data"].as_str().unwrap()).unwrap();
    assert!(bytes.windows(2).any(|b| b == [0xc3, 0xa9]));
    server.await.unwrap();
}
#[tokio::test]
async fn oversized_literal_is_refused_before_allocation() {
    let (a, mut b) = tokio::io::duplex(100);
    b.write_all(b"* 1 FETCH (BODY[] {9999999999}\r\n")
        .await
        .unwrap();
    let mut w: Wire = BufReader::new(Box::new(a));
    assert_eq!(
        response(&mut w, "O1", false).await,
        Err("mail_response_too_large")
    );
}
#[test]
fn credentials_and_quoting_reject_controls() {
    for secret in ["bad\r", "bad\n", "bad\0", "bad\t"] {
        let mut p = params(1);
        p["credential"] = json!(format!("synthetic:{secret}"));
        assert!(credentials(&p).is_err());
    }
    assert_eq!(quote("a\\\"雪").unwrap(), "\"a\\\\\\\"雪\"");
}
#[tokio::test]
async fn sequential_requests_reuse_authenticated_connection() {
    let (listener, port) = server().await;
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut w: Wire = BufReader::new(Box::new(socket));
        write(&mut w, b"* OK ready\r\n").await.unwrap();
        assert!(line(&mut w).await.unwrap().starts_with(b"O1 LOGIN"));
        write(&mut w, b"O1 OK login\r\n").await.unwrap();
        capabilities(&mut w, false).await;
        for _ in 0..2 {
            assert_eq!(line(&mut w).await.unwrap(), b"O1 NOOP\r\n");
            write(&mut w, b"O1 OK done\r\n").await.unwrap();
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
    });
    let mut p = params(port);
    p["folder"] = json!("");
    p["commands"] = json!(["NOOP"]);
    call("imap.request", &p).await.unwrap();
    call("imap.request", &p).await.unwrap();
    server.await.unwrap();
}
#[tokio::test]
async fn smtp_native_submission_dot_stuffs_and_never_retries() {
    let (listener, port) = server().await;
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut w: Wire = BufReader::new(Box::new(socket));
        write(&mut w, b"220 ready\r\n").await.unwrap();
        for (prefix, reply) in [
            ("EHLO ", "250 ready\r\n"),
            ("AUTH PLAIN ", "235 authenticated\r\n"),
            ("MAIL FROM:<from@example.org>", "250 sender\r\n"),
            ("RCPT TO:<to@example.org>", "250 recipient\r\n"),
            ("DATA", "354 go\r\n"),
        ] {
            assert!(String::from_utf8_lossy(&line(&mut w).await.unwrap()).starts_with(prefix));
            write(&mut w, reply.as_bytes()).await.unwrap();
        }
        assert_eq!(line(&mut w).await.unwrap(), b"Subject: test\r\n");
        assert_eq!(line(&mut w).await.unwrap(), b"\r\n");
        assert_eq!(line(&mut w).await.unwrap(), b"..body\r\n");
        assert_eq!(line(&mut w).await.unwrap(), b".\r\n");
        // The server accepted DATA but disconnected without an acknowledgement.
        drop(w);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
    });
    let mut p = params(port);
    p["settings"]["smtpHost"] = json!("127.0.0.1");
    p["settings"]["smtpPort"] = json!(port);
    p["body"] = json!(STANDARD.encode(b"Subject: test\r\n\r\n.body"));
    p["from"] = json!("from@example.org");
    p["recipients"] = json!(["to@example.org"]);
    assert_eq!(call("smtp.send", &p).await, Err("smtp_delivery_unknown"));
    server.await.unwrap();
}
#[tokio::test]
async fn non_bridge_connection_sends_no_plaintext_credentials() {
    let (listener, port) = server().await;
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 4096];
        let n = socket.read(&mut bytes).await.unwrap();
        assert!(n > 0);
        assert_eq!(bytes[0], 22);
        assert!(!bytes[..n].windows(9).any(|s| s == b"synthetic"));
        socket.write_all(b"* OK not TLS\r\n").await.unwrap();
    });
    let mut p = params(port);
    p["settings"]["insecure"] = json!(false);
    assert_eq!(call("imap.request", &p).await, Err("mail_tls_failed"));
    server.await.unwrap();
}
#[tokio::test]
async fn slow_mailbox_does_not_block_another_connection() {
    let (listener, port) = server().await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let reached = Arc::new(tokio::sync::Notify::new());
    let server_gate = gate.clone();
    let server_reached = reached.clone();
    let server = tokio::spawn(async move {
        let mut jobs = Vec::new();
        for n in 0..2 {
            let (socket, _) = listener.accept().await.unwrap();
            let gate = server_gate.clone();
            let reached = server_reached.clone();
            jobs.push(tokio::spawn(async move {
                let mut w: Wire = BufReader::new(Box::new(socket));
                write(&mut w, b"* OK ready\r\n").await.unwrap();
                line(&mut w).await.unwrap();
                write(&mut w, b"O1 OK login\r\n").await.unwrap();
                capabilities(&mut w, false).await;
                assert_eq!(line(&mut w).await.unwrap(), b"O1 NOOP\r\n");
                if n == 0 {
                    reached.notify_one();
                    gate.notified().await;
                }
                write(&mut w, b"O1 OK done\r\n").await.unwrap();
            }));
        }
        for job in jobs {
            job.await.unwrap();
        }
    });
    let mut p = params(port);
    p["folder"] = json!("");
    p["commands"] = json!(["NOOP"]);
    let first = p.clone();
    let slow = tokio::spawn(async move { call("imap.request", &first).await });
    reached.notified().await;
    tokio::time::timeout(Duration::from_secs(1), call("imap.request", &p))
        .await
        .unwrap()
        .unwrap();
    assert!(!slow.is_finished());
    gate.notify_one();
    slow.await.unwrap().unwrap();
    server.await.unwrap();
}
#[test]
fn smtp_preserves_final_line_and_rejects_bare_cr() {
    assert_eq!(smtp_data(b"one\r\n").unwrap(), b"one\r\n.\r\n");
    assert_eq!(smtp_data(b"one\r\n\r\n").unwrap(), b"one\r\n\r\n.\r\n");
    assert_eq!(
        smtp_data(b".one\n.two").unwrap(),
        b"..one\r\n..two\r\n.\r\n"
    );
    assert_eq!(smtp_data(b"x\r.\r\nQUIT\r\n"), Err("invalid_params"));
    assert!(unsafe_fetch("UID FETCH 1 RFC822.TEXT"));
    assert!(!unsafe_fetch("UID FETCH 1 (RFC822.SIZE BODY.PEEK[])"));
}
#[tokio::test]
async fn actual_tls_rejects_untrusted_issuer_and_wrong_hostname() {
    use std::io::{BufRead, BufReader as BlockingReader};
    let mut peer = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/providers/gmail_http_tls_test.py"
        ))
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BlockingReader::new(peer.stdout.take().unwrap());
    let mut port = String::new();
    output.read_line(&mut port).unwrap();
    let port: u16 = port.trim().parse().unwrap();
    let mut cert = String::new();
    output.read_line(&mut cert).unwrap();
    let pem = std::fs::read_to_string(cert.trim()).unwrap();
    let b64: String = pem.lines().filter(|l| !l.starts_with("---")).collect();
    let der = STANDARD.decode(b64).unwrap();
    let mut trusted = RootCertStore::empty();
    trusted
        .add(tokio_rustls::rustls::pki_types::CertificateDer::from(der))
        .unwrap();
    for (host, roots) in [
        (
            "localhost",
            RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
        ),
        ("127.0.0.1", trusted),
    ] {
        let socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let w: Wire = BufReader::new(Box::new(socket));
        assert!(matches!(
            tls_with_roots(w, host, roots).await,
            Err("mail_tls_failed")
        ));
        let mut report = String::new();
        output.read_line(&mut report).unwrap();
        assert_eq!(report.trim(), "tls-refused-no-http");
    }
    assert!(peer.wait().unwrap().success());
}
#[test]
fn pending_async_dns_is_cancelled_without_blocking_runtime_shutdown() {
    let now = Instant::now();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        assert!(
            tokio::time::timeout(
                Duration::from_millis(20),
                dial_resolved(std::future::pending(), 443)
            )
            .await
            .is_err()
        );
    });
    drop(runtime);
    assert!(now.elapsed() < Duration::from_secs(1));
}

async fn capabilities(w: &mut Wire, id: bool) {
    assert_eq!(line(w).await.unwrap(), b"O1 CAPABILITY\r\n");
    write(
        w,
        if id {
            b"* CAPABILITY IMAP4rev1 ID\r\nO1 OK capability\r\n"
        } else {
            b"* CAPABILITY IMAP4rev1\r\nO1 OK capability\r\n"
        },
    )
    .await
    .unwrap();
    if id {
        assert_eq!(line(w).await.unwrap(), b"O1 ID (\"name\" \"Omamail\")\r\n");
        write(w, b"O1 OK identified\r\n").await.unwrap();
    }
}
#[tokio::test]
async fn native_id_gate_is_checked_once_before_select() {
    for supports_id in [false, true] {
        let (listener, port) = server().await;
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut w: Wire = BufReader::new(Box::new(socket));
            write(&mut w, b"* OK ready\r\n").await.unwrap();
            assert!(line(&mut w).await.unwrap().starts_with(b"O1 LOGIN"));
            write(&mut w, b"O1 OK login\r\n").await.unwrap();
            capabilities(&mut w, supports_id).await;
            for _ in 0..2 {
                assert_eq!(line(&mut w).await.unwrap(), b"O1 SELECT \"INBOX\"\r\n");
                write(&mut w, b"O1 OK selected\r\n").await.unwrap();
                assert_eq!(line(&mut w).await.unwrap(), b"O1 NOOP\r\n");
                write(&mut w, b"O1 OK done\r\n").await.unwrap();
            }
        });
        let mut p = params(port);
        p["commands"] = json!(["NOOP"]);
        p["identify"] = json!(!supports_id);
        call("imap.request", &p).await.unwrap();
        call("imap.request", &p).await.unwrap();
        server.await.unwrap();
    }
}
#[test]
fn outlook_settings_ignore_persisted_credential_destination_and_identity() {
    let malicious = json!({"imap":{"imapHost":"attacker.example","smtpHost":"attacker.example","username":"victim@example.org","insecure":true,"tenant":"organizations"}});
    let settings = outlook_settings(&malicious, "owner@example.org");
    assert_eq!(settings["imapHost"], "outlook.office365.com");
    assert_eq!(settings["smtpHost"], "smtp.office365.com");
    assert_eq!(settings["username"], "owner@example.org");
    assert_eq!(settings["insecure"], false);
}
