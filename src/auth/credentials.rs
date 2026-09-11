//! Account-bound keyring resolution used by autonomous backend jobs.
use super::*;

pub fn settings(provider: &str, account: &str) -> Result<Value, &'static str> {
    if !["gmail", "outlook", "imap", "jmap"].contains(&provider)
        || account.is_empty()
        || account.len() > 1024
        || account.chars().any(char::is_control)
    {
        return Err("auth_account_invalid");
    }
    let raw = crate::account::raw_registry()?;
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

async fn keyring(args: Vec<String>, input: Vec<u8>) -> Result<String, &'static str> {
    let result = crate::process::async_run::run(
        "secret-tool",
        &args,
        &input,
        Duration::from_secs(15),
        16385,
    )
    .await
    .map_err(|_| "auth_keyring_failed")?;
    if !result.success {
        if args.first().is_some_and(|s| s == "lookup")
            && result.stdout.is_empty()
            && result.stderr.is_empty()
        {
            return Err("auth_signed_out");
        }
        return Err("auth_keyring_failed");
    }
    let bytes = result.stdout;
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    let value = std::str::from_utf8(bytes).map_err(|_| "auth_secret_invalid")?;
    if value.len() > 16384 || value.chars().any(char::is_control) {
        return Err("auth_secret_invalid");
    }
    Ok(value.to_owned())
}

pub async fn password(provider: &str, account: &str) -> Result<String, &'static str> {
    valid_account(provider, account)?;
    let kind = match provider {
        "imap" => "imap-password",
        "jmap" => "jmap-secret",
        _ => return Err("auth_provider_invalid"),
    };
    let args = [
        "lookup",
        "service",
        "omamail",
        "kind",
        kind,
        "account",
        &account.to_lowercase(),
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    let secret = keyring(args, vec![]).await?;
    if secret.is_empty() {
        return Err("auth_signed_out");
    }
    Ok(secret)
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
    if provider != "outlook" {
        return Err("auth_provider_invalid");
    }
    valid_account(provider, account)?;
    let scope = scope(resource)?;
    let owned = account.to_owned();
    let entry = tokio::task::spawn_blocking(move || settings("outlook", &owned))
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
    // One refresh at a time per mailbox, shared by mail and Graph resources:
    // rotating a refresh token must not race another resource's exchange.
    let mut tokens = lock.lock().await;
    if let Some((token, expiry)) = tokens.get(resource)
        && *expiry > std::time::Instant::now() + Duration::from_secs(60)
    {
        return Ok(token.clone());
    }
    let attrs = [
        "service",
        "omamail",
        "kind",
        "outlook-refresh-token",
        "client-id",
        client_id,
        "account",
        &account.to_lowercase(),
    ]
    .map(str::to_owned);
    let args = std::iter::once("lookup".to_owned())
        .chain(attrs.iter().cloned())
        .collect();
    let refresh = keyring(args, vec![]).await?;
    if refresh.is_empty() {
        return Err("auth_signed_out");
    }
    let reply = post(
        client()?,
        &url,
        callback::form(&[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh),
            ("scope", scope),
        ]),
    )
    .await?;
    let token: Value = serde_json::from_str(reply["body"].as_str().ok_or("auth_invalid_response")?)
        .map_err(|_| "auth_invalid_response")?;
    if reply["status"] != 200 {
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
    let access = token["access_token"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 16384
                && !s.chars().any(|c| c.is_whitespace() || c.is_control())
        })
        .ok_or("auth_invalid_response")?;
    if let Some(rotated) = token["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != refresh)
    {
        if rotated.len() > 16384 || rotated.chars().any(char::is_control) {
            return Err("auth_invalid_response");
        }
        let args = ["store".into(), "--label=Omamail Outlook".into()]
            .into_iter()
            .chain(attrs)
            .collect();
        keyring(args, rotated.as_bytes().to_vec()).await?;
    }
    let granted = token["scope"].as_str().unwrap_or("");
    if scope
        .split_whitespace()
        .filter(|s| s.starts_with("https://"))
        .any(|required| !granted.split_whitespace().any(|s| s == required))
    {
        return Err("auth_consent_required");
    }
    let lifetime = token["expires_in"]
        .as_u64()
        .filter(|n| *n <= 86400)
        .unwrap_or(0);
    tokens.insert(
        resource.to_owned(),
        (
            access.to_owned(),
            std::time::Instant::now() + Duration::from_secs(lifetime),
        ),
    );
    Ok(access.to_owned())
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
    let mut tokens = lock.lock().await;
    let mut args: Vec<String> = if clear {
        vec!["clear".into()]
    } else {
        vec!["store".into(), "--label=Omamail Outlook".into()]
    };
    args.extend(
        [
            "service",
            "omamail",
            "kind",
            "outlook-refresh-token",
            "client-id",
            client,
            "account",
            &account.to_lowercase(),
        ]
        .map(str::to_owned),
    );
    keyring(args, token.as_bytes().to_vec()).await?;
    tokens.clear();
    Ok(json!({"saved":!clear,"cleared":clear}))
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
    store_google_with(client_id, account, token, keyring).await
}

async fn store_google_with<F, Fut>(
    client_id: &str,
    account: &str,
    token: &str,
    mut run: F,
) -> Result<(), &'static str>
where
    F: FnMut(Vec<String>, Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<String, &'static str>>,
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
    let old = [
        "clear",
        "service",
        "omamail",
        "kind",
        "refresh-token",
        "client-id",
        client_id,
        "account",
        &account.to_lowercase(),
    ]
    .map(str::to_owned)
    .to_vec();
    // Match the existing current-grant migration: libsecret may otherwise
    // replace a pre-grant item while retaining its old attribute set.
    let _ = run(old, vec![]).await;
    let args = [
        "store",
        "--label=Omamail Google",
        "service",
        "omamail",
        "kind",
        "refresh-token",
        "client-id",
        client_id,
        "account",
        &account.to_lowercase(),
        "grant",
        "calendar-events-v1",
    ]
    .map(str::to_owned)
    .to_vec();
    run(args, token.as_bytes().to_vec()).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
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
    async fn google_grant_is_bound_and_secret_is_only_stdin() {
        let calls = std::sync::Mutex::new(Vec::new());
        let synthetic = "token'\\\"测试";
        store_google_with(
            "synthetic-client",
            "USER@example.org",
            synthetic,
            |args, bytes| {
                calls.lock().unwrap().push((args, bytes));
                async { Ok(String::new()) }
            },
        )
        .await
        .unwrap();
        let calls = calls.into_inner().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0].0,
            [
                "clear",
                "service",
                "omamail",
                "kind",
                "refresh-token",
                "client-id",
                "synthetic-client",
                "account",
                "user@example.org"
            ]
        );
        assert!(calls[0].1.is_empty());
        assert_eq!(
            calls[1].0,
            [
                "store",
                "--label=Omamail Google",
                "service",
                "omamail",
                "kind",
                "refresh-token",
                "client-id",
                "synthetic-client",
                "account",
                "user@example.org",
                "grant",
                "calendar-events-v1"
            ]
        );
        assert_eq!(calls[1].1, synthetic.as_bytes());
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
