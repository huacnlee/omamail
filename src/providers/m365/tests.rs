//! The provider against a scripted fake of Graph and the login host on one loopback listener, with
//! synthetic accounts, credentials and mail. The registry file, credential store and hosts are
//! process-wide, so a test that uses a `World` runs in an isolated child process
//! (`mail::tests::isolated`); pure functions are tested directly in `unit`.

mod actions;
mod drafts;
mod mail;
mod signin;
mod unit;
mod wire;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::model::Role;
use crate::credentials::tests::{StoreOverride, isolated_store};
use crate::credentials::{CredentialKey, CredentialStore, Error, Secret};
use crate::mail::tests::{AccountFixture, account_fixture};

pub(super) const ADDRESS: &str = "alice@example.org";
pub(super) const ACCOUNT: &str = "m365:alice@example.org";
pub(super) const CLIENT: &str = "00000000-1111-2222-3333-444444444444";

/// Runs the test in a child process of its own: the registry, keyring and hosts are process-wide.
macro_rules! isolated {
    () => {
        if crate::mail::tests::isolated() {
            return;
        }
    };
}
pub(super) use isolated;

/// `world.call(method, json!(params))` unwrapped (`ok!`) or its error (`err!`); the braces of the
/// params keep rustfmt from wrapping a short call over five lines.
macro_rules! ok {
    ($world:expr, $method:expr, $params:tt) => {
        $world
            .call($method, serde_json::json!($params))
            .await
            .unwrap()
    };
}
macro_rules! err {
    ($world:expr, $method:expr, $params:tt) => {
        $world
            .call($method, serde_json::json!($params))
            .await
            .unwrap_err()
    };
}
pub(super) use {err, ok};

/// One request the fake received.
#[derive(Clone, Debug)]
pub(super) struct Req {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Req {
    pub(super) fn header(&self, name: &str) -> Option<&str> {
        let found = self
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name));
        found.map(|(_, v)| v.as_str())
    }

    pub(super) fn param(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub(super) fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }

    /// A field of a urlencoded body.
    pub(super) fn field(&self, name: &str) -> Option<String> {
        let url = reqwest::Url::parse(&format!(
            "http://x/?{}",
            String::from_utf8_lossy(&self.body)
        ));
        url.unwrap()
            .query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    }
}

/// What the fake does with a request.
pub(super) enum Resp {
    Send(u16, Vec<(String, String)>, Vec<u8>),
    /// Declares `Content-Length` of the second field and sends the body.
    Lying(usize, Vec<u8>),
    /// A body with no length, one chunk per item.
    Chunked(Vec<Vec<u8>>),
    /// Confirms success, then stalls or truncates a chunked body.
    UnfinishedBody(u16, bool),
    /// Reads the request and never answers.
    Stall,
    /// Waits, then answers. A test sits a body between the listing clock and the body clock.
    Wait(std::time::Duration, Box<Resp>),
}

impl Resp {
    pub(super) fn json(status: u16, value: Value) -> Resp {
        Resp::Send(status, vec![], value.to_string().into_bytes())
    }

    pub(super) fn status(status: u16) -> Resp {
        Resp::Send(status, vec![], vec![])
    }

    pub(super) fn with(self, name: &str, value: &str) -> Resp {
        match self {
            Resp::Send(status, mut headers, body) => {
                headers.push((name.into(), value.into()));
                Resp::Send(status, headers, body)
            }
            other => other,
        }
    }
}

type Hook = Arc<dyn Fn(&Req) -> Option<Resp> + Send + Sync>;

pub(super) struct Msg {
    pub id: String,
    pub folder: Role,
    pub subject: String,
    pub read: bool,
    pub flagged: bool,
    pub mime: Vec<u8>,
}

