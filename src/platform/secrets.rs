use std::{
    collections::HashMap,
    fmt,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use zeroize::{Zeroize as _, Zeroizing};

#[cfg(target_os = "linux")]
use std::{
    io::{BufRead as _, BufReader},
    process::{Command, Stdio},
    thread,
    time::Instant,
};

#[cfg(target_os = "linux")]
use super::commands::{CommandError, PreparedCommand, ProcessRunner as _, SystemProcessRunner};

#[cfg(target_os = "linux")]
const LEGACY_UNNAMED_ACCOUNT: &[u8] = b"attribute.account = default";

// Every name a Gmail refresh token is or has been filed under, in one place.
//
// The two ends of that name live in different modules — `gmail_setup` writes
// the credential and `providers::gmail` reads it — and they used to be handed
// the names as arguments. One passed `omarchy-mail` for the superseded service,
// the other `omamail-gmail`, and neither has ever been a service this
// application stored anything under: the reader was looking in a place no
// writer had ever written, both sides compiled, and the test that pinned the
// shape passed a third pair of names of its own. They are constants here so
// there is nothing left to pass and nothing left to disagree about.
const GMAIL_SERVICE: &str = "omamail";
// What the service was called before the rename, and the reason
// `scripts/migrate-storage.sh` moves `omarchy-gmail` directories.
// `providers/Credentials.js` calls it `RENAMED_KEYRING_SERVICE`.
const GMAIL_RENAMED_SERVICE: &str = "omarchy-gmail";
const GMAIL_KIND: &str = "refresh-token";

/// The grant names a Gmail refresh token has been filed under before the
/// current one, most recent first.
///
/// A grant is the credential's *name* rather than its scopes, so renaming it
/// renames every entry already stored out from under the next read — the
/// mailbox is signed in, the keyring answers, and there is nothing there. Only
/// a name that stood for **exactly** the permissions the current one does may
/// be listed here, because a token found under one of these is used as if it
/// carried today's grant. All three below are Gmail modify, Gmail send and
/// Calendar events; `openid` and `email` name the address and grant nothing
/// further.
pub const SUPERSEDED_GMAIL_GRANTS: [&str; 3] = [
    // `providers/Credentials.js`'s `KEYRING_GRANT` — the shell plugin's name
    // for the same three permissions, and what every mailbox signed in through
    // the QML plugin still carries.
    "calendar-events-v1",
    // The two shapes of the scope string this host filed tokens under while the
    // grant *was* the scope string. Widening those scopes to the full URLs
    // Google requires renamed the credential as a side effect, which is the
    // defect `gmail_setup::GRANT`'s comment describes and this list repairs.
    concat!(
        "openid email",
        " https://www.googleapis.com/auth/gmail.modify",
        " https://www.googleapis.com/auth/gmail.send",
        " https://www.googleapis.com/auth/calendar.events",
    ),
    concat!(
        "https://www.googleapis.com/auth/gmail.modify",
        " https://www.googleapis.com/auth/gmail.send",
        " https://www.googleapis.com/auth/calendar.events",
    ),
];

/// One of the older names a credential may still be stored under, and whether
/// finding it there is allowed to take it away from that name.
///
/// A name this application itself retired is *moved*: nothing else reads it,
/// and leaving a second copy of a refresh token in the keyring is a copy
/// nothing will ever clean up. A name another client of the same credential
/// still reads — the QML plugin ships from this repository and looks under
/// `calendar-events-v1` — is *copied*: the entry is one grant seen by two
/// programs, and adopting it must not sign the other one out of a mailbox
/// nobody asked to leave.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Fallback {
    identity: Vec<(String, String)>,
    retire: bool,
}

impl Fallback {
    fn moved(identity: Vec<(String, String)>) -> Self {
        Self {
            identity,
            retire: true,
        }
    }

