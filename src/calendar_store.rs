//! The calendars the user configured, and the passwords that reach them.
//!
//! `CalendarController.qml` reads `$XDG_CONFIG_HOME/omamail/calendars.json`
//! through a `FileView` and writes it through `scripts/config-store.sh`. The
//! standalone window has neither, so the file is this host's to read and
//! write — with `config-store.sh`'s own discipline, because the two clients
//! share the file and a user who runs both must not find it half-written or
//! world-readable.
//!
//! The shape is `Sources.js`'s, and that library stays the one place that
//! decides what a calendar is: the window serializes a list it built there and
//! hands the text over. What this side adds is the guarantee that only that
//! shape can land on disk. The payload is parsed into the ten fields a source
//! has and written back out from them, so a `password` the window put in a
//! source by mistake is dropped here rather than stored in a file that outlives
//! the mistake — the same reason `config-store.sh` keeps the accounts
//! invariant at the final write boundary instead of at the caller.
//!
//! A CalDAV password never enters that file at all. It goes to the keyring
//! under `SecretKey::caldav`, which is where `CaldavTransport` looks for it,
//! and it crosses to this process inside the request rather than on a command
//! line, so it is never in the process table.

use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::platform::secrets::{Secret, SecretKey, SecretStore};

/// The keyring service every Omamail credential is filed under, and the one
/// `Sources.keyringAttributes` names.
const SERVICE: &str = "omamail";

/// A request carries a whole source list, so the ceiling is the file's.
const MAX_REQUEST_BYTES: usize = 256 * 1024;
/// What is read back off disk. A calendar list this side of a megabyte is
/// somebody else's file, not ours.
const MAX_FILE_BYTES: usize = 128 * 1024;
/// More calendars than any desktop has, and few enough that the write stays a
/// single small file.
const MAX_SOURCES: usize = 256;
/// Every text field in a source. A URL, a display name and a username are all
/// well under this; anything longer is a payload rather than a value.
const MAX_FIELD_BYTES: usize = 2048;
/// A password. Long enough for a generated app password and a passphrase both.
const MAX_PASSWORD_BYTES: usize = 1024;

/// The file is the user's alone: it names every calendar server this machine
/// talks to and the account on each. The directory too, for the same reason
/// `write_atomic` protects it — a fresh `~/.config/omamail` would otherwise
/// inherit the umask and the 0600 on the file would be all that stood.
const FILE_MODE: u32 = 0o600;
const DIRECTORY_MODE: u32 = 0o700;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalendarStoreError {
    /// The request was not one this host answers, or carried a value it
    /// refuses. Never says which value: a refusal is drawn on screen.
    Invalid,
    /// The file could not be read or published.
    Storage,
    /// The keyring refused the password.
    Secret,
}

impl fmt::Display for CalendarStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Invalid => "The calendar request is invalid",
            Self::Storage => "Could not save the calendar",
            Self::Secret => "Could not save the password",
        })
    }
}
impl std::error::Error for CalendarStoreError {}

/// One configured calendar, in `Sources.makeSource`'s own field order.
///
/// Every field has a default because the file on disk predates some of them —
/// a list written before `remoteCalendarId` existed carries nine keys, not
/// ten, and must still load rather than being read as a corrupt file and
/// replaced with an empty one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSource {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub remote_calendar_id: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub color_key: String,
}

/// `Sources.makeSource`: a calendar nobody has switched off is on.
fn enabled_by_default() -> bool {
    true
}

impl CalendarSource {
    fn checked(self) -> Result<Self, CalendarStoreError> {
        if self.id.trim().is_empty() {
            return Err(CalendarStoreError::Invalid);
        }
        for field in [
            &self.id,
            &self.kind,
            &self.name,
            &self.url,
            &self.username,
            &self.remote_calendar_id,
            &self.account_id,
            &self.color_key,
        ] {
            if field.len() > MAX_FIELD_BYTES {
                return Err(CalendarStoreError::Invalid);
            }
        }
        Ok(self)
    }
}