#[derive(Default)]
pub(super) struct State {
    pub msgs: Vec<Msg>,
    /// The roles the mailbox has a folder for (an Archive exists only once somebody made one).
    pub roles: Vec<Role>,
    /// The refresh token the login host accepts, and how many it has issued.
    pub refresh: String,
    pub access: String,
    pub issued: u32,
    /// Answers of the token endpoint to a device-code grant, in order (default: pending).
    pub device: VecDeque<(u16, Value)>,
    pub sent: Vec<Vec<u8>>,
    /// Consulted before anything else: a rule that replaces the answer to a chosen request.
    pub hook: Option<Hook>,
    pub seen: Vec<Req>,
}

pub(super) fn gid(n: u32) -> String {
    format!("AAMkAGI2{n:04}AAA=")
}

pub(super) fn oid(n: u32) -> String {
    super::ids::encode(&gid(n)).unwrap()
}

pub(super) fn plain_mime(subject: &str) -> Vec<u8> {
    format!("From: Bob <bob@example.org>\r\nTo: alice@example.org\r\nSubject: {subject}\r\nDate: Fri, 9 Oct 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody of {subject}\r\n").into_bytes()
}

impl State {
    pub(super) fn add(&mut self, n: u32, folder: Role, subject: &str) -> &mut Msg {
        self.msgs.push(Msg {
            id: gid(n),
            folder,
            subject: subject.into(),
            read: false,
            flagged: false,
            mime: plain_mime(subject),
        });
        self.msgs.last_mut().unwrap()
    }

    pub(super) fn msg(&mut self, n: u32) -> &mut Msg {
        let id = gid(n);
        self.msgs.iter_mut().find(|m| m.id == id).unwrap()
    }

    fn folder_id(role: Role) -> String {
        format!("folder-{}", role.well_known())
    }

    fn message_json(&self, m: &Msg) -> Value {
        let n: i64 = m.id[8..12].parse().unwrap();
        json!({
            "id": m.id, "parentFolderId": Self::folder_id(m.folder),
            "internetMessageId": format!("<m{n}@example.org>"), "subject": m.subject,
            "from": {"emailAddress": {"name": "Bob", "address": "bob@example.org"}},
            "toRecipients": [{"emailAddress": {"name": "Alice", "address": ADDRESS}}],
            "ccRecipients": [], "isRead": m.read, "isDraft": m.folder == Role::Drafts,
            "flag": {"flagStatus": if m.flagged {"flagged"} else {"notFlagged"}},
            "receivedDateTime": format!("2026-10-09T10:{:02}:00Z", n % 60), "sentDateTime": "2026-10-09T10:00:00Z",
            "bodyPreview": format!("Body of {}", m.subject),
        })
    }

    /// A listing page: newest first (the higher number), `$skiptoken` is an offset.
    fn page(&self, req: &Req, base: &str, rows: Vec<&Msg>) -> Resp {
        let mut rows = rows;
        rows.sort_by_key(|m| std::cmp::Reverse(m.id.clone()));
        let top: usize = req.param("$top").map_or(10, |t| t.parse().unwrap());
        let skip: usize = req.param("$skiptoken").map_or(0, |t| t.parse().unwrap());
        let mut body = json!({"value": rows.iter().skip(skip).take(top).map(|m| self.message_json(m)).collect::<Vec<_>>()});
        if skip + top < rows.len() {
            let mut query: Vec<String> = req
                .query
                .iter()
                .filter(|(k, _)| k != "$skiptoken")
                .map(|(k, v)| format!("{k}={}", v.replace(' ', "%20")))
                .collect();
            query.push(format!("$skiptoken={}", skip + top));
            body["@odata.nextLink"] = json!(format!("{base}{}?{}", req.path, query.join("&")));
        }
        Resp::json(200, body)
    }

