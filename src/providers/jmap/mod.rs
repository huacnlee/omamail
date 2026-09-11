//! JMAP's native transport. Session URLs are configured by the user or delegated
//! by an authenticated HTTPS session; redirects never carry a credential.
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, Url, header};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio::{
    sync::{Semaphore, mpsc},
    task::JoinHandle,
};

mod check;
mod discovery;
mod mailbox;
mod mutation;
mod query;
mod read;
mod resource;
mod stream;
#[cfg(test)]
mod tests;

const MAX_BODY: usize = 32 * 1024 * 1024;
const REQUEST_TIME: Duration = Duration::from_secs(20);

pub struct Session {
    client: Result<Client, &'static str>,
    streams: Mutex<HashMap<String, Stream>>,
    slots: Semaphore,
    policies: Mutex<HashMap<String, discovery::Policy>>,
    requests: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
    contexts: Mutex<HashMap<String, std::sync::Arc<mailbox::Context>>>,
}
struct Stream {
    task: JoinHandle<()>,
    receiver: std::sync::Arc<tokio::sync::Mutex<mpsc::Receiver<Value>>>,
}
struct Registration<'a> {
    requests: &'a Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
    id: &'a str,
}
impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if !self.id.is_empty()
            && let Ok(mut requests) = self.requests.lock()
        {
            requests.remove(self.id);
        }
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Default for Session {
    fn default() -> Self {
        Self {
            client: client_builder()
                .https_only(true)
                .build()
                .map_err(|_| "jmap_transport_unavailable"),
            streams: Mutex::new(HashMap::new()),
            slots: Semaphore::new(16),
            policies: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
            contexts: Mutex::new(HashMap::new()),
        }
    }
}
fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .hickory_dns(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .pool_idle_timeout(Duration::from_secs(90))
}
impl Session {
    async fn native_cancellable(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<Value, &'static str> {
        let id = params
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if id.len() > 256 || id.chars().any(char::is_control) {
            return Err("invalid_params");
        }
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        if !id.is_empty() {
            let mut requests = self.requests.lock().map_err(|_| "session_failed")?;
            if requests.len() >= 64 || requests.contains_key(id) {
                return Err("jmap_request_limit");
            }
            requests.insert(id.to_owned(), cancel);
        }
        let _registration = Registration {
            requests: &self.requests,
            id,
        };
        let operation = async {
            if method == "jmap.verify" {
                self.verify(params).await
            } else {
                self.native(method, params).await
            }
        };
        let result = tokio::select! {
            result=tokio::time::timeout(Duration::from_secs(25),operation)=>result.unwrap_or(Err(if method=="jmap.send"{"jmap_submission_unconfirmed"}else{"jmap_timeout"})),
            _=cancelled.changed(),if !id.is_empty()=>Err("jmap_cancelled")
        };
        if result == Err("jmap_unauthorized")
            && let Some(account) = params["accountId"].as_str()
            && let Ok(context) = self.context(account)
        {
            context
                .rejected
                .store(true, std::sync::atomic::Ordering::Release);
        }
        result
    }
    pub async fn call(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        match method {
            "jmap.verify" => self.native_cancellable(method, params).await,
            "jmap.request" => {
                let request = prepare(params)?;
                let request_id = params
                    .get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if request_id.len() > 256 || request_id.chars().any(char::is_control) {
                    return Err("invalid_params");
                }
                let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
                if !request_id.is_empty() {
                    let mut requests = self.requests.lock().map_err(|_| "session_failed")?;
                    if requests.len() >= 64 || requests.contains_key(request_id) {
                        return Err("jmap_request_limit");
                    }
                    requests.insert(request_id.to_owned(), cancel);
                }
                let _registration = Registration {
                    requests: &self.requests,
                    id: request_id,
                };
                let operation = async {
                    self.authorize(params, &request).await?;
                    let client = self.client.as_ref().map_err(|e| *e)?;
                    let _slot = self
                        .slots
                        .acquire()
                        .await
                        .map_err(|_| "jmap_transport_unavailable")?;
                    let session_request = (request.verb == "session").then(|| request.clone());
                    let reply = execute(client, request).await?;
                    if let Some(request) = session_request {
                        self.remember(params, &request, &reply)?;
                    }
                    Ok(reply)
                };
                tokio::select! {
                    result = tokio::time::timeout(REQUEST_TIME, operation) => result.map_err(|_| "jmap_timeout")?,
                    _ = cancelled.changed(), if !request_id.is_empty() => Err("jmap_cancelled"),
                }
            }
            "jmap.cancel" => {
                let id = text(params, "requestId")?;
                if let Some(cancel) = self.requests.lock().map_err(|_| "session_failed")?.get(id) {
                    let _ = cancel.send(true);
                }
                Ok(json!({"cancelled": true}))
            }
            "jmap.stream.open" => {
                let id = stream_id(params)?.to_owned();
                let mut request = prepare(params)?;
                if request.verb != "stream" {
                    return Err("invalid_params");
                }
                request.body = None;
                self.authorize(params, &request).await?;
                let client = self.client.as_ref().map_err(|e| *e)?.clone();
                let mut streams = self.streams.lock().map_err(|_| "session_failed")?;
                if !streams.contains_key(&id) && streams.len() >= 16 {
                    return Err("jmap_stream_limit");
                }
                let (sender, receiver) = mpsc::channel(8);
                let task = tokio::spawn(stream::run(client, request, sender));
                streams.insert(
                    id,
                    Stream {
                        task,
                        receiver: std::sync::Arc::new(tokio::sync::Mutex::new(receiver)),
                    },
                );
                Ok(json!({"opened": true}))
            }
            "jmap.stream.poll" => {
                let id = stream_id(params)?;
                let receiver = self
                    .streams
                    .lock()
                    .map_err(|_| "session_failed")?
                    .get(id)
                    .ok_or("jmap_stream_missing")?
                    .receiver
                    .clone();
                let mut receiver = receiver
                    .try_lock()
                    .map_err(|_| "jmap_stream_poll_pending")?;
                let first = tokio::time::timeout(Duration::from_secs(20), receiver.recv()).await;
                let mut events = Vec::new();
                match first {
                    Ok(Some(event)) => events.push(event),
                    Ok(None) => return Ok(json!({"events": [], "closed": true})),
                    Err(_) => return Ok(json!({"events": [], "closed": false})),
                }
                while events.len() < 8 {
                    match receiver.try_recv() {
                        Ok(event) => events.push(event),
                        Err(_) => break,
                    }
                }
                Ok(json!({"events": events, "closed": false}))
            }
            "jmap.stream.close" => {
                self.streams
                    .lock()
                    .map_err(|_| "session_failed")?
                    .remove(stream_id(params)?);
                Ok(json!({"closed": true}))
            }
            _ => self.native_cancellable(method, params).await,
        }
    }
}
fn stream_id(params: &Value) -> Result<&str, &'static str> {
    let id = params
        .get("streamId")
        .and_then(Value::as_str)
        .ok_or("invalid_params")?;
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        return Err("invalid_params");
    }
    Ok(id)
}
#[derive(Clone)]
struct Request {
    verb: String,
    url: Url,
    authorization: Option<header::HeaderValue>,
    body: Option<Vec<u8>>,
}
fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or("invalid_params")
}
fn clean(value: &str) -> bool {
    value.len() <= 65536 && !value.chars().any(char::is_control)
}
fn url(value: &str) -> Result<Url, &'static str> {
    if !clean(value) || value.contains('\\') || value.trim() != value {
        return Err("jmap_invalid_url");
    }
    let parsed = Url::parse(value).map_err(|_| "jmap_invalid_url")?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err("jmap_invalid_url");
    }
    Ok(parsed)
}
fn prepare(params: &Value) -> Result<Request, &'static str> {
    let verb = text(params, "verb")?;
    if !["session", "call", "download", "upload", "stream"].contains(&verb) {
        return Err("invalid_params");
    }
    let url = url(text(params, "url")?)?;
    let credential = params.get("credential").ok_or("invalid_params")?;
    let scheme = text(credential, "scheme")?;
    let username = text(credential, "username")?;
    let secret = text(credential, "secret")?;
    if !clean(username) || !clean(secret) {
        return Err("jmap_invalid_credential");
    }
    let authorization = match scheme {
        "none" if secret.is_empty() && username.is_empty() => None,
        "basic" if !secret.is_empty() && !username.contains(':') => Some(format!(
            "Basic {}",
            STANDARD.encode(format!("{username}:{secret}"))
        )),
        "bearer" if !secret.is_empty() => Some(format!("Bearer {secret}")),
        _ => return Err("jmap_invalid_credential"),
    }
    .map(|value| {
        let mut value =
            header::HeaderValue::from_str(&value).map_err(|_| "jmap_invalid_credential")?;
        value.set_sensitive(true);
        Ok::<_, &'static str>(value)
    })
    .transpose()?;
    let body = if matches!(verb, "call" | "upload") {
        let body = text(params, "body")?;
        if body.len() > MAX_BODY {
            return Err("jmap_request_too_large");
        }
        if verb == "call" {
            let _: Value = serde_json::from_str(body).map_err(|_| "jmap_invalid_request")?;
        }
        Some(body.as_bytes().to_vec())
    } else {
        None
    };
    Ok(Request {
        verb: verb.to_owned(),
        url,
        authorization,
        body,
    })
}
fn build(client: &Client, request: Request) -> reqwest::RequestBuilder {
    let mut builder = if let Some(body) = request.body {
        client
            .post(request.url)
            .header(
                header::CONTENT_TYPE,
                if request.verb == "upload" {
                    "message/rfc822"
                } else {
                    "application/json; charset=utf-8"
                },
            )
            .body(body)
    } else {
        client.get(request.url)
    };
    builder = builder.header(
        header::ACCEPT,
        if request.verb == "stream" {
            "text/event-stream"
        } else {
            "application/json"
        },
    );
    if let Some(auth) = request.authorization {
        builder = builder.header(header::AUTHORIZATION, auth);
    }
    builder
}
fn network_error(error: reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "jmap_timeout"
    } else {
        "jmap_network_failed"
    }
}
async fn execute(client: &Client, request: Request) -> Result<Value, &'static str> {
    execute_bounded(client, request, MAX_BODY).await
}
async fn execute_bounded(
    client: &Client,
    request: Request,
    limit: usize,
) -> Result<Value, &'static str> {
    let binary = request.verb == "download";
    let base = request.url.clone();
    let mut response = build(client, request)
        .timeout(REQUEST_TIME)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status().as_u16();
    let redirect = response
        .headers()
        .get(header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| base.join(v).ok())
        .and_then(|v| url(v.as_str()).ok())
        .map(|v| v.to_string())
        .unwrap_or_default();
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("jmap_response_too_large");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > limit - bytes.len() {
            return Err("jmap_response_too_large");
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = if binary {
        STANDARD.encode(bytes)
    } else {
        String::from_utf8(bytes).map_err(|_| "jmap_invalid_response")?
    };
    Ok(json!({"exit": 0, "status": status, "redirect": redirect, "body": body, "stderr": ""}))
}
