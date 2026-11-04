//! Microsoft 365 sign-in tokens: one Graph refresh token per mailbox, refreshed in the lane Outlook's
//! are (one refresh at a time, a rotated token saved before it is used), with its own scope, consent
//! rule and login authority. Nothing here changes what Outlook does.
use super::*;

/// What one sign-in asks for: Graph permissions only, so one device code covers mail and calendar
/// (Microsoft refuses a code that names two resources). `email` puts the address in the id token.
pub(crate) const SCOPE: &str = "openid profile email offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite";
const GRAPH: &str = "https://graph.microsoft.com/";
const ORGANIZATIONS: &str = "organizations";
/// Both attempts of one login request share this, below the 30 seconds the desktop waits.
const LOGIN_BUDGET: Duration = Duration::from_secs(20);

/// An Application (client) ID as every request, keyring item and refresh lane of this provider names
/// it: a GUID, in lower case. The portal shows it in lower case; a person may still type it in upper.
pub(crate) fn client_id(text: &str) -> Option<String> {
    let groups: Vec<&str> = text.split('-').collect();
    let sound = groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()));
    sound.then(|| text.to_ascii_lowercase())
}

/// Whether `granted` (a token response's `scope`) holds every Graph permission of `SCOPE`. Microsoft
/// writes a permission with or without the resource prefix and in either case.
pub(crate) fn permissions_granted(granted: &str) -> bool {
    let bare = |scope: &'_ str| {
        scope
            .strip_prefix(GRAPH)
            .unwrap_or(scope)
            .to_ascii_lowercase()
    };
    SCOPE
        .split_whitespace()
        .filter_map(|scope| scope.strip_prefix(GRAPH))
        .all(|asked| {
            granted
                .split_whitespace()
                .any(|scope| bare(scope) == asked.to_ascii_lowercase())
        })
}

/// The tenant a login request for `address` goes to: the domain after `@` (Microsoft takes a domain
/// of an organization for its tenant) when it is a plain hostname, else `organizations`. A single-tenant
/// registration signs in only through its own tenant, so the portal's default needs this.
fn authority(address: &str) -> String {
    let label = |label: &str| {
        (1..=63).contains(&label.len())
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    match address.rsplit_once('@') {
        Some((_, domain))
            if domain.len() <= 253 && domain.contains('.') && domain.split('.').all(label) =>
        {
            domain.to_ascii_lowercase()
        }
        _ => ORGANIZATIONS.into(),
    }
}

/// Microsoft says the tenant does not exist (or is no name at all): nobody has that domain.
pub(crate) fn tenant_unknown(body: &Value) -> bool {
    body["error"] == "invalid_tenant" || aadsts_code(body, 90002) || aadsts_code(body, 900023)
}

/// Microsoft says consent was never given (65001) or needs an administrator (90094).
pub(crate) fn consent_needed(body: &Value) -> bool {
    aadsts_code(body, 65001) || aadsts_code(body, 90094)
}

/// A form request to the login host as it answered: status and JSON body.
pub(crate) async fn login_at(
    authority: &str,
    endpoint: &str,
    fields: &[(&str, &str)],
) -> Result<(u16, Value), &'static str> {
    // The one place a login URL is made, and where the tenant is judged to be one plain name.
    let url = destination(&json!({"provider":"outlook", "endpoint":endpoint, "tenant":authority}))?;
    let reply = post_login(&url, callback::form(fields)).await?;
    let status = reply["status"].as_u64().ok_or("auth_invalid_response")?;
    let body = serde_json::from_str(reply["body"].as_str().ok_or("auth_invalid_response")?)
        .map_err(|_| "auth_invalid_response")?;
    Ok((status as u16, body))
}

/// A login request for `address`: to its domain's tenant, and if Microsoft does not know that
/// domain, once more to `organizations` (a registration for any directory takes people whose
/// domain is not their tenant's own). Answers the authority that answered, so a flow can keep to it.
pub(crate) async fn login(
    address: &str,
    endpoint: &str,
    fields: &[(&str, &str)],
) -> Result<(String, u16, Value), &'static str> {
    let domain = authority(address);
    tokio::time::timeout(LOGIN_BUDGET, async {
        let (status, body) = login_at(&domain, endpoint, fields).await?;
        if status == 200 || domain == ORGANIZATIONS || !tenant_unknown(&body) {
            return Ok((domain, status, body));
        }
        let (status, body) = login_at(ORGANIZATIONS, endpoint, fields).await?;
        Ok((ORGANIZATIONS.into(), status, body))
    })
    .await
    .map_err(|_| "auth_timeout")?
}