    fn graph(&mut self, req: &Req, base: &str) -> Resp {
        if req.header("authorization") != Some(&format!("Bearer {}", self.access)) {
            return Resp::json(
                401,
                json!({"error": {"code": "InvalidAuthenticationToken"}}),
            );
        }
        let segments: Vec<&str> = req
            .path
            .trim_start_matches("/v1.0/me/")
            .split('/')
            .collect();
        let missing = || Resp::json(404, json!({"error": {"code": "ErrorItemNotFound"}}));
        match (req.method.as_str(), segments.as_slice()) {
            ("GET", ["mailFolders", wk]) => {
                let Some(role) = Role::ALL
                    .into_iter()
                    .find(|r| r.well_known() == *wk)
                    .filter(|r| self.roles.contains(r))
                else {
                    return Resp::json(404, json!({"error": {"code": "ErrorFolderNotFound"}}));
                };
                let here = self.msgs.iter().filter(|m| m.folder == role);
                let unread = here.clone().filter(|m| !m.read).count();
                Resp::json(
                    200,
                    json!({"id": Self::folder_id(role), "totalItemCount": here.count(), "unreadItemCount": unread}),
                )
            }
            ("GET", ["mailFolders", wk, "messages"]) => {
                let filter = req.param("$filter").unwrap_or("");
                let rows = self.msgs.iter().filter(|m| m.folder.well_known() == *wk);
                let rows = rows
                    .filter(|m| !filter.contains("isRead eq false") || !m.read)
                    .filter(|m| !filter.contains("flagged") || m.flagged)
                    .collect();
                self.page(req, base, rows)
            }
            ("GET", ["messages"]) => {
                let phrase = req
                    .param("$search")
                    .unwrap_or("")
                    .trim_matches('"')
                    .to_lowercase();
                let rows = self
                    .msgs
                    .iter()
                    .filter(|m| m.subject.to_lowercase().contains(&phrase))
                    .collect();
                self.page(req, base, rows)
            }
            ("GET", ["messages", id]) => match self.msgs.iter().find(|m| m.id == *id) {
                Some(m) => Resp::json(200, self.message_json(m)),
                None => missing(),
            },
            ("GET", ["messages", id, "$value"]) => match self.msgs.iter().find(|m| m.id == *id) {
                Some(m) => Resp::Send(200, vec![], m.mime.clone()),
                None => missing(),
            },
            ("PATCH", ["messages", id]) => {
                let body = req.json();
                let Some(m) = self.msgs.iter_mut().find(|m| m.id == *id) else {
                    return missing();
                };
                if let Some(read) = body["isRead"].as_bool() {
                    m.read = read;
                }
                if let Some(status) = body["flag"]["flagStatus"].as_str() {
                    m.flagged = status == "flagged";
                }
                Resp::json(200, json!({}))
            }
            ("POST", ["messages", id, "move"]) => {
                let to = req.json()["destinationId"].as_str().unwrap().to_owned();
                let Some(role) = Role::ALL.into_iter().find(|r| r.well_known() == to) else {
                    return Resp::status(400);
                };
                let Some(m) = self.msgs.iter_mut().find(|m| m.id == *id) else {
                    return missing();
                };
                m.folder = role;
                Resp::json(201, json!({"id": m.id}))
            }
            ("POST", ["messages"]) => {
                let n = 9000 + self.seen.len() as u32;
                let mime = base64::engine::general_purpose::STANDARD
                    .decode(&req.body)
                    .unwrap();
                self.msgs.push(Msg {
                    id: gid(n),
                    folder: Role::Drafts,
                    subject: "Draft".into(),
                    read: true,
                    flagged: false,
                    mime,
                });
                Resp::json(201, self.message_json(self.msgs.last().unwrap()))
            }
            ("DELETE", ["messages", id]) => match self.msgs.iter().position(|m| m.id == *id) {
                Some(at) => {
                    self.msgs.remove(at);
                    Resp::status(204)
                }
                None => missing(),
            },
            ("POST", ["sendMail"]) => {
                self.sent.push(req.body.clone());
                Resp::status(202)
            }
            _ => Resp::status(404),
        }
    }

