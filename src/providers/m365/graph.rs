//! The wire to Microsoft Graph: one fixed host, a bearer token from `auth`, no redirects, no proxy,
//! bounded bodies and deadlines, and the throttling rules.
//!
//! - HTTPS only with certificate verification; a 3xx is an answer like any other, so the bearer token
//!   is never sent again to a `Location`. No setting, environment variable or request field names a
//!   host; only a test build can point the client at a local listener.
//! - Reads are repeated after 429, 503 and 504 (twice, after the `Retry-After` wait, never longer than
//!   `MAX_RETRY_WAIT`: asking sooner is what a throttle punishes). Writes only after 429, which
//!   Microsoft sends instead of acting; a 5xx or a lost connection after the bytes went out is an
//!   unknown outcome and is not repeated. A 401 is repeated once with a fresh token.
//! - Every request, with its waits for a slot, a token and (after a 401) the refresh lane, has a clock
//!   of its own: 20 seconds, and a message body (up to 24 MiB) 60, since 20 is a `m365_timeout` on a
//!   slow link before those bytes arrive. A message uploaded whole (a send, a draft) gets a second
//!   more for every 256 KiB, up to what its caller can wait (`upload_clock`). The call around it has
//!   its own deadline (`cancel`), and a batch caps every request at its own end (`until`). Four
//!   requests at most are in flight per mailbox (Microsoft's per-mailbox limit for an application).
//! - A change answered with a 2xx was applied: its answer is not read past what the caller needs,
//!   and an answer too long to read does not make it a failure.
//! - Errors are static codes. What Graph says in an error body is read only for its `error.code`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use reqwest::{Client, Method, Url, header};
use serde_json::Value;
use tokio::sync::Semaphore;
use tokio::time::{Instant, sleep, timeout_at};

const ROOT: &str = "https://graph.microsoft.com/v1.0";
const OPERATION: Duration = Duration::from_secs(20);
/// A full message, on its own clock. 24 MiB at about 3 Mbit/s, and still inside the longer wait
/// `reader.open` and the desktop give a Microsoft 365 message.
const MIME_BUDGET: Duration = Duration::from_secs(60);
const MAX_RETRY_WAIT: Duration = Duration::from_secs(5);
const MAX_RETRIES: usize = 2;
/// A repeat needs this much of the deadline left after its wait.
const MIN_RETRY_BUDGET: Duration = Duration::from_secs(2);
const MAX_ERROR_BODY: usize = 16 * 1024;
pub(super) const MAX_JSON: usize = 4 * 1024 * 1024;
/// An upload's clock grows by a second for every this many bytes of its body: about 2 Mbit/s.
const UPLOAD_RATE: usize = 256 * 1024;

pub(super) const NOT_FOUND: &str = "m365_message_not_found";
const DENIED: &str = "m365_access_denied";
const AUTH: &str = "m365_auth_failed";
const THROTTLED: &str = "m365_throttled";
const SERVER: &str = "m365_server_error";
const REQUEST: &str = "m365_invalid_request";
pub(super) const TOO_LARGE: &str = "m365_response_too_large";
/// Microsoft refused what was sent for its size.
pub(super) const MESSAGE_TOO_LARGE: &str = "m365_message_too_large";

/// The requests one mailbox may have in flight: four, each mailbox its own.
pub(super) fn slots(account: &str) -> Arc<Semaphore> {
    static SLOTS: LazyLock<Mutex<HashMap<String, Arc<Semaphore>>>> =
        LazyLock::new(Default::default);
    let mut slots = SLOTS.lock().unwrap_or_else(PoisonError::into_inner);
    Arc::clone(
        slots
            .entry(account.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(4))),
    )
}

/// A failed request: the code, the HTTP status (0 before an answer) and whether the request may
/// have reached the server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Fault {
    pub code: &'static str,
    pub status: u16,
    pub sent: bool,
}

fn before_send(code: &'static str) -> Fault {
    Fault {
        code,
        status: 0,
        sent: false,
    }
}

pub(super) struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    retry_after: Option<Duration>,
}

/// Which failures a request is repeated after.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Read,
    Write,
    Once,
}

