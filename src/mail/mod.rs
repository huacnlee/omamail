mod account;
pub(crate) mod action;
pub(crate) mod list;
pub(crate) mod read;
pub(crate) mod send;
mod types;

pub use account::resolve_account;
pub use types::{
    Account, ActRequest, AttachmentInput, ListRequest, Mailbox, Mark, Provider, ReadRequest,
    SendRequest,
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
mod send_tests;
