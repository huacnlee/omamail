//! Loopback HTTPS peers with a fixed or scripted answer.

use crate::test_support::{http, tls};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_rustls::TlsAcceptor;

/// How long a peer waits for a client that never arrives.
const ACCEPT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);
/// How long a peer waits for a client that never finishes its handshake.
const HANDSHAKE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// A TLS peer that reports, for each connection, whether the client sent
/// HTTP after the handshake.
pub(crate) struct HttpTlsPeer {
    pub(crate) port: u16,
    reports: mpsc::UnboundedReceiver<&'static str>,
    task: JoinHandle<()>,
}

impl HttpTlsPeer {
    /// Serves `connections` attempts in the order the client makes them.
    pub(crate) async fn start(connections: usize) -> Self {
        Self::start_with_deadlines(connections, ACCEPT_DEADLINE, HANDSHAKE_DEADLINE).await
    }

    /// Serves the attempts, with deadlines a regression test can shorten.
    ///
    /// A failed handshake is a refusal. An absent client and a stalled
    /// handshake get their own reports, so a negative test cannot pass without
    /// reaching TLS.
    pub(crate) async fn start_with_deadlines(
        connections: usize,
        accept: std::time::Duration,
        handshake: std::time::Duration,
    ) -> Self {
        let (listener, port) = tls::bind().await;
        let acceptor = TlsAcceptor::from(tls::localhost_config());
        let (reports, received) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            for _ in 0..connections {
                let stream = match tokio::time::timeout(accept, listener.accept()).await {
                    Ok(Ok((stream, _))) => stream,
                    _ => {
                        let _ = reports.send("no-connection");
                        break;
                    }
                };
                let mut stream =
                    match tokio::time::timeout(handshake, acceptor.accept(stream)).await {
                        Ok(Ok(stream)) => stream,
                        Ok(Err(_)) => {
                            let _ = reports.send("tls-refused-no-http");
                            continue;
                        }
                        Err(_) => {
                            let _ = reports.send("handshake-timeout");
                            continue;
                        }
                    };
                let report = match http::read_request(&mut stream).await {
                    Ok(Some(_)) => {
                        let _ = http::respond(&mut stream, 200, None, br#"{"ok":true}"#).await;
                        "http-received"
                    }
                    Ok(None) => "empty",
                    Err(_) => "tls-refused-no-http",
                };
                let _ = reports.send(report);
            }
        });
        Self {
            port,
            reports: received,
            task,
        }
    }

    /// The outcome of the next connection the client made.
    pub(crate) async fn report(&mut self) -> &'static str {
        self.reports
            .recv()
            .await
            .expect("the peer serves one report per connection")
    }
}

impl Drop for HttpTlsPeer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A TLS peer that records the path and authorization presence of each
/// request, and answers `/report` with the record.
pub(crate) struct RecordingHttpsPeer {
    pub(crate) port: u16,
    task: JoinHandle<()>,
}

impl RecordingHttpsPeer {
    pub(crate) async fn start() -> Self {
        let (listener, port) = tls::bind().await;
        let acceptor = TlsAcceptor::from(tls::localhost_config());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let mut stream = match tokio::time::timeout(
                    HANDSHAKE_DEADLINE,
                    tls::accept(&acceptor, &listener),
                )
                .await
                {
                    Ok(Ok(stream)) => stream,
                    _ => continue,
                };
                let Ok(Some(request)) = http::read_request(&mut stream).await else {
                    continue;
                };
                if request.path == "/report" {
                    let body = serde_json::to_vec(&*recorded.lock().unwrap()).unwrap();
                    let _ = http::respond(&mut stream, 200, Some("application/json"), &body).await;
                    continue;
                }
                recorded.lock().unwrap().push(json!({
                    "path": request.path,
                    "authorization": request.header("authorization").is_some(),
                }));
                if request.path == "/html" {
                    let _ = http::respond(
                        &mut stream,
                        200,
                        Some("text/html"),
                        b"<html>marketing page</html>",
                    )
                    .await;
                } else {
                    let _ = http::respond(&mut stream, 401, None, b"").await;
                }
            }
        });
        Self { port, task }
    }
}

impl Drop for RecordingHttpsPeer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct ScriptedState {
    responses: VecDeque<Value>,
    requests: Vec<Value>,
    connections: u64,
}

/// A TLS peer that answers each request with the next scripted response and
/// records what the client sent.
pub(crate) struct ScriptedHttpsPeer {
    pub(crate) port: u16,
    state: Arc<Mutex<ScriptedState>>,
    task: JoinHandle<()>,
}

impl ScriptedHttpsPeer {
    pub(crate) async fn start() -> Self {
        let (listener, port) = tls::bind().await;
        let acceptor = TlsAcceptor::from(tls::discovery_config());
        let state = Arc::new(Mutex::new(ScriptedState {
            responses: VecDeque::new(),
            requests: Vec::new(),
            connections: 0,
        }));
        let shared = state.clone();
        let task = tokio::spawn(async move {
            loop {
                // Count every accepted TCP connection, as the baseline peer
                // did: a handshake the client aborts is still a connection.
                let stream = match tokio::time::timeout(ACCEPT_DEADLINE, listener.accept()).await {
                    Ok(Ok((stream, _))) => stream,
                    _ => break,
                };
                shared.lock().unwrap().connections += 1;
                let mut stream =
                    match tokio::time::timeout(HANDSHAKE_DEADLINE, acceptor.accept(stream)).await {
                        Ok(Ok(stream)) => stream,
                        _ => continue,
                    };
                let Ok(Some(request)) = http::read_request(&mut stream).await else {
                    continue;
                };
                let response = {
                    let mut shared = shared.lock().unwrap();
                    shared.requests.push(json!({
                        "host": request.header("host").unwrap_or_default(),
                        "path": request.path,
                        "method": request.method,
                        "authorization": request.header("authorization"),
                        "depth": request.header("depth"),
                        "body": String::from_utf8_lossy(&request.body),
                    }));
                    shared
                        .responses
                        .pop_front()
                        .unwrap_or_else(|| json!({"status": 500}))
                };
                let status = response["status"].as_u64().unwrap_or(200) as u16;
                let body = response["body"].as_str().unwrap_or_default().as_bytes();
                let location = response["location"]
                    .as_str()
                    .map(|value| ("Location", value));
                let headers: Vec<(&str, &str)> = location.into_iter().collect();
                let _ = http::respond_with(&mut stream, status, None, &headers, body).await;
            }
        });
        Self { port, state, task }
    }

    /// Replaces the scripted answers and clears the record.
    pub(crate) fn responses(&self, responses: Value) {
        let mut state = self.state.lock().unwrap();
        state.responses = responses.as_array().cloned().unwrap_or_default().into();
        state.requests.clear();
        state.connections = 0;
    }

    /// The requests received since the last `responses` call.
    ///
    /// A connection without an HTTP request means TLS refused the client, so
    /// the two counts must agree. The assertion runs after the lock is
    /// released, so a mismatch leaves the peer usable.
    pub(crate) fn requests(&self) -> Vec<Value> {
        let (connections, requests) = {
            let state = self.state.lock().unwrap();
            (state.connections, state.requests.clone())
        };
        assert_eq!(
            connections,
            requests.len() as u64,
            "an unexpected connection occurred even though TLS prevented an HTTP request"
        );
        requests
    }
}

impl Drop for ScriptedHttpsPeer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