/// A test build can send login requests to a local listener (`http://127.0.0.1:<port>`); nothing in
/// a release build, a setting or the environment can name another host.
#[cfg(test)]
pub(crate) static TEST_LOGIN: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

async fn post_login(url: &str, body: String) -> Result<Value, &'static str> {
    #[cfg(test)]
    let local = TEST_LOGIN.lock().unwrap_or_else(|e| e.into_inner()).clone();
    #[cfg(test)]
    if let Some(local) = local {
        // The production client but for the HTTPS requirement.
        let client = builder().build().map_err(|_| "auth_transport_failed")?;
        let url = url.replacen("https://login.microsoftonline.com", &local, 1);
        return post(&client, &url, body).await;
    }
    post(client()?, url, body).await
}

fn key(client: &str, account: &str) -> CredentialKey {
    CredentialKey {
        provider: "m365".into(),
        account_id: account.to_lowercase(),
        kind: CredentialKind::M365RefreshToken {
            client_id: client.into(),
        },
    }
}

/// The account's lane (see `in_outlook_lane`): the same for every caller of one mailbox and client.
async fn lane(account: &str, client: &str) -> Result<AccountTokens, &'static str> {
    account_tokens(account, client, "m365").await
}

/// A Graph access token from the mailbox's refresh token, cached until it nears expiry.
pub(super) async fn access_token(account: &str, read_only: bool) -> Result<String, &'static str> {
    valid_account("m365", account)?;
    let owned = account.to_owned();
    let entry = tokio::task::spawn_blocking(move || {
        if read_only {
            settings_readonly("m365", &owned)
        } else {
            settings("m365", &owned)
        }
    })
    .await
    .map_err(|_| "auth_account_invalid")??;
    let client = entry["clientId"].as_str().ok_or("auth_client_missing")?;
    let client = client_id(client).ok_or("auth_client_invalid")?;
    let lane = lane(account, &client).await?;
    let account = account.to_owned();
    in_outlook_lane(lane, move |mut tokens| async move {
        let now = (std::time::Instant::now(), std::time::SystemTime::now());
        if let Some(token) = cached_token(&tokens, "graph", now.0, now.1) {
            return Ok(token);
        }
        let key = key(&client, &account);
        let secret = store::get(key.clone()).await.map_err(store_error)?;
        let refresh = text_secret(&secret)?;
        let address = account.strip_prefix("m365:").unwrap_or(&account);
        let fields = [
            ("client_id", client.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("scope", SCOPE),
        ];
        let (_, status, token) = login(address, "token", &fields).await?;
        if status != 200 {
            return Err(if consent_needed(&token) {
                "auth_consent_required"
            } else if token["error"] == "invalid_grant" {
                "auth_signed_out"
            } else {
                "auth_refresh_failed"
            });
        }
        let access = outlook_access(&token)?;
        persist_outlook_rotation(refresh, &token, key, read_only).await?;
        if !permissions_granted(token["scope"].as_str().unwrap_or("")) {
            return Err("auth_consent_required");
        }
        let lifetime = token["expires_in"]
            .as_u64()
            .filter(|n| *n <= 86400)
            .unwrap_or(0);
        let expiry = TokenExpiry::after(
            Duration::from_secs(lifetime),
            std::time::Instant::now(),
            std::time::SystemTime::now(),
        );
        tokens.insert("graph".into(), (access.to_owned(), expiry));
        Ok(access.to_owned())
    })
    .await
}

/// Keeps (`Some`) or deletes (`None`) the mailbox's refresh token under the lane its refreshes use, so
/// a rotation cannot land after the change. The account entry may not exist yet: a sign-in comes first.
pub(crate) async fn change(
    account: &str,
    client: &str,
    token: Option<&str>,
) -> Result<(), &'static str> {
    change_while(account, client, token, || true)
        .await
        .map(|_| ())
}