    /// A token response: a new access token and a new refresh token (the old one is no longer good),
    /// with an id token whose `preferred_username` is `user` when there is one.
    pub(super) fn issue(&mut self, user: Option<&str>) -> Value {
        self.issue_claims(user.map(|user| json!({"preferred_username": user})))
    }

    /// The same with an id token of any claims.
    pub(super) fn issue_claims(&mut self, claims: Option<Value>) -> Value {
        self.issued += 1;
        self.access = format!("access-{}", self.issued);
        self.refresh = format!("refresh-{}", self.issued);
        let mut body = json!({"access_token": self.access, "refresh_token": self.refresh,
            "expires_in": 3600, "scope": "Mail.ReadWrite Mail.Send Calendars.ReadWrite openid profile"});
        if let Some(claims) = claims {
            body["id_token"] = json!(format!(
                "e30.{}.sig",
                URL_SAFE_NO_PAD.encode(claims.to_string())
            ));
        }
        body
    }

    fn login(&mut self, req: &Req) -> Resp {
        match req.path.rsplit('/').next().unwrap() {
            "devicecode" => Resp::json(
                200,
                json!({
                    "device_code": "synthetic-device-code", "user_code": "ABCD1234", "expires_in": 900,
                    "verification_uri": "https://microsoft.com/devicelogin", "interval": 5,
                }),
            ),
            "token" if req.field("grant_type").as_deref() == Some("refresh_token") => {
                if req.field("refresh_token").as_deref() != Some(&self.refresh) {
                    return Resp::json(400, json!({"error": "invalid_grant"}));
                }
                Resp::json(200, self.issue(None))
            }
            "token" => {
                let (status, body) = self
                    .device
                    .pop_front()
                    .unwrap_or((400, json!({"error": "authorization_pending"})));
                Resp::json(status, body)
            }
            _ => Resp::status(404),
        }
    }
}

pub(super) struct Fake {
    pub base: String,
    pub state: Arc<Mutex<State>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Fake {
    async fn start() -> Fake {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(State {
            roles: Role::ALL.to_vec(),
            refresh: "refresh-0".into(),
            ..State::default()
        }));
        let (served, origin) = (Arc::clone(&state), base.clone());
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(serve(socket, Arc::clone(&served), origin.clone()));
            }
        });
        Fake { base, state, task }
    }

    pub(super) fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    pub(super) fn hook(&self, hook: impl Fn(&Req) -> Option<Resp> + Send + Sync + 'static) {
        self.state().hook = Some(Arc::new(hook));
    }

    /// The requests that went to Graph, and those that went to the login host.
    pub(super) fn graph(&self) -> Vec<Req> {
        self.state()
            .seen
            .iter()
            .filter(|r| r.path.starts_with("/v1.0/"))
            .cloned()
            .collect()
    }

    pub(super) fn login(&self) -> Vec<Req> {
        self.state()
            .seen
            .iter()
            .filter(|r| !r.path.starts_with("/v1.0/"))
            .cloned()
            .collect()
    }
}

