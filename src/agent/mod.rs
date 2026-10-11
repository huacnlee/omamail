//! Native assistant context, durable jobs, and bounded public-answer streaming.
mod codex;
mod config;
pub mod context;
#[cfg(target_os = "macos")]
mod control;
pub mod events;
mod history;
pub mod jobs;
pub mod mcp;
pub mod opencode;
mod prompt;
mod proposals;
mod provider;
mod provider_stream;
mod storage;
mod stream;
pub mod worker;
