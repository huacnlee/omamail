//! The wire layer against a scripted TLS server and fixed documents.

pub mod calendar;
mod conn;
pub mod detail;
pub mod fake;
mod meeting;
mod ops;
pub mod series;
mod wire;

/// How much faster than real time the deadlines of this process run (`conn::clock`). Only a test
/// that runs in a process of its own sets it.
pub static HURRY: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
