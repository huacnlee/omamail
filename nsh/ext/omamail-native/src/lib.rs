//! Omamail's Rust for the NSH app (`App.tsx` imports it as
//! `omamail-native`). The mail itself is the `omamail` library
//! ([`omamail::api`]); this crate runs it on a worker thread and hands
//! the results to TSX, so the UI thread never waits on the network.

mod theme;
mod worker;

use nsh_core::prelude::*;

/// The app's UI set: what `App.tsx` imports from `omamail-native`.
#[native_module("omamail-native")]
fn native(registry: &mut Registry) {
    registry.module::<Mail>().module::<Look>();
}

/// A configured account.
#[derive(Clone, Debug, JsObject)]
pub struct Account {
    /// The id other calls take.
    pub id: String,
    pub email: String,
    /// `gmail`, `imap`, `jmap`, `outlook`, `m365` or `hey`.
    pub provider: String,
    /// The user's name for the account; empty when unset.
    pub label: String,
}

/// The accounts and the one picked last.
#[derive(Clone, Debug, JsObject)]
pub struct Accounts {
    pub accounts: Vec<Account>,
    pub active_id: Option<String>,
}

/// A system mailbox.
#[derive(Clone, Debug, JsObject)]
pub struct Mailbox {
    /// The id `Mail.messages` takes: `inbox`, `sent`, ...
    pub id: String,
    pub title: String,
}

/// One row of a message list.
#[derive(Clone, Debug, JsObject)]
pub struct Message {
    pub id: String,
    pub subject: String,
    pub snippet: String,
    /// The sender's name, or the address when there is none.
    pub from: String,
    pub from_email: String,
    /// Short time for the list: `21m`, `Nov 3`.
    pub time: String,
    pub full_time: String,
    pub unread: bool,
    pub starred: bool,
}

/// One page of a mailbox.
#[derive(Clone, Debug, JsObject)]
pub struct MessagePage {
    pub account_id: String,
    pub mailbox: String,
    pub messages: Vec<Message>,
    /// Pass to `Mail.messages` for the next page; empty on the last one.
    pub next_page_token: String,
}

/// The mail library: accounts, mailboxes and messages.
#[module]
pub struct Mail;

#[module]
impl Mail {
    /// The configured accounts.
    pub async fn accounts() -> Result<Accounts, String> {
        let accounts = worker::run(|mail| async move { mail.accounts().await }).await?;
        Ok(Accounts {
            accounts: accounts
                .accounts
                .into_iter()
                .filter(|a| !a.pending)
                .map(|a| Account {
                    id: a.id,
                    email: a.email,
                    provider: a.provider,
                    label: a.label,
                })
                .collect(),
            active_id: accounts.active_id,
        })
    }

    /// The system mailboxes, in the sidebar's order.
    pub fn mailboxes() -> Vec<Mailbox> {
        omamail::api::mailboxes::SYSTEM
            .iter()
            .map(|m| Mailbox {
                id: m.id.to_owned(),
                title: m.title.to_owned(),
            })
            .collect()
    }

    /// A page of `limit` (1 to 100) messages of `mailbox` in `account`,
    /// newest first; `pageToken` continues a page before. Rejects with the
    /// backend's error code (`auth_required`, `mail_account_unknown`, ...).
    pub async fn messages(
        account: String,
        mailbox: String,
        limit: u32,
        page_token: Option<String>,
    ) -> Result<MessagePage, String> {
        let query = omamail::api::ListQuery {
            account: Some(account),
            mailbox,
            query: String::new(),
            limit: limit.clamp(1, 100) as u16,
            page_token: page_token.unwrap_or_default(),
        };
        let page = worker::run(move |mail| async move { mail.messages(&query).await }).await?;
        Ok(MessagePage {
            account_id: page.account_id,
            mailbox: page.mailbox,
            next_page_token: page.next_page_token,
            messages: page
                .messages
                .into_iter()
                .map(|m| Message {
                    from: if m.from.display.is_empty() {
                        m.from.email.clone()
                    } else {
                        m.from.display
                    },
                    from_email: m.from.email,
                    id: m.id,
                    subject: m.subject,
                    snippet: m.snippet,
                    time: m.time,
                    full_time: m.full_time,
                    unread: m.unread,
                    starred: m.starred,
                })
                .collect(),
        })
    }
}

/// Omamail's look: NsVim's palettes drawn through nsh-omarchy.
#[module]
pub struct Look;

#[module]
impl Look {
    /// Draws the app with NsVim's dark or light palette.
    pub fn apply(dark: bool, _cx: &mut ModuleCx) {
        theme::palette(dark).apply();
    }
}
