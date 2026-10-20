//! The EWS wire layer: signed-in connection, NTLM, SOAP builders and decoders, typed operations.

mod client;
mod conn;
mod decode;
mod ntlm;
mod page;
mod soap;
mod xml;

pub(super) use client::{Client, Folders, MAX_IDS, MAX_MIME_IDS, Outcome};
pub(super) use conn::{Choice, Config, DEADLINE, clock, endpoint};
pub(super) use decode::{Item, MAX_MIME, Party};
pub(super) use soap::{Change, Condition, Role};

#[cfg(test)]
pub(super) mod tests;
