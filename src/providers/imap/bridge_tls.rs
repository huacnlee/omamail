//! The explicit loopback self-signed-certificate exception still requires TLS.
use super::*;
use tokio_rustls::rustls::{self, client::danger, pki_types};

#[derive(Debug)]
struct LoopbackCertificate;
impl danger::ServerCertVerifier for LoopbackCertificate {
    fn verify_server_cert(
        &self,
        _: &pki_types::CertificateDer<'_>,
        _: &[pki_types::CertificateDer<'_>],
        _: &pki_types::ServerName<'_>,
        _: &[u8],
        _: pki_types::UnixTime,
    ) -> std::result::Result<danger::ServerCertVerified, rustls::Error> {
        Ok(danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub(super) async fn upgrade(w: Wire, host: &str) -> Result<Wire> {
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| "mail_tls_failed")?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(LoopbackCertificate))
            .with_no_client_auth();
    tls_with_config(w, host, config).await
}
