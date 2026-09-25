use super::*;
use tokio::net::TcpListener;
#[tokio::test]
async fn proton_custom_port_requires_starttls_before_credentials() {
    use std::io::{BufRead, BufReader as BlockingReader};
    let mut peer = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/providers/imap/starttls_test.py"
        ))
        .args(["imap", "local", "starttls"])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BlockingReader::new(peer.stdout.take().unwrap());
    let mut port = String::new();
    output.read_line(&mut port).unwrap();
    let settings = json!({"imapHost":"127.0.0.1", "imapPort":port.trim().parse::<u16>().unwrap(), "insecure":true});
    let mut wire = connect(&settings, false).await.unwrap();
    write(&mut wire, b"synthetic-credential\r\n").await.unwrap();
    let mut report = String::new();
    output.read_line(&mut report).unwrap();
    let success = peer.wait().unwrap().success();
    assert_eq!(report.trim(), "encrypted-credentials");
    assert!(success);
}
#[tokio::test]
async fn bridge_starttls_encrypts_credentials_and_never_downgrades() {
    use std::io::{BufRead, BufReader as BlockingReader};
    for smtp in [false, true] {
        let bridge_port = if smtp { 1025 } else { 1143 };
        let standard_port = if smtp { 587 } else { 143 };
        let implicit_port = if smtp { 465 } else { 993 };
        for (host, logical_port, insecure, implicit, mode) in [
            ("127.0.0.1", bridge_port, true, false, "local"),
            ("localhost", bridge_port, true, false, "local"),
            ("::1", bridge_port, true, false, "local"),
            ("127.0.0.1", 23456, true, false, "local"),
            ("127.0.0.1", standard_port, true, false, "local"),
            ("127.0.0.1", implicit_port, true, true, "local"),
            ("127.0.0.1", bridge_port, false, false, "strict"),
            ("localhost", 23456, false, false, "strict"),
            ("127.0.0.1", implicit_port, false, true, "strict"),
            ("remote.example", bridge_port, true, true, "strict"),
            ("remote.example", 23456, true, true, "strict"),
            ("remote.example", standard_port, true, false, "strict"),
            ("127.0.0.1", bridge_port, true, false, "refuse"),
            ("127.0.0.1", bridge_port, true, false, "malformed"),
            ("127.0.0.1", bridge_port, true, false, "buffered"),
        ] {
            let mut peer = std::process::Command::new("python3")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/src/providers/imap/starttls_test.py"
                ))
                .arg(if smtp { "smtp" } else { "imap" })
                .arg(mode)
                .arg(if implicit { "implicit" } else { "starttls" })
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let mut output = BlockingReader::new(peer.stdout.take().unwrap());
            let mut port = String::new();
            output.read_line(&mut port).unwrap();
            let port = port.trim().parse::<u16>().unwrap();
            let settings = json!({"imapHost":"127.0.0.1", "imapPort":1143,
                "smtpHost":host, "smtpPort":logical_port, "insecure":insecure});
            let mut settings = settings;
            if !smtp {
                settings["imapHost"] = json!(host);
                settings["imapPort"] = json!(logical_port);
            }
            // Only the socket destination is substituted. All host/port/trust
            // decisions go through the production connection selection path.
            let result = connect_with_dial(&settings, smtp, |dial_host, dial_port| async move {
                assert_eq!(
                    dial_host,
                    if host == "localhost" {
                        "127.0.0.1"
                    } else {
                        host
                    }
                );
                assert_eq!(dial_port, logical_port);
                TcpStream::connect(("127.0.0.1", port))
                    .await
                    .map_err(|_| "mail_network_failed")
            })
            .await;
            // Keep the TLS socket alive until the peer has read and reported
            // the credentials. Closing it here can abort the peer's handshake
            // on Windows while TLS 1.3 session tickets are still in flight.
            let mut secure = None;
            if mode == "local" {
                let mut wire = result.unwrap();
                write(&mut wire, b"synthetic-credential\r\n").await.unwrap();
                secure = Some(wire);
            } else {
                assert!(result.is_err());
            }
            let mut report = String::new();
            output.read_line(&mut report).unwrap();
            assert_eq!(
                report.trim(),
                if mode == "local" {
                    "encrypted-credentials"
                } else {
                    "no-credentials"
                },
                "smtp={smtp} host={host} port={logical_port} mode={mode}"
            );
            assert!(peer.wait().unwrap().success());
            drop(secure);
        }
    }
}
pub(super) async fn server() -> (TcpListener, u16) {
    let s = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p = s.local_addr().unwrap().port();
    (s, p)
}
#[tokio::test]
async fn bridge_tls_refuses_buffered_plaintext_before_writing() {
    let (client, mut peer) = tokio::io::duplex(256);
    peer.write_all(b"plaintext after STARTTLS\r\n")
        .await
        .unwrap();
    let mut w: Wire = BufReader::new(Box::new(client));
    assert!(!w.fill_buf().await.unwrap().is_empty());
    assert!(matches!(
        bridge_tls::upgrade(w, "127.0.0.1").await,
        Err("mail_tls_failed")
    ));
    let mut received = Vec::new();
    peer.read_to_end(&mut received).await.unwrap();
    assert!(received.is_empty());
}
pub(super) fn params(port: u16) -> Value {
    json!({"settings":{"imapHost":"127.0.0.1","imapPort":port,"username":"synthetic","insecure":true,"testPlaintext":true},"credential":"synthetic:password","folder":"INBOX","commands":["UID FETCH 1 (UID BODY.PEEK[])"]})
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
async fn only_a_tagged_refusal_is_an_auth_failure() {
    for (reply, expected) in [
        (
            &b"O1 NO [AUTHENTICATIONFAILED] bad\r\n"[..],
            "mail_auth_failed",
        ),
        (&b"* BYE going away\r\n"[..], "mail_connection_closed"),
        (&b""[..], "mail_connection_closed"),
    ] {
        let (a, mut b) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            let mut buf = [0u8; 256];
            let n = b.read(&mut buf).await.unwrap();
            assert!(buf[..n].starts_with(b"O1 LOGIN"));
            b.write_all(reply).await.unwrap();
            drop(b);
        });
        let mut w: Wire = BufReader::new(Box::new(a));
        assert_eq!(login(&mut w, &params(1)).await, Err(expected));
        server.await.unwrap();
    }
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
    p["settings"]["imapHost"] = json!("remote.example");
    let result = connect_with_dial(&p["settings"], false, |host, selected_port| async move {
        assert_eq!(host, "remote.example");
        assert_eq!(selected_port, port);
        TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(|_| "mail_network_failed")
    })
    .await;
    assert!(matches!(result, Err("mail_tls_failed")));
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
        .arg("3")
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
        ("127.0.0.1", trusted.clone()),
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
    // A private authority the store was built from — the system's, in
    // production — is honoured for the host it issued for (#185).
    let socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let w: Wire = BufReader::new(Box::new(socket));
    let mut secure = tls_with_roots(w, "localhost", trusted).await.unwrap();
    // close_notify, so the peer reads a clean end rather than a reset.
    secure.shutdown().await.unwrap();
    let mut report = String::new();
    output.read_line(&mut report).unwrap();
    assert_eq!(report.trim(), "empty");
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
