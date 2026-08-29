use std::{sync::Mutex, thread, time::Duration};

use omamail::{
    imap_setup::{ImapSetupAuthority, SetupError, SetupProtocol, SetupTarget, SetupVerifier},
    platform::secrets::{MemorySecretStore, Secret, SecretKey, SecretStore, SecretStoreError},
};

#[derive(Default)]
struct PartialFailureStore(Mutex<Option<(SecretKey, Secret)>>);
impl SecretStore for PartialFailureStore {
    fn get(&self, key: &SecretKey) -> Result<Option<Secret>, SecretStoreError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(stored, _)| stored == key)
            .map(|(_, secret)| secret.clone()))
    }
    fn set(&self, key: &SecretKey, secret: Secret) -> Result<(), SecretStoreError> {
        *self.0.lock().unwrap() = Some((key.clone(), secret));
        Err(SecretStoreError::Failed)
    }
    fn delete(&self, key: &SecretKey) -> Result<(), SecretStoreError> {
        let mut value = self.0.lock().unwrap();
        if value.as_ref().is_some_and(|(stored, _)| stored == key) {
            *value = None;
        }
        Ok(())
    }
}

#[derive(Default)]
struct UncertainDeleteStore(Mutex<Option<(SecretKey, Secret)>>);
impl SecretStore for UncertainDeleteStore {
    fn get(&self, key: &SecretKey) -> Result<Option<Secret>, SecretStoreError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(stored, _)| stored == key)
            .map(|(_, secret)| secret.clone()))
    }
    fn set(&self, key: &SecretKey, secret: Secret) -> Result<(), SecretStoreError> {
        *self.0.lock().unwrap() = Some((key.clone(), secret));
        Ok(())
    }
    fn delete(&self, key: &SecretKey) -> Result<(), SecretStoreError> {
        let mut value = self.0.lock().unwrap();
        if value.as_ref().is_some_and(|(stored, _)| stored == key) {
            *value = None;
        }
        Err(SecretStoreError::Failed)
    }
}

#[derive(Default)]
struct Verifier {
    calls: Mutex<Vec<(SetupProtocol, String, Duration)>>,
    fail_smtp: bool,
    delay: Duration,
}
impl SetupVerifier for Verifier {
    fn verify(
        &self,
        target: &SetupTarget,
        credentials: &Secret,
        deadline: Duration,
    ) -> Result<(), SetupError> {
        assert!(credentials.expose().contains(':'));
        self.calls
            .lock()
            .unwrap()
            .push((target.protocol(), target.url().to_owned(), deadline));
        if !self.delay.is_zero() {
            thread::sleep(self.delay);
        }
        if self.fail_smtp && target.protocol() == SetupProtocol::Smtp {
            Err(SetupError::Rejected)
        } else {
            Ok(())
        }
    }
}

fn request(insecure: bool) -> String {
    serde_json::json!({
        "operation":"imap.setup.verifyAndStore",
        "deadlineMs":1000,
        "email":"me@example.test",
        "username":"mail-user",
        "password":"top secret",
        "imapHost": if insecure { "127.0.0.1" } else { "imap.example.test" },
        "smtpHost": if insecure { "::1" } else { "smtp.example.test" },
        "insecure":insecure
    })
    .to_string()
}

