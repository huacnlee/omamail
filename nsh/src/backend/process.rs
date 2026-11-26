//! [`Backend`] over a child `omamail serve`: a writer behind a lock, one
//! thread reading lines and one failing requests past their deadline.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use super::{
    Backend, Event, NextEvent, Reply,
    wire::{self, ChunkStep, Chunks, Incoming, RpcError},
};

/// How long a chunked transfer may take to arrive.
const CHUNK_DEADLINE: Duration = Duration::from_secs(30);

type Pending = HashMap<String, (Instant, oneshot::Sender<Result<Value, RpcError>>)>;

struct Shared {
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<Pending>,
    closed: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl Shared {
    fn fail_all(&self, error: &RpcError) {
        let drained: Vec<_> = self
            .pending
            .lock()
            .map(|mut p| p.drain().collect())
            .unwrap_or_default();
        for (_, (_, reply)) in drained {
            let _ = reply.send(Err(error.clone()));
        }
    }

    fn write(&self, line: &str) -> Result<(), RpcError> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| RpcError::new(-32099, "backend_unavailable"))?;
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| RpcError::new(-32099, "backend_unavailable"))?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush())
            .map_err(|_| RpcError::new(-32099, "backend_unavailable"))
    }
}

/// `omamail serve`, started by the app and stopped with it.
pub struct ProcessBackend {
    shared: Arc<Shared>,
    serial: Arc<AtomicU64>,
    events: std::rc::Rc<std::cell::RefCell<mpsc::UnboundedReceiver<Event>>>,
}

/// Where the backend binary is: `OMAMAIL_BIN`, then an `omamail` beside
/// this executable (the packaged app), then the plugin's private copy,
/// then `omamail` on `PATH` (docs/BACKEND-RUNTIME.md).
pub fn backend_path() -> PathBuf {
    if let Some(path) = std::env::var_os("OMAMAIL_BIN").filter(|p| !p.is_empty()) {
        return PathBuf::from(path);
    }
    let name = if cfg!(windows) {
        "omamail.exe"
    } else {
        "omamail"
    };
    if let Some(beside) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        && beside.is_file()
    {
        return beside;
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    if let Some(private) = data.map(|dir| dir.join("omamail/bin").join(name))
        && private.is_file()
    {
        return private;
    }
    PathBuf::from(name)
}

impl ProcessBackend {
    /// Starts `binary serve` and the threads that read it.
    pub fn spawn(binary: &Path) -> Result<Self, RpcError> {
        let mut child = Command::new(binary)
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
                log::error!("backend: cannot start {}: {error}", binary.display());
                RpcError::new(-32099, "backend_unavailable")
            })?;
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RpcError::new(-32099, "backend_unavailable"))?;
        let shared = Arc::new(Shared {
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            child: Mutex::new(Some(child)),
        });
        let (events, receiver) = mpsc::unbounded_channel();
        let reader = shared.clone();
        std::thread::Builder::new()
            .name("omamail-backend-read".into())
            .spawn(move || read_loop(&reader, BufReader::new(stdout), &events))
            .map_err(|_| RpcError::new(-32099, "backend_unavailable"))?;
        let sweeper = Arc::downgrade(&shared);
        std::thread::Builder::new()
            .name("omamail-backend-deadlines".into())
            .spawn(move || {
                while let Some(shared) = sweeper.upgrade() {
                    if shared.closed.load(Ordering::Acquire) {
                        break;
                    }
                    let now = Instant::now();
                    let expired: Vec<_> = shared
                        .pending
                        .lock()
                        .map(|mut pending| {
                            let ids: Vec<_> = pending
                                .iter()
                                .filter(|(_, (at, _))| *at <= now)
                                .map(|(id, _)| id.clone())
                                .collect();
                            ids.into_iter()
                                .filter_map(|id| pending.remove(&id))
                                .collect()
                        })
                        .unwrap_or_default();
                    drop(shared);
                    for (_, reply) in expired {
                        let _ = reply.send(Err(RpcError::new(-32003, "backend_deadline")));
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            })
            .map_err(|_| RpcError::new(-32099, "backend_unavailable"))?;
        Ok(Self {
            shared,
            serial: Arc::new(AtomicU64::new(0)),
            events: std::rc::Rc::new(std::cell::RefCell::new(receiver)),
        })
    }

    fn send(&self, method: &str, params: &Value) -> oneshot::Receiver<Result<Value, RpcError>> {
        send(&self.shared, &self.serial, method, params)
    }

    fn sender(&self) -> Sender {
        Sender {
            shared: self.shared.clone(),
            serial: self.serial.clone(),
        }
    }
}

/// What a call's future holds: enough to send more requests (an upload's
/// pieces) without the backend's engine-thread parts.
struct Sender {
    shared: Arc<Shared>,
    serial: Arc<AtomicU64>,
}

impl Sender {
    async fn call(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        let answer = send(&self.shared, &self.serial, method, params);
        answer
            .await
            .unwrap_or_else(|_| Err(RpcError::new(-32099, "backend_unavailable")))
    }

