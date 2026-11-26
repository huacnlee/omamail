//! The mail state the screens read: connection, accounts, the selected
//! mailbox and its messages, the open message. One owner, private
//! signals behind read accessors, changes through methods.

use std::rc::Rc;

use nsh_core::prelude::*;
use serde_json::{Value, json};

use crate::{
    backend::{Backend, Pins, RpcError, handshake},
    reader_html,
};

/// The system mailboxes `mail.list` takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mailbox {
    Inbox,
    Unread,
    Starred,
    Sent,
    Drafts,
    Archive,
    Spam,
    Trash,
}

impl Mailbox {
    pub const ALL: [Mailbox; 8] = [
        Mailbox::Inbox,
        Mailbox::Unread,
        Mailbox::Starred,
        Mailbox::Sent,
        Mailbox::Drafts,
        Mailbox::Archive,
        Mailbox::Spam,
        Mailbox::Trash,
    ];

    /// Its name in the protocol.
    pub fn id(self) -> &'static str {
        match self {
            Mailbox::Inbox => "inbox",
            Mailbox::Unread => "unread",
            Mailbox::Starred => "starred",
            Mailbox::Sent => "sent",
            Mailbox::Drafts => "drafts",
            Mailbox::Archive => "archive",
            Mailbox::Spam => "spam",
            Mailbox::Trash => "trash",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Mailbox::Inbox => "Inbox",
            Mailbox::Unread => "Unread",
            Mailbox::Starred => "Starred",
            Mailbox::Sent => "Sent",
            Mailbox::Drafts => "Drafts",
            Mailbox::Archive => "Archive",
            Mailbox::Spam => "Spam",
            Mailbox::Trash => "Trash",
        }
    }
}

/// An account as `accounts.list` lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct Account {
    pub id: SharedString,
    pub email: SharedString,
    pub label: SharedString,
}

/// A message row as `mail.list` summarizes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    pub id: SharedString,
    pub sender: SharedString,
    pub subject: SharedString,
    pub snippet: SharedString,
    pub time: SharedString,
    pub unread: bool,
    pub starred: bool,
}

impl Summary {
    pub fn from_json(value: &Value) -> Option<Self> {
        let text = |v: &Value| SharedString::from(v.as_str().unwrap_or_default().to_owned());
        let from = &value["from"];
        let sender = from["name"]
            .as_str()
            .filter(|n| !n.is_empty())
            .or_else(|| from["email"].as_str())
            .or_else(|| from.as_str())
            .unwrap_or_default();
        Some(Self {
            id: text(value.get("id")?),
            sender: sender.to_owned().into(),
            subject: text(&value["subject"]),
            snippet: text(&value["snippet"]),
            time: text(&value["time"]),
            unread: value["unread"] == true,
            starred: value["starred"] == true,
        })
    }
}

/// The connection to the backend.
#[derive(Clone, Debug, PartialEq)]
pub enum Connection {
    Connecting,
    Ready,
    Failed(SharedString),
}

/// What the reader shows.
#[derive(Clone, Debug, PartialEq)]
pub enum Reader {
    Empty,
    Loading,
    Ready {
        subject: SharedString,
        sender: SharedString,
        html: SharedString,
    },
    Failed(SharedString),
}

