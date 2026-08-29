use std::{
    collections::BTreeMap,
    fmt,
    net::IpAddr,
    sync::{Arc, RwLock},
};

use serde::Deserialize;
use url::Url;

const MAX_ID_BYTES: usize = 2048;
const MAX_HOST_BYTES: usize = 253;
const MAX_USERNAME_BYTES: usize = 1024;
const MAX_GRANT_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextError {
    InvalidRequest,
    DuplicateIdentity,
    UnknownAccount,
    UnknownSource,
}

impl fmt::Display for ContextError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRequest => "host context request is invalid",
            Self::DuplicateIdentity => "host context identity is duplicated",
            Self::UnknownAccount => "host account is unknown",
            Self::UnknownSource => "calendar source is unknown",
        })
    }
}

impl std::error::Error for ContextError {}

#[derive(Clone, PartialEq, Eq)]
pub enum HostContext {
    Gmail(GmailContext),
    Imap(ImapContext),
}

impl fmt::Debug for HostContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Gmail(_) => formatter.write_str("GmailContext { account: [REDACTED] }"),
            Self::Imap(value) => value.fmt(formatter),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct GmailContext {
    account_id: String,
    client_id: String,
    grant: String,
}

impl GmailContext {
    pub fn account_id(&self) -> &str {
        &self.account_id
    }
    pub fn client_id(&self) -> &str {
        &self.client_id
    }
    pub fn grant(&self) -> &str {
        &self.grant
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ImapContext {
    account_id: String,
    email: String,
    username: String,
    imap_host: String,
    smtp_host: String,
    imap_url: String,
    smtp_url: String,
}

impl ImapContext {
    pub fn account_id(&self) -> &str {
        &self.account_id
    }
    pub fn email(&self) -> &str {
        &self.email
    }
    pub fn username(&self) -> &str {
        &self.username
    }
    pub fn imap_url(&self) -> &str {
        &self.imap_url
    }
    pub fn smtp_url(&self) -> &str {
        &self.smtp_url
    }
}

impl fmt::Debug for ImapContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImapContext")
            .field("account", &"[REDACTED]")
            .field("username", &"[REDACTED]")
            .field("imap_host", &self.imap_host)
            .field("smtp_host", &self.smtp_host)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalendarProvider {
    Google,
    Caldav,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CalendarContext {
    source_id: String,
    account_id: String,
    provider: CalendarProvider,
    source_url: Option<String>,
    source_host: Option<String>,
    remote_calendar_id: Option<String>,
}

impl CalendarContext {
    pub fn source_id(&self) -> &str {
        &self.source_id
    }
    pub fn account_id(&self) -> &str {
        &self.account_id
    }
    pub fn provider(&self) -> CalendarProvider {
        self.provider
    }
    pub fn source_url(&self) -> Option<&str> {
        self.source_url.as_deref()
    }
    pub fn remote_calendar_id(&self) -> Option<&str> {
        self.remote_calendar_id.as_deref()
    }
}

impl fmt::Debug for CalendarContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CalendarContext")
            .field("source", &"[REDACTED]")
            .field("account", &"[REDACTED]")
            .field("provider", &self.provider)
            .field("host", &self.source_host)
            .finish()
    }
}

#[derive(Clone, Default, PartialEq, Eq)]
pub struct ContextSnapshot {
    accounts: BTreeMap<String, HostContext>,
    sources: BTreeMap<String, CalendarContext>,
}

impl fmt::Debug for ContextSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ContextSnapshot")
            .field("account_count", &self.accounts.len())
            .field("source_count", &self.sources.len())
            .finish()
    }
}

pub struct HostContextRegistry {
    snapshot: RwLock<Arc<ContextSnapshot>>,
}

impl HostContextRegistry {
    pub fn new() -> Self {
        Self {
            snapshot: RwLock::new(Arc::new(ContextSnapshot::default())),
        }
    }

    /// Replaces trusted native setup state. This is a privileged setup-only
    /// boundary; mail/calendar effects must only resolve this registry and can
    /// never submit `ConfigureRequest`s themselves.
    pub fn replace_json(&self, json: &str) -> Result<(), ContextError> {
        if json.len() > 1024 * 1024 {
            return Err(ContextError::InvalidRequest);
        }
        let requests: Vec<ConfigureRequest> =
            serde_json::from_str(json).map_err(|_| ContextError::InvalidRequest)?;
        let candidate = ContextSnapshot::build(requests)?;
        *self.snapshot.write().expect("host context lock poisoned") = Arc::new(candidate);
        Ok(())
    }

