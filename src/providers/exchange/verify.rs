//! `exchange.verify`: does this server accept this login, and what does the mailbox look like?
//!
//! - Sign-in `{address, settings, secret, requestToken?}`: the secret travels in the body only and
//!   the UI stores it after success. Nothing is read from or written to the registry or keyring; a
//!   refusal latched for the same credentials is lifted by an accepted sign-in.
//! - Restore `{accountId, requestToken?}`: settings and password as for any request.
//!
//! The answer is `{ok, email, scheme, serverVersion, roles, refusals}`: `scheme` is the one signed
//! in with (`ntlm` or `basic`), and the UI keeps `ntlm` in place of `auto`; `roles` holds
//! `{total, unread}` per folder (`null` when the account has none), `refusals` a sentence for the
//! one capability this can withdraw (`send`, without a Sent folder).

use std::sync::Arc;

use futures_util::FutureExt;
use serde_json::{Map, Value, json};

use super::ews::{Client, Config, Role};
use super::{INVALID, account, fields, ids, text, token};

pub async fn verify(params: &Value) -> Result<Value, &'static str> {
    if params.get("accountId").is_some() {
        let map = fields(params, &["accountId", "requestToken"])?;
        let account = super::account(map)?;
        let email = ids::account(&account)?.to_owned();
        return account::read(&account, token(map)?, move |client| {
            async move { answer(client, &email).await }.boxed()
        })
        .await;
    }
    let map = fields(params, &["address", "settings", "secret", "requestToken"])?;
    let account = format!("exchange:{}", text(map, "address")?.to_ascii_lowercase());
    let email = ids::account(&account)?;
    let settings = map.get("settings").ok_or(INVALID)?;
    if settings.as_object().is_none_or(|s| {
        s.keys()
            .any(|key| !["ewsUrl", "username", "authScheme"].contains(&key.as_str()))
    }) {
        return Err(INVALID);
    }
    // A URL the policy refuses has a sentence of its own in the form; any other bad field is a bad request.
    let (url, login, choice) = account::settings(settings, email).map_err(|code| {
        if code == "exchange_url_invalid" {
            code
        } else {
            INVALID
        }
    })?;
    let secret = text(map, "secret")?;
    if secret.is_empty()
        || secret.len() > account::MAX_PASSWORD
        || secret.chars().any(char::is_control)
    {
        return Err(INVALID);
    }
    let config = Arc::new(Config::new(url, choice, &login, secret));
    let mut client = Client::new(Arc::clone(&config));
    let deadline = account::deadline(account::TOTAL);
    client.until(deadline);
    let answer =
        account::guarded(&account, token(map)?, deadline, answer(&mut client, email)).await?;
    account::accepted(&account, &config);
    Ok(answer)
}

async fn answer(client: &mut Client, email: &str) -> Result<Value, &'static str> {
    let folders = client.refresh().await?;
    let counts = |role| {
        folders.get(role).map_or(
            Value::Null,
            |folder| json!({"total": folder.total, "unread": folder.unread}),
        )
    };
    let mut refusals = Map::new();
    if folders.get(Role::Sent).is_none() {
        refusals.insert(
            "send".into(),
            json!("No Sent folder was found on this server"),
        );
    }
    Ok(json!({
        "ok": true,
        "email": email,
        "scheme": client.scheme(),
        "serverVersion": client.version().unwrap_or_default(),
        "roles": {
            "inbox": counts(Role::Inbox),
            "sent": counts(Role::Sent),
            "drafts": counts(Role::Drafts),
            "trash": counts(Role::Trash),
            "junk": counts(Role::Junk),
        },
        "refusals": refusals,
    }))
}
