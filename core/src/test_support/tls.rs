//! TLS server pieces for the in-process test peers.

use rustls::{
    ServerConfig,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
};
use std::{path::PathBuf, sync::Arc};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::{TlsAcceptor, server::TlsStream};

/// The shared synthetic fixtures: a test CA, a `localhost` leaf, and a
/// discovery leaf naming the hosts the calendar tests use.
pub(crate) fn testdata(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/providers/testdata/tls")
        .join(name)
}

/// The PEM-encoded test CA, ready for `reqwest::Certificate::from_pem`.
pub(crate) fn ca_pem() -> Vec<u8> {
    std::fs::read(testdata("ca.pem")).unwrap()
}

fn pem_der(pem: &str, label: &str) -> Vec<u8> {
    use base64::Engine;
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let body: String = pem
        .lines()
        .skip_while(|line| *line != begin)
        .skip(1)
        .take_while(|line| *line != end)
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .unwrap()
}

/// A server for the `localhost` leaf in `testdata`.
pub(crate) fn localhost_config() -> Arc<ServerConfig> {
    config("server.pem", "server-key.pem")
}

/// A server for the discovery leaf, whose names the calendar tests dial.
pub(crate) fn discovery_config() -> Arc<ServerConfig> {
    config("discovery.pem", "discovery-key.pem")
}

fn config(certificate: &str, key: &str) -> Arc<ServerConfig> {
    let certificate = CertificateDer::from(pem_der(
        &std::fs::read_to_string(testdata(certificate)).unwrap(),
        "CERTIFICATE",
    ));
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pem_der(
        &std::fs::read_to_string(testdata(key)).unwrap(),
        "PRIVATE KEY",
    )));
    Arc::new(
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![certificate], key)
            .unwrap(),
    )
}

/// A loopback listener and the port it holds.
pub(crate) async fn bind() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

/// Accept one connection and finish the TLS handshake.
///
/// A client that refuses the certificate aborts it, so an error here is an
/// expected outcome and not a fault of the peer.
pub(crate) async fn accept(
    acceptor: &TlsAcceptor,
    listener: &TcpListener,
) -> std::io::Result<TlsStream<TcpStream>> {
    let (stream, _) = listener.accept().await?;
    acceptor.accept(stream).await
}
