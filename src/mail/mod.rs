mod account;
pub(crate) mod list;
mod types;

pub use account::resolve_account;
pub use types::{
    Account, ActRequest, AttachmentInput, ListRequest, Mailbox, Mark, Provider, ReadRequest,
    SendRequest,
};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod list_tests;
