//! Account-bound keyring resolution used by autonomous backend jobs.
use super::*;
use crate::credentials::{
    self as store, CredentialKey, CredentialKind, Error as StoreError, Secret,
};

pub fn settings(provider: &str, account: &str) -> Result<Value, &'static str> {
    settings_with(provider, account, crate::account::raw_registry()?)
}

pub fn settings_readonly(provider: &str, account: &str) -> Result<Value, &'static str> {
    settings_with(provider, account, crate::account::raw_registry_readonly()?)
}

fn settings_with(provider: &str, account: &str, raw: Value) -> Result<Value, &'static str> {
    if !["gmail", "outlook", "imap", "jmap"].contains(&provider)
        || account.is_empty()
        || account.len() > 1024
        || account.chars().any(char::is_control)
    {
        return Err("auth_account_invalid");
    }
    if raw["version"] != 1 {
        return Err("accounts_version_unsupported");
    }
    let entries = raw["accounts"].as_array().ok_or("accounts_invalid")?;
    for entry in entries {
        let p = entry["provider"].as_str().unwrap_or("gmail");
        if p != provider {
            continue;
        }
        let email = entry["email"]
            .as_str()
            .filter(|e| !e.is_empty())
            .or_else(|| entry["imap"]["username"].as_str())
            .unwrap_or("");
        let id = if provider == "gmail" {
            email.to_lowercase()
        } else {
            format!("{provider}:{}", email.to_lowercase())
        };
        if id.eq_ignore_ascii_case(account) {
            return Ok(entry.clone());
        }
    }
    Err("auth_account_missing")
}

fn valid_account(provider: &str, account: &str) -> Result<(), &'static str> {
    if !account.starts_with(&format!("{provider}:"))
        || !account.contains('@')
        || account.len() > 1024
        || account.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("auth_account_invalid");
    }
    Ok(())
}

fn store_error(error: StoreError) -> &'static str {
    match error {
        StoreError::Missing => "auth_signed_out",
        StoreError::InvalidKey => "auth_account_invalid",
        StoreError::InvalidSecret | StoreError::TooLarge => "auth_secret_invalid",
        StoreError::Unavailable | StoreError::Ambiguous => "auth_keyring_failed",
    }
}

fn text_secret(secret: &Secret) -> Result<&str, &'static str> {
    let value = secret.text().map_err(store_error)?;
    if value.is_empty() {
        return Err("auth_signed_out");
    }
    if value.len() > 16384 || value.chars().any(char::is_control) {
        return Err("auth_secret_invalid");
    }
    Ok(value)
}

fn outlook_key(client: &str, account: &str) -> CredentialKey {
    CredentialKey {
        provider: "outlook".into(),
        account_id: account.to_lowercase(),
        kind: CredentialKind::OutlookRefreshToken {
            client_id: client.into(),
        },
    }
}

pub async fn password(provider: &str, account: &str) -> Result<String, &'static str> {
    valid_account(provider, account)?;
    let kind = match provider {
        "imap" => CredentialKind::ImapPassword,
        "jmap" => CredentialKind::JmapSecret,
        _ => return Err("auth_provider_invalid"),
    };
    let secret = store::get(CredentialKey {
        provider: provider.into(),
        account_id: account.to_lowercase(),
        kind,
    })
    .await
    .map_err(store_error)?;
    Ok(text_secret(&secret)?.to_owned())
}

type Tokens = std::collections::HashMap<String, (String, std::time::Instant)>;
type AccountTokens = std::sync::Arc<tokio::sync::Mutex<Tokens>>;
static TOKENS: OnceLock<tokio::sync::Mutex<std::collections::HashMap<String, AccountTokens>>> =
    OnceLock::new();

pub async fn access_token(
    provider: &str,
    account: &str,
    resource: &str,
) -> Result<String, &'static str> {
    access_token_with(provider, account, resource, false).await
}

pub async fn access_token_readonly(
    provider: &str,
    account: &str,
    resource: &str,
) -> Result<String, &'static str> {
    access_token_with(provider, account, resource, true).await
}

