//! Omamail's mail core for the NSH app: accounts, mailboxes, messages and
//! actions, imported from TSX as `omamail-native`. The backend runs inside
//! the app process; TSX calls typed functions and gets typed records.

mod engine;
mod mail;
mod types;

use nsh_core::prelude::*;

pub use mail::{Accounts, Mail};
pub use types::{Account, Address, MessageDetail, MessagePage, MessageRow};

/// What `omamail-native` exports to TSX.
#[native_module("omamail-native")]
fn native(registry: &mut Registry) {
    registry.module::<Accounts>().module::<Mail>();
}
