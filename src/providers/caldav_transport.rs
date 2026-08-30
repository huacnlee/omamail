use crate::{
    host_context::{CalendarContext, CalendarProvider},
    platform::{
        commands::{CommandError, PreparedCommand, SystemProcessRunner},
        secrets::{Secret, SecretKey, SecretStore},
    },
};
use std::{
    fmt,
    net::{IpAddr, ToSocketAddrs as _},
    path::PathBuf,
    time::Duration,
};
use url::Url;
const OUT: usize = 1_048_608;
const ERR: usize = 65_536;
const BODY: usize = 1_048_576;
const ICS: usize = 65_536;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaldavError {
    InvalidRequest,
    OriginRefused,
    UnknownSecret,
    AuthRequired,
    TimedOut,
    OutputTooLarge,
    PlatformUnavailable,
    InvalidResponse,
    RemoteFailure,
}
pub enum CaldavOperation {
    List { start_ms: i64, end_ms: i64 },
    Write { target: String, payload: String },
    Delete { target: String },
}
pub struct CaldavReply {
    status: u16,
    body: Vec<u8>,
}
impl CaldavReply {
    pub fn status(&self) -> u16 {
        self.status
    }
    pub fn body(&self) -> &[u8] {
        &self.body
    }
}
impl fmt::Debug for CaldavReply {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CaldavReply")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}
pub trait CaldavResolver: Send + Sync {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>>;
}
pub struct SystemCaldavResolver;
impl CaldavResolver for SystemCaldavResolver {
    fn resolve(&self, h: &str, p: u16) -> std::io::Result<Vec<IpAddr>> {
        (h, p)
            .to_socket_addrs()
            .map(|v| v.map(|x| x.ip()).collect())
    }
}
pub struct CaldavProcessOutput {
    status: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
impl fmt::Debug for CaldavProcessOutput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CaldavProcessOutput")
            .field("status", &self.status)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .finish()
    }
}
impl CaldavProcessOutput {
    pub fn new(status: Option<i32>, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
        Self {
            status,
            stdout,
            stderr,
        }
    }
}
pub trait CaldavProcessRunner: Send + Sync {
    fn run_bounded(
        &self,
        c: PreparedCommand,
        o: usize,
        e: usize,
    ) -> Result<CaldavProcessOutput, CommandError>;
}
impl CaldavProcessRunner for SystemProcessRunner {
    fn run_bounded(
        &self,
        c: PreparedCommand,
        o: usize,
        e: usize,
    ) -> Result<CaldavProcessOutput, CommandError> {
        let x = crate::platform::commands::ProcessRunner::run_bounded(self, c, o, e)?;
        Ok(CaldavProcessOutput::new(
            x.status(),
            x.stdout().to_vec(),
            x.stderr().to_vec(),
        ))
    }
}
pub struct CaldavTransport<'a> {
    context: CalendarContext,
    store: &'a dyn SecretStore,
    key: SecretKey,
    curl: PathBuf,
    runner: &'a dyn CaldavProcessRunner,
    resolver: &'a dyn CaldavResolver,
}
impl fmt::Debug for CaldavTransport<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let host = self
            .context
            .source_url()
            .and_then(|u| Url::parse(u).ok())
            .and_then(|u| u.host_str().map(str::to_owned));
        f.debug_struct("CaldavTransport")
            .field("host", &host)
            .finish_non_exhaustive()
    }
}
impl<'a> CaldavTransport<'a> {
    pub fn new(
        context: CalendarContext,
        store: &'a dyn SecretStore,
        service: &str,
        curl: PathBuf,
        runner: &'a dyn CaldavProcessRunner,
        resolver: &'a dyn CaldavResolver,
    ) -> Result<Self, CaldavError> {
        if context.provider() != CalendarProvider::Caldav || context.source_url().is_none() {
            return Err(CaldavError::InvalidRequest);
        }
        let key = SecretKey::caldav(service, context.source_id())
            .map_err(|_| CaldavError::InvalidRequest)?;
        Ok(Self {
            context,
            store,
            key,
            curl,
            runner,
            resolver,
        })
    }
    pub fn execute(
        &self,
        op: CaldavOperation,
        deadline: Duration,
    ) -> Result<CaldavReply, CaldavError> {
        if deadline.is_zero() || deadline > Duration::from_secs(120) {
            return Err(CaldavError::InvalidRequest);
        }
        let base = Url::parse(
            self.context
                .source_url()
                .ok_or(CaldavError::InvalidRequest)?,
        )
        .map_err(|_| CaldavError::InvalidRequest)?;
        if base.scheme() != "https"
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(CaldavError::InvalidRequest);
        }
        let (method, content_type, target, body) = match op {
            CaldavOperation::List { start_ms, end_ms } => {
                if start_ms >= end_ms {
                    return Err(CaldavError::InvalidRequest);
                }
                (
                    "REPORT",
                    "application/xml; charset=utf-8",
                    base.clone(),
                    report(start_ms, end_ms),
                )
            }
            CaldavOperation::Write { target, payload } => {
                let u = base.join(&target).map_err(|_| CaldavError::OriginRefused)?;
                if u.origin() != base.origin() || !u.username().is_empty() || u.password().is_some()
                {
                    return Err(CaldavError::OriginRefused);
                }
                if !super::ics::valid_event_calendar(&payload, ICS) {
                    return Err(CaldavError::InvalidRequest);
                }
                ("PUT", "text/calendar; charset=utf-8", u, payload)
            }
            CaldavOperation::Delete { target } => {
                let u = base.join(&target).map_err(|_| CaldavError::OriginRefused)?;
                if u.origin() != base.origin() || !u.username().is_empty() || u.password().is_some()
                {
                    return Err(CaldavError::OriginRefused);
                }
                ("DELETE", "text/calendar; charset=utf-8", u, String::new())
            }
        };
        let host = base.host_str().ok_or(CaldavError::InvalidRequest)?;
        let port = base
            .port_or_known_default()
            .ok_or(CaldavError::InvalidRequest)?;
        let pins = self
            .resolver
            .resolve(host, port)
            .map_err(|_| CaldavError::InvalidRequest)?;
        if pins.is_empty() {
            return Err(CaldavError::InvalidRequest);
        }
        let secret = self
            .store
            .get(&self.key)
            .map_err(|_| CaldavError::UnknownSecret)?
            .ok_or(CaldavError::UnknownSecret)?;
        if secret.expose().chars().any(char::is_control) {
            return Err(CaldavError::InvalidRequest);
        }
        let config = CurlConfig {
            method,
            content_type,
            url: &target,
            host,
            port,
            pins: &pins,
            credential: secret.expose(),
            body: &body,
            deadline,
        }
        .render();
        let command = PreparedCommand::new(
            self.curl.clone(),
            vec!["-q".into(), "--config".into(), "-".into()],
            Some(Secret::new(config)),
            deadline,
        )
        .map_err(map)?;
        let output = self.runner.run_bounded(command, OUT, ERR).map_err(map)?;
        parse(output, method)
    }
}
struct CurlConfig<'a> {
    method: &'a str,
    content_type: &'a str,
    url: &'a Url,
    host: &'a str,
    port: u16,
    pins: &'a [IpAddr],
    credential: &'a str,
    body: &'a str,
    deadline: Duration,
}
impl CurlConfig<'_> {
    fn render(&self) -> String {
        let mut c = format!(
            "url = \"{}\"\nnoproxy = \"*\"\nproxy = \"\"\nmax-redirs = 0\nproto = \"=https\"\nproto-redir = \"=https\"\nrequest = \"{}\"\nuser = \"{}\"\nheader = \"Content-Type: {}\"\nmax-time = {}\nconnect-timeout = 20\nwrite-out = \"\\nOMAMAIL-STATUS:%{{http_code}}\\n\"\n",
            esc(self.url.as_str()),
            self.method,
            esc(self.credential),
            self.content_type,
            self.deadline.as_secs_f64()
        );
        if self.method != "DELETE" {
            c.push_str(&format!("data = \"{}\"\n", esc(self.body)));
        }
        if self.method == "REPORT" {
            c.push_str("header = \"Depth: 1\"\n");
        }
        for ip in self.pins {
            let ip = match ip {
                IpAddr::V4(v) => v.to_string(),
                IpAddr::V6(v) => format!("[{v}]"),
            };
            c.push_str(&format!(
                "resolve = \"{}:{}:{}\"\n",
                self.host, self.port, ip
            ))
        }
        c
    }
}
fn parse(x: CaldavProcessOutput, method: &str) -> Result<CaldavReply, CaldavError> {
    if x.status != Some(0) {
        return Err(CaldavError::RemoteFailure);
    }
    let s = std::str::from_utf8(&x.stdout).map_err(|_| CaldavError::InvalidResponse)?;
    let (b, st) = s
        .rsplit_once("\nOMAMAIL-STATUS:")
        .ok_or(CaldavError::InvalidResponse)?;
    let st = st
        .strip_suffix('\n')
        .filter(|v| v.len() == 3 && v.bytes().all(|x| x.is_ascii_digit()))
        .ok_or(CaldavError::InvalidResponse)?
        .parse()
        .map_err(|_| CaldavError::InvalidResponse)?;
    if b.len() > BODY {
        return Err(CaldavError::OutputTooLarge);
    }
    if st == 401 || st == 403 {
        return Err(CaldavError::AuthRequired);
    }
    if method == "REPORT" {
        if st != 207 || !valid_multistatus(b) {
            return Err(CaldavError::InvalidResponse);
        }
    } else if !(200..300).contains(&st) {
        return Err(CaldavError::RemoteFailure);
    }
    Ok(CaldavReply {
        status: st,
        body: b.as_bytes().to_vec(),
    })
}
fn valid_multistatus(body: &str) -> bool {
    use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};

    let mut reader = NsReader::from_str(body);
    let mut depth = 0usize;
    let mut saw_root = false;
    loop {
        let Ok((namespace, event)) = reader.read_resolved_event() else {
            return false;
        };
        match event {
            Event::Start(element) => {
                if depth == 0 {
                    if saw_root
                        || element.local_name().as_ref() != b"multistatus"
                        || !matches!(namespace, ResolveResult::Bound(ns) if ns.as_ref() == b"DAV:")
                    {
                        return false;
                    }
                    saw_root = true;
                }
                depth += 1;
            }
            Event::Empty(element) => {
                if depth == 0 {
                    if saw_root
                        || element.local_name().as_ref() != b"multistatus"
                        || !matches!(namespace, ResolveResult::Bound(ns) if ns.as_ref() == b"DAV:")
                    {
                        return false;
                    }
                    saw_root = true;
                }
            }
            Event::End(_) => {
                let Some(parent_depth) = depth.checked_sub(1) else {
                    return false;
                };
                depth = parent_depth;
            }
            Event::Text(text) => {
                let bytes: &[u8] = text.as_ref();
                if depth == 0 && !bytes.iter().all(u8::is_ascii_whitespace) {
                    return false;
                }
            }
            Event::CData(_) if depth == 0 => return false,
            Event::DocType(_) => return false,
            Event::Eof => return saw_root && depth == 0,
            _ => {}
        }
    }
}
fn map(e: CommandError) -> CaldavError {
    match e {
        CommandError::TimedOut => CaldavError::TimedOut,
        CommandError::OutputTooLarge => CaldavError::OutputTooLarge,
        CommandError::PlatformUnavailable => CaldavError::PlatformUnavailable,
        _ => CaldavError::RemoteFailure,
    }
}
fn esc(v: &str) -> String {
    v.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}
fn report(a: i64, b: i64) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><c:calendar-query xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name=\"VCALENDAR\"><c:comp-filter name=\"VEVENT\"><c:time-range start=\"{}\" end=\"{}\"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>",
        stamp(a),
        stamp(b)
    )
}
fn stamp(ms: i64) -> String {
    let s = ms.div_euclid(1000);
    let days = s.div_euclid(86400);
    let day = s.rem_euclid(86400);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 }.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    if m <= 2 {
        y += 1
    }
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        day / 3600,
        (day % 3600) / 60,
        day % 60
    )
}