#[test]
fn setup_only_forget_removes_only_the_exact_endpoint_credential() {
    let store = MemorySecretStore::default();
    let authority = ImapSetupAuthority::new(Verifier::default(), &store);
    let exact = SecretKey::imap_endpoint(
        "omamail",
        "imap:me@example.test",
        "imap.example.test",
        993,
        "me",
    )
    .unwrap();
    let other = SecretKey::imap_endpoint(
        "omamail",
        "imap:me@example.test",
        "imap.example.test",
        993,
        "other",
    )
    .unwrap();
    store.set(&exact, Secret::new("exact")).unwrap();
    store.set(&other, Secret::new("other")).unwrap();
    let reply: serde_json::Value = serde_json::from_str(
        &authority.dispatch(
            &serde_json::json!({
                "operation":"imap.setup.forgetCredential", "accountId":"imap:me@example.test",
                "imapHost":"imap.example.test", "imapPort":993, "username":"me"
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(
        reply,
        serde_json::json!({"ok":true,"data":{"forgotten":true,"outcome":"deleted"}})
    );
    assert!(store.get(&exact).unwrap().is_none());
    assert_eq!(store.get(&other).unwrap().unwrap().expose(), "other");
}

#[test]
fn partial_delete_reports_uncertain_without_diagnostics() {
    let store = UncertainDeleteStore::default();
    let authority = ImapSetupAuthority::new(Verifier::default(), &store);
    let key = SecretKey::imap_endpoint(
        "omamail",
        "imap:me@example.test",
        "imap.example.test",
        993,
        "me",
    )
    .unwrap();
    store.set(&key, Secret::new("secret")).unwrap();
    let reply: serde_json::Value = serde_json::from_str(
        &authority.dispatch(
            &serde_json::json!({
                "operation":"imap.setup.forgetCredential", "accountId":"imap:me@example.test",
                "imapHost":"imap.example.test", "imapPort":993, "username":"me"
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["credentialOutcome"], "uncertain");
    assert!(store.get(&key).unwrap().is_none());
    assert!(!reply.to_string().contains("secret"));
}

#[test]
fn verifies_both_protocols_then_stores_only_the_endpoint_bound_secret() {
    let setup = ImapSetupAuthority::new(Verifier::default(), MemorySecretStore::default());
    let reply = setup.dispatch(&request(false));
    let value: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["data"]["account"]["id"], "imap:me@example.test");
    assert_eq!(value["data"]["account"]["imap"]["username"], "mail-user");
    assert!(value["data"]["account"].get("password").is_none());
    assert!(value.to_string().find("top secret").is_none());
    let calls = setup.verifier().calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, SetupProtocol::Imap);
    assert_eq!(calls[1].0, SetupProtocol::Smtp);
    assert_eq!(calls[0].1, "imaps://imap.example.test:993");
    assert_eq!(calls[1].1, "smtps://smtp.example.test:465");
    assert!(
        calls[1].2 <= calls[0].2,
        "both checks share one absolute deadline"
    );
    drop(calls);
    let key = SecretKey::imap_endpoint(
        "omamail",
        "imap:me@example.test",
        "imap.example.test",
        993,
        "mail-user",
    )
    .unwrap();
    assert_eq!(
        setup.store().get(&key).unwrap().unwrap().expose(),
        "top secret"
    );
}

#[test]
fn smtp_failure_and_expired_shared_deadline_leave_no_secret() {
    let setup = ImapSetupAuthority::new(
        Verifier {
            fail_smtp: true,
            ..Verifier::default()
        },
        MemorySecretStore::default(),
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&setup.dispatch(&request(false))).unwrap()["error"],
        "Mail server sign-in was rejected"
    );
    let key = SecretKey::imap_endpoint(
        "omamail",
        "imap:me@example.test",
        "imap.example.test",
        993,
        "mail-user",
    )
    .unwrap();
    assert!(setup.store().get(&key).unwrap().is_none());

    let slow = ImapSetupAuthority::new(
        Verifier {
            delay: Duration::from_millis(8),
            ..Verifier::default()
        },
        MemorySecretStore::default(),
    );
    let mut tiny: serde_json::Value = serde_json::from_str(&request(false)).unwrap();
    tiny["deadlineMs"] = 1.into();
    let reply: serde_json::Value = serde_json::from_str(&slow.dispatch(&tiny.to_string())).unwrap();
    assert_eq!(reply["error"], "Mail server verification timed out");
}

#[test]
fn validation_is_closed_tls_first_and_insecure_only_for_literal_loopback() {
    let setup = ImapSetupAuthority::new(Verifier::default(), MemorySecretStore::default());
    for mutation in [
        ("operation", serde_json::json!("imap.setup.raw")),
        ("email", serde_json::json!("bad\n@example.test")),
        ("username", serde_json::json!("bad\0name")),
        ("imapHost", serde_json::json!("imaps://imap.example.test")),
        ("imapPort", serde_json::json!(0)),
    ] {
        let mut value: serde_json::Value = serde_json::from_str(&request(false)).unwrap();
        value[mutation.0] = mutation.1;
        let reply: serde_json::Value =
            serde_json::from_str(&setup.dispatch(&value.to_string())).unwrap();
        assert_eq!(reply["error"], "Invalid IMAP setup request");
    }
    let mut remote_plain: serde_json::Value = serde_json::from_str(&request(false)).unwrap();
    remote_plain["insecure"] = true.into();
    let reply: serde_json::Value =
        serde_json::from_str(&setup.dispatch(&remote_plain.to_string())).unwrap();
    assert_eq!(
        reply["error"],
        "Insecure mail servers must use loopback addresses"
    );

    let local: serde_json::Value = serde_json::from_str(&setup.dispatch(&request(true))).unwrap();
    assert_eq!(local["ok"], true, "{local}");
    let calls = setup.verifier().calls.lock().unwrap();
    let last = calls.len();
    assert_eq!(calls[last - 2].1, "imap://127.0.0.1:143");
    assert_eq!(calls[last - 1].1, "smtp://[::1]:587");
}

#[test]
fn request_caps_and_unknown_fields_fail_with_fixed_redacted_errors() {
    let setup = ImapSetupAuthority::new(Verifier::default(), MemorySecretStore::default());
    let huge = "x".repeat(20_000);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&setup.dispatch(&huge)).unwrap()["error"],
        "Invalid IMAP setup request"
    );
    let mut value: serde_json::Value = serde_json::from_str(&request(false)).unwrap();
    value["password"] = "secret-that-must-not-return".into();
    value["rawCommand"] = "LOGIN secret-that-must-not-return".into();
    let reply = setup.dispatch(&value.to_string());
    assert!(!reply.contains("secret-that-must-not-return"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&reply).unwrap()["error"],
        "Invalid IMAP setup request"
    );
}

#[test]
fn partial_secret_store_failure_is_rolled_back() {
    let setup = ImapSetupAuthority::new(Verifier::default(), PartialFailureStore::default());
    let reply: serde_json::Value = serde_json::from_str(&setup.dispatch(&request(false))).unwrap();
    assert_eq!(reply["error"], "Couldn’t store the mail password");
    let key = SecretKey::imap_endpoint(
        "omamail",
        "imap:me@example.test",
        "imap.example.test",
        993,
        "mail-user",
    )
    .unwrap();
    assert!(setup.store().get(&key).unwrap().is_none());
}
