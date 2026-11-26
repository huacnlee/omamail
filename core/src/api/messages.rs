//! Message lists (`mail.list`): one page of summaries, newest first.

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{Error, Mail};

/// Which page of which mailbox to list.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListQuery {
    /// The account id; `None` lists the active account.
    pub account: Option<String>,
    /// A [`Mailbox`](super::Mailbox) id; `inbox` when empty.
    pub mailbox: String,
    /// Search in the provider's syntax; empty lists everything.
    pub query: String,
    /// 1 to 100.
    pub limit: u16,
    /// The `next_page_token` of the page before; empty for the first.
    pub page_token: String,
}

/// A sender or recipient.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Address {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    /// The name when there is one, else the address.
    #[serde(default)]
    pub display: String,
}

/// One row of a message list.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    pub id: String,
    #[serde(default)]
    pub thread_id: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub from: Address,
    /// ISO 8601.
    #[serde(default)]
    pub date: String,
    /// Short relative time for the list (`21m`, `Nov 3`).
    #[serde(default)]
    pub time: String,
    #[serde(default)]
    pub full_time: String,
    #[serde(default)]
    pub unread: bool,
    #[serde(default)]
    pub starred: bool,
}

/// One page of a mailbox.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub account_id: String,
    pub mailbox: String,
    pub messages: Vec<MessageSummary>,
    /// Empty on the last page.
    #[serde(default)]
    pub next_page_token: String,
    /// The provider's estimate of the mailbox's size.
    #[serde(default)]
    pub estimate: u64,
}

impl ListQuery {
    fn params(&self) -> serde_json::Value {
        let mut params = json!({
            "mailbox": if self.mailbox.is_empty() { "inbox" } else { &self.mailbox },
            "limit": self.limit.clamp(1, 100),
        });
        if let Some(account) = &self.account {
            params["account"] = json!(account);
        }
        if !self.query.is_empty() {
            params["query"] = json!(self.query);
        }
        if !self.page_token.is_empty() {
            params["pageToken"] = json!(self.page_token);
        }
        params
    }
}

/// The readable parts of one message (`mail.read`): plain text only,
/// never the HTML.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MessageBody {
    pub text: String,
    pub attachments: Vec<String>,
}

impl MessageBody {
    fn from_reply(value: &serde_json::Value) -> Self {
        let message = &value["message"];
        let attachments = message["attachments"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|a| a["filename"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            text: message["nativeContent"]["body"]["text"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_owned(),
            attachments,
        }
    }
}

/// A new message for [`Mail::send`].
#[derive(Clone, Debug, Default)]
pub struct Draft {
    pub account: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub body: String,
}

/// What [`Mail::act`] changed: the ids it reached and the ones that failed.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ActResult {
    pub succeeded_ids: Vec<String>,
    pub failed_ids: Vec<String>,
}

impl Mail {
    /// Runs `operation` (`read`, `unread`, `star`, `unstar`, `archive`,
    /// `trash` or `spam`) on messages `ids` of `account`, as `omamail act`.
    pub async fn act(
        &self,
        account: &str,
        operation: &str,
        ids: &[String],
    ) -> Result<ActResult, Error> {
        self.call(
            "mail.act",
            json!({"account": account, "operation": operation, "ids": ids, "execute": true}),
        )
        .await
    }

    /// Sends `draft` now, as `omamail send --execute`.
    pub async fn send(&self, draft: &Draft) -> Result<(), Error> {
        let mut params =
            json!({"to": draft.to, "subject": draft.subject, "body": draft.body, "execute": true});
        if !draft.cc.is_empty() {
            params["cc"] = json!(draft.cc);
        }
        if let Some(account) = &draft.account {
            params["account"] = json!(account);
        }
        let _: serde_json::Value = self.call("mail.send", params).await?;
        Ok(())
    }

    /// One page of `query.mailbox`, as `omamail list` prints it.
    pub async fn messages(&self, query: &ListQuery) -> Result<MessagePage, Error> {
        self.call("mail.list", query.params()).await
    }

    /// The plain-text body of message `id` in `account`.
    pub async fn read(&self, account: &str, id: &str) -> Result<MessageBody, Error> {
        let value: serde_json::Value = self
            .call("mail.read", json!({"account": account, "id": id}))
            .await?;
        Ok(MessageBody::from_reply(&value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_omit_empty_fields() {
        let query = ListQuery {
            limit: 500,
            ..Default::default()
        };
        assert_eq!(query.params(), json!({"mailbox":"inbox","limit":100}));
        let query = ListQuery {
            account: Some("a@x.org".into()),
            mailbox: "sent".into(),
            query: "q".into(),
            limit: 10,
            page_token: "t".into(),
        };
        assert_eq!(
            query.params(),
            json!({"account":"a@x.org","mailbox":"sent","limit":10,"query":"q","pageToken":"t"})
        );
    }

    #[test]
    fn reads_the_plain_text_body() {
        let value = json!({"message":{
            "nativeContent":{"body":{"text":"  Hello\n"}},
            "attachments":[{"filename":"a.pdf"}]}});
        let body = MessageBody::from_reply(&value);
        assert_eq!(body.text, "Hello");
        assert_eq!(body.attachments, ["a.pdf"]);
    }

    #[test]
    fn decodes_a_list_reply() {
        let value = json!({
            "accountId":"a@x.org","mailbox":"inbox","estimate":3,"nextPageToken":"",
            "messages":[{"id":"1","threadId":"1","subject":"Hi","snippet":"s",
                "from":{"name":"A","email":"a@x.org","display":"A"},
                "date":"2026-11-26T14:06:39.000Z","time":"21m","fullTime":"Nov 26","unread":true,"starred":false,
                "labelIds":["INBOX"]}]
        });
        let page: MessagePage = super::super::decode(value).unwrap();
        assert!(page.messages[0].unread);
        assert_eq!(page.messages[0].from.display, "A");
    }
}