/// The file's own envelope. The version is written rather than echoed: there
/// is one version and this is what wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalendarSourceList {
    pub version: u32,
    pub sources: Vec<CalendarSource>,
}

impl Default for CalendarSourceList {
    fn default() -> Self {
        Self {
            version: 1,
            sources: Vec::new(),
        }
    }
}

impl CalendarSourceList {
    /// The canonical text for a list, which is what is written and what is
    /// handed back to the window so both sides hold the same bytes.
    ///
    /// One line and a newline, the way `config-store.sh` writes one.
    pub fn serialize(&self) -> String {
        let mut text = serde_json::to_string(self).unwrap_or_else(|_| {
            // `CalendarSourceList` is strings, bools and a number; there is no
            // value in it serde can refuse. An empty list is still a better
            // answer than a panic in the process drawing the window.
            String::from("{\"version\":1,\"sources\":[]}")
        });
        text.push('\n');
        text
    }

    /// Read a list out of whatever text is offered.
    ///
    /// Unknown keys are dropped rather than kept, which is `Sources.load`'s own
    /// behaviour — it rebuilds every entry through `makeSource` — and is what
    /// makes "a secret cannot reach this file" a property of the writer rather
    /// than a promise about the caller.
    pub fn parse(text: &str) -> Result<Self, CalendarStoreError> {
        let value: Value = serde_json::from_str(text).map_err(|_| CalendarStoreError::Invalid)?;
        let raw = value
            .get("sources")
            .and_then(Value::as_array)
            .ok_or(CalendarStoreError::Invalid)?;
        if raw.len() > MAX_SOURCES {
            return Err(CalendarStoreError::Invalid);
        }
        let mut sources = Vec::with_capacity(raw.len());
        for entry in raw {
            let source: CalendarSource =
                serde_json::from_value(entry.clone()).map_err(|_| CalendarStoreError::Invalid)?;
            sources.push(source.checked()?);
        }
        Ok(Self {
            version: 1,
            sources,
        })
    }
}

/// Where the calendar list lives, and the keyring the passwords for it live in.
pub struct CalendarStore<S> {
    path: PathBuf,
    secrets: S,
}

impl<S: SecretStore> CalendarStore<S> {
    pub fn new(path: PathBuf, secrets: S) -> Self {
        Self { path, secrets }
    }

    /// The JSON envelope every operation answers with.
    ///
    /// A refusal is an answer rather than a rejected promise, for the same
    /// reason the attachment chooser's is: the window draws the reason on the
    /// settings page, and a rejection there would be reported as the host
    /// being unavailable.
    pub fn dispatch(&self, request: &str) -> String {
        match self.execute(request) {
            Ok(value) => value.to_string(),
            Err(error) => json!({ "ok": false, "error": error.to_string() }).to_string(),
        }
    }

    fn execute(&self, request: &str) -> Result<Value, CalendarStoreError> {
        if request.len() > MAX_REQUEST_BYTES {
            return Err(CalendarStoreError::Invalid);
        }
        let parsed: Request =
            serde_json::from_str(request).map_err(|_| CalendarStoreError::Invalid)?;
        match parsed {
            Request::Read {} => Ok(json!({ "ok": true, "text": self.read()?.serialize() })),
            Request::Write { payload } => Ok(json!({ "ok": true, "text": self.write(&payload)? })),
            Request::SavePassword {
                source_id,
                password,
            } => {
                self.save_password(&source_id, password)?;
                Ok(json!({ "ok": true }))
            }
        }
    }