/// What every client of this provider is: no environment proxy and no redirect, so a bearer token is
/// never sent anywhere a server points. Tests add nothing and drop only the HTTPS requirement.
pub(super) fn builder() -> reqwest::ClientBuilder {
    Client::builder()
        .hickory_dns(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
}

#[cfg(test)]
pub(super) static LOCAL: std::sync::Mutex<Option<(Client, Url)>> = std::sync::Mutex::new(None);
/// Test builds: a shorter deadline for the operations that follow.
#[cfg(test)]
pub(super) static SHORT_OPERATION: std::sync::Mutex<Option<Duration>> = std::sync::Mutex::new(None);
/// Test builds: a shorter clock for a message body. Unset, the body keeps `MIME_BUDGET`.
#[cfg(test)]
pub(super) static SHORT_MIME: std::sync::Mutex<Option<Duration>> = std::sync::Mutex::new(None);

/// How long a message body may take to arrive. Every other request has the operation's clock.
fn body_budget() -> Duration {
    #[cfg(test)]
    if let Some(short) = *SHORT_MIME.lock().unwrap_or_else(|e| e.into_inner()) {
        return short;
    }
    MIME_BUDGET
}

/// The client and the `/v1.0` root: fixed, or in a test build the local listener a test installed.
fn root() -> Result<(Client, Url), &'static str> {
    #[cfg(test)]
    if let Some((client, root)) = LOCAL.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Ok((client, root));
    }
    static CLIENT: OnceLock<Result<Client, &'static str>> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        builder()
            .https_only(true)
            .build()
            .map_err(|_| "m365_network_failed")
    });
    let root = Url::parse(ROOT).map_err(|_| "m365_network_failed")?;
    Ok((client.clone()?, root))
}

/// The code for an auth failure, in this provider's words.
pub(super) fn token_error(code: &'static str) -> &'static str {
    match code {
        "auth_signed_out" | "auth_client_missing" | "auth_client_invalid" => "m365_signed_out",
        "auth_consent_required" => "m365_consent_required",
        "auth_refresh_failed" => AUTH,
        "auth_transport_failed" => "m365_network_failed",
        "auth_timeout" => "m365_timeout",
        "auth_response_too_large" | "auth_invalid_response" | "auth_redirect_refused" => {
            "m365_invalid_response"
        }
        other => other,
    }
}

/// Percent-encodes a query value with `%20` for a space: not every service reads a `+` the same.
fn encode_query(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (key, value) in pairs {
        out.push(if out.is_empty() { '?' } else { '&' });
        out.push_str(key);
        out.push('=');
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                out.push(char::from(byte));
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

/// `<root>/<segments...>?<query>`. A segment is a word or an id, never a path step.
pub(super) fn url(segments: &[&str], query: &[(&str, &str)]) -> Result<Url, &'static str> {
    if segments
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        return Err(REQUEST);
    }
    let mut url = root()?.1;
    url.path_segments_mut()
        .map_err(|_| REQUEST)?
        .extend(segments);
    if !query.is_empty() {
        url.set_query(Some(&encode_query(query)[1..]));
    }
    Ok(url)
}

/// A `@odata.nextLink` (or the same in a page token) that may be followed: https on the Graph origin
/// exactly, no user name or fragment, a messages listing under `/v1.0/me/` with no dot segment or
/// escaped separator. Anything else is a hostile or forged link and the bearer token never goes there.
pub(super) fn next_link(raw: &str) -> Option<Url> {
    if raw.len() > 8192
        || raw
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return None;
    }
    let (_, root) = root().ok()?;
    let link = Url::parse(raw).ok()?;
    let path = link.path();
    let safe = |segment: &str| {
        let lower = segment.to_ascii_lowercase();
        !matches!(segment, "." | "..")
            && !["%2f", "%5c", "%2e"].iter().any(|bad| lower.contains(bad))
    };
    (link.origin() == root.origin()
        && link.username().is_empty()
        && link.password().is_none()
        && link.fragment().is_none()
        && path.starts_with(&format!("{}/me/", root.path()))
        && path.ends_with("/messages")
        && path.split('/').skip(1).all(safe))
    .then_some(link)
}

/// The JSON object of an answer.
pub(super) fn object(reply: &Reply) -> Result<Value, &'static str> {
    serde_json::from_slice::<Value>(&reply.body)
        .ok()
        .filter(Value::is_object)
        .ok_or("m365_invalid_response")
}

