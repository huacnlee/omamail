use std::{
    fmt,
    path::{Path, PathBuf},
    time::Duration,
};

use crate::platform::commands::{PreparedCommand, ProcessRunner, SystemProcessRunner};

/// The desktop's address book has thousands of entries at most, and each is a
/// name and an address. An answer past this is a malformed one.
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_CONTACTS: usize = 5000;
const MAX_FIELD_BYTES: usize = 320;
/// Long enough for a cold SQLite read of several profiles, short enough that a
/// composer does not wait on it. A completion list that is late is a completion
/// list that is not there.
const DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ContactsError;
impl fmt::Debug for ContactsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ContactsError")
    }
}
impl fmt::Display for ContactsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("contact request failed")
    }
}
impl std::error::Error for ContactsError {}

/// Where the completion's address book comes from.
///
/// `Service.refreshRecipientContacts` runs `scripts/contact-suggestions.py`,
/// which reads Thunderbird's and Betterbird's own SQLite address books
/// read-only. That is the desktop address book this project has: there is no
/// system one to ask, and the standalone client had been completing from the
/// senders in the open mailbox alone — good for a reply, useless for a first
/// message to somebody the mailbox has never heard from.
///
/// The two sources are kept separate and merged in the window rather than here,
/// because they answer different questions and either can be empty on its own.
pub trait ContactSource: Send + Sync {
    fn read(&self) -> Result<Vec<u8>, ContactsError>;
}

/// Where a desktop address book lives on this platform.
///
/// The same directories `scripts/contact-suggestions.py` reads — it keeps the
/// whole list because one script serves both clients, and this keeps the pair
/// this platform can have, because the host has one question to answer before
/// it runs anything: whether there is an address book here at all.
///
/// That question earns its keep on macOS. `/usr/bin/python3` there is a stub
/// that puts a "install the command line developer tools" dialog on screen when
/// the tools are absent, and a completion list nobody asked for is not worth
/// putting that in front of somebody who has no Thunderbird to read.
/// `tests/contacts_host.rs` holds these against the script's own list.
pub fn address_book_roots(home: Option<&Path>) -> Vec<PathBuf> {
    let Some(home) = home else {
        return Vec::new();
    };
    if cfg!(target_os = "macos") {
        vec![
            home.join("Library/Thunderbird"),
            home.join("Library/Betterbird"),
        ]
    } else {
        vec![home.join(".thunderbird"), home.join(".betterbird")]
    }
}

/// Whether this machine has one, which is whether the module is exported.
pub fn has_address_book(home: Option<&Path>) -> bool {
    address_book_roots(home).iter().any(|root| root.is_dir())
}

pub struct ScriptContacts {
    script: PathBuf,
}
impl ScriptContacts {
    pub fn new(script: PathBuf) -> Self {
        Self { script }
    }
}
impl ContactSource for ScriptContacts {
    fn read(&self) -> Result<Vec<u8>, ContactsError> {
        let command = PreparedCommand::new(self.script.clone(), Vec::new(), None, DEADLINE)
            .map_err(|_| ContactsError)?;
        let output = SystemProcessRunner
            .run_bounded(command, MAX_OUTPUT_BYTES, 4096)
            .map_err(|_| ContactsError)?;
        if output.status() != Some(0) {
            return Err(ContactsError);
        }
        Ok(output.stdout().to_vec())
    }
}

/// The address book as the window gets it: `{"ok":true,"contacts":[…]}`, or an
/// `ok:false` with nothing in it.
///
/// A missing script, a machine with no Thunderbird on it and a Python that is
/// not installed all land in the same place, and none of them is worth a
/// message: the completion falls back to the mailbox's own senders, which is
/// what it has always had. Every name and address here was typed by whoever
/// owns the address book, so both are bounded before they cross.
pub fn read_contacts(source: &dyn ContactSource) -> String {
    let Ok(bytes) = source.read() else {
        return empty();
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return empty();
    };
    let Ok(serde_json::Value::Array(listed)) = serde_json::from_str::<serde_json::Value>(&text)
    else {
        return empty();
    };
    let contacts: Vec<_> = listed
        .iter()
        .filter_map(|entry| {
            let email = entry.get("email").and_then(serde_json::Value::as_str)?;
            let name = entry
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            // A control character in either would be a line break in a header
            // the moment it was accepted into a To field.
            if email.len() > MAX_FIELD_BYTES
                || name.len() > MAX_FIELD_BYTES
                || !email.contains('@')
                || email.chars().any(char::is_control)
                || name.chars().any(char::is_control)
            {
                return None;
            }
            Some(serde_json::json!({"name": name, "email": email}))
        })
        .take(MAX_CONTACTS)
        .collect();
    serde_json::to_string(&serde_json::json!({"ok": true, "contacts": contacts}))
        .unwrap_or_else(|_| empty())
}

fn empty() -> String {
    r#"{"ok":false,"contacts":[]}"#.to_owned()
}