    pub fn snapshot(&self) -> ContextSnapshot {
        self.snapshot
            .read()
            .expect("host context lock poisoned")
            .as_ref()
            .clone()
    }

    pub fn resolve_account(&self, id: &str) -> Result<HostContext, ContextError> {
        self.snapshot
            .read()
            .expect("host context lock poisoned")
            .accounts
            .get(id)
            .cloned()
            .ok_or(ContextError::UnknownAccount)
    }

    pub fn resolve_source(&self, id: &str) -> Result<CalendarContext, ContextError> {
        self.snapshot
            .read()
            .expect("host context lock poisoned")
            .sources
            .get(id)
            .cloned()
            .ok_or(ContextError::UnknownSource)
    }
}

impl Default for HostContextRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for HostContextRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.snapshot().fmt(formatter)
    }
}

impl ContextSnapshot {
    fn build(requests: Vec<ConfigureRequest>) -> Result<Self, ContextError> {
        let mut snapshot = Self::default();
        for request in &requests {
            let (id, context) = match request {
                ConfigureRequest::Gmail(value) => {
                    value.validate()?;
                    (
                        value.account_id.clone(),
                        HostContext::Gmail(GmailContext {
                            account_id: value.account_id.clone(),
                            client_id: value.client_id.clone(),
                            grant: value.grant.clone(),
                        }),
                    )
                }
                ConfigureRequest::Imap(value) => {
                    let context = value.context()?;
                    (value.account_id.clone(), HostContext::Imap(context))
                }
                ConfigureRequest::Calendar(_) => continue,
            };
            if snapshot.accounts.insert(id, context).is_some() {
                return Err(ContextError::DuplicateIdentity);
            }
        }
        for request in requests {
            let ConfigureRequest::Calendar(value) = request else {
                continue;
            };
            let context = value.context(&snapshot.accounts)?;
            if snapshot.sources.insert(value.source_id, context).is_some() {
                return Err(ContextError::DuplicateIdentity);
            }
        }
        Ok(snapshot)
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ConfigureRequest {
    Gmail(GmailRequest),
    Imap(ImapRequest),
    Calendar(CalendarRequest),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GmailRequest {
    account_id: String,
    client_id: String,
    grant: String,
}

impl GmailRequest {
    fn validate(&self) -> Result<(), ContextError> {
        if !valid_email(&self.account_id)
            || self.client_id.len() > MAX_ID_BYTES
            || !self.client_id.ends_with(".apps.googleusercontent.com")
            || self.client_id.chars().any(char::is_control)
            || !valid_grant(&self.grant)
        {
            Err(ContextError::InvalidRequest)
        } else {
            Ok(())
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImapRequest {
    account_id: String,
    email: String,
    username: String,
    imap_host: String,
    imap_port: u16,
    smtp_host: String,
    smtp_port: u16,
    insecure: bool,
}

impl ImapRequest {
    fn context(&self) -> Result<ImapContext, ContextError> {
        let imap_host = canonical_host(&self.imap_host).ok_or(ContextError::InvalidRequest)?;
        let smtp_host = canonical_host(&self.smtp_host).ok_or(ContextError::InvalidRequest)?;
        if self.account_id != format!("imap:{}", self.email)
            || !valid_email(&self.email)
            || self.username.is_empty()
            || self.username.len() > MAX_USERNAME_BYTES
            || self.username.chars().any(char::is_control)
            || self.imap_port == 0
            || self.smtp_port == 0
            || !valid_host(&self.imap_host)
            || !valid_host(&self.smtp_host)
            || (self.insecure && (!loopback_host(&imap_host) || !loopback_host(&smtp_host)))
        {
            return Err(ContextError::InvalidRequest);
        }
        let imap_scheme = if self.insecure { "imap" } else { "imaps" };
        let smtp_scheme = if self.insecure { "smtp" } else { "smtps" };
        Ok(ImapContext {
            account_id: self.account_id.clone(),
            email: self.email.clone(),
            username: self.username.clone(),
            imap_host: imap_host.clone(),
            smtp_host: smtp_host.clone(),
            imap_url: mail_url(imap_scheme, &imap_host, self.imap_port)?,
            smtp_url: mail_url(smtp_scheme, &smtp_host, self.smtp_port)?,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CalendarRequest {
    source_id: String,
    account_id: String,
    provider: CalendarProviderWire,
    #[serde(default)]
    source_url: String,
    #[serde(default)]
    remote_calendar_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum CalendarProviderWire {
    Google,
    Caldav,
}

impl CalendarRequest {
    fn context(
        &self,
        accounts: &BTreeMap<String, HostContext>,
    ) -> Result<CalendarContext, ContextError> {
        if !valid_identity(&self.source_id) || !accounts.contains_key(&self.account_id) {
            return Err(if accounts.contains_key(&self.account_id) {
                ContextError::InvalidRequest
            } else {
                ContextError::UnknownAccount
            });
        }
        let (provider, source_url, source_host, remote_calendar_id) = match self.provider {
            CalendarProviderWire::Google => {
                if !self.source_url.is_empty()
                    || !matches!(accounts.get(&self.account_id), Some(HostContext::Gmail(_)))
                {
                    return Err(ContextError::InvalidRequest);
                }
                let remote = if self.remote_calendar_id.is_empty() {
                    (self.source_id == "primary")
                        .then(|| "primary".to_owned())
                        .ok_or(ContextError::InvalidRequest)?
                } else if valid_remote_calendar_id(&self.remote_calendar_id) {
                    self.remote_calendar_id.clone()
                } else {
                    return Err(ContextError::InvalidRequest);
                };
                (CalendarProvider::Google, None, None, Some(remote))
            }
            CalendarProviderWire::Caldav => {
                let url = https_url(&self.source_url)?;
                let host = url.host_str().map(str::to_owned);
                if !self.remote_calendar_id.is_empty() {
                    return Err(ContextError::InvalidRequest);
                }
                (CalendarProvider::Caldav, Some(url.into()), host, None)
            }
        };
        Ok(CalendarContext {
            source_id: self.source_id.clone(),
            account_id: self.account_id.clone(),
            provider,
            source_url,
            source_host,
            remote_calendar_id,
        })
    }
}

fn valid_email(value: &str) -> bool {
    value.len() <= 320
        && !value.chars().any(char::is_control)
        && !value.contains(char::is_whitespace)
        && value.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && valid_host(domain)
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        })
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}
fn valid_remote_calendar_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn valid_host(value: &str) -> bool {
    canonical_host(value).is_some()
}

fn canonical_host(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > MAX_HOST_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
        || value.contains(['/', '\\', '@', '?', '#'])
    {
        return None;
    }
    let parsed_ip = value.parse::<IpAddr>();
    if parsed_ip.is_err() && value.contains(':') {
        return None;
    }
    let authority = match parsed_ip {
        Ok(IpAddr::V6(_)) => format!("[{value}]"),
        _ => value.to_owned(),
    };
    let url = Url::parse(&format!("https://{authority}/")).ok()?;
    if url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.host_str().map(str::to_owned)
}

fn mail_url(scheme: &str, host: &str, port: u16) -> Result<String, ContextError> {
    let mut url =
        Url::parse(&format!("{scheme}://localhost/")).map_err(|_| ContextError::InvalidRequest)?;
    url.set_host(Some(host))
        .map_err(|_| ContextError::InvalidRequest)?;
    url.set_port(Some(port))
        .map_err(|_| ContextError::InvalidRequest)?;
    Ok(url.into())
}

fn loopback_host(value: &str) -> bool {
    value == "localhost"
        || value
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn valid_grant(value: &str) -> bool {
    const ALLOWED: &[&str] = &[
        "gmail.modify",
        "gmail.send",
        "calendar.events",
        "calendar.readonly",
    ];
    !value.is_empty()
        && value.len() <= MAX_GRANT_BYTES
        && value
            .split_ascii_whitespace()
            .all(|scope| ALLOWED.contains(&scope))
}

fn https_url(value: &str) -> Result<Url, ContextError> {
    let url = Url::parse(value).map_err(|_| ContextError::InvalidRequest)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        Err(ContextError::InvalidRequest)
    } else {
        Ok(url)
    }
}
