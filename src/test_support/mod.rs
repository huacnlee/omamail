//! In-process loopback peers for the native TLS tests.
//!
//! Each peer serves one listener from the test runtime. A test needs no
//! interpreter and no external TLS tool, and it controls every answer.

pub(crate) mod http;
pub(crate) mod jmap;
pub(crate) mod peers;
pub(crate) mod starttls;
mod tests;
pub(crate) mod tls;
