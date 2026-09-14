//! Native credential storage. Only metadata is normalized; secret bytes never
//! enter child-process arguments or acquire a text/line-ending interpretation here.
use std::collections::BTreeMap;
use zeroize::Zeroizing;

#[cfg(all(feature = "integration-test-credentials", not(debug_assertions)))]
compile_error!("integration-test-credentials must never be enabled in a release build");

pub mod rpc;

#[cfg(target_os = "macos")]
mod keychain;
#[cfg(target_os = "linux")]
mod secret_service;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "macos")]
use keychain as platform;
#[cfg(target_os = "linux")]
use secret_service as platform;
#[cfg(target_os = "windows")]
use windows as platform;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CredentialKind {
    GoogleRefreshToken { client_id: String },
    OutlookRefreshToken { client_id: String },
    ImapPassword,
    JmapSecret,
    CalendarPassword,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialKey {
    pub provider: String,
    /// Stable mailbox id, or the stable CalDAV source id for CalendarPassword.
    pub account_id: String,
    pub kind: CredentialKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Missing,
    Unavailable,
    InvalidKey,
    InvalidSecret,
    TooLarge,
    Ambiguous,
}

/// Deliberately has no Debug/Display implementation. Owned buffers are erased
/// on drop, including when a native call fails. Borrowing callers own their copy.
pub struct Secret(Zeroizing<Vec<u8>>);
impl Secret {
    pub fn new(bytes: Vec<u8>) -> Result<Self, Error> {
        let bytes = Zeroizing::new(bytes);
        validate_secret(&bytes)?;
        Ok(Self(bytes))
    }
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
    pub fn text(&self) -> Result<&str, Error> {
        std::str::from_utf8(&self.0).map_err(|_| Error::InvalidSecret)
    }
}

/// Empty secrets and NUL are refused; all other bytes are opaque. Windows
/// additionally enforces Credential Manager's native 2560-byte blob limit.
pub trait CredentialStore: Send + Sync {
    fn get(&self, key: &CredentialKey) -> Result<Secret, Error>;
    fn put(&self, key: &CredentialKey, secret: &[u8]) -> Result<(), Error>;
    /// Returns Missing if there was no matching item; consumers may make clear idempotent.
    fn delete(&self, key: &CredentialKey) -> Result<(), Error>;
}

pub struct NativeStore;
impl CredentialStore for NativeStore {
    fn get(&self, key: &CredentialKey) -> Result<Secret, Error> {
        key.attributes()?;
        #[cfg(feature = "integration-test-credentials")]
        if let Some(result) = fixture_secret() {
            return result;
        }
        #[cfg(test)]
        if let Some(store) = tests::override_store() {
            return store.get(key);
        }
        platform::get(key)
    }
    fn put(&self, key: &CredentialKey, secret: &[u8]) -> Result<(), Error> {
        key.attributes()?;
        validate_secret(secret)?;
        #[cfg(test)]
        if let Some(store) = tests::override_store() {
            return store.put(key, secret);
        }
        let temporary = Zeroizing::new(secret.to_vec());
        platform::put(key, &temporary)
    }
    fn delete(&self, key: &CredentialKey) -> Result<(), Error> {
        key.attributes()?;
        #[cfg(test)]
        if let Some(store) = tests::override_store() {
            return store.delete(key);
        }
        platform::delete(key)
    }
}

#[cfg(feature = "integration-test-credentials")]
fn fixture_secret() -> Option<Result<Secret, Error>> {
    let path = std::env::var_os("OMAMAIL_INTEGRATION_CREDENTIAL_FILE")?;
    if let Some(trace) = std::env::var_os("OMAMAIL_INTEGRATION_CREDENTIAL_TRACE") {
        if std::fs::write(trace, b"get\n").is_err() {
            return Some(Err(Error::Unavailable));
        }
    }
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return Some(Err(Error::Unavailable)),
    };
    Some(match bytes.as_slice() {
        b"missing\n" => Err(Error::Missing),
        b"synthetic\n" => Secret::new(b"synthetic".to_vec()),
        _ => Err(Error::Unavailable),
    })
}

