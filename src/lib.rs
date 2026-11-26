pub mod account;
// Detached assistant workers re-launch the current executable and rely on
// Linux pidfds or a Darwin control socket. iOS and Android apps cannot spawn
// workers, so there the build reports `capabilities.agent = false` and every
// `agent.*` method answers `unknown_method`, like a build without the feature.
#[cfg(all(feature = "agent", any(target_os = "macos", target_os = "linux")))]
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
#[cfg(test)]
mod test_support;
pub mod tls;
