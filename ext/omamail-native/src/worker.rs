//! The thread that owns the backend [`Session`]. Its futures are not `Send`,
//! so, as in `omamail serve`, one thread drives them all on a `LocalSet`
//! inside the backend runtime; the backend's own work uses the runtime's
//! pool. Callers await a oneshot reply from any executor.

use std::sync::OnceLock;

use futures_util::{StreamExt, stream::FuturesUnordered};
use omamail::backend::Session;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc, oneshot};

enum Job {
    Request(Vec<u8>, oneshot::Sender<Option<Value>>),
    Shutdown(oneshot::Sender<Result<(), String>>),
}

struct Worker {
    jobs: mpsc::UnboundedSender<Job>,
    events: Mutex<mpsc::UnboundedReceiver<Value>>,
}

static WORKER: OnceLock<Option<Worker>> = OnceLock::new();
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn worker() -> Result<&'static Worker, String> {
    WORKER
        .get_or_init(start)
        .as_ref()
        .ok_or_else(|| "backend_unavailable".to_owned())
}

fn start() -> Option<Worker> {
    let runtime = match omamail::backend::runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            log::error!("omamail: no backend runtime: {error}");
            return None;
        }
    };
    let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
    let (notify, events) = mpsc::unbounded_channel::<Value>();
    std::thread::Builder::new()
        .name("omamail-backend".into())
        .spawn(move || {
            let local = tokio::task::LocalSet::new();
            runtime.block_on(local.run_until(async move {
                let session = Session::default();
                let session = &session;
                // Subscribe before the first request, so a watch that
                // settles before its reply is not missed.
                let mut stream = session.subscribe();
                let mut streaming = true;
                let mut inflight = FuturesUnordered::new();
                let mut stop = None;
                loop {
                    tokio::select! {
                        job = queue.recv(), if stop.is_none() => match job {
                            Some(Job::Request(frame, reply)) => inflight.push(async move {
                                let _ = reply.send(session.request(&frame).await);
                            }),
                            Some(Job::Shutdown(reply)) => stop = Some(reply),
                            None => break,
                        },
                        Some(()) = inflight.next(), if !inflight.is_empty() => {}
                        event = stream.recv(), if streaming => match event {
                            Some(event) => { let _ = notify.send(event); }
                            None => streaming = false,
                        },
                        else => {}
                    }
                    if stop.is_some() && inflight.is_empty() {
                        break;
                    }
                }
                let result = session.shutdown().await.map_err(|e| e.to_string());
                if let Some(reply) = stop {
                    let _ = reply.send(result);
                }
            }));
        })
        .ok()?;
    Some(Worker {
        jobs,
        events: Mutex::new(events),
    })
}

pub async fn request(method: String, params: Value) -> Result<Value, String> {
    let id = format!("nsh-{}", NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let frame = serde_json::to_vec(&json!({
        "jsonrpc": "2.0", "id": id, "method": method, "params": params,
    }))
    .map_err(|e| e.to_string())?;
    let (reply, answer) = oneshot::channel();
    worker()?
        .jobs
        .send(Job::Request(frame, reply))
        .map_err(|_| "backend_unavailable".to_owned())?;
    match answer.await {
        Ok(Some(reply)) => Ok(reply),
        Ok(None) => Ok(json!({ "result": null })),
        Err(_) => Err("backend_unavailable".into()),
    }
}

pub async fn next_event() -> Option<Value> {
    let worker = worker().ok()?;
    worker.events.lock().await.recv().await
}

pub async fn shutdown() -> Result<(), String> {
    let Some(Some(worker)) = WORKER.get() else {
        return Ok(());
    };
    let (reply, answer) = oneshot::channel();
    worker
        .jobs
        .send(Job::Shutdown(reply))
        .map_err(|_| "backend_unavailable".to_owned())?;
    answer.await.map_err(|_| "backend_unavailable".to_owned())?
}
