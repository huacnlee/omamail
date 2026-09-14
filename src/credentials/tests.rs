use super::*;

fn key(provider: &str, account: &str, kind: CredentialKind) -> CredentialKey {
    CredentialKey {
        provider: provider.into(),
        account_id: account.into(),
        kind,
    }
}

#[test]
fn credentials_reject_invalid_metadata_before_native_access() {
    for bad in ["", "a\n", "a\r", "a\r\n", "a\0", "a\t"] {
        let key = key("imap", bad, CredentialKind::ImapPassword);
        assert!(matches!(NativeStore.get(&key), Err(Error::InvalidKey)));
        assert_eq!(NativeStore.put(&key, b"synthetic"), Err(Error::InvalidKey));
        assert_eq!(NativeStore.delete(&key), Err(Error::InvalidKey));
    }
    for bad in ["", "client\n", "client\r", "client\r\n", "client\0"] {
        let key = key(
            "gmail",
            "one@example.org",
            CredentialKind::GoogleRefreshToken {
                client_id: bad.into(),
            },
        );
        assert!(matches!(NativeStore.get(&key), Err(Error::InvalidKey)));
        assert_eq!(NativeStore.put(&key, b"synthetic"), Err(Error::InvalidKey));
        assert_eq!(NativeStore.delete(&key), Err(Error::InvalidKey));
    }
    let wrong_provider = key("jmap", "imap:one@example.org", CredentialKind::ImapPassword);
    assert!(matches!(
        NativeStore.get(&wrong_provider),
        Err(Error::InvalidKey)
    ));
}

#[test]
fn credentials_reject_nul_before_native_access() {
    let key = key("imap", "imap:one@example.org", CredentialKind::ImapPassword);
    for secret in [b"".as_slice(), b"a\0", b"\0a", b"a\0b"] {
        assert_eq!(NativeStore.put(&key, secret), Err(Error::InvalidSecret));
    }
}

#[test]
fn credentials_preserve_linux_scope_and_native_key_is_unambiguous() {
    let key = key(
        "gmail",
        "ONE@example.org",
        CredentialKind::GoogleRefreshToken {
            client_id: "client:one".into(),
        },
    );
    let attributes = key.attributes().unwrap();
    assert_eq!(attributes.get("account").unwrap(), "one@example.org");
    assert_eq!(attributes.get("client-id").unwrap(), "client:one");
    assert_eq!(attributes.get("grant").unwrap(), "calendar-events-v1");
    assert_eq!(attributes.get("kind").unwrap(), "refresh-token");
    let other = CredentialKey {
        provider: "gmail".into(),
        account_id: "one@example.org".into(),
        kind: CredentialKind::GoogleRefreshToken {
            client_id: "client:two".into(),
        },
    };
    assert_ne!(key.native_id().unwrap(), other.native_id().unwrap());
}

/// Explicit native runner gate. Never silently succeeds when the store is locked,
/// absent, or unavailable. Unique synthetic entries are removed by Drop even on panic.
#[test]
#[ignore = "requires an unlocked native credential store; run explicitly on each native runner"]
fn credentials_native_contract() {
    let id = format!(
        "omamail-native-{}-{}@example.invalid",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let keys = vec![
        key("imap", &format!("imap:{id}"), CredentialKind::ImapPassword),
        key("jmap", &format!("jmap:{id}"), CredentialKind::JmapSecret),
        key(
            "imap",
            &format!("imap:other-{id}"),
            CredentialKind::ImapPassword,
        ),
        key(
            "gmail",
            &id,
            CredentialKind::GoogleRefreshToken {
                client_id: "synthetic-client-one".into(),
            },
        ),
        key(
            "gmail",
            &id,
            CredentialKind::GoogleRefreshToken {
                client_id: "synthetic-client-two".into(),
            },
        ),
        key(
            "outlook",
            &format!("outlook:{id}"),
            CredentialKind::OutlookRefreshToken {
                client_id: "synthetic-client-one".into(),
            },
        ),
        key(
            "caldav",
            &format!("source-{id}"),
            CredentialKind::CalendarPassword,
        ),
    ];
    struct Cleanup(Vec<CredentialKey>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for key in &self.0 {
                let _ = NativeStore.delete(key);
            }
        }
    }
    let cleanup = Cleanup(keys);
    for key in &cleanup.0 {
        assert!(matches!(NativeStore.get(key), Err(Error::Missing)));
        assert_eq!(NativeStore.delete(key), Err(Error::Missing));
    }
    let samples: &[&[u8]] = &[
        b"synthetic'\\\"",
        "synthetic-测试-متن".as_bytes(),
        b"cr\r",
        b"lf\n",
        b"crlf\r\n",
        b"tab\t",
        b"control\x01",
        b"opaque\xff",
    ];
    for (i, key) in cleanup.0.iter().enumerate() {
        NativeStore
            .put(key, format!("synthetic-{i}").as_bytes())
            .unwrap();
    }
    for (i, key) in cleanup.0.iter().enumerate() {
        assert!(NativeStore.get(key).unwrap().as_slice() == format!("synthetic-{i}").as_bytes());
    }
    for (index, sample) in samples.iter().enumerate() {
        NativeStore.put(&cleanup.0[0], sample).unwrap();
        assert!(
            NativeStore.get(&cleanup.0[0]).unwrap().as_slice() == *sample,
            "native store changed opaque bytes in sample {index}"
        );
    }
    let mut normalized = cleanup.0[0].clone();
    normalized.account_id = format!("imap:{}", id.to_uppercase());
    assert!(NativeStore.get(&normalized).unwrap().as_slice() == b"opaque\xff");
    assert_eq!(
        NativeStore.put(&cleanup.0[0], b"forbidden\0"),
        Err(Error::InvalidSecret)
    );
    assert!(NativeStore.get(&cleanup.0[0]).unwrap().as_slice() == b"opaque\xff");
    NativeStore.delete(&cleanup.0[0]).unwrap();
    assert!(matches!(
        NativeStore.get(&cleanup.0[0]),
        Err(Error::Missing)
    ));
    assert!(NativeStore.get(&cleanup.0[1]).unwrap().as_slice() == b"synthetic-1");
    for key in &cleanup.0[1..] {
        NativeStore.delete(key).unwrap();
    }
    for key in &cleanup.0 {
        assert!(matches!(NativeStore.get(key), Err(Error::Missing)));
    }
}