    /// Sends large parameters through `upload.begin`, `upload.append` and
    /// `request.upload`.
    async fn upload(&self, method: &str, params: String) -> Result<Value, RpcError> {
        let bytes = params.into_bytes();
        let begun = self
            .call("upload.begin", &json!({"size": bytes.len()}))
            .await?;
        let upload = begun["upload"]
            .as_str()
            .ok_or_else(|| RpcError::new(-32603, "upload_invalid"))?
            .to_owned();
        let chunk = begun["chunkSize"].as_u64().unwrap_or(256 * 1024) as usize;
        for (offset, data) in wire::upload_pieces(&bytes, chunk) {
            let reply = self
                .call(
                    "upload.append",
                    &json!({"upload": upload, "offset": offset, "data": data}),
                )
                .await;
            match reply {
                Ok(reply) if reply["offset"].as_u64().is_some() => {}
                Ok(_) | Err(_) => {
                    let _ = self
                        .call("upload.discard", &json!({"upload": upload}))
                        .await;
                    return Err(RpcError::new(-32603, "upload_failed"));
                }
            }
        }
        self.call(
            "request.upload",
            &json!({"method": method, "upload": upload}),
        )
        .await
    }
}

impl Backend for ProcessBackend {
    fn call(&self, method: &str, params: Value) -> Reply {
        let serialized = params.to_string();
        if serialized.chars().count() > wire::UPLOAD_THRESHOLD {
            let sender = self.sender();
            let method = method.to_owned();
            return Box::pin(async move { sender.upload(&method, serialized).await });
        }
        let answer = self.send(method, &params);
        Box::pin(async move {
            answer
                .await
                .unwrap_or_else(|_| Err(RpcError::new(-32099, "backend_unavailable")))
        })
    }

    fn next_event(&self) -> NextEvent {
        let events = self.events.clone();
        Box::pin(std::future::poll_fn(move |cx| {
            events.borrow_mut().poll_recv(cx)
        }))
    }

    fn shutdown(&self) {
        let _ = self
            .shared
            .write(&wire::request("nsh-quit", "system.quit", &json!({})));
        let shared = self.shared.clone();
        let _ = std::thread::Builder::new()
            .name("omamail-backend-stop".into())
            .spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    let done = shared
                        .child
                        .lock()
                        .ok()
                        .and_then(|mut child| {
                            child
                                .as_mut()
                                .map(|c| c.try_wait().map(|s| s.is_some()).unwrap_or(true))
                        })
                        .unwrap_or(true);
                    if done {
                        break;
                    }
                    if Instant::now() >= deadline {
                        if let Ok(mut child) = shared.child.lock()
                            && let Some(child) = child.as_mut()
                        {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            });
    }
}

impl Drop for ProcessBackend {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn send(
    shared: &Shared,
    serial: &AtomicU64,
    method: &str,
    params: &Value,
) -> oneshot::Receiver<Result<Value, RpcError>> {
    let (reply, answer) = oneshot::channel();
    if shared.closed.load(Ordering::Acquire) {
        let _ = reply.send(Err(RpcError::new(-32099, "backend_unavailable")));
        return answer;
    }
    let id = format!("nsh-{}", serial.fetch_add(1, Ordering::Relaxed) + 1);
    let line = wire::request(&id, method, params);
    if line.len() > wire::MAX_FRAME {
        let _ = reply.send(Err(RpcError::new(-32600, "request_too_large")));
        return answer;
    }
    let deadline = Instant::now() + Duration::from_millis(wire::deadline_ms(method, params));
    if let Ok(mut pending) = shared.pending.lock() {
        pending.insert(id.clone(), (deadline, reply));
    }
    if let Err(error) = shared.write(&line)
        && let Some((_, reply)) = shared.pending.lock().ok().and_then(|mut p| p.remove(&id))
    {
        let _ = reply.send(Err(error));
    }
    answer
}

fn read_loop(shared: &Shared, mut stdout: impl BufRead, events: &mpsc::UnboundedSender<Event>) {
    let mut chunks = Chunks::default();
    let mut chunk_started = Instant::now();
    let mut line = String::new();
    loop {
        line.clear();
        match stdout.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(n) if n > wire::MAX_FRAME => {
                log::error!("backend: a frame of {n} bytes exceeds the limit");
                break;
            }
            Ok(_) => {}
        }
        for incoming in wire::parse(line.trim_end()) {
            match incoming {
                Incoming::Notification { method, params } if method == "transport.chunk" => {
                    if params["index"] == 0 {
                        chunk_started = Instant::now();
                    } else if chunk_started.elapsed() > CHUNK_DEADLINE {
                        chunks.reset();
                    }
                    match chunks.push(&params) {
                        ChunkStep::Pending => {}
                        ChunkStep::Complete(whole) => {
                            for incoming in wire::parse(&whole) {
                                route(shared, incoming, events);
                            }
                        }
                        ChunkStep::Rejected(why) => log::warn!("backend: chunk dropped: {why}"),
                    }
                }
                incoming => route(shared, incoming, events),
            }
        }
    }
    shared.closed.store(true, Ordering::Release);
    shared.fail_all(&RpcError::new(-32099, "backend_exited"));
}

fn route(shared: &Shared, incoming: Incoming, events: &mpsc::UnboundedSender<Event>) {
    match incoming {
        Incoming::Response { id, result } => {
            let reply = shared
                .pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&id));
            if let Some((_, reply)) = reply {
                let _ = reply.send(result);
            }
        }
        Incoming::Notification { method, params } => {
            let _ = events.send(Event { method, params });
        }
        Incoming::Invalid => log::warn!("backend: an invalid line was dropped"),
    }
}
