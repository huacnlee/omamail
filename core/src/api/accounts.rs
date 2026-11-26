//! The configured accounts (`accounts.list`). Credentials and server
//! settings never leave the backend.

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{Error, Mail};

/// One account as the account list shows it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Account {
    pub id: String,
    pub email: String,
    /// `gmail`, `imap`, `jmap`, `outlook`, `m365` or `hey`.
    pub provider: String,
    #[serde(default)]
    pub label: String,
    /// Sign-in started but not finished.
    #[serde(default)]
    pub pending: bool,
}

/// Every account and the one picked last.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accounts {
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub active_id: Option<String>,
}

impl Mail {
    /// The accounts in `$XDG_CONFIG_HOME/omamail/accounts.json`.
    pub async fn accounts(&self) -> Result<Accounts, Error> {
        self.call("accounts.list", json!({})).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_rpc_shape() {
        let value = json!({
            "accounts":[{"id":"a@x.org","email":"a@x.org","provider":"imap","label":"","pending":false}],
            "activeId":"a@x.org"
        });
        let accounts: Accounts = super::super::decode(value).unwrap();
        assert_eq!(accounts.active_id.as_deref(), Some("a@x.org"));
        assert_eq!(accounts.accounts[0].provider, "imap");
    }
}
