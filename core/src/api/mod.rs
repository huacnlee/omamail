//! A typed facade over the backend for apps that link `omamail` as a
//! library (the NSH app's `omamail-native` module). It calls the same
//! [`Session`](crate::backend::Session) methods as `omamail serve`, so
//! behaviour stays identical; it only turns JSON into Rust types and
//! error codes into [`Error`].
//!
//! The futures are not `Send`: drive them on one thread, as `serve` does.

pub mod accounts;
pub mod mailboxes;
pub mod messages;

use serde::de::DeserializeOwned;
use serde_json::Value;

pub use accounts::{Account, Accounts};
pub use mailboxes::Mailbox;
pub use messages::{
    ActResult, Address, Draft, ListQuery, MessageBody, MessagePage, MessageSummary,
};

/// A backend error: the stable code the RPC replies carry
/// (`mail_account_unknown`, `auth_required`, ...).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

/// The mail library for one process: accounts, mailboxes and messages.
#[derive(Default)]
pub struct Mail {
    session: crate::backend::Session,
}

impl Mail {
    /// The backend session underneath, for calls the facade does not wrap yet.
    pub fn session(&self) -> &crate::backend::Session {
        &self.session
    }

    async fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T, Error> {
        let value = self
            .session
            .dispatch(method, &params)
            .await
            .map_err(|code| Error(code.to_owned()))?;
        decode(value)
    }

    /// Lets running work finish and flushes caches; call before exit.
    pub async fn shutdown(&self) -> std::io::Result<()> {
        self.session.shutdown().await
    }
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(|_| Error("backend_reply_invalid".to_owned()))
}