async fn serve(mut socket: tokio::net::TcpStream, state: Arc<Mutex<State>>, base: String) {
    let mut buffer = Vec::new();
    let end = loop {
        let mut chunk = [0u8; 4096];
        let n = socket.read(&mut chunk).await.unwrap_or(0);
        if n == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(at) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
    let mut lines = head.lines();
    let mut start = lines.next().unwrap().split(' ');
    let (method, target) = (
        start.next().unwrap().to_owned(),
        start.next().unwrap().to_owned(),
    );
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .map_or(0, |(_, v)| v.parse().unwrap());
    while buffer.len() < end + length {
        let mut chunk = [0u8; 65536];
        let n = socket.read(&mut chunk).await.unwrap_or(0);
        if n == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..n]);
    }
    let url = reqwest::Url::parse(&format!("http://x{target}")).unwrap();
    let req = Req {
        method,
        path: url.path().to_owned(),
        query: url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect(),
        headers,
        body: buffer[end..end + length].to_vec(),
    };
    let resp = {
        let mut state = state.lock().unwrap();
        state.seen.push(req.clone());
        let hooked = state.hook.clone().and_then(|hook| hook(&req));
        hooked.unwrap_or_else(|| {
            if req.path.starts_with("/v1.0/") {
                state.graph(&req, &base)
            } else {
                state.login(&req)
            }
        })
    };
    let resp = {
        let mut resp = resp;
        while let Resp::Wait(wait, inner) = resp {
            tokio::time::sleep(wait).await;
            resp = *inner;
        }
        resp
    };
    let write = |status: u16, headers: String, body: &[u8]| {
        let mut out =
            format!("HTTP/1.1 {status} X\r\n{headers}Connection: close\r\n\r\n").into_bytes();
        out.extend_from_slice(body);
        out
    };
    let bytes = match resp {
        Resp::Send(status, headers, body) => {
            let extra: String = headers
                .iter()
                .map(|(k, v)| format!("{k}: {v}\r\n"))
                .collect();
            write(
                status,
                format!("Content-Length: {}\r\n{extra}", body.len()),
                &body,
            )
        }
        Resp::Lying(declared, body) => write(200, format!("Content-Length: {declared}\r\n"), &body),
        Resp::Chunked(chunks) => {
            let mut body = Vec::new();
            for chunk in chunks {
                body.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
                body.extend_from_slice(&chunk);
                body.extend_from_slice(b"\r\n");
            }
            body.extend_from_slice(b"0\r\n\r\n");
            write(200, "Transfer-Encoding: chunked\r\n".into(), &body)
        }
        Resp::UnfinishedBody(status, stall) => {
            let head = write(status, "Transfer-Encoding: chunked\r\n".into(), &[]);
            let _ = socket.write_all(&head).await;
            if stall {
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            }
            return;
        }
        Resp::Stall => {
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            return;
        }
        Resp::Wait(_, _) => return,
    };
    let _ = socket.write_all(&bytes).await;
    let _ = socket.shutdown().await;
}

/// The keyring item of the test account: kind `m365-refresh-token`, bound to account and client id.
pub(super) fn key() -> CredentialKey {
    CredentialKey {
        provider: "m365".into(),
        account_id: ACCOUNT.into(),
        kind: crate::credentials::CredentialKind::M365RefreshToken {
            client_id: CLIENT.into(),
        },
    }
}

/// A credential store in memory that remembers every write.
#[derive(Clone, Default)]
pub(super) struct MemoryStore {
    secrets: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    pub gets: Arc<std::sync::atomic::AtomicUsize>,
    pub puts: Arc<Mutex<Vec<(String, String)>>>,
    /// Runs while a token is being written, before the write lands.
    pub during_put: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>,
}

impl MemoryStore {
    fn name(key: &CredentialKey) -> String {
        format!("{key:?}")
    }

    pub(super) fn set(&self, token: &str) {
        let key = key();
        self.secrets
            .lock()
            .unwrap()
            .insert(Self::name(&key), token.as_bytes().to_vec());
    }

    pub(super) fn token(&self) -> Option<String> {
        let key = key();
        let found = self.secrets.lock().unwrap().get(&Self::name(&key)).cloned();
        found.map(|bytes| String::from_utf8(bytes).unwrap())
    }
}

impl CredentialStore for MemoryStore {
    fn get(&self, key: &CredentialKey) -> Result<Secret, Error> {
        self.gets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match self.secrets.lock().unwrap().get(&Self::name(key)) {
            Some(bytes) => Secret::new(bytes.clone()),
            None => Err(Error::Missing),
        }
    }

    fn put(&self, key: &CredentialKey, secret: &[u8]) -> Result<(), Error> {
        let during = self.during_put.lock().unwrap().clone();
        if let Some(during) = during {
            during();
        }
        let (name, text) = (Self::name(key), String::from_utf8(secret.to_vec()).unwrap());
        self.puts.lock().unwrap().push((name.clone(), text));
        self.secrets.lock().unwrap().insert(name, secret.to_vec());
        Ok(())
    }