async fn access_token_with(
    provider: &str,
    account: &str,
    resource: &str,
    read_only: bool,
) -> Result<String, &'static str> {
    if provider != "outlook" {
        return Err("auth_provider_invalid");
    }
    valid_account(provider, account)?;
    scope(resource)?;
    let owned = account.to_owned();
    let entry = tokio::task::spawn_blocking(move || {
        if read_only {
            settings_readonly("outlook", &owned)
        } else {
            settings("outlook", &owned)
        }
    })
    .await
    .map_err(|_| "auth_account_invalid")??;
    let client_id = entry["clientId"].as_str().ok_or("auth_client_missing")?;
    if client_id.is_empty() || client_id.len() > 1024 || client_id.chars().any(char::is_control) {
        return Err("auth_client_invalid");
    }
    let url = destination(
        &json!({"provider":"outlook", "endpoint":"token", "tenant":entry["imap"]["tenant"].as_str().unwrap_or("consumers")}),
    )?;
    let lock = account_tokens(
        account,
        client_id,
        entry["imap"]["tenant"].as_str().unwrap_or("consumers"),
    )
    .await?;
    let account = account.to_owned();
    let client_id = client_id.to_owned();
    let resource = resource.to_owned();
    in_outlook_lane(lock, move |mut tokens| async move {
        // One refresh at a time per mailbox, shared by mail and Graph resources:
        // rotating a refresh token must not race another resource's exchange.
        if let Some((token, expiry)) = tokens.get(&resource)
            && *expiry > std::time::Instant::now() + Duration::from_secs(60)
        {
            return Ok(token.clone());
        }
        let key = outlook_key(&client_id, &account);
        let refresh_secret = store::get(key.clone()).await.map_err(store_error)?;
        let refresh = text_secret(&refresh_secret)?;
        let http = client()?;
        let (access, lifetime) = refresh_outlook_with(
            &client_id,
            refresh,
            &resource,
            |body| post(http, &url, body),
            |token| {
                let key = key.clone();
                async move { persist_outlook_rotation(refresh, &token, key, read_only).await }
            },
        )
        .await?;
        tokens.insert(
            resource.to_owned(),
            (
                access.to_owned(),
                std::time::Instant::now() + Duration::from_secs(lifetime),
            ),
        );
        Ok(access.to_owned())
    })
    .await
}

// The account lock remains held across every exchange and refresh-token store.
// Inject only the transport and store so provider fixtures never touch a keyring.
async fn refresh_outlook_with<Request, RequestFuture, Persist, PersistFuture>(
    client_id: &str,
    refresh: &str,
    resource: &str,
    mut request: Request,
    mut persist: Persist,
) -> Result<(String, u64), &'static str>
where
    Request: FnMut(String) -> RequestFuture,
    RequestFuture: std::future::Future<Output = Result<Value, &'static str>>,
    Persist: FnMut(Value) -> PersistFuture,
    PersistFuture: std::future::Future<Output = Result<(), &'static str>>,
{
    let scope = scope(resource)?;
    // Both network exchanges share one budget below the UI's RPC timeout.
    // Do not time out a keyring write: its blocking native operation must
    // finish while the caller still owns the account rotation lock.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let reply = tokio::time::timeout_at(
        deadline,
        request(callback::form(&[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("scope", scope),
        ])),
    )
    .await
    .map_err(|_| "auth_timeout")??;
    let token: Value = serde_json::from_str(reply["body"].as_str().ok_or("auth_invalid_response")?)
        .map_err(|_| "auth_invalid_response")?;
    if reply["status"] != 200 {
        // Consumers can refuse the first Graph grant with 70000 while this
        // refresh token still works for mail. A cached mail access token is
        // not evidence: verify this exact grant, under the same rotation lock.
        if resource == "graph" && token["error"] == "invalid_grant" && aadsts_code(&token, 70000) {
            let mail_scope = self::scope("mail")?;
            let mail_reply = tokio::time::timeout_at(
                deadline,
                request(callback::form(&[
                    ("client_id", client_id),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh),
                    ("scope", mail_scope),
                ])),
            )
            .await
            .map_err(|_| "auth_timeout")??;
            let mail: Value =
                serde_json::from_str(mail_reply["body"].as_str().ok_or("auth_invalid_response")?)
                    .map_err(|_| "auth_invalid_response")?;
            if mail_reply["status"] != 200 {
                return Err(if mail["error"] == "invalid_grant" {
                    "auth_signed_out"
                } else {
                    "auth_refresh_failed"
                });
            }
            outlook_access(&mail)?;
            // Even a scope refusal may rotate the grant. Keep the successful
            // mail probe's rotation before reporting missing Graph consent.
            persist(mail.clone()).await?;
            if !outlook_scopes(&mail, mail_scope) {
                return Err("auth_refresh_failed");
            }
            return Err("auth_consent_required");
        }
        if token["error_codes"]
            .as_array()
            .is_some_and(|codes| codes.iter().any(|v| *v == 65001))
            || token["error_description"]
                .as_str()
                .is_some_and(|s| s.contains("AADSTS65001"))
        {
            return Err("auth_consent_required");
        }
        if token["error"] == "invalid_grant" {
            return Err("auth_signed_out");
        }
        return Err("auth_refresh_failed");
    }
    let access = outlook_access(&token)?;
    persist(token.clone()).await?;
    if !outlook_scopes(&token, scope) {
        return Err("auth_consent_required");
    }
    let lifetime = token["expires_in"]
        .as_u64()
        .filter(|n| *n <= 86400)
        .unwrap_or(0);
    Ok((access.to_owned(), lifetime))
}

