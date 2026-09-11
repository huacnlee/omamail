use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[test]
fn refuses_nonpublic_and_transition_addresses() {
    for ip in [
        "127.0.0.1",
        "0.0.0.0",
        "10.1.2.3",
        "100.64.0.1",
        "169.254.169.254",
        "172.31.1.1",
        "192.168.1.1",
        "192.0.0.9",
        "192.88.99.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "240.0.0.1",
        "::",
        "::1",
        "::ffff:8.8.8.8",
        "64:ff9b::808:808",
        "2001::1",
        "2001:db8::1",
        "2002:808:808::1",
        "fc00::1",
        "fe80::1",
        "fec0::1",
        "ff02::1",
        "3fff::1",
    ] {
        assert!(!is_public(ip.parse().unwrap()), "{ip}");
    }
    for ip in [
        "8.8.8.8",
        "1.1.1.1",
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
    ] {
        assert!(is_public(ip.parse().unwrap()), "{ip}");
    }
    assert!(checked_addresses(vec![]).is_err());
    assert!(
        checked_addresses(vec![
            "8.8.8.8".parse().unwrap(),
            "127.0.0.1".parse().unwrap()
        ])
        .is_err()
    );
    assert_eq!(
        checked_addresses(vec!["8.8.8.8".parse().unwrap()]).unwrap()[0],
        "8.8.8.8:0".parse().unwrap()
    );
}

#[test]
fn raw_url_bytes_are_validated_before_normalization() {
    for url in [
        "https://example.org/\n",
        "\thttps://example.org/",
        "https://example.org/\r\n",
        "https://example.org/\0",
        "https://example.org\\@127.0.0.1/",
        "https://user:secret@example.org/",
        "file:///tmp/mail",
        "https://localhost/",
        "https://127.1/",
        "https://2130706433/",
        "https://0x7f000001/",
        "https://[::ffff:127.0.0.1]/",
        "http://192.168.1.1/",
        "https://example.org:0/",
        "https://example.org./",
    ] {
        assert!(parse_url(url, false).is_err(), "{url:?}");
    }
    assert!(parse_url("http://example.org/", true).is_err());
    assert!(parse_url("https://example.org/日本?a=%22%5C&b=hello", true).is_ok());
}

async fn server(response: Vec<u8>) -> (SocketAddr, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let job = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut block = [0; 1024];
        loop {
            let n = stream.read(&mut block).await.unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&block[..n]);
            if request.windows(4).any(|v| v == b"\r\n\r\n") {
                let is_post = request.starts_with(b"POST ");
                if !is_post || request.ends_with(b"List-Unsubscribe=One-Click") {
                    break;
                }
            }
        }
        let _ = stream.write_all(&response).await;
        String::from_utf8(request).unwrap()
    });
    (address, job)
}

// This private test client pins a synthetic public name to the local harness.
// Production has no endpoint override, certificate bypass or private-IP switch.
fn test_client(address: SocketAddr) -> Client {
    client_builder()
        .resolve("sender.example", address)
        .build()
        .unwrap()
}