    fn delete(&self, key: &CredentialKey) -> Result<(), Error> {
        match self.secrets.lock().unwrap().remove(&Self::name(key)) {
            Some(_) => Ok(()),
            None => Err(Error::Missing),
        }
    }
}

/// A fake, a registry with one Microsoft 365 account, a keyring and the two hosts pointed at the fake.
pub(super) struct World {
    pub fake: Fake,
    pub store: MemoryStore,
    _fixture: AccountFixture,
    _override: StoreOverride,
}

impl Drop for World {
    fn drop(&mut self) {
        *super::graph::LOCAL.lock().unwrap() = None;
        *crate::auth::m365::TEST_LOGIN.lock().unwrap() = None;
        *super::graph::SHORT_OPERATION.lock().unwrap() = None;
        *super::graph::SHORT_MIME.lock().unwrap() = None;
        *super::cancel::SHORT_DEADLINE.lock().unwrap() = None;
        *super::signin::INTERVAL.lock().unwrap() = None;
        *super::signin::SHORT_POLL_WAIT.lock().unwrap() = None;
        *super::signin::SHORT_LANE_WAIT.lock().unwrap() = None;
    }
}

impl World {
    /// Signed in: the keyring holds the refresh token the login host accepts.
    pub(super) async fn new() -> World {
        let world = World::signed_out().await;
        world.store.set("refresh-0");
        world
    }

    pub(super) async fn signed_out() -> World {
        let fake = Fake::start().await;
        let client = super::graph::builder().build().unwrap();
        let root = reqwest::Url::parse(&format!("{}/v1.0", fake.base)).unwrap();
        *super::graph::LOCAL.lock().unwrap() = Some((client, root));
        *crate::auth::m365::TEST_LOGIN.lock().unwrap() = Some(fake.base.clone());
        *super::signin::INTERVAL.lock().unwrap() = Some(std::time::Duration::ZERO);
        let registry = json!({"version": 1, "activeId": ACCOUNT, "accounts": [
            {"provider": "m365", "email": ADDRESS, "clientId": CLIENT},
            {"provider": "outlook", "email": "bob@example.org", "clientId": CLIENT},
        ]});
        let store = MemoryStore::default();
        World {
            fake,
            _fixture: account_fixture(registry),
            _override: isolated_store(store.clone()),
            store,
        }
    }

    /// The registry's Microsoft 365 entry with this `clientId`, as the window may have saved it.
    pub(super) fn save_client(&self, client: &str) {
        let registry = json!({"version": 1, "activeId": ACCOUNT, "accounts": [
            {"provider": "m365", "email": ADDRESS, "clientId": client},
        ]});
        let path = self
            ._fixture
            .config
            .join(crate::platform::dirs::APP_DIRECTORY);
        std::fs::write(path.join("accounts.json"), registry.to_string()).unwrap();
    }

    /// Deadlines for the calls that follow: an operation's and a call's, in milliseconds.
    pub(super) fn deadlines(&self, operation: u64, call: u64) {
        *super::graph::SHORT_OPERATION.lock().unwrap() =
            Some(std::time::Duration::from_millis(operation));
        *super::cancel::SHORT_DEADLINE.lock().unwrap() =
            Some(std::time::Duration::from_millis(call));
    }

    pub(super) async fn call(
        &self,
        method: &str,
        mut params: Value,
    ) -> Result<Value, &'static str> {
        params["accountId"] = json!(ACCOUNT);
        super::call(method, &params).await
    }
}

/// An inbox of `count` messages numbered 1..=count.
pub(super) fn inbox(world: &World, count: u32) {
    let mut state = world.fake.state();
    for n in 1..=count {
        state.add(n, Role::Inbox, &format!("Message {n}"));
    }
}
