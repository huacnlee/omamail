//! Typed credential operations exposed to the two desktop frontends.
//!
//! Callers choose one of the product credential kinds. They cannot provide
//! native keyring attributes or a platform command, so validation completes
//! before the native store is touched.
use super::{CredentialKey, CredentialKind, Error, Secret};
use serde_json::{Value, json};
use std::sync::Arc;

enum Request {
    Get(CredentialKey),
    Put(CredentialKey, Secret),
    Delete(CredentialKey),
}

fn key(params: &serde_json::Map<String, Value>) -> Result<CredentialKey, &'static str> {
    let kind = params
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("invalid_params")?;
    let account_id = params
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("invalid_params")?
        .to_owned();
    let client_id = || {
        params
            .get("clientId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or("invalid_params")
    };
    let (provider, kind) = match kind {
        "google-refresh-token" => (
            "gmail",
            CredentialKind::GoogleRefreshToken {
                client_id: client_id()?,
            },
        ),
        "outlook-refresh-token" => (
            "outlook",
            CredentialKind::OutlookRefreshToken {
                client_id: client_id()?,
            },
        ),
        "imap-password" => ("imap", CredentialKind::ImapPassword),
        "jmap-secret" => ("jmap", CredentialKind::JmapSecret),
        "calendar-password" => ("caldav", CredentialKind::CalendarPassword),
        _ => return Err("invalid_params"),
    };
    let has_client = params.contains_key("clientId");
    let needs_client = matches!(
        kind,
        CredentialKind::GoogleRefreshToken { .. } | CredentialKind::OutlookRefreshToken { .. }
    );
    if has_client != needs_client {
        return Err("invalid_params");
    }
    let key = CredentialKey {
        provider: provider.into(),
        account_id,
        kind,
    };
    key.attributes().map_err(map_input_error)?;
    Ok(key)
}

fn parse(method: &str, params: &Value) -> Result<Request, &'static str> {
    let fields = params.as_object().ok_or("invalid_params")?;
    let expected = match method {
        "credentials.get" | "credentials.delete" => {
            2 + usize::from(matches!(
                fields.get("kind").and_then(Value::as_str),
                Some("google-refresh-token" | "outlook-refresh-token")
            ))
        }
        "credentials.put" => {
            3 + usize::from(matches!(
                fields.get("kind").and_then(Value::as_str),
                Some("google-refresh-token" | "outlook-refresh-token")
            ))
        }
        _ => return Err("unknown_method"),
    };
    if fields.len() != expected {
        return Err("invalid_params");
    }
    let key = key(fields)?;
    match method {
        "credentials.get" => Ok(Request::Get(key)),
        "credentials.delete" => Ok(Request::Delete(key)),
        "credentials.put" => {
            let text = fields
                .get("secret")
                .and_then(Value::as_str)
                .ok_or("invalid_params")?;
            let secret = Secret::new(text.as_bytes().to_vec()).map_err(map_input_error)?;
            Ok(Request::Put(key, secret))
        }
        _ => Err("unknown_method"),
    }
}

fn map_input_error(error: Error) -> &'static str {
    match error {
        Error::InvalidKey | Error::InvalidSecret | Error::TooLarge => "invalid_params",
        Error::Missing => "credential_missing",
        Error::Unavailable | Error::Ambiguous => "credential_store_unavailable",
    }
}

fn map_store_error(error: Error) -> &'static str {
    match error {
        Error::Missing => "credential_missing",
        Error::InvalidKey | Error::InvalidSecret | Error::TooLarge => "invalid_params",
        Error::Unavailable | Error::Ambiguous => "credential_store_unavailable",
    }
}

async fn call_with_store(
    store: Arc<dyn super::CredentialStore>,
    method: &str,
    params: &Value,
) -> Result<Value, &'static str> {
    // Parsing before the first await is deliberate: malformed metadata or a
    // secret containing NUL cannot prompt, read, write, or delete in a native
    // credential store.
    match parse(method, params)? {
        Request::Get(key) => match tokio::task::spawn_blocking(move || store.get(&key))
            .await
            .map_err(|_| "credential_store_unavailable")?
        {
            Ok(secret) => {
                Ok(json!({"found":true,"secret":secret.text().map_err(map_store_error)?}))
            }
            Err(Error::Missing) => Ok(json!({"found":false})),
            Err(error) => Err(map_store_error(error)),
        },
        Request::Put(key, secret) => {
            tokio::task::spawn_blocking(move || store.put(&key, secret.as_slice()))
                .await
                .map_err(|_| "credential_store_unavailable")?
                .map_err(map_store_error)?;
            Ok(json!({"stored":true}))
        }
        Request::Delete(key) => match tokio::task::spawn_blocking(move || store.delete(&key))
            .await
            .map_err(|_| "credential_store_unavailable")?
        {
            Ok(()) => Ok(json!({"deleted":true})),
            Err(Error::Missing) => Ok(json!({"deleted":false})),
            Err(error) => Err(map_store_error(error)),
        },
    }
}

