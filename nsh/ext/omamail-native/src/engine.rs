//! The backend thread. `omamail::backend::Session` futures are not `Send`, so
//! they cannot run as NSH tasks; one thread owns the backend runtime, a
//! `LocalSet` and the session, and the exported functions send it requests.
//! Backend notifications (new mail, outbox changes) join in the next stage,
//! with `mail.watch`.

use std::sync::OnceLock;
use std::thread;

use omamail::backend::{Session, runtime};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

type Reply = oneshot::Sender<Result<Value, String>>;

struct Request {
    method: &'static str,
    params: Value,
    reply: Reply,
}

/// The handle every export shares.
pub(crate) struct Engine {
    requests: mpsc::UnboundedSender<Request>,
}

static ENGINE: OnceLock<Engine> = OnceLock::new();

/// The engine, started on first use.
pub(crate) fn engine() -> &'static Engine {
    ENGINE.get_or_init(Engine::start)
}

impl Engine {
    fn start() -> Self {
        let (requests, mut inbox) = mpsc::unbounded_channel::<Request>();
        thread::Builder::new()
            .name("omamail-backend".into())
            .spawn(move || {
                let runtime = match runtime() {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        log_failure(&error.to_string());
                        // Answer every request with the start failure.
                        while let Some(request) = inbox.blocking_recv() {
                            let _ = request.reply.send(Err("backend_unavailable".into()));
                        }
                        return;
                    }
                };
                let local = tokio::task::LocalSet::new();
                local.block_on(&runtime, async move {
                    let session: &'static Session = Box::leak(Box::new(Session::default()));
                    while let Some(request) = inbox.recv().await {
                        tokio::task::spawn_local(async move {
                            let result = session
                                .dispatch(request.method, &request.params)
                                .await
                                .map_err(str::to_owned);
                            let _ = request.reply.send(result);
                        });
                    }
                    let _ = session.shutdown().await;
                });
            })
            .expect("the backend thread starts");
        Self { requests }
    }

    /// Runs one backend operation and waits for its result.
    pub(crate) async fn call(&self, method: &'static str, params: Value) -> Result<Value, String> {
        let (reply, answer) = oneshot::channel();
        self.requests
            .send(Request {
                method,
                params,
                reply,
            })
            .map_err(|_| "backend_stopped".to_owned())?;
        answer.await.map_err(|_| "backend_stopped".to_owned())?
    }
}

fn log_failure(message: &str) {
    eprintln!("omamail: the mail backend did not start: {message}");
}
