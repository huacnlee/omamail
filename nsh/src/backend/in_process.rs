//! [`Backend`] inside the app's own process: the `omamail` library's
//! `backend::Session` on its own runtime. iOS does not let an app start
//! `omamail serve`, so the phone apps use this instead of
//! `ProcessBackend`. The replies and
//! notifications are the ones `serve` writes (docs/BACKEND-RUNTIME.md,
//! "In-process backend on iOS and Android").

use std::{
    cell::RefCell,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use omamail::backend::Session;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use super::{
    Backend, Event, NextEvent, Reply,
    wire::{self, Incoming, RpcError},
};

fn unavailable() -> RpcError {
    RpcError::new(-32099, "backend_unavailable")
}

/// One frame for the session and where its reply goes.
type Job = (String, oneshot::Sender<Option<Value>>);

/// The backend library, running in this process.
///
/// `Session::request` futures are not `Send`, so, as in `serve`, one
/// thread drives them all with `block_on`; they run concurrently on a
/// `LocalSet` while the session's own work uses the runtime's pool.
pub struct InProcessBackend {
    jobs: RefCell<Option<mpsc::UnboundedSender<Job>>>,
    serial: AtomicU64,
    events: Rc<RefCell<mpsc::UnboundedReceiver<Event>>>,
}

impl InProcessBackend {
    /// Builds the backend's runtime and session, and subscribes to its
    /// notifications before any request can run.
    pub fn start() -> Result<Self, RpcError> {
        let runtime = omamail::backend::runtime().map_err(|_| unavailable())?;
        let session = Arc::new(Session::default());
        let (sender, receiver) = mpsc::unbounded_channel();
        let (subscribed, ready) = std::sync::mpsc::channel();
        let forwarder = runtime.spawn({
            let session = session.clone();
            async move {
                let mut events = session.subscribe();
                let _ = subscribed.send(());
                while let Some(value) = events.recv().await {
                    let Some(method) = value["method"].as_str() else {
                        continue;
                    };
                    let event = Event {
                        method: method.to_owned(),
                        params: value["params"].clone(),
                    };
                    if sender.send(event).is_err() {
                        break;
                    }
                }
            }
        });
        // A watch that settles before its first reply must not be missed.
        ready.recv().map_err(|_| unavailable())?;
        let (jobs, queue) = mpsc::unbounded_channel();
        std::thread::Builder::new()
            .name("omamail-backend".into())
            .spawn(move || drive(runtime, session, queue, forwarder))
            .map_err(|_| unavailable())?;
        Ok(Self {
            jobs: RefCell::new(Some(jobs)),
            serial: AtomicU64::new(0),
            events: Rc::new(RefCell::new(receiver)),
        })
    }
}

/// Runs every frame until the app shuts the backend down, lets the
/// accepted ones reply, then runs the session's shutdown drain.
fn drive(
    runtime: tokio::runtime::Runtime,
    session: Arc<Session>,
    mut queue: mpsc::UnboundedReceiver<Job>,
    forwarder: tokio::task::JoinHandle<()>,
) {
    let local = tokio::task::LocalSet::new();
    runtime.block_on(local.run_until(async {
        let mut running = Vec::new();
        while let Some((frame, reply)) = queue.recv().await {
            running.retain(|task: &tokio::task::JoinHandle<()>| !task.is_finished());
            let session = session.clone();
            running.push(tokio::task::spawn_local(async move {
                let _ = reply.send(session.request(frame.as_bytes()).await);
            }));
        }
        for task in running {
            let _ = task.await;
        }
        forwarder.abort();
        if let Err(error) = session.shutdown().await {
            log::warn!("backend: shutdown failed: {error}");
        }
    }));
}

impl Backend for InProcessBackend {
    fn call(&self, method: &str, params: Value) -> Reply {
        let id = format!("nsh-{}", self.serial.fetch_add(1, Ordering::Relaxed));
        // No line limit in-process, so large parameters skip `upload.*`.
        let frame =
            json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string();
        let (reply, answered) = oneshot::channel();
        let sent = self
            .jobs
            .borrow()
            .as_ref()
            .is_some_and(|jobs| jobs.send((frame, reply)).is_ok());
        if !sent {
            return Box::pin(async { Err(unavailable()) });
        }
        Box::pin(async move {
            let reply = answered.await.map_err(|_| unavailable())?;
            answer(&id, reply)
        })
    }

    fn next_event(&self) -> NextEvent {
        let events = self.events.clone();
        Box::pin(std::future::poll_fn(move |cx| {
            events.borrow_mut().poll_recv(cx)
        }))
    }

    /// Stops taking calls; once the accepted ones reply, the backend runs
    /// its shutdown drain (watches, Gmail queues, outbox, query cache).
    /// Later calls answer `backend_unavailable`.
    fn shutdown(&self) {
        self.jobs.borrow_mut().take();
    }
}

impl Drop for InProcessBackend {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Reads the reply `Session::request` gave for request `id`.
fn answer(id: &str, reply: Option<Value>) -> Result<Value, RpcError> {
    let reply = reply.ok_or_else(|| RpcError::new(-32603, "backend_no_reply"))?;
    match wire::parse(&reply.to_string()).into_iter().next() {
        Some(Incoming::Response { id: got, result }) if got == id => result,
        _ => Err(RpcError::new(-32603, "backend_invalid_reply")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn answers_and_errors_match_serve() {
        let backend = InProcessBackend::start().unwrap();
        // The linked library is the backend this build pins.
        let info = block_on(crate::backend::handshake(&backend, &wire::Pins::compiled())).unwrap();
        assert!(!info.methods.is_empty());
        let unknown = block_on(backend.call("no.such.method", json!({}))).unwrap_err();
        assert_eq!(unknown.code, -32601);
        backend.shutdown();
        let closed = block_on(backend.call("system.info", json!({}))).unwrap_err();
        assert_eq!(closed, unavailable());
    }

    #[test]
    fn a_reply_for_another_request_is_refused() {
        let reply = json!({"jsonrpc": "2.0", "id": "nsh-9", "result": {}});
        assert_eq!(
            answer("nsh-1", Some(reply)).unwrap_err().message,
            "backend_invalid_reply"
        );
        assert_eq!(
            answer("nsh-1", None).unwrap_err().message,
            "backend_no_reply"
        );
    }
}