fn aadsts_code(token: &Value, code: u64) -> bool {
    token["error_codes"]
        .as_array()
        .is_some_and(|codes| codes.iter().any(|value| value.as_u64() == Some(code)))
        || token["error_description"]
            .as_str()
            .is_some_and(|description| {
                description
                    .split_whitespace()
                    .any(|word| word == format!("AADSTS{code}:"))
            })
}

fn outlook_access(token: &Value) -> Result<&str, &'static str> {
    token["access_token"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 16384
                && !s.chars().any(|c| c.is_whitespace() || c.is_control())
        })
        .ok_or("auth_invalid_response")
}

fn outlook_scopes(token: &Value, scope: &str) -> bool {
    let granted = token["scope"].as_str().unwrap_or("");
    scope
        .split_whitespace()
        .filter(|s| s.starts_with("https://"))
        .all(|required| {
            granted.split_whitespace().any(|s| {
                s == required
                    || required
                        .strip_prefix("https://graph.microsoft.com/")
                        .is_some_and(|short| s == short)
            })
        })
}

async fn in_outlook_lane<T, F, Fut>(lane: AccountTokens, operation: F) -> Result<T, &'static str>
where
    T: Send + 'static,
    F: FnOnce(tokio::sync::OwnedMutexGuard<Tokens>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, &'static str>> + Send + 'static,
{
    // Waiting is cancellable. Once admitted, finish under the owned guard:
    // native keyring writes use spawn_blocking and cannot be cancelled when
    // a calendar caller's outer deadline drops its authentication future.
    let guard = lane.lock_owned().await;
    tokio::spawn(operation(guard))
        .await
        .map_err(|_| "auth_refresh_failed")?
}

async fn account_tokens(
    account: &str,
    client: &str,
    tenant: &str,
) -> Result<AccountTokens, &'static str> {
    let key = format!("{}:{client}:{tenant}", account.to_lowercase());
    let mut accounts = TOKENS.get_or_init(Default::default).lock().await;
    if accounts.len() >= 128 && !accounts.contains_key(&key) {
        return Err("auth_too_many_accounts");
    }
    Ok(accounts.entry(key).or_default().clone())
}

/// Serialize explicit stores/clears with refresh-token rotation.
pub(super) async fn change_outlook(params: &Value, clear: bool) -> Result<Value, &'static str> {
    let account = params["accountId"].as_str().ok_or("invalid_params")?;
    valid_account("outlook", account)?;
    let owned = account.to_owned();
    let entry = tokio::task::spawn_blocking(move || settings("outlook", &owned))
        .await
        .map_err(|_| "auth_account_invalid")??;
    let client = entry["clientId"].as_str().ok_or("auth_client_missing")?;
    if params["clientId"] != client || client.is_empty() || client.chars().any(char::is_control) {
        return Err("auth_client_invalid");
    }
    let token = if clear {
        ""
    } else {
        params["token"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 16384 && !s.chars().any(char::is_control))
            .ok_or("auth_secret_invalid")?
    };
    let lock = account_tokens(
        account,
        client,
        entry["imap"]["tenant"].as_str().unwrap_or("consumers"),
    )
    .await?;
    let key = outlook_key(client, account);
    let token = token.to_owned();
    in_outlook_lane(lock, move |mut tokens| async move {
        if clear {
            match store::delete(key).await {
                Ok(()) | Err(StoreError::Missing) => {}
                Err(error) => return Err(store_error(error)),
            }
        } else {
            store::put(
                key,
                Secret::new(token.as_bytes().to_vec()).map_err(store_error)?,
            )
            .await
            .map_err(store_error)?;
        }
        tokens.clear();
        Ok(json!({"saved":!clear,"cleared":clear}))
    })
    .await
}