    fn copied(identity: Vec<(String, String)>) -> Self {
        Self {
            identity,
            retire: false,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SecretKey {
    canonical: Vec<(String, String)>,
    fallbacks: Vec<Fallback>,
}

impl SecretKey {
    pub fn new(
        service: impl Into<String>,
        kind: impl Into<String>,
        client_id: impl Into<String>,
        account: impl Into<String>,
        grant: Option<&str>,
    ) -> Result<Self, SecretStoreError> {
        let service = service.into();
        let kind = kind.into();
        let client_id = client_id.into();
        let account = account.into();
        let mut canonical = vec![
            ("service".into(), service),
            ("kind".into(), kind),
            ("client-id".into(), client_id),
            ("account".into(), account),
        ];
        if let Some(grant) = grant {
            canonical.push(("grant".into(), grant.to_owned()));
        }
        Self::from_identities(canonical, Vec::new())
    }

    /// The Gmail refresh token for one account of one OAuth client.
    ///
    /// Takes no service name: see `GMAIL_SERVICE`. The superseded grants come
    /// first among the fallbacks because they name the account as well as the
    /// client and so identify exactly one entry, where the older shapes below
    /// them drop `account` and have to be gated on there being a single match.
    pub fn gmail(client_id: &str, account: &str, grant: &str) -> Result<Self, SecretStoreError> {
        let identity = |service: &str, account: Option<&str>, grant: Option<&str>| {
            let mut attributes = vec![
                ("service".into(), service.to_owned()),
                ("kind".into(), GMAIL_KIND.to_owned()),
                ("client-id".into(), client_id.to_owned()),
            ];
            if let Some(account) = account {
                attributes.push(("account".into(), account.to_owned()));
            }
            if let Some(grant) = grant {
                attributes.push(("grant".into(), grant.to_owned()));
            }
            attributes
        };
        let mut fallbacks = SUPERSEDED_GMAIL_GRANTS
            .iter()
            .filter(|superseded| **superseded != grant)
            .map(|superseded| {
                Fallback::copied(identity(GMAIL_SERVICE, Some(account), Some(superseded)))
            })
            .collect::<Vec<_>>();
        fallbacks.extend([
            Fallback::moved(identity(GMAIL_SERVICE, Some(account), None)),
            Fallback::moved(identity(GMAIL_SERVICE, None, None)),
            Fallback::moved(identity(GMAIL_RENAMED_SERVICE, Some(account), None)),
            Fallback::moved(identity(GMAIL_RENAMED_SERVICE, None, None)),
        ]);
        Self::from_fallbacks(
            identity(GMAIL_SERVICE, Some(account), Some(grant)),
            fallbacks,
        )
    }

    pub fn imap(service: &str, account: &str) -> Result<Self, SecretStoreError> {
        Self::from_identities(
            vec![
                ("service".into(), service.to_owned()),
                ("kind".into(), "imap-password".into()),
                ("account".into(), account.to_owned()),
            ],
            Vec::new(),
        )
    }

    pub fn imap_endpoint(
        service: &str,
        account: &str,
        host: &str,
        port: u16,
        username: &str,
    ) -> Result<Self, SecretStoreError> {
        let mut canonical = vec![
            ("service".into(), service.to_owned()),
            ("kind".into(), "imap-password".into()),
            ("account".into(), account.to_owned()),
        ];
        canonical.extend([
            ("host".into(), host.to_owned()),
            ("port".into(), port.to_string()),
            ("username".into(), username.to_owned()),
        ]);
        Self::from_identities(canonical, Vec::new())
    }

    pub(crate) fn imap_endpoint_migration(
        service: &str,
        account: &str,
        host: &str,
        port: u16,
        username: &str,
        confirmed_previous_endpoint: &str,
    ) -> Result<Self, SecretStoreError> {
        if confirmed_previous_endpoint.is_empty() {
            return Err(SecretStoreError::InvalidKey);
        }
        let mut key = Self::imap_endpoint(service, account, host, port, username)?;
        key.fallbacks.push(Fallback::moved(vec![
            ("service".into(), service.to_owned()),
            ("kind".into(), "imap-password".into()),
            ("account".into(), account.to_owned()),
        ]));
        Ok(key)
    }

    pub fn caldav(service: &str, source: &str) -> Result<Self, SecretStoreError> {
        Self::from_identities(
            vec![
                ("service".into(), service.to_owned()),
                ("kind".into(), "calendar-password".into()),
                ("source".into(), source.to_owned()),
            ],
            Vec::new(),
        )
    }

    fn from_identities(
        canonical: Vec<(String, String)>,
        fallbacks: Vec<Vec<(String, String)>>,
    ) -> Result<Self, SecretStoreError> {
        Self::from_fallbacks(
            canonical,
            fallbacks.into_iter().map(Fallback::moved).collect(),
        )
    }

    fn from_fallbacks(
        canonical: Vec<(String, String)>,
        fallbacks: Vec<Fallback>,
    ) -> Result<Self, SecretStoreError> {
        if canonical
            .iter()
            .any(|(name, value)| name.is_empty() || value.is_empty())
            || fallbacks
                .iter()
                .flat_map(|fallback| &fallback.identity)
                .any(|(name, value)| name.is_empty() || value.is_empty())
        {
            return Err(SecretStoreError::InvalidKey);
        }
        Ok(Self {
            canonical,
            fallbacks,
        })
    }

    /// Every identity a read tries, canonical first, each with whether adopting
    /// it may also retire it. One walk, so a store cannot answer from a name
    /// it would then fail to clean up.
    fn lookups(&self) -> impl Iterator<Item = (&Vec<(String, String)>, bool)> {
        std::iter::once((&self.canonical, false)).chain(
            self.fallbacks
                .iter()
                .map(|fallback| (&fallback.identity, fallback.retire)),
        )
    }

    pub fn keyring_service(&self) -> String {
        "com.omarchy.omamail.secrets.v1".to_owned()
    }

    pub fn keyring_account(&self) -> String {
        physical_key(&self.canonical)
    }

    pub fn secret_service_attributes(&self) -> Vec<(&str, &str)> {
        self.canonical
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect()
    }

    pub fn secret_service_lookup_attributes(&self) -> Vec<Vec<(&str, &str)>> {
        self.lookups()
            .map(|(identity, _)| {
                identity
                    .iter()
                    .map(|(name, value)| (name.as_str(), value.as_str()))
                    .collect()
            })
            .collect()
    }
}

fn physical_key(identity: &[(String, String)]) -> String {
    let mut account = String::from("v1");
    for (name, value) in identity {
        account.push('|');
        account.push_str(&name.len().to_string());
        account.push(':');
        account.push_str(name);
        account.push(':');
        account.push_str(&value.len().to_string());
        account.push(':');
        account.push_str(value);
    }
    account
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SecretKey")
            .field("canonical", &self.canonical)
            .field("fallback_count", &self.fallbacks.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(Zeroizing::new(value.into()))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Secret([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretStoreError {
    InvalidKey,
    InvalidEncoding,
    Unavailable,
    AccessDenied,
    TimedOut,
    NotFound,
    Failed,
}

impl fmt::Display for SecretStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidKey => "secret key fields must not be empty",
            Self::InvalidEncoding => "secret storage returned invalid text",
            Self::Unavailable => "secret storage is unavailable",
            Self::AccessDenied => "secret storage access was denied",
            Self::TimedOut => "secret storage operation timed out",
            Self::NotFound => "secret was not found",
            Self::Failed => "secret storage operation failed",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for SecretStoreError {}

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &SecretKey) -> Result<Option<Secret>, SecretStoreError>;
    fn set(&self, key: &SecretKey, secret: Secret) -> Result<(), SecretStoreError>;
    fn delete(&self, key: &SecretKey) -> Result<(), SecretStoreError>;
}

impl<T: SecretStore + ?Sized> SecretStore for &T {
    fn get(&self, key: &SecretKey) -> Result<Option<Secret>, SecretStoreError> {
        (**self).get(key)
    }

    fn set(&self, key: &SecretKey, secret: Secret) -> Result<(), SecretStoreError> {
        (**self).set(key, secret)
    }

    fn delete(&self, key: &SecretKey) -> Result<(), SecretStoreError> {
        (**self).delete(key)
    }
}

#[derive(Default)]
pub struct MemorySecretStore {
    secrets: Mutex<HashMap<SecretKey, Secret>>,
}

impl SecretStore for MemorySecretStore {
    fn get(&self, key: &SecretKey) -> Result<Option<Secret>, SecretStoreError> {
        Ok(self
            .secrets
            .lock()
            .map_err(|_| SecretStoreError::Failed)?
            .get(key)
            .cloned())
    }

    fn set(&self, key: &SecretKey, secret: Secret) -> Result<(), SecretStoreError> {
        self.secrets
            .lock()
            .map_err(|_| SecretStoreError::Failed)?
            .insert(key.clone(), secret);
        Ok(())
    }

    fn delete(&self, key: &SecretKey) -> Result<(), SecretStoreError> {
        self.secrets
            .lock()
            .map_err(|_| SecretStoreError::Failed)?
            .remove(key);
        Ok(())
    }
}

pub struct SystemSecretStore {
    secret_tool: PathBuf,
    deadline: Duration,
    clear_legacy: bool,
}

impl Default for SystemSecretStore {
    fn default() -> Self {
        Self {
            secret_tool: PathBuf::from("secret-tool"),
            deadline: Duration::from_secs(10),
            clear_legacy: true,
        }
    }
}

impl SystemSecretStore {
    pub fn with_secret_tool(path: &Path, deadline: Duration, clear_legacy: bool) -> Self {
        Self {
            secret_tool: path.to_owned(),
            deadline,
            clear_legacy,
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn entry(&self, key: &SecretKey) -> Result<keyring::Entry, SecretStoreError> {
        self.entry_for(&key.canonical)
    }

    #[cfg(not(target_os = "linux"))]
    fn entry_for(&self, identity: &[(String, String)]) -> Result<keyring::Entry, SecretStoreError> {
        keyring::Entry::new("com.omarchy.omamail.secrets.v1", &physical_key(identity))
            .map_err(map_keyring_error)
    }
}

impl SecretStore for SystemSecretStore {
    fn get(&self, key: &SecretKey) -> Result<Option<Secret>, SecretStoreError> {
        #[cfg(target_os = "linux")]
        {
            secret_tool_get(self, key)
        }
        #[cfg(not(target_os = "linux"))]
        {
            for (index, (identity, retire)) in key.lookups().enumerate() {
                match self.entry_for(identity)?.get_password() {
                    Ok(value) => {
                        let secret = Secret::new(value);
                        if index != 0 {
                            self.entry(key)?
                                .set_password(secret.expose())
                                .map_err(map_keyring_error)?;
                            if retire && self.clear_legacy {
                                match self.entry_for(identity)?.delete_credential() {
                                    Ok(()) | Err(keyring::Error::NoEntry) => {}
                                    Err(error) => return Err(map_keyring_error(error)),
                                }
                            }
                        }
                        return Ok(Some(secret));
                    }
                    Err(keyring::Error::NoEntry) => {}
                    Err(error) => return Err(map_keyring_error(error)),
                }
            }
            Ok(None)
        }
    }

    fn set(&self, key: &SecretKey, secret: Secret) -> Result<(), SecretStoreError> {
        #[cfg(target_os = "linux")]
        {
            secret_tool_set(self, &key.canonical, secret)
        }
        #[cfg(not(target_os = "linux"))]
        self.entry(key)?
            .set_password(secret.expose())
            .map_err(map_keyring_error)
    }

    fn delete(&self, key: &SecretKey) -> Result<(), SecretStoreError> {
        #[cfg(target_os = "linux")]
        {
            secret_tool_delete(self, &key.canonical)
        }
        #[cfg(not(target_os = "linux"))]
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

#[cfg(target_os = "linux")]
fn secret_tool_args(attributes: &[(String, String)]) -> Vec<String> {
    attributes
        .iter()
        .flat_map(|(name, value)| [name.to_owned(), value.to_owned()])
        .collect()
}

#[cfg(target_os = "linux")]
fn secret_tool_get(
    store: &SystemSecretStore,
    key: &SecretKey,
) -> Result<Option<Secret>, SecretStoreError> {
    for (index, (attributes, retire)) in key.lookups().enumerate() {
        if index != 0 && !secret_tool_has_lone_legacy_entry(store, attributes)? {
            continue;
        }
        let output = run_secret_tool(store, "lookup", attributes, None)?;
        if output.status() == Some(0) {
            let secret = Secret::new(
                String::from_utf8(output.stdout().to_vec())
                    .map_err(|_| SecretStoreError::InvalidEncoding)?
                    .trim_end_matches(['\r', '\n'])
                    .to_owned(),
            );
            if index != 0 {
                secret_tool_set(store, &key.canonical, secret.clone())?;
                if retire && store.clear_legacy {
                    secret_tool_delete(store, attributes)?;
                }
            }
            return Ok(Some(secret));
        }
        if output.status() != Some(1) {
            return Err(SecretStoreError::Failed);
        }
    }
    Ok(None)
}

#[cfg(target_os = "linux")]
fn secret_tool_has_lone_legacy_entry(
    store: &SystemSecretStore,
    attributes: &[(String, String)],
) -> Result<bool, SecretStoreError> {
    let summary = run_secret_tool_search(store, attributes)?;
    if summary.matches != 1 || summary.service_attributes != summary.matches {
        return Ok(false);
    }
    if summary.requested_attributes.iter().any(|count| *count != 1) {
        return Ok(false);
    }

    let omits_account = !attributes.iter().any(|(name, _)| name == "account");
    if omits_account && (summary.account_attributes > 1 || summary.named_account_attributes != 0) {
        return Ok(false);
    }
    let omits_grant = !attributes.iter().any(|(name, _)| name == "grant");
    if omits_grant && summary.grant_attributes != 0 {
        return Ok(false);
    }
    Ok(true)
}

#[cfg(target_os = "linux")]
struct LegacySearchSummary {
    matches: usize,
    service_attributes: usize,
    account_attributes: usize,
    named_account_attributes: usize,
    grant_attributes: usize,
    requested_attributes: Vec<usize>,
}

#[cfg(target_os = "linux")]
fn run_secret_tool_search(
    store: &SystemSecretStore,
    attributes: &[(String, String)],
) -> Result<LegacySearchSummary, SecretStoreError> {
    let mut arguments = vec![
        "search".to_owned(),
        "--all".to_owned(),
        "--unlock".to_owned(),
    ];
    arguments.extend(secret_tool_args(attributes));

    let mut process = Command::new(&store.secret_tool);
    process
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    use std::os::unix::process::CommandExt as _;
    process.process_group(0);
    let mut child = process.spawn().map_err(|_| SecretStoreError::Unavailable)?;
    let Some(stdout) = child.stdout.take() else {
        terminate_search_and_reap(&mut child)?;
        return Err(SecretStoreError::Failed);
    };
    let Some(stderr) = child.stderr.take() else {
        terminate_search_and_reap(&mut child)?;
        return Err(SecretStoreError::Failed);
    };

    let requested_prefixes = attributes
        .iter()
        .map(|(name, value)| format!("attribute.{name} = {value}").into_bytes())
        .collect::<Vec<_>>();
    let stdout_reader = thread::spawn(move || count_search_records(stdout));
    let stderr_reader = thread::spawn(move || count_search_attributes(stderr, requested_prefixes));
    let deadline = Instant::now() + store.deadline;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                terminate_search_and_reap(&mut child)?;
                join_search_readers(stdout_reader, stderr_reader)?;
                return Err(SecretStoreError::TimedOut);
            }
            Err(_) => {
                terminate_search_and_reap(&mut child)?;
                join_search_readers(stdout_reader, stderr_reader)?;
                return Err(SecretStoreError::Failed);
            }
        }
    };
    while (!stdout_reader.is_finished() || !stderr_reader.is_finished())
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(5));
    }
    if !stdout_reader.is_finished() || !stderr_reader.is_finished() {
        terminate_search_and_reap(&mut child)?;
        join_search_readers(stdout_reader, stderr_reader)?;
        return Err(SecretStoreError::TimedOut);
    }
    let matches = join_search_reader(stdout_reader)?;
    let attributes = join_search_reader(stderr_reader)?;
    if matches!(status.code(), Some(0 | 1)) {
        Ok(LegacySearchSummary {
            matches,
            service_attributes: attributes.service_attributes,
            account_attributes: attributes.account_attributes,
            named_account_attributes: attributes.named_account_attributes,
            grant_attributes: attributes.grant_attributes,
            requested_attributes: attributes.requested_attributes,
        })
    } else {
        Err(SecretStoreError::Failed)
    }
}

#[cfg(target_os = "linux")]
struct SearchAttributeCounts {
    service_attributes: usize,
    account_attributes: usize,
    named_account_attributes: usize,
    grant_attributes: usize,
    requested_attributes: Vec<usize>,
}

#[cfg(target_os = "linux")]
fn count_search_records(stdout: impl std::io::Read) -> std::io::Result<usize> {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    let mut matches = 0;
    while reader.read_until(b'\n', &mut line)? != 0 {
        if line.starts_with(b"[") {
            matches += 1;
        }
        line.zeroize();
        line.clear();
    }
    Ok(matches)
}

#[cfg(target_os = "linux")]
fn count_search_attributes(
    stderr: impl std::io::Read,
    requested_prefixes: Vec<Vec<u8>>,
) -> std::io::Result<SearchAttributeCounts> {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    let mut counts = SearchAttributeCounts {
        service_attributes: 0,
        account_attributes: 0,
        named_account_attributes: 0,
        grant_attributes: 0,
        requested_attributes: vec![0; requested_prefixes.len()],
    };
    while reader.read_until(b'\n', &mut line)? != 0 {
        let content = line.strip_suffix(b"\n").unwrap_or(&line);
        let content = content.strip_suffix(b"\r").unwrap_or(content);
        if content.starts_with(b"attribute.service = ") {
            counts.service_attributes += 1;
        }
        if content.starts_with(b"attribute.account = ") {
            counts.account_attributes += 1;
            if content != LEGACY_UNNAMED_ACCOUNT {
                counts.named_account_attributes += 1;
            }
        }
        if content.starts_with(b"attribute.grant = ") {
            counts.grant_attributes += 1;
        }
        for (index, prefix) in requested_prefixes.iter().enumerate() {
            if content == prefix {
                counts.requested_attributes[index] += 1;
            }
        }
        line.zeroize();
        line.clear();
    }
    Ok(counts)
}

#[cfg(target_os = "linux")]
fn join_search_reader<T>(
    reader: thread::JoinHandle<std::io::Result<T>>,
) -> Result<T, SecretStoreError> {
    reader
        .join()
        .map_err(|_| SecretStoreError::Failed)?
        .map_err(|_| SecretStoreError::Failed)
}

#[cfg(target_os = "linux")]
fn join_search_readers<T, U>(
    first: thread::JoinHandle<std::io::Result<T>>,
    second: thread::JoinHandle<std::io::Result<U>>,
) -> Result<(), SecretStoreError> {
    join_search_reader(first)?;
    join_search_reader(second)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn terminate_search_and_reap(child: &mut std::process::Child) -> Result<(), SecretStoreError> {
    unsafe {
        if libc::kill(-(child.id() as i32), libc::SIGKILL) != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            return Err(SecretStoreError::Failed);
        }
    }
    child.wait().map_err(|_| SecretStoreError::Failed)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn secret_tool_set(
    store: &SystemSecretStore,
    attributes: &[(String, String)],
    secret: Secret,
) -> Result<(), SecretStoreError> {
    let mut arguments = vec!["store".to_owned(), "--label=Omamail secret".to_owned()];
    arguments.extend(secret_tool_args(attributes));
    let output = run_secret_tool_command(store, arguments, Some(secret))?;
    if output.status() == Some(0) {
        Ok(())
    } else {
        Err(SecretStoreError::AccessDenied)
    }
}

#[cfg(target_os = "linux")]
fn secret_tool_delete(
    store: &SystemSecretStore,
    attributes: &[(String, String)],
) -> Result<(), SecretStoreError> {
    let output = run_secret_tool(store, "clear", attributes, None)?;
    if matches!(output.status(), Some(0 | 1)) {
        Ok(())
    } else {
        Err(SecretStoreError::Failed)
    }
}

#[cfg(target_os = "linux")]
fn run_secret_tool(
    store: &SystemSecretStore,
    operation: &str,
    attributes: &[(String, String)],
    stdin: Option<Secret>,
) -> Result<super::commands::ProcessOutput, SecretStoreError> {
    let mut arguments = vec![operation.to_owned()];
    arguments.extend(secret_tool_args(attributes));
    run_secret_tool_command(store, arguments, stdin)
}

#[cfg(target_os = "linux")]
fn run_secret_tool_command(
    store: &SystemSecretStore,
    arguments: Vec<String>,
    stdin: Option<Secret>,
) -> Result<super::commands::ProcessOutput, SecretStoreError> {
    let command = PreparedCommand::new(store.secret_tool.clone(), arguments, stdin, store.deadline)
        .map_err(map_command_error)?;
    SystemProcessRunner.run(command).map_err(map_command_error)
}

#[cfg(target_os = "linux")]
fn map_command_error(error: CommandError) -> SecretStoreError {
    match error {
        CommandError::TimedOut => SecretStoreError::TimedOut,
        CommandError::SpawnFailed | CommandError::PlatformUnavailable => {
            SecretStoreError::Unavailable
        }
        CommandError::InvalidDeadline => SecretStoreError::InvalidKey,
        _ => SecretStoreError::Failed,
    }
}

pub fn keyring_error_class(error: &keyring::Error) -> SecretStoreError {
    match error {
        keyring::Error::NoEntry => SecretStoreError::NotFound,
        keyring::Error::NoStorageAccess(_) => SecretStoreError::AccessDenied,
        keyring::Error::PlatformFailure(_)
        | keyring::Error::NoDefaultStore
        | keyring::Error::NotSupportedByStore(_) => SecretStoreError::Unavailable,
        keyring::Error::Invalid(_, _) | keyring::Error::TooLong(_, _) => {
            SecretStoreError::InvalidKey
        }
        keyring::Error::BadEncoding(_)
        | keyring::Error::BadDataFormat(_, _)
        | keyring::Error::BadStoreFormat(_) => SecretStoreError::InvalidEncoding,
        _ => SecretStoreError::Failed,
    }
}

#[cfg(not(target_os = "linux"))]
fn map_keyring_error(error: keyring::Error) -> SecretStoreError {
    keyring_error_class(&error)
}