// A process-local native-store substitute for existing isolated dispatcher
// fixtures. It cannot be enabled by production builds, settings or environment.
static STORE: std::sync::Mutex<Option<std::sync::Arc<dyn CredentialStore>>> =
    std::sync::Mutex::new(None);
pub(super) fn override_store() -> Option<std::sync::Arc<dyn CredentialStore>> {
    STORE.lock().unwrap().clone()
}
pub(crate) struct StoreOverride;
impl Drop for StoreOverride {
    fn drop(&mut self) {
        *STORE.lock().unwrap() = None;
    }
}
pub(crate) fn isolated_store(store: impl CredentialStore + 'static) -> StoreOverride {
    assert!(
        std::env::var_os("OMAMAIL_ACTION_TEST_CHILD").is_some(),
        "fixture requires process isolation"
    );
    let mut slot = STORE.lock().unwrap();
    assert!(slot.is_none());
    *slot = Some(std::sync::Arc::new(store));
    StoreOverride
}

pub(crate) struct SingleCredential {
    pub key: CredentialKey,
    pub secret: Secret,
}
impl CredentialStore for SingleCredential {
    fn get(&self, key: &CredentialKey) -> Result<Secret, Error> {
        if *key != self.key {
            return Err(Error::Missing);
        }
        Secret::new(self.secret.as_slice().to_vec())
    }
    fn put(&self, _: &CredentialKey, _: &[u8]) -> Result<(), Error> {
        panic!("read fixture wrote credential")
    }
    fn delete(&self, _: &CredentialKey) -> Result<(), Error> {
        panic!("read fixture deleted credential")
    }
}

#[test]
fn credentials_reject_oversize_secrets_without_native_access() {
    let key = key("imap", "imap:one@example.org", CredentialKind::ImapPassword);
    assert_eq!(
        NativeStore.put(&key, &vec![b'x'; 65537]),
        Err(Error::TooLarge)
    );
    #[cfg(target_os = "windows")]
    assert_eq!(
        NativeStore.put(&key, &vec![b'x'; 2561]),
        Err(Error::TooLarge)
    );
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires an unlocked Linux Secret Service; run explicitly on its native runner"]
fn credentials_native_linux_retains_legacy_attribute_scopes() {
    use ::secret_service::{EncryptionType, blocking::SecretService};
    use std::collections::HashMap;
    let account = format!(
        "omamail-legacy-{}-{}@example.invalid",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let service = SecretService::connect(EncryptionType::Dh).unwrap();
    let collection = service.get_default_collection().unwrap();
    let old = collection
        .create_item(
            "Omamail synthetic legacy fixture",
            HashMap::from([
                ("service", "omamail"),
                ("kind", "refresh-token"),
                ("client-id", "synthetic-client"),
                ("account", account.as_str()),
            ]),
            b"synthetic-old-grant",
            false,
            "text/plain",
        )
        .unwrap();
    struct Cleanup<'a>(::secret_service::blocking::Item<'a>, CredentialKey);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            let _ = self.0.delete();
            let _ = NativeStore.delete(&self.1);
        }
    }
    let cleanup = Cleanup(
        old,
        key(
            "gmail",
            &account,
            CredentialKind::GoogleRefreshToken {
                client_id: "synthetic-client".into(),
            },
        ),
    );
    assert!(
        matches!(NativeStore.get(&cleanup.1), Err(Error::Missing)),
        "old grant was accepted as current grant"
    );
    NativeStore
        .put(&cleanup.1, b"synthetic-current-grant")
        .unwrap();
    assert!(
        cleanup.0.get_secret().unwrap() == b"synthetic-old-grant",
        "writing a current grant replaced an old item"
    );
    assert!(NativeStore.get(&cleanup.1).unwrap().as_slice() == b"synthetic-current-grant");
    NativeStore.delete(&cleanup.1).unwrap();
    assert!(
        cleanup.0.get_secret().unwrap() == b"synthetic-old-grant",
        "clearing a current grant deleted an old item"
    );
    cleanup.0.delete().unwrap();
}
