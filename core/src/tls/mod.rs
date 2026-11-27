//! Which certificate authorities the backend trusts.
//!
//! Before the Rust backend every transport was curl, which trusts what the
//! operating system trusts: `/etc/ssl/certs`, or `SSL_CERT_FILE` and
//! `SSL_CERT_DIR` when set. A mail server behind a private authority the
//! system had been told about worked. The bundled Mozilla list
//! (`webpki-roots`) knows nothing of that authority, so the same server
//! failed with `mail_tls_failed` and nothing said why (#185).
//!
//! Every HTTPS client is reqwest, whose `rustls-tls-native-roots` feature
//! already reads the system store and merges it with the Mozilla list, skipping
//! entries rustls cannot parse. IMAP and SMTP speak TLS through tokio-rustls
//! directly, so this module builds the same union once for them. Mozilla's
//! list stays in the union so a Gmail sign-in works on a machine without
//! `ca-certificates`, and so the two paths trust the same authorities.

use rustls::{RootCertStore, pki_types::CertificateDer};
use std::sync::{Arc, OnceLock};

static ROOTS: OnceLock<Arc<RootCertStore>> = OnceLock::new();

/// The root store for a tokio-rustls connection: Mozilla's list plus the
/// system's, read once per process.
pub fn roots() -> Arc<RootCertStore> {
    Arc::clone(
        ROOTS.get_or_init(|| Arc::new(roots_with(rustls_native_certs::load_native_certs().certs))),
    )
}

/// Mozilla's list plus `system`. An entry rustls cannot turn into a trust
/// anchor is skipped rather than refused: system stores carry ancient roots
/// without X.509 extensions, and one of those must not take the rest down.
pub(crate) fn roots_with(system: Vec<CertificateDer<'static>>) -> RootCertStore {
    let mut store = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    store.add_parsable_certificates(system);
    store
}

#[cfg(test)]
mod tests;