    /// The stored list, or an empty one where no file has been written yet.
    ///
    /// A missing file is first run, not a failure. A file that will not parse
    /// is reported, because replacing it with an empty list is how a
    /// configuration gets silently lost — `FileView.onLoadFailed` could afford
    /// the empty list only because it never wrote one back.
    pub fn read(&self) -> Result<CalendarSourceList, CalendarStoreError> {
        let mut file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(CalendarSourceList::default());
            }
            Err(_) => return Err(CalendarStoreError::Storage),
        };
        let mut text = String::new();
        std::io::Read::by_ref(&mut file)
            .take(MAX_FILE_BYTES as u64 + 1)
            .read_to_string(&mut text)
            .map_err(|_| CalendarStoreError::Storage)?;
        if text.len() > MAX_FILE_BYTES {
            return Err(CalendarStoreError::Storage);
        }
        CalendarSourceList::parse(&text)
    }

    /// Publish a list, and answer with the text that landed.
    pub fn write(&self, payload: &str) -> Result<String, CalendarStoreError> {
        let text = CalendarSourceList::parse(payload)?.serialize();
        write_atomic(&self.path, text.as_bytes())?;
        Ok(text)
    }

    /// A CalDAV password, under the identity `CaldavTransport` reads it back
    /// by. Storing one is the whole of it: the source list is written
    /// separately and carries no trace of the secret.
    pub fn save_password(
        &self,
        source_id: &str,
        password: String,
    ) -> Result<(), CalendarStoreError> {
        let secret = Secret::new(password);
        if source_id.trim().is_empty()
            || source_id.len() > MAX_FIELD_BYTES
            || secret.expose().is_empty()
            || secret.expose().len() > MAX_PASSWORD_BYTES
        {
            return Err(CalendarStoreError::Invalid);
        }
        let key = SecretKey::caldav(SERVICE, source_id).map_err(|_| CalendarStoreError::Invalid)?;
        self.secrets
            .set(&key, secret)
            .map_err(|_| CalendarStoreError::Secret)
    }
}

#[derive(Deserialize)]
#[serde(tag = "operation", deny_unknown_fields, rename_all = "camelCase")]
enum Request {
    /// Braces rather than a bare unit variant: serde ignores every other key
    /// on a unit variant, and a request carrying one is a request this host
    /// does not understand.
    #[serde(rename = "calendars.read")]
    Read {},
    #[serde(rename = "calendars.write")]
    Write { payload: String },
    /// The password never reaches an argument vector: it is a field of the
    /// request, which crosses the QJS boundary in memory.
    #[serde(rename = "calendars.savePassword")]
    SavePassword {
        #[serde(rename = "sourceId")]
        source_id: String,
        password: String,
    },
}

/// `write_companion_status` and `gmail_setup::write_atomic`'s discipline, on
/// the file those two share a directory with: a private directory, a temporary
/// file nobody else can open, the bytes flushed, then one rename. A reader —
/// the QML plugin's `FileView` among them — sees either the old list or the
/// new one and never a truncated file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), CalendarStoreError> {
    let parent = path.parent().ok_or(CalendarStoreError::Storage)?;
    fs::create_dir_all(parent).map_err(|_| CalendarStoreError::Storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(parent, fs::Permissions::from_mode(DIRECTORY_MODE))
            .map_err(|_| CalendarStoreError::Storage)?;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(CalendarStoreError::Storage)?;
    let temporary = parent.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options
                .mode(FILE_MODE)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| CalendarStoreError::Storage)?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| CalendarStoreError::Storage)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            file.set_permissions(fs::Permissions::from_mode(FILE_MODE))
                .map_err(|_| CalendarStoreError::Storage)?;
        }
        drop(file);
        fs::rename(&temporary, path).map_err(|_| CalendarStoreError::Storage)?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| CalendarStoreError::Storage)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// The store this machine should use, with the system keyring behind it.
pub fn production() -> CalendarStore<crate::platform::secrets::SystemSecretStore> {
    CalendarStore::new(
        crate::calendars_path(std::env::var_os("HOME").map(PathBuf::from).as_deref())
            .unwrap_or_else(|| PathBuf::from("calendars.json")),
        crate::platform::secrets::SystemSecretStore::default(),
    )
}
