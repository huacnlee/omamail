//! What crosses to TSX: plain records with TS interfaces generated from them.

use nsh_core::prelude::*;
use serde_json::Value;

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

/// A configured mail account.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Account {
    /// The id every other call takes.
    pub id: String,
    /// The mailbox address.
    pub email: String,
    /// The name the user gave it, or empty.
    pub label: String,
    /// "gmail", "outlook", "hey", "jmap", "imap" or "m365".
    pub provider: String,
    /// True while sign-in has not finished.
    pub pending: bool,
}

impl Account {
    pub(crate) fn from_value(value: &Value) -> Self {
        Self {
            id: text(&value["id"]),
            email: text(&value["email"]),
            label: text(&value["label"]),
            provider: text(&value["provider"]),
            pending: value["pending"] == true,
        }
    }
}

/// A name and an address.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Address {
    /// The display name, or empty.
    pub name: String,
    /// The address.
    pub email: String,
}

impl Address {
    pub(crate) fn from_value(value: &Value) -> Self {
        Self {
            name: text(&value["name"]),
            email: text(&value["email"]),
        }
    }
}

/// One row of a message list.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct MessageRow {
    /// The message id, unique in its account.
    pub id: String,
    /// The conversation it belongs to.
    pub thread_id: String,
    /// The sender.
    pub from: Address,
    /// The subject ("(no subject)" when it has none).
    pub subject: String,
    /// The start of the body as plain text.
    pub snippet: String,
    /// When it arrived, RFC 3339, or empty.
    pub date: String,
    /// The arrival time as the list shows it ("10:42", "Mon", "Nov 3").
    pub time: String,
    /// Not read yet.
    pub unread: bool,
    /// Starred (flagged).
    pub starred: bool,
}

impl MessageRow {
    pub(crate) fn from_value(value: &Value) -> Self {
        Self {
            id: text(&value["id"]),
            thread_id: text(&value["threadId"]),
            from: Address::from_value(&value["from"]),
            subject: text(&value["subject"]),
            snippet: text(&value["snippet"]),
            date: text(&value["date"]),
            time: text(&value["time"]),
            unread: value["unread"] == true,
            starred: value["starred"] == true,
        }
    }
}

/// A page of a mailbox.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct MessagePage {
    /// The rows, newest first.
    pub messages: Vec<MessageRow>,
    /// Pass back as `pageToken` for the next page; empty on the last page.
    pub next_page_token: String,
    /// About how many messages match.
    pub estimate: f64,
}

impl MessagePage {
    pub(crate) fn from_value(value: &Value) -> Self {
        Self {
            messages: value["messages"]
                .as_array()
                .map(|rows| rows.iter().map(MessageRow::from_value).collect())
                .unwrap_or_default(),
            next_page_token: text(&value["nextPageToken"]),
            estimate: value["estimate"].as_f64().unwrap_or_default(),
        }
    }
}

/// An open message.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct MessageDetail {
    /// The message id.
    pub id: String,
    /// The subject.
    pub subject: String,
    /// The sender.
    pub from: Address,
    /// The recipients.
    pub to: Vec<Address>,
    /// The copied recipients.
    pub cc: Vec<Address>,
    /// When it arrived, RFC 3339, or empty.
    pub date: String,
    /// The body as safe plain text.
    pub text: String,
    /// Attachment file names.
    pub attachments: Vec<String>,
}

impl MessageDetail {
    pub(crate) fn from_value(value: &Value) -> Self {
        let message = &value["message"];
        let summary = &message["summary"];
        let addresses = |value: &Value| {
            value
                .as_array()
                .map(|rows| rows.iter().map(Address::from_value).collect())
                .unwrap_or_default()
        };
        Self {
            id: text(&message["id"]),
            subject: text(&summary["subject"]),
            from: Address::from_value(&summary["from"]),
            to: addresses(&summary["to"]),
            cc: addresses(&summary["cc"]),
            date: text(&summary["date"]),
            text: text(&message["nativeContent"]["body"]["text"]),
            attachments: message["attachments"]
                .as_array()
                .map(|rows| rows.iter().map(|row| text(&row["filename"])).collect())
                .unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_list_page_keeps_the_rows_the_list_shows() {
        let page = MessagePage::from_value(&json!({
            "accountId": "me",
            "mailbox": "inbox",
            "messages": [{
                "id": "1", "threadId": "t1",
                "from": {"name": "Ada", "email": "ada@example.org"},
                "subject": "Engine notes", "snippet": "Patterns",
                "date": "2026-11-26T10:42:00.000Z", "time": "10:42",
                "unread": true, "starred": false
            }],
            "nextPageToken": "next",
            "estimate": 12
        }));
        assert_eq!(page.next_page_token, "next");
        assert_eq!(page.estimate, 12.0);
        let row = &page.messages[0];
        assert_eq!((row.id.as_str(), row.thread_id.as_str()), ("1", "t1"));
        assert_eq!(row.from.email, "ada@example.org");
        assert!(row.unread && !row.starred);
    }

    #[test]
    fn a_read_result_gives_the_safe_text_and_attachment_names() {
        let detail = MessageDetail::from_value(&json!({"message": {
            "id": "1",
            "summary": {
                "id": "1", "subject": "Engine notes",
                "from": {"name": "Ada", "email": "ada@example.org"},
                "to": [{"name": "", "email": "me@example.org"}]
            },
            "nativeContent": {"body": {"text": "Hello"}},
            "attachments": [{"filename": "notes.pdf"}]
        }}));
        assert_eq!(detail.text, "Hello");
        assert_eq!(detail.to[0].email, "me@example.org");
        assert_eq!(detail.attachments, ["notes.pdf"]);
    }

    #[test]
    fn missing_fields_read_as_empty() {
        let row = MessageRow::from_value(&json!({"id": "1"}));
        assert_eq!(row.subject, "");
        assert!(!row.unread);
    }
}