#[tokio::test]
async fn forbidden_literal_never_connects() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    assert!(fetch(&url, 100).await.is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn connection_is_pinned_and_original_host_is_preserved() {
    let (address, server) = server(
        b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 8\r\n\r\n\x89PNG\r\n\x1a\n"
            .to_vec(),
    )
    .await;
    let response = execute(
        &test_client(address),
        parse_url("http://sender.example/image", false).unwrap(),
        Method::GET,
        MAX_IMAGE,
        DEADLINE,
    )
    .await
    .unwrap();
    assert_eq!(
        image_data(response).unwrap(),
        "data:image/png;base64,iVBORw0KGgo="
    );
    let request = server.await.unwrap();
    assert!(request.to_lowercase().contains("host: sender.example\r\n"));
    assert!(!request.to_lowercase().contains("authorization:"));
}

#[tokio::test]
async fn post_is_fixed_and_redirect_destination_receives_nothing() {
    let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let reply = format!(
        "HTTP/1.1 302 Found\r\nLocation: http://{}/landed\r\nContent-Length: 0\r\n\r\n",
        destination.local_addr().unwrap()
    );
    let (address, server) = server(reply.into_bytes()).await;
    let response = execute(
        &test_client(address),
        parse_url("http://sender.example/unsubscribe", false).unwrap(),
        Method::POST,
        0,
        DEADLINE,
    )
    .await
    .unwrap();
    assert_eq!(response.status, 302);
    let request = server.await.unwrap();
    assert!(request.ends_with("\r\n\r\nList-Unsubscribe=One-Click"));
    assert!(
        request
            .to_lowercase()
            .contains("content-type: application/x-www-form-urlencoded\r\n")
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), destination.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn streamed_size_encoding_and_image_type_are_bounded() {
    for reply in [
        "HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n123456789\r\n0\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n",
    ] {
        let (address, server) = server(reply.as_bytes().to_vec()).await;
        assert!(
            execute(
                &test_client(address),
                parse_url("http://sender.example/", false).unwrap(),
                Method::GET,
                8,
                DEADLINE
            )
            .await
            .is_err()
        );
        server.await.unwrap();
    }
    assert!(
        image_data(Response {
            status: 200,
            content_type: "image/png".into(),
            body: b"<svg><image href='http://127.0.0.1/'/></svg>".to_vec()
        })
        .is_err()
    );
    assert!(
        image_data(Response {
            status: 200,
            content_type: "text/html".into(),
            body: b"\x89PNG\r\n\x1a\n".to_vec()
        })
        .is_err()
    );
}

#[tokio::test]
async fn deadline_includes_waiting_for_headers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = test_client(listener.local_addr().unwrap());
    let blocked = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let result = execute(
        &client,
        parse_url("http://sender.example/", false).unwrap(),
        Method::GET,
        8,
        Duration::from_millis(50),
    )
    .await;
    assert_eq!(result.err(), Some("public_http_timeout"));
    blocked.abort();
}

#[tokio::test]
async fn pending_dns_is_inside_the_whole_request_deadline() {
    struct Pending;
    impl Resolve for Pending {
        fn resolve(&self, _: Name) -> Resolving {
            Box::pin(std::future::pending())
        }
    }
    let client = client_builder()
        .dns_resolver(Arc::new(Pending))
        .build()
        .unwrap();
    let result = execute(
        &client,
        parse_url("http://sender.example/", false).unwrap(),
        Method::GET,
        8,
        Duration::from_millis(50),
    )
    .await;
    assert_eq!(result.err(), Some("public_http_timeout"));
}

#[tokio::test]
async fn tls_verifies_issuer_and_original_hostname_before_http() {
    use std::io::{BufRead, BufReader};
    let mut peer = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/providers/gmail_http_tls_test.py"
        ))
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(peer.stdout.take().unwrap());
    let mut port = String::new();
    output.read_line(&mut port).unwrap();
    let address: SocketAddr = format!("127.0.0.1:{}", port.trim()).parse().unwrap();
    let mut certificate = String::new();
    output.read_line(&mut certificate).unwrap();
    let certificate =
        reqwest::Certificate::from_pem(&std::fs::read(certificate.trim()).unwrap()).unwrap();
    let trusted = client_builder()
        .resolve("sender.example", address)
        .add_root_certificate(certificate)
        .build()
        .unwrap();
    // Both requests connect to the pinned address, retaining sender.example as
    // the TLS name. Trusting the issuer alone must not trust its localhost name.
    for client in [test_client(address), trusted] {
        let result = execute(
            &client,
            parse_url("https://sender.example/unsubscribe", true).unwrap(),
            Method::POST,
            0,
            DEADLINE,
        )
        .await;
        assert!(result.is_err());
        let mut report = String::new();
        output.read_line(&mut report).unwrap();
        assert_eq!(report.trim(), "tls-refused-no-http");
    }
    assert!(peer.wait().unwrap().success());
}