/// Saves a device grant only while its flow is current. The checks, save and any rollback own one
/// refresh lane, so a cancelled grant can never delete a newer grant queued behind its keyring write.
pub(crate) async fn save_grant(
    account: &str,
    client: &str,
    token: &str,
    current: impl Fn() -> bool + Send + 'static,
) -> Result<bool, &'static str> {
    change_while(account, client, Some(token), current).await
}

async fn change_while(
    account: &str,
    client: &str,
    token: Option<&str>,
    current: impl Fn() -> bool + Send + 'static,
) -> Result<bool, &'static str> {
    valid_account("m365", account)?;
    let client = &client_id(client).ok_or("auth_client_invalid")?;
    let secret = token
        .map(|token| {
            if token.is_empty() || token.len() > 16384 || token.chars().any(char::is_control) {
                return Err("auth_secret_invalid");
            }
            Secret::new(token.as_bytes().to_vec()).map_err(store_error)
        })
        .transpose()?;
    let lane = lane(account, client).await?;
    let key = key(client, account);
    in_outlook_lane(lane, move |mut tokens| async move {
        if !current() {
            return Ok(false);
        }
        if let Some(secret) = secret {
            store::put(key.clone(), secret).await.map_err(store_error)?;
            tokens.clear();
            if current() {
                return Ok(true);
            }
            // A cancellation during the native write is undone before another grant or refresh
            // can take this lane. Comparing token bytes would not protect a reused token value.
        }
        match store::delete(key).await {
            Ok(()) | Err(StoreError::Missing) => {}
            Err(error) => return Err(store_error(error)),
        }
        tokens.clear();
        Ok(false)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_login_goes_to_the_domain_of_the_address_when_that_is_a_plain_hostname() {
        for (address, expected) in [
            ("a@example.org", "example.org"),
            ("a@Sub.Example.ORG", "sub.example.org"),
            ("a@xn--bcher-kva.example", "xn--bcher-kva.example"),
            ("a@localhost", "organizations"),
            ("a@exa_mple.org", "organizations"),
            ("a@a..org", "organizations"),
            ("a@-a.org", "organizations"),
            ("a@a-.org", "organizations"),
            ("a@b\u{fc}cher.example", "organizations"),
            ("a@a/b.org", "organizations"),
            ("a@a.org.", "organizations"),
            ("no-at-sign", "organizations"),
        ] {
            assert_eq!(authority(address), expected, "{address}");
        }
        for long in [
            format!("a@{}.org", "a".repeat(64)),
            format!("a@{}", vec!["aa"; 130].join(".")),
        ] {
            assert_eq!(authority(&long), "organizations");
        }
    }

    #[test]
    fn a_grant_is_judged_by_the_graph_permissions_in_either_spelling() {
        assert!(SCOPE.contains("email") && !SCOPE.contains("outlook.office.com"));
        let all = "Mail.ReadWrite Mail.Send Calendars.ReadWrite openid profile";
        assert!(permissions_granted(all));
        assert!(permissions_granted(&all.to_uppercase()));
        assert!(permissions_granted(&SCOPE.replace("openid", "")));
        for short in [
            "",
            "openid",
            "Mail.ReadWrite Mail.Send",
            "Mail.Read Mail.Send Calendars.ReadWrite",
            "https://outlook.office.com/Mail.ReadWrite Mail.Send Calendars.ReadWrite",
        ] {
            assert!(!permissions_granted(short), "{short}");
        }
    }

    #[test]
    fn microsofts_numbers_say_consent_or_tenant_and_its_words_are_not_read() {
        assert!(consent_needed(&json!({"error_codes":[65001]})));
        assert!(consent_needed(
            &json!({"error_description":"AADSTS90094: needs admin"})
        ));
        assert!(tenant_unknown(&json!({"error":"invalid_tenant"})));
        assert!(tenant_unknown(&json!({"error_codes":[90002]})));
        assert!(tenant_unknown(&json!({"error_codes":[900023]})));
        for body in [
            json!({}),
            json!({"error":"invalid_grant"}),
            json!({"error_codes":[50194]}),
            json!({"error_description":"secret AADSTS65001 words"}),
        ] {
            assert!(!tenant_unknown(&body) && !consent_needed(&body), "{body}");
        }
    }
}