fn validate_secret(bytes: &[u8]) -> Result<(), Error> {
    if bytes.is_empty() || bytes.contains(&0) {
        return Err(Error::InvalidSecret);
    }
    if bytes.len() > 65536 {
        return Err(Error::TooLarge);
    }
    Ok(())
}

impl CredentialKey {
    /// Keep Linux's historical libsecret attributes: a provider's credential
    /// kind is its namespace, OAuth also binds the client and current grant.
    fn attributes(&self) -> Result<BTreeMap<String, String>, Error> {
        fn metadata(value: &str) -> Result<(), Error> {
            if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
                return Err(Error::InvalidKey);
            }
            Ok(())
        }
        metadata(&self.account_id)?;
        let (provider, kind) = match self.kind {
            CredentialKind::GoogleRefreshToken { .. } => ("gmail", "refresh-token"),
            CredentialKind::OutlookRefreshToken { .. } => ("outlook", "outlook-refresh-token"),
            CredentialKind::ImapPassword => ("imap", "imap-password"),
            CredentialKind::JmapSecret => ("jmap", "jmap-secret"),
            CredentialKind::CalendarPassword => ("caldav", "calendar-password"),
        };
        if self.provider != provider {
            return Err(Error::InvalidKey);
        }
        let mut attrs = BTreeMap::from([
            ("service".into(), "omamail".into()),
            ("kind".into(), kind.into()),
        ]);
        if provider == "caldav" {
            attrs.insert("source".into(), self.account_id.clone());
        } else {
            if self.account_id.chars().any(char::is_whitespace)
                || (provider != "gmail" && !self.account_id.starts_with(&format!("{provider}:")))
                || (provider != "gmail" && !self.account_id.contains('@'))
                || (provider == "gmail"
                    && self.account_id != "default"
                    && (!self.account_id.contains('@') || self.account_id.contains(':')))
            {
                return Err(Error::InvalidKey);
            }
            attrs.insert("account".into(), self.account_id.to_lowercase());
        }
        if let CredentialKind::GoogleRefreshToken { client_id }
        | CredentialKind::OutlookRefreshToken { client_id } = &self.kind
        {
            metadata(client_id)?;
            attrs.insert("client-id".into(), client_id.clone());
        }
        if matches!(self.kind, CredentialKind::GoogleRefreshToken { .. }) {
            attrs.insert("grant".into(), "calendar-events-v1".into());
        }
        Ok(attrs)
    }

    /// Length-delimited fields prevent delimiter collisions. Hashing also keeps
    /// Windows target names below its limit without putting secrets in metadata.
    #[cfg(any(target_os = "macos", target_os = "windows", test))]
    fn native_id(&self) -> Result<String, Error> {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        for (name, value) in self.attributes()? {
            for field in [name, value] {
                hash.update((field.len() as u64).to_be_bytes());
                hash.update(field.as_bytes());
            }
        }
        Ok(format!("omamail:v1:{:x}", hash.finalize()))
    }
}

/// Native APIs can prompt/block, so async consumers use a blocking worker.
pub async fn get(key: CredentialKey) -> Result<Secret, Error> {
    tokio::task::spawn_blocking(move || NativeStore.get(&key))
        .await
        .map_err(|_| Error::Unavailable)?
}
pub async fn put(key: CredentialKey, secret: Secret) -> Result<(), Error> {
    tokio::task::spawn_blocking(move || NativeStore.put(&key, secret.as_slice()))
        .await
        .map_err(|_| Error::Unavailable)?
}
pub async fn delete(key: CredentialKey) -> Result<(), Error> {
    tokio::task::spawn_blocking(move || NativeStore.delete(&key))
        .await
        .map_err(|_| Error::Unavailable)?
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
    use super::*;
    pub fn get(_: &CredentialKey) -> Result<Secret, Error> {
        Err(Error::Unavailable)
    }
    pub fn put(_: &CredentialKey, _: &[u8]) -> Result<(), Error> {
        Err(Error::Unavailable)
    }
    pub fn delete(_: &CredentialKey) -> Result<(), Error> {
        Err(Error::Unavailable)
    }
}

#[cfg(test)]
pub(crate) mod tests;