thread_local! {
    /// The backends of the stores on this (the engine's) thread, so a
    /// store is `Copy` like the signals it holds.
    static BACKENDS: std::cell::RefCell<Vec<Rc<dyn Backend>>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// The app's mail state.
#[derive(Clone, Copy)]
pub struct MailStore {
    backend: usize,
    connection: Signal<Connection>,
    accounts: Signal<Vec<Account>>,
    account: Signal<Option<SharedString>>,
    mailbox: Signal<Mailbox>,
    messages: Signal<Vec<Summary>>,
    inbox_unread: Signal<usize>,
    loading: Signal<bool>,
    selected: Signal<Option<SharedString>>,
    reader: Signal<Reader>,
    /// Bumped by each list and reader load, so a late answer is dropped.
    list_serial: Signal<u64>,
    reader_serial: Signal<u64>,
}

fn failure(error: &RpcError) -> SharedString {
    error.message.clone().into()
}

impl MailStore {
    pub fn new(backend: Rc<dyn Backend>) -> Self {
        let backend = BACKENDS.with_borrow_mut(|all| {
            all.push(backend);
            all.len() - 1
        });
        Self {
            backend,
            connection: signal(Connection::Connecting),
            accounts: signal(Vec::new()),
            account: signal(None),
            mailbox: signal(Mailbox::Inbox),
            messages: signal(Vec::new()),
            inbox_unread: signal(0),
            loading: signal(false),
            selected: signal(None),
            reader: signal(Reader::Empty),
            list_serial: signal(0),
            reader_serial: signal(0),
        }
    }

    fn backend(&self) -> Rc<dyn Backend> {
        BACKENDS.with_borrow(|all| all[self.backend].clone())
    }

    pub fn connection(&self) -> Connection {
        self.connection.get()
    }
    pub fn accounts(&self) -> Vec<Account> {
        self.accounts.get()
    }
    pub fn mailbox(&self) -> Mailbox {
        self.mailbox.get()
    }
    pub fn message_count(&self) -> usize {
        self.messages.with(|m| m.len())
    }
    pub fn message(&self, index: usize) -> Option<Summary> {
        self.messages.with(|m| m.get(index).cloned())
    }
    pub fn message_ids(&self) -> Vec<SharedString> {
        self.messages
            .with(|m| m.iter().map(|m| m.id.clone()).collect())
    }
    pub fn inbox_unread(&self) -> usize {
        self.inbox_unread.get()
    }
    pub fn loading(&self) -> bool {
        self.loading.get()
    }
    pub fn selected(&self) -> Option<SharedString> {
        self.selected.get()
    }
    pub fn reader(&self) -> Reader {
        self.reader.get()
    }

    /// Connects, lists the accounts, loads the inbox, watches it and
    /// follows the backend's pushed events. Runs with the calling owner.
    pub fn start(&self) {
        let store = *self;
        spawn(async move {
            if let Err(error) = handshake(store.backend().as_ref(), &Pins::compiled()).await {
                store.connection.set(Connection::Failed(failure(&error)));
                return;
            }
            let accounts = match store.backend().call("accounts.list", json!({})).await {
                Ok(list) => list,
                Err(error) => {
                    store.connection.set(Connection::Failed(failure(&error)));
                    return;
                }
            };
            let parsed: Vec<Account> = accounts["accounts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| {
                    Some(Account {
                        id: a["id"].as_str()?.to_owned().into(),
                        email: a["email"].as_str().unwrap_or_default().to_owned().into(),
                        label: a["label"].as_str().unwrap_or_default().to_owned().into(),
                    })
                })
                .collect();
            let active = accounts["activeId"]
                .as_str()
                .map(|id| SharedString::from(id.to_owned()))
                .or_else(|| parsed.first().map(|a| a.id.clone()));
            store.accounts.set(parsed);
            store.account.set(active.clone());
            store.connection.set(Connection::Ready);
            store.load();
            if let Some(account) = active {
                let _ = store
                    .backend()
                    .call("mail.watch", json!({"accountId": account.to_string(), "query": "in:inbox", "intervalSec": 60, "pageSize": 25}))
                    .await;
            }
        });
        let store = *self;
        spawn(async move {
            while let Some(event) = store.backend().next_event().await {
                if event.method == "mail.updated"
                    && store
                        .account
                        .with(|a| a.as_deref() == event.params["accountId"].as_str())
                {
                    store.load();
                }
            }
        });
    }

    /// Shows `mailbox`.
    pub fn select_mailbox(&self, mailbox: Mailbox) {
        if self.mailbox.get() == mailbox {
            return;
        }
        self.mailbox.set(mailbox);
        self.selected.set(None);
        self.reader.set(Reader::Empty);
        self.messages.set(Vec::new());
        self.load();
    }

    /// Loads the current mailbox's first page.
    pub fn load(&self) {
        let Some(account) = self.account.get() else {
            return;
        };
        let mailbox = self.mailbox.get();
        let serial = self.list_serial.get() + 1;
        self.list_serial.set(serial);
        self.loading.set(true);
        let store = *self;
        spawn(async move {
            let reply = store
                .backend()
                .call(
                    "mail.list",
                    json!({"account": account.to_string(), "mailbox": mailbox.id(), "limit": 50}),
                )
                .await;
            if store.list_serial.get() != serial {
                return;
            }
            store.loading.set(false);
            match reply {
                Ok(page) => {
                    let rows: Vec<Summary> = page["messages"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Summary::from_json)
                        .collect();
                    if mailbox == Mailbox::Inbox {
                        store
                            .inbox_unread
                            .set(rows.iter().filter(|m| m.unread).count());
                    }
                    store.messages.set(rows);
                }
                Err(error) => log::warn!("mail.list {}: {error}", mailbox.id()),
            }
        });
    }

    /// Opens message `id` in the reader: `reader.open` (cache first, then
    /// live), and `reader.render` when the open left the render out.
    pub fn open(&self, id: SharedString) {
        let Some(account) = self.account.get() else {
            return;
        };
        self.selected.set(Some(id.clone()));
        let summary = self
            .messages
            .with(|m| m.iter().find(|m| m.id == id).cloned());
        let serial = self.reader_serial.get() + 1;
        self.reader_serial.set(serial);
        self.reader.set(Reader::Loading);
        let store = *self;
        spawn(async move {
            let request = format!("nsh-reader-{serial}");
            let options = json!({"allowRemoteImages": false, "withReader": true});
            let opened = store
                .backend()
                .call(
                    "reader.open",
                    json!({"accountId": account.to_string(), "id": id.to_string(), "requestId": request,
                           "cacheOnly": false, "now": unix_ms(), "options": options}),
                )
                .await;
            if store.reader_serial.get() != serial {
                return;
            }
            let mut resource = match opened {
                Ok(resource) => resource,
                Err(error) => {
                    store.reader.set(Reader::Failed(failure(&error)));
                    return;
                }
            };
            if resource["nativeRender"].is_null()
                && let Some(key) = resource["readerKey"].as_str().map(str::to_owned)
            {
                match store
                    .backend()
                    .call(
                        "reader.render",
                        json!({"accountId": account.to_string(), "id": id.to_string(), "readerKey": key,
                               "now": unix_ms(), "options": options}),
                    )
                    .await
                {
                    Ok(rendered) => resource["nativeRender"] = rendered["nativeRender"].clone(),
                    Err(error) => {
                        if store.reader_serial.get() == serial {
                            store.reader.set(Reader::Failed(failure(&error)));
                        }
                        return;
                    }
                }
                if store.reader_serial.get() != serial {
                    return;
                }
            }
            let html = reader_html::to_html(&resource["nativeRender"]["reader"]["document"])
                .unwrap_or_default();
            let summary = summary.or_else(|| Summary::from_json(&resource["nativeSummary"]));
            store.reader.set(Reader::Ready {
                subject: summary
                    .as_ref()
                    .map(|s| s.subject.clone())
                    .unwrap_or_default(),
                sender: summary
                    .as_ref()
                    .map(|s| s.sender.clone())
                    .unwrap_or_default(),
                html: html.into(),
            });
        });
    }
}

fn unix_ms() -> u64 {
    nsh_core::time::unix_ms() as u64
}
