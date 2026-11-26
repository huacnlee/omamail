//! The mail backend: `omamail serve` behind one trait, so screens never
//! see the process, and tests use [`FakeBackend`].

pub mod fake;
#[cfg(not(target_arch = "wasm32"))]
pub mod process;
pub mod wire;

use std::{future::Future, pin::Pin, rc::Rc};

use serde_json::{Value, json};

pub use fake::FakeBackend;
pub use wire::{BackendInfo, Pins, RpcError};

/// The answer to one call.
pub type Reply = Pin<Box<dyn Future<Output = Result<Value, RpcError>>>>;
/// The next pushed event, `None` once the backend is gone.
pub type NextEvent = Pin<Box<dyn Future<Output = Option<Event>>>>;

/// A notification the backend pushed (`mail.updated`, `gmail.settled`,
/// outbox changes). Transport notifications never reach here.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub method: String,
    pub params: Value,
}

/// A connection to the mail backend. Calls may answer out of order; each
/// future resolves with its own answer, a backend error, or a deadline.
pub trait Backend {
    /// Calls `method` with `params` (JSON-RPC 2.0).
    fn call(&self, method: &str, params: Value) -> Reply;
    /// Waits for the next pushed event.
    fn next_event(&self) -> NextEvent;
    /// Asks the backend to finish its work and quit.
    fn shutdown(&self) {}
}

/// Connects: calls `system.info` and checks it against the versions this
/// build was made for.
pub async fn handshake(backend: &dyn Backend, pins: &Pins) -> Result<BackendInfo, RpcError> {
    let info = backend.call("system.info", json!({})).await?;
    wire::accept(&info, pins)
}

/// The backend the app uses: the fake one when `OMAMAIL_NSH_BACKEND=fake`
/// (screenshots, demos), else `omamail serve`.
pub fn connect_default() -> Result<Rc<dyn Backend>, RpcError> {
    if std::env::var("OMAMAIL_NSH_BACKEND").as_deref() == Ok("fake") {
        return Ok(Rc::new(FakeBackend::sample()));
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let backend = process::ProcessBackend::spawn(&process::backend_path())?;
        Ok(Rc::new(backend))
    }
    #[cfg(target_arch = "wasm32")]
    {
        Err(RpcError::new(-32099, "backend_unavailable"))
    }
}