/// Discard cached credentials without opening a second refresh lane.
pub async fn invalidate(account: &str) -> Result<(), &'static str> {
    valid_account("outlook", account)?;
    if let Some(accounts) = TOKENS.get() {
        let prefix = format!("{}:", account.to_lowercase());
        let locks: Vec<_> = accounts
            .lock()
            .await
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(_, v)| v.clone())
            .collect();
        for lock in locks {
            lock.lock().await.clear();
        }
    }
    Ok(())
}

pub(super) async fn store_google(
    client_id: &str,
    account: &str,
    token: &str,
) -> Result<(), &'static str> {
    store_google_with(client_id, account, token, |key, secret| async {
        store::put(key, secret).await.map_err(store_error)
    })
    .await
}

async fn store_google_with<F, Fut>(
    client_id: &str,
    account: &str,
    token: &str,
    mut run: F,
) -> Result<(), &'static str>
where
    F: FnMut(CredentialKey, Secret) -> Fut,
    Fut: std::future::Future<Output = Result<(), &'static str>>,
{
    if client_id.is_empty()
        || client_id.len() > 1024
        || account.is_empty()
        || !account.contains('@')
        || account.len() > 1024
        || account.chars().any(|c| c.is_control() || c.is_whitespace())
        || token.is_empty()
        || client_id.chars().any(char::is_control)
        || token.len() > 16384
        || token.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("auth_secret_invalid");
    }
    let key = CredentialKey {
        provider: "gmail".into(),
        account_id: account.to_lowercase(),
        kind: CredentialKind::GoogleRefreshToken {
            client_id: client_id.into(),
        },
    };
    run(
        key,
        Secret::new(token.as_bytes().to_vec()).map_err(store_error)?,
    )
    .await?;
    Ok(())
}

pub(super) fn scope(resource: &str) -> Result<&'static str, &'static str> {
    Ok(match resource {
        "mail" => {
            "openid offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send"
        }
        "graph" => {
            "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite"
        }
        _ => return Err("invalid_params"),
    })
}

async fn persist_outlook_rotation(
    refresh: &str,
    token: &Value,
    key: CredentialKey,
    read_only: bool,
) -> Result<(), &'static str> {
    persist_outlook_rotation_with(refresh, token, key, read_only, |key, secret| async {
        store::put(key, secret).await.map_err(store_error)
    })
    .await
}

