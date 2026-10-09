mod account;
pub(crate) mod action;
pub(crate) mod clear_unread;
pub(crate) mod list;
pub(crate) mod read;
mod read_links;
pub(crate) mod send;
mod types;

pub use account::resolve_account;
pub use types::{
    Account, ActRequest, AttachmentInput, ClearUnreadRequest, ListRequest, Mailbox, Mark, Provider,
    ReadRequest, SendRequest,
};

#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
mod list_tests;

#[cfg(test)]
mod read_tests;

#[cfg(test)]
mod action_tests;

#[cfg(test)]
mod clear_unread_tests;

#[cfg(test)]
mod send_tests;
