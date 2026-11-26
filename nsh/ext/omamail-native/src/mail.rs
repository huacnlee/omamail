//! `Accounts` and `Mail`: the operations TSX calls.

use nsh_core::prelude::*;
use serde_json::json;

use crate::engine::engine;
use crate::types::{Account, MessageDetail, MessagePage};

/// The configured mail accounts.
#[module]
pub struct Accounts;

#[module]
impl Accounts {
    /// Every configured account, in the user's order.
    pub async fn list() -> Result<Vec<Account>, String> {
        let value = engine().call("accounts.list", json!({})).await?;
        Ok(value["accounts"]
            .as_array()
            .map(|rows| rows.iter().map(Account::from_value).collect())
            .unwrap_or_default())
    }
}

/// Reads and changes mail.
#[module]
pub struct Mail;

#[module]
impl Mail {
    /// One page of `mailbox` ("inbox", "unread", "starred", "sent", "drafts",
    /// "archive", "spam" or "trash") in `account`, filtered by `query` in the
    /// provider's search syntax. `page_token` is empty for the first page.
    pub async fn list(
        account: String,
        mailbox: String,
        query: String,
        page_token: String,
        limit: u32,
    ) -> Result<MessagePage, String> {
        let value = engine()
            .call(
                "mail.list",
                json!({"account":account,"mailbox":mailbox,"query":query,"pageToken":page_token,"limit":limit.clamp(1, 100)}),
            )
            .await?;
        Ok(MessagePage::from_value(&value))
    }

    /// Opens one message without marking it read.
    pub async fn read(account: String, id: String) -> Result<MessageDetail, String> {
        let value = engine()
            .call("mail.read", json!({"account":account,"id":id}))
            .await?;
        Ok(MessageDetail::from_value(&value))
    }

    /// Applies `operation` ("read", "unread", "star", "unstar", "archive",
    /// "trash" and the other `omamail` actions) to `ids`.
    pub async fn act(account: String, operation: String, ids: Vec<String>) -> Result<(), String> {
        engine()
            .call(
                "mail.act",
                json!({"account":account,"operation":operation,"ids":ids,"execute":true}),
            )
            .await?;
        Ok(())
    }
}