/// `error.code` of a Graph error body: ASCII word characters and dots, at most 128.
fn error_code(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let code = value["error"]["code"].as_str()?;
    (code.len() <= 128
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.'))
    .then(|| code.to_owned())
}

/// The code for an error answer. The body's `error.code` refines the status: Graph answers some
/// missing items with a 400.
fn fault(reply: &Reply) -> Fault {
    let code = match error_code(&reply.body).as_deref().unwrap_or("") {
        "ErrorItemNotFound"
        | "ErrorInvalidIdMalformed"
        | "ErrorInvalidMailboxItemId"
        | "ResourceNotFound"
        | "ErrorFolderNotFound" => NOT_FOUND,
        "ErrorAccessDenied"
        | "ErrorSendAsDenied"
        | "MailboxNotEnabledForRESTAPI"
        | "MailboxNotSupportedForRESTAPI"
        | "Authorization_RequestDenied" => DENIED,
        "InvalidAuthenticationToken" => AUTH,
        // Exchange's response code for a message over the size the mailbox takes.
        "ErrorMessageSizeExceeded" => MESSAGE_TOO_LARGE,
        "ApplicationThrottled" | "ErrorServerBusy" | "MailboxConcurrency" | "TooManyRequests" => {
            THROTTLED
        }
        _ => match reply.status {
            401 => AUTH,
            403 => DENIED,
            404 => NOT_FOUND,
            413 => MESSAGE_TOO_LARGE,
            429 => THROTTLED,
            400 | 405..=499 => REQUEST,
            503 | 504 if reply.retry_after.is_some() => THROTTLED,
            500..=599 => SERVER,
            // A 3xx was not followed, and nothing else answers a request like ours.
            _ => "m365_bad_response",
        },
    };
    Fault {
        code,
        status: reply.status,
        sent: true,
    }
}

/// A transport error as a fault. A failure to connect (refused, no route, a certificate the platform
/// does not trust) came before any byte of the request could be acted on.
fn classify(error: reqwest::Error) -> Fault {
    if error.is_timeout() {
        return Fault {
            code: "m365_timeout",
            status: 0,
            sent: !error.is_connect(),
        };
    }
    if error.is_connect() || error.is_builder() {
        let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(&error);
        while let Some(current) = cause {
            // An `io::Error` hides what it wraps from `source()`: look through `get_ref` too.
            let inner = current
                .downcast_ref::<std::io::Error>()
                .and_then(std::io::Error::get_ref);
            if current.is::<rustls::Error>() || inner.is_some_and(|e| e.is::<rustls::Error>()) {
                return before_send("m365_tls_failed");
            }
            cause = current.source();
        }
        return before_send("m365_network_failed");
    }
    // The connection was up when it failed: the server may have received the request.
    Fault {
        code: "m365_network_failed",
        status: 0,
        sent: true,
    }
}

/// One operation's access to a mailbox: every request ends at its own deadline.
pub(super) struct Graph {
    pub account: String,
    operation: Duration,
    /// A plan's look at the mailbox: a token refreshed for it does not save a rotated refresh token.
    read_only: bool,
    /// When set, no request runs past it: a batch's end.
    until: Option<Instant>,
    /// Why there is no token, once there has been no token: the rest of the operation fails with it,
    /// so a batch of fifty messages does not send a refused grant to the login host fifty times.
    no_token: Mutex<Option<&'static str>>,
}

impl Graph {
    pub(super) fn new(account: &str) -> Graph {
        #[cfg(test)]
        let operation = SHORT_OPERATION
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .unwrap_or(OPERATION);
        #[cfg(not(test))]
        let operation = OPERATION;
        Graph {
            account: account.to_owned(),
            operation,
            read_only: false,
            until: None,
            no_token: Default::default(),
        }
    }

    /// The same, with every request ending by `end` at the latest.
    pub(super) fn until(self, end: Instant) -> Graph {
        Graph {
            until: Some(end),
            ..self
        }
    }

    /// The clock of a request that uploads `len` bytes: the operation's, a second more for every
    /// `UPLOAD_RATE` bytes, and never more than `budget`, the caller's own wait.
    pub(super) fn upload_clock(&self, len: usize, budget: Duration) -> Duration {
        let grown = self.operation + Duration::from_secs((len / UPLOAD_RATE) as u64);
        grown.min(budget)
    }

    /// For reads that change nothing, the keyring included (what `mail.act` plans from).
    pub(super) fn read_only(account: &str) -> Graph {
        Graph {
            read_only: true,
            ..Graph::new(account)
        }
    }

    /// One request, repeated as `mode` allows; only a 2xx answer comes back as `Ok`.
    pub(super) async fn request(
        &self,
        mode: Mode,
        method: Method,
        url: &Url,
        body: Option<(&'static str, &[u8])>,
        ceiling: usize,
    ) -> Result<Reply, Fault> {
        // A body larger than a JSON page is the MIME of a message, on a longer clock.
        let clock = if ceiling > MAX_JSON {
            body_budget()
        } else {
            self.operation
        };
        self.request_within(mode, method, url, body, ceiling, clock)
            .await
    }

    /// The same on a clock of `clock`, or less if the operation ends sooner (`until`).
    pub(super) async fn request_within(
        &self,
        mode: Mode,
        method: Method,
        url: &Url,
        body: Option<(&'static str, &[u8])>,
        ceiling: usize,
        clock: Duration,
    ) -> Result<Reply, Fault> {
        let (client, root) = root().map_err(before_send)?;
        if url.origin() != root.origin() {
            return Err(before_send(REQUEST));
        }
        let (mut repeats, mut refreshed) = (0, false);
        let mut deadline = Instant::now() + clock;
        if let Some(until) = self.until {
            deadline = deadline.min(until);
        }
        let slots = slots(&self.account);
        // Set once this attempt's request is handed to the connection: a deadline before that sent
        // nothing. Cleared for every attempt, since every status that is repeated (a 401, a write's
        // 429) applied nothing: a deadline in the waits for the next attempt's slot or token is not a
        // request that may have gone out.
        let written = AtomicBool::new(false);
        loop {
            written.store(false, Ordering::SeqCst);
            let exchange = async {
                let _slot = slots.acquire().await.map_err(|_| before_send(REQUEST))?;
                let held = *self.no_token.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(code) = held {
                    return Err(before_send(code));
                }
                let token = if self.read_only {
                    crate::auth::access_token_readonly("m365", &self.account, "graph").await
                } else {
                    crate::auth::access_token("m365", &self.account, "graph").await
                };
                let token = token.map_err(|code| {
                    let code = token_error(code);
                    *self.no_token.lock().unwrap_or_else(|e| e.into_inner()) = Some(code);
                    before_send(code)
                })?;
                let mut bearer = header::HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|_| before_send(AUTH))?;
                bearer.set_sensitive(true);
                let mut request = client
                    .request(method.clone(), url.clone())
                    .header(header::AUTHORIZATION, bearer)
                    .header("Prefer", "IdType=\"ImmutableId\"");
                if let Some((kind, bytes)) = body {
                    request = request
                        .header(header::CONTENT_TYPE, kind)
                        .body(bytes.to_vec());
                }
                written.store(true, Ordering::SeqCst);
                let mut response = request.send().await.map_err(classify)?;
                let status = response.status().as_u16();
                let retry_after = response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|text| text.trim().parse::<u64>().ok())
                    .map(Duration::from_secs);
                let wanted = (200..300).contains(&status);
                // These writes consume only the status. Once Graph confirmed
                // them, a missing or broken optional body cannot undo success.
                if wanted && ceiling == 0 {
                    return Ok(Reply {
                        status,
                        body: Vec::new(),
                        retry_after,
                    });
                }
                let limit = if wanted { ceiling } else { MAX_ERROR_BODY };
                // Only a read needs its whole answer. An error is read for its code and a change that
                // succeeded for what the caller asked of it: neither fails for being longer than that.
                let whole = wanted && mode == Mode::Read;
                let too_large = Fault {
                    code: TOO_LARGE,
                    status,
                    sent: true,
                };
                if response.content_length().is_some_and(|n| n > limit as u64) {
                    if whole {
                        return Err(too_large);
                    }
                    if wanted {
                        return Ok(Reply {
                            status,
                            body: Vec::new(),
                            retry_after,
                        });
                    }
                }
                let mut body = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|error| Fault {
                    sent: true,
                    ..classify(error)
                })? {
                    if chunk.len() > limit - body.len() {
                        if whole {
                            return Err(too_large);
                        }
                        body.clear();
                        break;
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(Reply {
                    status,
                    body,
                    retry_after,
                })
            };
            let reply = timeout_at(deadline, exchange).await.map_err(|_| Fault {
                code: "m365_timeout",
                status: 0,
                sent: written.load(Ordering::SeqCst),
            })??;
            if (200..300).contains(&reply.status) {
                return Ok(reply);
            }
            if reply.status == 401 && !refreshed {
                // Refused before any work: a fresh token and once more. Forgetting the old token waits
                // for the mailbox's refresh lane, which another request's refresh may hold for its whole
                // exchange with the login host, so that wait ends at this request's deadline too. The
                // 401 applied nothing, so a request that runs out of time there did nothing.
                refreshed = true;
                if timeout_at(deadline, crate::auth::invalidate(&self.account))
                    .await
                    .is_err()
                {
                    return Err(before_send("m365_timeout"));
                }
                continue;
            }
            let repeatable = match mode {
                Mode::Read => matches!(reply.status, 429 | 503 | 504),
                Mode::Write => reply.status == 429,
                Mode::Once => false,
            };
            if repeatable && repeats < MAX_RETRIES {
                let wait = reply
                    .retry_after
                    .filter(|wait| !wait.is_zero())
                    .unwrap_or(Duration::from_secs(1));
                let left = deadline.saturating_duration_since(Instant::now());
                if wait <= MAX_RETRY_WAIT && left >= wait + MIN_RETRY_BUDGET {
                    repeats += 1;
                    sleep(wait).await;
                    continue;
                }
            }
            return Err(fault(&reply));
        }
    }

    pub(super) async fn get(&self, url: &Url) -> Result<Value, Fault> {
        let reply = self
            .request(Mode::Read, Method::GET, url, None, MAX_JSON)
            .await?;
        object(&reply).map_err(|code| Fault {
            code,
            status: reply.status,
            sent: true,
        })
    }
}
