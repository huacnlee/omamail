//! `m365.verify` (is this mailbox signed in, and what does it look like?) and the background check
//! behind `mail.watch`.
//!
//! Verify refreshes the token from the keyring's refresh token, so it is the real sign-in check: a
//! refused grant, a withdrawn consent and a mailbox without Graph mail all show here. It reads the
//! folder table afresh and answers `{ok, email, displayName, roles, refusals}`: `roles` holds
//! `{total, unread}` per folder role (`null` when the mailbox has none; Archive often has not),
//! `refusals` the withdrawn capabilities (`send` without a Sent folder, `archive` without an Archive).
//! `displayName` is empty: the permissions asked for include no profile read.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::actions::with_archive_refusal;
use super::cancel::guarded;
use super::graph::Graph;
use super::model::{self, Role};
use super::{ids, params};

const SEND_REFUSAL: &str = "No Sent folder was found in this mailbox";

pub(super) async fn verify(request: &Value) -> Result<Value, &'static str> {
    let map = params::object(request, &["accountId", "requestToken"])?;
    let account = params::account(map)?;
    let token = params::request_token(map)?;
    guarded(account, token, async {
        let roles = Graph::new(account).roles(true).await?;
        let counts = |role: Role| {
            roles.get(&role).map_or(
                Value::Null,
                |f| json!({"total": f.total, "unread": f.unread}),
            )
        };
        let mut refusals = Map::new();
        if !roles.contains_key(&Role::Sent) {
            refusals.insert("send".into(), json!(SEND_REFUSAL));
        }
        let refusals =
            with_archive_refusal(Value::Object(refusals), roles.contains_key(&Role::Archive));
        Ok(json!({
            "ok": true,
            "email": account.strip_prefix("m365:").unwrap_or(account),
            "displayName": "",
            "roles": {
                "inbox": counts(Role::Inbox), "sent": counts(Role::Sent),
                "drafts": counts(Role::Drafts), "trash": counts(Role::Trash),
                "junk": counts(Role::Junk), "archive": counts(Role::Archive),
            },
            "refusals": refusals,
        }))
    })
    .await
}

/// The check behind `mail.watch`: the Inbox's unread count, a sample of the newest unread rows and a
/// fingerprint of the Inbox (`total|unread|ids`) that changes when mail arrives, is read or moves.
pub(crate) async fn check(account: &str) -> Result<Value, &'static str> {
    let account = ids::account_id(account)?;
    // Boxed: the sync layer awaits this inside its own, already large, future.
    Box::pin(guarded(account, None, async {
        let graph = Graph::new(account);
        let inbox = graph
            .folder(Role::Inbox)
            .await?
            .ok_or("m365_folder_unavailable")?;
        let roles = model::Roles::from([(Role::Inbox, inbox.clone())]);
        let unread = model::parse("role:inbox unseen")?;
        let page = graph.page(&roles, &unread, 3, None).await?;
        let digest = Sha256::digest(format!(
            "{}|{}|{}",
            inbox.total,
            inbox.unread,
            page.ids.join(",")
        ));
        Ok(json!({
            "estimate": page.estimate,
            "fingerprint": digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            "messages": page.rows,
        }))
    }))
    .await
}
