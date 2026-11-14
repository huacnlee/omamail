//! Regressions for the peer observers the TLS tests rely on.

use crate::test_support::{
    peers::{HttpTlsPeer, ScriptedHttpsPeer},
    tls,
};
use serde_json::json;
use std::time::Duration;

// A handshake the client aborts is still an accepted connection. The calendar
// tests depend on that count, so a warm-up connection must make `requests`
// refuse to certify the run.
#[tokio::test]
async fn a_rejected_handshake_counts_as_a_connection() {
    let peer = ScriptedHttpsPeer::start().await;
    let socket = tokio::net::TcpStream::connect(("127.0.0.1", peer.port))
        .await
        .unwrap();
    drop(socket);
    peer.responses(json!([{"status": 200, "body": "ok"}]));
    let address: std::net::SocketAddr = format!("127.0.0.1:{}", peer.port).parse().unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .resolve("caldav.icloud.com", address)
        .add_root_certificate(
            reqwest::Certificate::from_pem(&std::fs::read(tls::testdata("discovery.pem")).unwrap())
                .unwrap(),
        )
        .build()
        .unwrap();
    client
        .get(format!("https://caldav.icloud.com:{}/", peer.port))
        .send()
        .await
        .unwrap();
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| peer.requests()));
    assert!(
        refused.is_err(),
        "a connection without a request must fail the count assertion"
    );
}

// No client at all must not look like a client that refused the certificate.
#[tokio::test]
async fn an_absent_client_is_not_reported_as_a_refusal() {
    let mut peer = HttpTlsPeer::start_with_deadlines(
        1,
        Duration::from_millis(100),
        Duration::from_millis(200),
    )
    .await;
    assert_eq!(peer.report().await, "no-connection");
}

// A client that connects and stalls before TLS must not look like a refusal.
#[tokio::test]
async fn a_stalled_handshake_is_not_reported_as_a_refusal() {
    let mut peer =
        HttpTlsPeer::start_with_deadlines(1, Duration::from_secs(1), Duration::from_millis(100))
            .await;
    let _socket = tokio::net::TcpStream::connect(("127.0.0.1", peer.port))
        .await
        .unwrap();
    assert_eq!(peer.report().await, "handshake-timeout");
}
