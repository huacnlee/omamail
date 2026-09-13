//! Task arguments become provider-neutral requests; domain code validates them.
use clap::{Args, ValueEnum};
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf};

#[derive(Args)]
pub(super) struct AccountArg {
    /// Registered account ID (defaults to the active account)
    #[arg(long, value_name = "ID")]
    account: Option<String>,
}

impl AccountArg {
    fn params(&self) -> Value {
        match &self.account {
            Some(account) => json!({"account":account}),
            None => json!({}),
        }
    }
}

#[derive(Args)]
pub(super) struct ExecuteArg {
    /// Perform the operation; without this flag, only preview it
    #[arg(long)]
    execute: bool,
}

#[derive(ValueEnum, Clone)]
pub(super) enum MarkArg {
    Read,
    Unread,
    Star,
    Unstar,
}

#[derive(Args)]
pub(super) struct List {
    #[command(flatten)]
    account: AccountArg,
    /// Mailbox to list
    #[arg(long, default_value = "inbox", value_parser = ["inbox", "unread", "starred", "sent", "drafts", "archive", "spam", "trash"])]
    mailbox: String,
    /// Search text
    #[arg(long, default_value = "")]
    query: String,
    /// Maximum rows in this page (1–100)
    #[arg(long, default_value_t = 25, value_parser = clap::value_parser!(u16).range(1..=100))]
    limit: u16,
    /// Opaque continuation token from a previous list result
    #[arg(long, default_value = "", value_name = "TOKEN")]
    page_token: String,
}

impl List {
    pub(super) fn params(&self) -> Value {
        let mut params = self.account.params();
        params["mailbox"] = json!(self.mailbox);
        params["query"] = json!(self.query);
        params["limit"] = json!(self.limit);
        params["pageToken"] = json!(self.page_token);
        params
    }
}

#[derive(Args)]
pub(super) struct ReadMessage {
    #[command(flatten)]
    account: AccountArg,
    #[arg(value_name = "MESSAGE_ID")]
    id: String,
}

impl ReadMessage {
    pub(super) fn params(&self) -> Value {
        let mut params = self.account.params();
        params["id"] = json!(self.id);
        params
    }
}

#[derive(Args)]
pub(super) struct Action {
    #[command(flatten)]
    account: AccountArg,
    #[command(flatten)]
    execution: ExecuteArg,
    #[arg(required = true, value_name = "MESSAGE_ID")]
    ids: Vec<String>,
}

impl Action {
    pub(super) fn params(&self, operation: &str) -> Value {
        let mut params = self.account.params();
        params["operation"] = json!(operation);
        params["ids"] = json!(self.ids);
        params["execute"] = json!(self.execution.execute);
        params
    }
}

#[derive(Args)]
pub(super) struct Mark {
    #[arg(value_enum)]
    state: MarkArg,
    #[command(flatten)]
    action: Action,
}

impl Mark {
    pub(super) fn params(&self) -> Value {
        self.action.params(match self.state {
            MarkArg::Read => "read",
            MarkArg::Unread => "unread",
            MarkArg::Star => "star",
            MarkArg::Unstar => "unstar",
        })
    }
}

#[derive(Args)]
pub(super) struct Send {
    #[command(flatten)]
    account: AccountArg,
    #[command(flatten)]
    execution: ExecuteArg,
    /// Recipient address; repeat for additional recipients
    #[arg(long)]
    to: Vec<String>,
    /// Copy recipient; repeat for additional recipients
    #[arg(long)]
    cc: Vec<String>,
    /// Blind-copy recipient; repeat for additional recipients
    #[arg(long)]
    bcc: Vec<String>,
    /// Sender identity belonging to this account
    #[arg(long, default_value = "")]
    from: String,
    #[arg(long, default_value = "")]
    subject: String,
    /// Absolute regular-file path; repeat for additional attachments
    #[arg(long, value_name = "PATH")]
    attach: Vec<PathBuf>,
}

impl Send {
    pub(super) fn params(&self, input: impl Read) -> Result<Value, &'static str> {
        let mut bytes = Vec::new();
        input
            .take(crate::mail::send::MAX_BODY as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "message_input_failed")?;
        if bytes.len() > crate::mail::send::MAX_BODY {
            return Err("mail_send_invalid_body");
        }
        let body = String::from_utf8(bytes).map_err(|_| "mail_send_invalid_body")?;
        let attachments = self
            .attach
            .iter()
            .map(|path| {
                let text = path.to_str().ok_or("mail_send_attachment_path")?;
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("mail_send_attachment_path")?;
                // This is an input snapshot only. The mail layer securely opens the
                // path without following symlinks and compares size before reading.
                let size = std::fs::symlink_metadata(path)
                    .map_err(|_| "mail_send_attachment_unreadable")?
                    .len();
                Ok(json!({"path":text,"name":name,"size":size}))
            })
            .collect::<Result<Vec<_>, &'static str>>()?;
        let mut params = self.account.params();
        params["to"] = json!(self.to);
        params["cc"] = json!(self.cc);
        params["bcc"] = json!(self.bcc);
        params["from"] = json!(self.from);
        params["subject"] = json!(self.subject);
        params["body"] = json!(body);
        params["attachments"] = json!(attachments);
        params["execute"] = json!(self.execution.execute);
        Ok(params)
    }
}
