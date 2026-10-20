//! The background check behind `mail.watch`: unread count, the newest unread messages and a
//! fingerprint. Two requests on an already signed-in connection (`GetFolder`, then `FindItem` for
//! the three newest unread), with nothing cached. The fingerprint is the hex SHA-256 of
//! `total|unread|ids`, which changes when mail arrives, is read or moves.

use futures_util::FutureExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::ews::{Condition, Role};
use super::{account, ids, resource};

pub(crate) async fn check(account: &str) -> Result<Value, &'static str> {
    ids::account(account)?;
    // Boxed: the sync layer awaits this inside its own, already large, future.
    Box::pin(account::read(account, None, |client| {
        async move {
            let folders = client.refresh().await?;
            let found = client
                .find(Role::Inbox, 3, 0, &[Condition::Unread], None)
                .await?;
            let inbox = folders.get(Role::Inbox);
            let messages: Vec<Value> = found
                .items
                .iter()
                .filter_map(|item| resource::row(item, &folders).ok())
                .collect();
            let listed: Vec<&str> = messages
                .iter()
                .filter_map(|message| message["id"].as_str())
                .collect();
            let (total, unread) = inbox.map_or((0, 0), |folder| (folder.total, folder.unread));
            let digest =
                Sha256::digest(format!("{total}|{unread}|{}", listed.join(",")).as_bytes());
            Ok(json!({
                "estimate": unread,
                "fingerprint": digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
                "messages": messages,
            }))
        }
        .boxed()
    }))
    .await
}