async fn persist_outlook_rotation_with<F, Fut>(
    refresh: &str,
    token: &Value,
    key: CredentialKey,
    read_only: bool,
    mut put: F,
) -> Result<(), &'static str>
where
    F: FnMut(CredentialKey, Secret) -> Fut,
    Fut: std::future::Future<Output = Result<(), &'static str>>,
{
    if let Some(rotated) = token["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != refresh)
    {
        if rotated.len() > 16384 || rotated.chars().any(char::is_control) {
            return Err("auth_invalid_response");
        }
        if read_only {
            return Ok(());
        }
        put(
            key,
            Secret::new(rotated.as_bytes().to_vec()).map_err(store_error)?,
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reply(status: u16, token: Value) -> Value {
        json!({"status": status, "body": token.to_string()})
    }

    fn mail_grant() -> Value {
        json!({"access_token":"synthetic-mail", "expires_in":3600,
            "refresh_token":"synthetic-rotated", "scope":scope("mail").unwrap()})
    }

    // This is Microsoft's consumer-account refusal, not proof the grant died.
    fn unconsented_graph() -> Value {
        json!({"error":"invalid_grant", "error_codes":[70000],
            "error_description":"AADSTS70000: The request was denied because one or more scopes requested are unauthorized or expired. The user must first sign in and grant the client application access to the requested scope."})
    }

    #[tokio::test]
    async fn graph_70000_probes_the_same_grant_for_mail_before_offering_consent() {
        let requests = std::sync::Mutex::new(Vec::new());
        let rotations = std::sync::Mutex::new(Vec::new());
        let mut replies = std::collections::VecDeque::from([
            reply(400, unconsented_graph()),
            reply(200, mail_grant()),
        ]);
        let answer = refresh_outlook_with(
            "synthetic-client",
            "synthetic-original",
            "graph",
            |body| {
                requests.lock().unwrap().push(body);
                let answer = replies.pop_front().expect("only one mail probe is allowed");
                async move { Ok(answer) }
            },
            |token| {
                rotations.lock().unwrap().push(token);
                async { Ok(()) }
            },
        )
        .await;
        assert_eq!(answer, Err("auth_consent_required"));
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let graph = &requests[0];
        let mail = &requests[1];
        for body in [graph, mail] {
            assert!(body.contains("refresh_token=synthetic-original"));
            assert!(body.contains("client_id=synthetic-client"));
        }
        assert!(graph.contains("graph.microsoft.com"));
        assert!(!graph.contains("outlook.office.com"));
        assert!(mail.contains("outlook.office.com"));
        assert!(!mail.contains("graph.microsoft.com"));
        assert_eq!(
            rotations.lock().unwrap()[0]["refresh_token"],
            "synthetic-rotated"
        );
    }

    #[tokio::test]
    async fn graph_70000_needs_a_successful_mail_probe_not_a_cached_session() {
        let mut malformed = mail_grant();
        malformed["access_token"] = json!("synthetic\ninvalid");
        let mut partial = mail_grant();
        partial["scope"] = json!("https://outlook.office.com/SMTP.Send");
        for (probe, expected, stores) in [
            (
                Ok(reply(
                    400,
                    json!({"error":"invalid_grant","error_codes":[70000]}),
                )),
                "auth_signed_out",
                0,
            ),
            (
                Ok(reply(
                    400,
                    json!({"error":"invalid_grant","error_codes":[700082]}),
                )),
                "auth_signed_out",
                0,
            ),
            (
                Ok(reply(401, json!({"error":"invalid_client"}))),
                "auth_refresh_failed",
                0,
            ),
            (
                Ok(reply(503, json!({"error":"temporarily_unavailable"}))),
                "auth_refresh_failed",
                0,
            ),
            (Err("auth_timeout"), "auth_timeout", 0),
            (
                Ok(json!({"status":200,"body":"not-json"})),
                "auth_invalid_response",
                0,
            ),
            (Ok(reply(200, malformed)), "auth_invalid_response", 0),
            (Ok(reply(200, partial)), "auth_refresh_failed", 1),
        ] {
            let mut replies =
                std::collections::VecDeque::from([Ok(reply(400, unconsented_graph())), probe]);
            let mut requests = 0;
            let mut writes = 0;
            let result = refresh_outlook_with(
                "synthetic",
                "original",
                "graph",
                |_| {
                    requests += 1;
                    let answer = replies.pop_front().expect("probe must not retry");
                    async move { answer }
                },
                |_| {
                    writes += 1;
                    async { Ok(()) }
                },
            )
            .await;
            assert_eq!(result, Err(expected));
            assert_eq!(requests, 2);
            assert_eq!(writes, stores);
        }
    }

    #[tokio::test]
    async fn only_graph_70000_adds_a_mail_probe() {
        for (resource, response, expected) in [
            ("mail", unconsented_graph(), "auth_signed_out"),
            (
                "graph",
                json!({"error":"invalid_grant","error_codes":[700082]}),
                "auth_signed_out",
            ),
            (
                "graph",
                json!({"error":"invalid_client","error_codes":[70000]}),
                "auth_refresh_failed",
            ),
            (
                "graph",
                json!({"error":"temporarily_unavailable"}),
                "auth_refresh_failed",
            ),
            (
                "graph",
                json!({"error":"invalid_grant","error_codes":[65001]}),
                "auth_consent_required",
            ),
            (
                "graph",
                json!({"error":"invalid_grant","error_description":"AADSTS700000: not the same code"}),
                "auth_signed_out",
            ),
        ] {
            let mut requests = 0;
            let result = refresh_outlook_with(
                "synthetic",
                "original",
                resource,
                |_| {
                    requests += 1;
                    assert_eq!(requests, 1, "unrelated refusals must not probe mail");
                    let answer = reply(400, response.clone());
                    async move { Ok(answer) }
                },
                |_| async { panic!("a failed response cannot store a token") },
            )
            .await;
            assert_eq!(result, Err(expected));
        }
    }

    #[tokio::test]
    async fn graph_70000_description_and_rotation_failure_are_preserved() {
        let mut refusal = unconsented_graph();
        refusal.as_object_mut().unwrap().remove("error_codes");
        let mut replies =
            std::collections::VecDeque::from([reply(400, refusal), reply(200, mail_grant())]);
        let result = refresh_outlook_with(
            "synthetic",
            "original",
            "graph",
            |_| {
                let answer = replies.pop_front().unwrap();
                async move { Ok(answer) }
            },
            |_| async { Err("auth_keyring_failed") },
        )
        .await;
        assert_eq!(result, Err("auth_keyring_failed"));
        assert!(replies.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn graph_probe_shares_the_original_network_deadline() {
        let started = tokio::time::Instant::now();
        let mut calls = 0;
        let result = refresh_outlook_with(
            "synthetic",
            "original",
            "graph",
            |_| {
                calls += 1;
                let response = if calls == 1 {
                    reply(400, unconsented_graph())
                } else {
                    reply(200, mail_grant())
                };
                async move {
                    tokio::time::sleep(Duration::from_secs(12)).await;
                    Ok(response)
                }
            },
            |_| async { panic!("a timed-out probe must not rotate the grant") },
        )
        .await;
        assert_eq!(result, Err("auth_timeout"));
        assert_eq!(calls, 2);
        assert!(started.elapsed() <= Duration::from_secs(20));
    }

    #[tokio::test]
    async fn device_grant_store_waits_for_an_older_probe_rotation() {
        if crate::mail::tests::isolated() {
            return;
        }
        let account = "outlook:consent-race@example.org";
        let _fixture = crate::mail::tests::account_fixture(json!({"version":1,
            "activeId":account,"accounts":[{"provider":"outlook","email":"consent-race@example.org",
            "clientId":"synthetic-client","imap":{"tenant":"consumers"}}]}));
        let key = outlook_key("synthetic-client", account);
        struct RecordingStore {
            key: CredentialKey,
            writes: std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
        }
        impl store::CredentialStore for RecordingStore {
            fn get(&self, key: &CredentialKey) -> Result<Secret, StoreError> {
                assert_eq!(key, &self.key);
                Secret::new(self.writes.lock().unwrap().last().unwrap().clone())
            }
            fn put(&self, key: &CredentialKey, value: &[u8]) -> Result<(), StoreError> {
                assert_eq!(key, &self.key);
                self.writes.lock().unwrap().push(value.to_vec());
                Ok(())
            }
            fn delete(&self, _: &CredentialKey) -> Result<(), StoreError> {
                panic!("grant replacement cannot delete a credential")
            }
        }
        let writes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let _store = store::tests::isolated_store(RecordingStore {
            key: key.clone(),
            writes: writes.clone(),
        });
        let lane = account_tokens(account, "synthetic-client", "consumers")
            .await
            .unwrap();
        let mut probe = lane.lock().await;
        probe.insert(
            "graph".into(),
            (
                "old-graph".into(),
                std::time::Instant::now() + Duration::from_secs(3600),
            ),
        );
        let mut device = tokio::spawn(async move {
            Session::default()
                .call(
                    "auth.store",
                    &json!({"accountId":account,
                "clientId":"synthetic-client","token":"graph-device-refresh"}),
                )
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut device)
                .await
                .is_err(),
            "device store must wait for the older refresh lane"
        );
        assert!(writes.lock().unwrap().is_empty());
        persist_outlook_rotation(
            "original",
            &json!({"refresh_token":"mail-probe-rotation"}),
            key.clone(),
            false,
        )
        .await
        .unwrap();
        drop(probe);
        assert_eq!(device.await.unwrap().unwrap()["saved"], true);
        assert_eq!(
            *writes.lock().unwrap(),
            vec![
                b"mail-probe-rotation".to_vec(),
                b"graph-device-refresh".to_vec()
            ]
        );
        assert!(
            lane.lock().await.is_empty(),
            "device grant invalidates cached resource tokens"
        );
        assert_eq!(
            store::get(key).await.unwrap().as_slice(),
            b"graph-device-refresh"
        );
    }

    #[tokio::test]
    async fn outer_cancellation_cannot_release_a_lane_during_native_rotation() {
        if crate::mail::tests::isolated() {
            return;
        }
        let account = "outlook:cancelled-probe@example.org";
        let _fixture = crate::mail::tests::account_fixture(json!({"version":1,
            "activeId":account,"accounts":[{"provider":"outlook","email":"cancelled-probe@example.org",
            "clientId":"synthetic-client","imap":{"tenant":"consumers"}}]}));
        let key = outlook_key("synthetic-client", account);
        let writes = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Vec<u8>>::new()));
        let release =
            std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let finished = std::sync::Arc::new(tokio::sync::Notify::new());
        let (started, started_rx) = tokio::sync::oneshot::channel();
        struct BlockedStore {
            key: CredentialKey,
            writes: std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
            release: std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
            started: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
            finished: std::sync::Arc<tokio::sync::Notify>,
        }
        impl store::CredentialStore for BlockedStore {
            fn get(&self, _: &CredentialKey) -> Result<Secret, StoreError> {
                panic!("no native get")
            }
            fn delete(&self, _: &CredentialKey) -> Result<(), StoreError> {
                panic!("no native delete")
            }
            fn put(&self, key: &CredentialKey, value: &[u8]) -> Result<(), StoreError> {
                assert_eq!(key, &self.key);
                if value == b"mail-probe-rotation" {
                    self.started
                        .lock()
                        .unwrap()
                        .take()
                        .unwrap()
                        .send(())
                        .unwrap();
                    let (state, notify) = &*self.release;
                    let mut state = state.lock().unwrap();
                    while !*state {
                        state = notify.wait(state).unwrap();
                    }
                }
                self.writes.lock().unwrap().push(value.to_vec());
                if value == b"mail-probe-rotation" {
                    self.finished.notify_one();
                }
                Ok(())
            }
        }
        let _store = store::tests::isolated_store(BlockedStore {
            key: key.clone(),
            writes: writes.clone(),
            release: release.clone(),
            started: std::sync::Mutex::new(Some(started)),
            finished: finished.clone(),
        });
        let lane = account_tokens(account, "synthetic-client", "consumers")
            .await
            .unwrap();
        let older = tokio::spawn(in_outlook_lane(lane, move |tokens| async move {
            let result = persist_outlook_rotation(
                "original",
                &json!({"refresh_token":"mail-probe-rotation"}),
                key,
                false,
            )
            .await;
            drop(tokens);
            result
        }));
        started_rx.await.unwrap();
        older.abort();
        assert!(older.await.unwrap_err().is_cancelled());
        let mut device = tokio::spawn(async move {
            Session::default()
                .call(
                    "auth.store",
                    &json!({"accountId":account,
                "clientId":"synthetic-client","token":"graph-device-refresh"}),
                )
                .await
        });
        let early = tokio::time::timeout(Duration::from_millis(30), &mut device).await;
        let stayed_locked = early.is_err();
        let (state, notify) = &*release;
        *state.lock().unwrap() = true;
        notify.notify_all();
        finished.notified().await;
        let stored = match early {
            Ok(result) => result,
            Err(_) => device.await,
        };
        assert_eq!(stored.unwrap().unwrap()["saved"], true);
        assert!(
            stayed_locked,
            "caller cancellation must not release the native-write lane"
        );
        assert_eq!(
            *writes.lock().unwrap(),
            vec![
                b"mail-probe-rotation".to_vec(),
                b"graph-device-refresh".to_vec()
            ]
        );
    }

    #[tokio::test]
    async fn graph_refresh_after_device_consent_accepts_short_resource_scopes() {
        let mut calls = 0;
        let result = refresh_outlook_with(
            "synthetic",
            "graph-device-refresh",
            "graph",
            |body| {
                calls += 1;
                assert!(body.contains("refresh_token=graph-device-refresh"));
                let response = reply(
                    200,
                    json!({"access_token":"graph-token", "expires_in":3600,
                "refresh_token":"graph-rotated", "scope":"Mail.Send Calendars.ReadWrite"}),
                );
                async move { Ok(response) }
            },
            |token| {
                assert_eq!(token["refresh_token"], "graph-rotated");
                async { Ok(()) }
            },
        )
        .await;
        assert_eq!(calls, 1);
        assert_eq!(result, Ok(("graph-token".into(), 3600)));
    }

    #[test]
    fn scope_abbreviations_do_not_cross_resource_boundaries() {
        for granted in [
            "",
            "Mail.Send",
            "Calendars.ReadWrite",
            "https://outlook.office.com/Mail.Send Calendars.ReadWrite",
            "https://other.example/Mail.Send Calendars.ReadWrite",
        ] {
            assert!(!outlook_scopes(
                &json!({"scope": granted}),
                scope("graph").unwrap()
            ));
        }
        assert!(!outlook_scopes(
            &json!({"scope":"IMAP.AccessAsUser.All SMTP.Send"}),
            scope("mail").unwrap()
        ));
        assert!(!outlook_scopes(
            &json!({"scope":"Mail.Send Calendars.ReadWrite"}),
            scope("mail").unwrap()
        ));
    }

    #[tokio::test]
    async fn successful_graph_refresh_never_requests_mail() {
        let mut calls = 0;
        let result = refresh_outlook_with(
            "synthetic",
            "original",
            "graph",
            |_| {
                calls += 1;
                let response = reply(
                    200,
                    json!({"access_token":"graph-token", "expires_in":3600,
                "refresh_token":"graph-rotated", "scope":scope("graph").unwrap()}),
                );
                async move { Ok(response) }
            },
            |token| {
                assert_eq!(token["refresh_token"], "graph-rotated");
                async { Ok(()) }
            },
        )
        .await;
        assert_eq!(calls, 1);
        assert_eq!(result, Ok(("graph-token".into(), 3600)));
    }
    #[tokio::test]
    async fn outlook_readonly_refresh_never_persists_rotated_credentials() {
        let key = outlook_key("synthetic", "outlook:test@example.org");
        let token = json!({"refresh_token":"rotated-synthetic"});
        persist_outlook_rotation_with("old-synthetic", &token, key.clone(), true, |_, _| async {
            panic!("read-only refresh must never write credentials")
        })
        .await
        .unwrap();
        let calls = std::sync::Mutex::new(Vec::new());
        persist_outlook_rotation_with("old-synthetic", &token, key.clone(), false, |key, bytes| {
            calls.lock().unwrap().push((key, bytes));
            async { Ok(()) }
        })
        .await
        .unwrap();
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, key);
        assert!(calls[0].1.as_slice() == b"rotated-synthetic");
    }
    #[tokio::test]
    async fn invalidation_waits_for_rotation_without_opening_another_refresh_lane() {
        let account = "outlook:rotation-fixture@example.org";
        let lock = account_tokens(account, "synthetic", "consumers")
            .await
            .unwrap();
        let mut rotation = lock.lock().await;
        let invalidation = tokio::spawn(async move { invalidate(account).await });
        tokio::task::yield_now().await;
        assert!(!invalidation.is_finished());
        let another = account_tokens(account, "synthetic", "consumers")
            .await
            .unwrap();
        assert!(std::sync::Arc::ptr_eq(&lock, &another));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), another.lock())
                .await
                .is_err()
        );
        let independent = account_tokens(
            "outlook:other-fixture@example.org",
            "synthetic",
            "consumers",
        )
        .await
        .unwrap();
        assert!(
            independent.try_lock().is_ok(),
            "unrelated mailboxes must stay independent"
        );
        rotation.insert(
            "mail".into(),
            (
                "old-token".into(),
                std::time::Instant::now() + Duration::from_secs(3600),
            ),
        );
        drop(rotation);
        invalidation.await.unwrap().unwrap();
        assert!(
            lock.lock().await.is_empty(),
            "a completed old refresh must not restore the invalidated cache"
        );
    }
    #[tokio::test]
    async fn google_grant_is_bound_and_secret_is_only_in_memory() {
        let calls = std::sync::Mutex::new(Vec::new());
        let synthetic = "token'\\\"测试";
        store_google_with(
            "synthetic-client",
            "USER@example.org",
            synthetic,
            |args, bytes| {
                calls.lock().unwrap().push((args, bytes));
                async { Ok(()) }
            },
        )
        .await
        .unwrap();
        let calls = calls.into_inner().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].0,
            CredentialKey {
                provider: "gmail".into(),
                account_id: "user@example.org".into(),
                kind: CredentialKind::GoogleRefreshToken {
                    client_id: "synthetic-client".into()
                },
            }
        );
        assert!(calls[0].1.as_slice() == synthetic.as_bytes());
    }
    #[tokio::test]
    async fn invalid_google_grant_never_invokes_keyring() {
        for bad in ["", "a\n", "a\r", "a\r\n", "a\0", "a "] {
            assert!(
                store_google_with("client", "user@example.org", bad, |_, _| async {
                    panic!("must not invoke keyring")
                })
                .await
                .is_err()
            );
        }
        for bad in [
            "",
            "user@example.org\n",
            "user@example.org\0",
            "user@example.org\r\n",
        ] {
            assert!(
                store_google_with("client", bad, "synthetic", |_, _| async {
                    panic!("must not invoke keyring")
                })
                .await
                .is_err()
            );
        }
    }
}