pub async fn call(method: &str, params: &Value) -> Result<Value, &'static str> {
    call_with_store(Arc::new(super::NativeStore), method, params).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingStore {
        calls: Mutex<Vec<&'static str>>,
        value: Mutex<Option<(CredentialKey, Vec<u8>)>>,
    }
    impl super::super::CredentialStore for RecordingStore {
        fn get(&self, key: &CredentialKey) -> Result<Secret, Error> {
            self.calls.lock().unwrap().push("get");
            let value = self.value.lock().unwrap();
            let Some((stored_key, secret)) = value.as_ref() else {
                return Err(Error::Missing);
            };
            if stored_key != key {
                return Err(Error::Missing);
            }
            Secret::new(secret.clone())
        }
        fn put(&self, key: &CredentialKey, secret: &[u8]) -> Result<(), Error> {
            self.calls.lock().unwrap().push("put");
            *self.value.lock().unwrap() = Some((key.clone(), secret.to_vec()));
            Ok(())
        }
        fn delete(&self, key: &CredentialKey) -> Result<(), Error> {
            self.calls.lock().unwrap().push("delete");
            let mut value = self.value.lock().unwrap();
            if value
                .as_ref()
                .is_some_and(|(stored_key, _)| stored_key == key)
            {
                *value = None;
                Ok(())
            } else {
                Err(Error::Missing)
            }
        }
    }

    #[test]
    fn typed_requests_reject_unknown_fields_kinds_and_control_characters() {
        for params in [
            json!({"kind":"shell-command","accountId":"imap:a@example.org"}),
            json!({"kind":"imap-password","accountId":"imap:a@example.org","clientId":"forged"}),
            json!({"kind":"imap-password","accountId":"imap:a@example.org\n"}),
            json!({"kind":"calendar-password","accountId":"source\0id"}),
            json!({"kind":"google-refresh-token","accountId":"a@example.org"}),
            json!({"kind":"google-refresh-token","accountId":"a@example.org","clientId":"client","nativeAttributes":[]}),
        ] {
            assert!(matches!(
                parse("credentials.get", &params),
                Err("invalid_params")
            ));
        }
    }

    #[test]
    fn put_rejects_nul_empty_and_oversize_secrets_before_native_access() {
        for secret in [String::new(), "x\0y".into(), "x".repeat(65_537)] {
            assert!(matches!(
                parse(
                    "credentials.put",
                    &json!({
                        "kind":"imap-password",
                        "accountId":"imap:a@example.org",
                        "secret":secret
                    })
                ),
                Err("invalid_params")
            ));
        }
    }

    #[test]
    fn typed_keys_preserve_each_product_scope() {
        let cases = [
            (
                json!({"kind":"imap-password","accountId":"imap:a@example.org"}),
                "imap",
            ),
            (
                json!({"kind":"jmap-secret","accountId":"jmap:a@example.org"}),
                "jmap",
            ),
            (
                json!({"kind":"calendar-password","accountId":"source-id"}),
                "caldav",
            ),
            (
                json!({"kind":"google-refresh-token","accountId":"a@example.org","clientId":"client"}),
                "gmail",
            ),
            (
                json!({"kind":"outlook-refresh-token","accountId":"outlook:a@example.org","clientId":"client"}),
                "outlook",
            ),
        ];
        for (params, provider) in cases {
            let Request::Get(key) = parse("credentials.get", &params).unwrap() else {
                panic!()
            };
            assert_eq!(key.provider, provider);
            assert!(key.attributes().is_ok());
        }
    }

    #[tokio::test]
    async fn public_responses_round_trip_opaque_text_through_a_controlled_store() {
        let store = Arc::new(RecordingStore::default());
        let key = json!({"kind":"imap-password","accountId":"imap:a@example.org"});
        let secret = "quotes '\" backslash \\ Unicode 你好\r\nline";
        assert_eq!(
            call_with_store(
                store.clone(),
                "credentials.put",
                &json!({
                    "kind":"imap-password","accountId":"imap:a@example.org","secret":secret
                })
            )
            .await
            .unwrap(),
            json!({"stored":true})
        );
        assert_eq!(
            call_with_store(store.clone(), "credentials.get", &key)
                .await
                .unwrap(),
            json!({"found":true,"secret":secret})
        );
        assert_eq!(
            call_with_store(store.clone(), "credentials.delete", &key)
                .await
                .unwrap(),
            json!({"deleted":true})
        );
        assert_eq!(
            call_with_store(store.clone(), "credentials.get", &key)
                .await
                .unwrap(),
            json!({"found":false})
        );
        assert_eq!(
            *store.calls.lock().unwrap(),
            ["put", "get", "delete", "get"]
        );
    }

    #[tokio::test]
    async fn rejected_public_requests_have_no_store_side_effect() {
        let store = Arc::new(RecordingStore::default());
        for (method, params) in [
            (
                "credentials.get",
                json!({"kind":"native-command","accountId":"imap:a@example.org"}),
            ),
            (
                "credentials.put",
                json!({"kind":"imap-password","accountId":"imap:a@example.org\n","secret":"x"}),
            ),
            (
                "credentials.delete",
                json!({"kind":"calendar-password","accountId":"source","nativeAttributes":[]}),
            ),
        ] {
            assert_eq!(
                call_with_store(store.clone(), method, &params).await,
                Err("invalid_params")
            );
        }
        assert!(store.calls.lock().unwrap().is_empty());
        assert!(store.value.lock().unwrap().is_none());
    }
}
