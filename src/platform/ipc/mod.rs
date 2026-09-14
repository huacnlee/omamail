//! Peer-authenticated local endpoints, independent of the outbox protocol.
#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub(crate) use unix::*;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub(crate) use windows::*;
