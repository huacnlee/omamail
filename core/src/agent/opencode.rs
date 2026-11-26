//! One private OpenCode server shared by mail turns. A live IPC lease keeps it
//! resident; after five idle minutes it shuts down, including its MCP children.
use super::{
    storage::Store,
    worker::{Group, pipe, read},
};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::Read as _,
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt},
            process::CommandExt,
        },
    },
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
};
type Result<T> = std::result::Result<T, &'static str>;
fn agent(proposals: bool) -> &'static str {
    if proposals {
        "omamail"
    } else {
        "omamail-events"
    }
}

fn configuration() -> Result<String> {
    let exe = std::env::current_exe().map_err(|_| "agent_worker_unavailable")?;
    let mut configuration = super::config::opencode()?;
    let restricted = json!({"agents":{
        "omamail":{"mode":"primary","system":super::worker::MAIL_ROLE,
            "permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"omamail_propose_draft","resource":"*","effect":"allow"}]},
        "omamail-events":{"mode":"primary","system":super::worker::MAIL_ROLE,
            "permissions":[{"action":"*","resource":"*","effect":"deny"}]}},
        "snapshots":false,"warming":false,"mcp":{"servers":{"omamail":{"type":"local","command":[exe,"agent-mcp","workspace"],"codemode":false}}}});
    for (key, value) in restricted.as_object().unwrap() {
        configuration[key] = value.clone();
    }
    Ok(configuration.to_string())
}

fn isolate(command: &mut Command) -> Result<()> {
    let directory = directory()?;
    crate::cache::directories(&directory, &["config"], true)?.ok_or("agent_storage_unavailable")?;
    command
        .env("XDG_CONFIG_HOME", directory.join("config"))
        .env("OPENCODE_DISABLE_PROJECT_CONFIG", "true")
        .env("OPENCODE_CONFIG_PROJECT_DISABLE", "true")
        .env_remove("OPENCODE_CONFIG")
        .env_remove("OPENCODE_CONFIG_DIR");
    Ok(())
}

fn directory() -> Result<PathBuf> {
    let store = Store::open()?;
    let base = store
        .path()
        .parent()
        .and_then(|p| p.parent())
        .ok_or("agent_storage_unavailable")?;
    crate::cache::directories(base, &["omamail", "agent-runtime"], true)?
        .ok_or("agent_storage_unavailable")?;
    Ok(base.join("omamail/agent-runtime"))
}
fn secret() -> Result<String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|_| "agent_random_failed")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub struct Lease {
    _stream: UnixStream,
    pub url: String,
    pub password: String,
}
impl Lease {
    pub async fn release(&mut self) -> Result<()> {
        self._stream
            .write_all(b"d")
            .await
            .map_err(|_| "agent_server_unavailable")
    }
    pub async fn bind(&mut self, id: &str, session: &str) -> Result<()> {
        super::storage::check_id(id)?;
        if !super::provider::Provider::OpenCode.session(session) {
            return Err("agent_invalid_session");
        }
        let message = json!({"id":id,"session":session}).to_string() + "\n";
        self._stream
            .write_all(message.as_bytes())
            .await
            .map_err(|_| "agent_server_unavailable")
    }
    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.request(reqwest::Method::POST, path, Some(body)).await
    }
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "agent_server_unavailable")?;
        let mut request = client
            .request(method, format!("{}{path}", self.url))
            .basic_auth("opencode", Some(&self.password));
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(body.to_string());
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "agent_server_unavailable")?;
        if !response.status().is_success() {
            return Err("agent_server_invalid");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "agent_server_invalid")? {
            if bytes.len() + chunk.len() > 65536 {
                return Err("agent_server_invalid");
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| "agent_server_invalid")
    }
    pub async fn session(
        &self,
        path: &std::path::Path,
        resume: &str,
        proposals: bool,
    ) -> Result<String> {
        self.ready(path).await?;
        let id = if resume.is_empty() {
            let answer = self
                .post(
                    "/api/session",
                    json!({"agent":agent(proposals),"location":{"directory":path}}),
                )
                .await?;
            answer["data"]["id"]
                .as_str()
                .filter(|id| super::provider::Provider::OpenCode.session(id))
                .ok_or("agent_invalid_session")?
                .to_owned()
        } else {
            if !super::provider::Provider::OpenCode.session(resume) {
                return Err("agent_invalid_session");
            }
            resume.to_owned()
        };
        if !resume.is_empty() {
            self.post(
                &format!("/api/session/{id}/move"),
                json!({"directory":path}),
            )
            .await?;
        }
        Ok(id)
    }
    async fn ready(&self, path: &std::path::Path) -> Result<()> {
        let mut endpoint =
            reqwest::Url::parse("http://127.0.0.1/api/mcp").map_err(|_| "agent_server_invalid")?;
        endpoint.query_pairs_mut().append_pair(
            "location[directory]",
            path.to_str().ok_or("agent_unsafe_storage")?,
        );
        let endpoint = format!("{}?{}", endpoint.path(), endpoint.query().unwrap_or(""));
        let ready = async {
            loop {
                let value = self.request(reqwest::Method::GET, &endpoint, None).await?;
                if value["data"].as_array().is_some_and(|rows| {
                    rows.iter()
                        .any(|r| r["name"] == "omamail" && r["status"]["status"] == "connected")
                }) {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(30), ready)
            .await
            .map_err(|_| "agent_server_timeout")?
    }
    pub async fn outcome(&self, session: &str) -> Result<Value> {
        if !super::provider::Provider::OpenCode.session(session) {
            return Err("agent_invalid_session");
        }
        self.request(
            reqwest::Method::GET,
            &format!("/api/session/{session}"),
            None,
        )
        .await
    }
    pub async fn acquire() -> Result<Self> {
        let directory = directory()?;
        let socket = directory.join("server.sock");
        let connect = async {
            if let Ok(stream) = UnixStream::connect(&socket).await {
                return Ok::<_, &'static str>(stream);
            }
            let mut launch =
                Command::new(std::env::current_exe().map_err(|_| "agent_worker_unavailable")?);
            launch
                .arg("agent-opencode-server")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            unsafe {
                launch.pre_exec(|| {
                    if libc::setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut child = launch.spawn().map_err(|_| "agent_server_unavailable")?;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            loop {
                if let Ok(stream) = UnixStream::connect(&socket).await {
                    return Ok(stream);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        let stream: UnixStream = tokio::time::timeout(Duration::from_secs(40), connect)
            .await
            .map_err(|_| "agent_server_timeout")??;
        let mut reader = BufReader::new(stream);
        let mut bytes = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            tokio::io::AsyncReadExt::take(&mut reader, 4097).read_until(b'\n', &mut bytes),
        )
        .await
        .map_err(|_| "agent_server_timeout")?
        .map_err(|_| "agent_server_unavailable")?;
        if bytes.len() > 4096 {
            return Err("agent_server_invalid");
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "agent_server_invalid")?;
        let url = value["url"].as_str().ok_or("agent_server_invalid")?;
        let parsed = reqwest::Url::parse(url).map_err(|_| "agent_server_invalid")?;
        let password = value["password"].as_str().ok_or("agent_server_invalid")?;
        if parsed.scheme() != "http"
            || parsed.host_str() != Some("127.0.0.1")
            || parsed.port().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != "/"
            || value["version"] != 1
            || password.len() != 64
            || !password.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("agent_server_invalid");
        }
        Ok(Self {
            _stream: reader.into_inner(),
            url: url.trim_end_matches('/').to_owned(),
            password: password.to_owned(),
        })
    }
    pub fn command(
        &self,
        path: &std::path::Path,
        resume: &str,
        model: &str,
        proposals: bool,
    ) -> Result<Command> {
        let mut command = Command::new(super::provider::Provider::OpenCode.executable());
        command
            .current_dir(path)
            .args([
                "run",
                "--server",
                &self.url,
                "--format",
                "json",
                "--agent",
                agent(proposals),
            ])
            .env("OPENCODE_PASSWORD", &self.password);
        command.env("OPENCODE_CONFIG_CONTENT", configuration()?);
        isolate(&mut command)?;
        if !resume.is_empty() {
            command.args(["--session", resume]);
        }
        if !model.is_empty() {
            command.args(["--model", model]);
        }
        Ok(command)
    }
    pub async fn interrupt(&self, session: &str) -> Result<()> {
        if !super::provider::Provider::OpenCode.session(session) {
            return Ok(());
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "agent_server_unavailable")?;
        let response = client
            .post(format!(
                "{}/api/session/{session}/interrupt?resume=false",
                self.url
            ))
            .basic_auth("opencode", Some(&self.password))
            .send()
            .await
            .map_err(|_| "agent_cancel_failed")?;
        if !response.status().is_success() {
            return Err("agent_cancel_failed");
        }
        Ok(())
    }
}

async fn serve_lease(
    mut stream: UnixStream,
    reply: String,
    url: String,
    password: String,
    active: &AtomicUsize,
    stop: tokio::sync::mpsc::Sender<()>,
) -> Result<()> {
    stream
        .write_all(reply.as_bytes())
        .await
        .map_err(|_| "agent_server_unavailable")?;
    let mut reader = BufReader::new(stream);
    let mut bytes = Vec::new();
    tokio::io::AsyncReadExt::take(&mut reader, 513)
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|_| "agent_server_unavailable")?;
    if bytes == b"s" && active.load(Ordering::SeqCst) == 1 {
        let _ = stop.send(()).await;
        return Ok(());
    }
    if bytes.len() > 512 {
        return Err("agent_server_invalid");
    }
    let binding: Value = serde_json::from_slice(&bytes).map_err(|_| "agent_server_invalid")?;
    let id = binding["id"].as_str().ok_or("agent_invalid_id")?;
    let session = binding["session"].as_str().ok_or("agent_invalid_session")?;
    super::storage::check_id(id)?;
    if !super::provider::Provider::OpenCode.session(session) {
        return Err("agent_invalid_session");
    }
    let mut byte = [0];
    let released = tokio::io::AsyncReadExt::read(&mut reader, &mut byte)
        .await
        .is_ok_and(|n| n == 1 && byte[0] == b'd');
    if released {
        return Ok(());
    }
    // EOF after a crashed worker revokes its immutable native-session binding.
    // Never interrupt a completed turn or one that already has a successor.
    let needs_stop = (|| {
        let store = Store::open()?;
        let job = super::jobs::read_job(&store, id)?;
        Ok::<_, &'static str>(
            job["state"] != "done" && store.read_json(id, "next.json", 128)?.is_none(),
        )
    })()
    .unwrap_or(true);
    if needs_stop {
        let lease = Lease {
            _stream: reader.into_inner(),
            url,
            password,
        };
        lease.interrupt(session).await?;
    }
    Ok(())
}

pub async fn serve() -> Result<()> {
    let directory = directory()?;
    let root = crate::cache::directories(&directory, &[], false)?.ok_or("agent_unsafe_storage")?;
    let lock = crate::platform::private_fs::open_lock(&root, "server.lock")
        .map_err(|_| "agent_unsafe_storage")?;
    let metadata = lock.metadata().map_err(|_| "agent_unsafe_storage")?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o600
        || metadata.nlink() != 1
    {
        return Err("agent_unsafe_storage");
    }
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Ok(());
    }
    let socket = directory.join("server.sock");
    if let Ok(metadata) = std::fs::symlink_metadata(&socket) {
        if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("agent_unsafe_storage");
        }
        std::fs::remove_file(&socket).map_err(|_| "agent_unsafe_storage")?;
    }
    let password = secret()?;
    let path = {
        let store = Store::open()?;
        store.path().to_owned()
    };
    let config = configuration()?;
    let mut command = Command::new(super::provider::Provider::OpenCode.executable());
    isolate(&mut command)?;
    command
        .current_dir(&path)
        .args(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"])
        .env("OPENCODE_PASSWORD", &password)
        .env("OPENCODE_CONFIG_CONTENT", config)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut group = Group(
        command.spawn().map_err(|_| "agent_server_unavailable")?,
        true,
    );
    let stdout = pipe(group.0.stdout.take().ok_or("agent_server_unavailable")?)
        .map_err(|_| "agent_server_unavailable")?;
    let handshake = async {
        let mut bytes = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            if read(&stdout, &mut byte)
                .await
                .map_err(|_| "agent_server_unavailable")?
                == 0
                || bytes.len() >= 4096
            {
                return Err("agent_server_invalid");
            }
            bytes.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        serde_json::from_slice::<Value>(&bytes).map_err(|_| "agent_server_invalid")
    };
    let handshake = tokio::time::timeout(Duration::from_secs(30), handshake)
        .await
        .map_err(|_| "agent_server_timeout")??;
    let url = handshake["url"]
        .as_str()
        .ok_or("agent_server_invalid")?
        .to_owned();
    let listener = UnixListener::bind(&socket).map_err(|_| "agent_server_unavailable")?;
    let active = Arc::new(AtomicUsize::new(0));
    let reply = json!({"version":1,"url":url,"password":password}).to_string() + "\n";
    let mut idle = std::time::Instant::now();
    let (stop, mut stopped) = tokio::sync::mpsc::channel(1);
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|_| "agent_server_unavailable")?;
    loop {
        tokio::select! {
            _ = terminate.recv() => break,
            _ = stopped.recv() => break,
            connection = listener.accept() => {
                let (stream, _) = connection.map_err(|_| "agent_server_unavailable")?;
                let active = active.clone();
                let reply = reply.clone();
                let stop = stop.clone();
                let url = url.clone();
                let password = password.clone();
                active.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let _ = serve_lease(stream, reply, url, password, &active, stop).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                });
                idle = std::time::Instant::now();
            }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if group.exited().map_err(|_|"agent_server_unavailable")? {break;}
                if active.load(Ordering::SeqCst)>0 {idle=std::time::Instant::now();}
                if idle.elapsed()>Duration::from_secs(300) {break;}
            }
        }
    }
    std::fs::remove_file(socket).map_err(|_| "agent_server_unavailable")?;
    group.0.stdin.take();
    group.signal(libc::SIGTERM);
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Group's destructor kills and reaps while its PID identity is reserved.
    drop(group);
    Ok(())
}
