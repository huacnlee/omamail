pub mod account;
// Detached assistant workers currently rely on Linux pidfds and private storage.
#[cfg(all(feature = "agent", target_os = "linux"))]
pub mod agent;
pub mod attachment;
pub mod auth;
pub mod backend;
pub mod cache;
pub mod calendar;
pub mod cli;
pub mod compose;
pub mod contacts;
pub mod credentials;
pub mod mail;
pub mod message;
pub mod outbox;
pub mod platform;
pub mod process;
pub mod providers;
pub mod public_http;
pub mod sync;
pub mod tls;
