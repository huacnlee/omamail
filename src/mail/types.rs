use crate::mail::resolve_account;
use serde_json::{Map, Value};
use std::path::PathBuf;

const MAX_ID: usize = 8192;
const MAX_QUERY: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provider {
    Gmail,
    Outlook,
    Hey,
    Jmap,
    Imap,
}

impl Provider {
    pub fn id(self) -> &'static str {
        match self {
            Self::Gmail => "gmail",
            Self::Outlook => "outlook",
            Self::Hey => "hey",
            Self::Jmap => "jmap",
            Self::Imap => "imap",
        }
    }
}

impl TryFrom<&str> for Provider {
    type Error = &'static str;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "gmail" => Ok(Self::Gmail),
            "outlook" => Ok(Self::Outlook),
            "hey" => Ok(Self::Hey),
            "jmap" => Ok(Self::Jmap),
            "imap" => Ok(Self::Imap),
            _ => Err("mail_provider_unknown"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mailbox {
    Inbox,
    Unread,
    Starred,
    Sent,
    Drafts,
    Archive,
    Spam,
    Trash,
}

impl TryFrom<&str> for Mailbox {
    type Error = &'static str;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "inbox" => Ok(Self::Inbox),
            "unread" => Ok(Self::Unread),
            "starred" => Ok(Self::Starred),
            "sent" => Ok(Self::Sent),
            "drafts" => Ok(Self::Drafts),
            "archive" => Ok(Self::Archive),
            "spam" => Ok(Self::Spam),
            "trash" => Ok(Self::Trash),
            _ => Err("mail_mailbox_unknown"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mark {
    Read,
    Unread,
    Star,
    Unstar,
}

impl TryFrom<&str> for Mark {
    type Error = &'static str;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "read" => Ok(Self::Read),
            "unread" => Ok(Self::Unread),
            "star" => Ok(Self::Star),
            "unstar" => Ok(Self::Unstar),
            _ => Err("mail_mark_unknown"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Account {
    pub id: String,
    pub provider: Provider,
}

pub struct ListRequest {
    pub account: Account,
    pub mailbox: Mailbox,
    pub query: String,
    pub limit: u16,
    pub page_token: String,
}

pub struct ReadRequest {
    pub account: Account,
    pub id: String,
}

pub struct ActRequest {
    pub account: Account,
    pub operation: String,
    pub ids: Vec<String>,
    pub execute: bool,
}

pub struct AttachmentInput {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
}

pub struct SendRequest {
    pub account: Account,
    pub from: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
    pub attachments: Vec<AttachmentInput>,
    pub execute: bool,
    pub send_id: Option<String>,
}

fn params_object<'a>(
    value: &'a Value,
    fields: &[&str],
) -> Result<&'a Map<String, Value>, &'static str> {
    let object = value.as_object().ok_or("invalid_params")?;
    if object.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err("invalid_params");
    }
    Ok(object)
}

fn optional_string(
    object: &Map<String, Value>,
    field: &str,
    default: &str,
) -> Result<String, &'static str> {
    match object.get(field) {
        Some(value) => value.as_str().map(str::to_owned).ok_or("invalid_params"),
        None => Ok(default.to_owned()),
    }
}

fn account(object: &Map<String, Value>) -> Result<Account, &'static str> {
    let wanted = optional_string(object, "account", "")?;
    if wanted.len() > MAX_ID || wanted.chars().any(char::is_control) {
        return Err("invalid_params");
    }
    resolve_account(&wanted)
}

pub(crate) fn opaque_id(value: &str) -> Result<String, &'static str> {
    if value.is_empty()
        || value.len() > MAX_ID
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{061c}'
                        | '\u{200e}'
                        | '\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2066}'..='\u{2069}'
                )
        })
    {
        return Err("invalid_params");
    }
    Ok(value.to_owned())
}

fn ids(object: &Map<String, Value>) -> Result<Vec<String>, &'static str> {
    let values = object
        .get("ids")
        .and_then(Value::as_array)
        .ok_or("invalid_params")?;
    if values.is_empty() || values.len() > 1000 {
        return Err("invalid_params");
    }
    values
        .iter()
        .map(|value| value.as_str().ok_or("invalid_params").and_then(opaque_id))
        .collect()
}

fn addresses(object: &Map<String, Value>, field: &str) -> Result<Vec<String>, &'static str> {
    let Some(values) = object.get(field) else {
        return Ok(Vec::new());
    };
    values
        .as_array()
        .ok_or("invalid_params")?
        .iter()
        .map(|value| {
            let value = value.as_str().ok_or("invalid_params")?;
            if value.chars().any(char::is_control) {
                return Err("invalid_params");
            }
            Ok(value.to_owned())
        })
        .collect()
}

fn execute(object: &Map<String, Value>) -> Result<bool, &'static str> {
    match object.get("execute") {
        Some(value) => value.as_bool().ok_or("invalid_params"),
        None => Ok(false),
    }
}

impl TryFrom<&Value> for ListRequest {
    type Error = &'static str;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        let object = params_object(
            value,
            &["account", "mailbox", "query", "limit", "pageToken"],
        )?;
        let mailbox = Mailbox::try_from(optional_string(object, "mailbox", "inbox")?.as_str())?;
        let query = optional_string(object, "query", "")?;
        let page_token = optional_string(object, "pageToken", "")?;
        if query.len() > MAX_QUERY
            || page_token.len() > MAX_QUERY
            || query.chars().any(char::is_control)
            || page_token.chars().any(char::is_control)
        {
            return Err("invalid_params");
        }
        let limit = match object.get("limit") {
            Some(value) => value.as_u64().and_then(|value| u16::try_from(value).ok()),
            None => Some(25),
        }
        .filter(|limit| (1..=100).contains(limit))
        .ok_or("invalid_params")?;
        Ok(Self {
            account: account(object)?,
            mailbox,
            query,
            limit,
            page_token,
        })
    }
}

impl TryFrom<&Value> for ReadRequest {
    type Error = &'static str;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        let object = params_object(value, &["account", "id"])?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or("invalid_params")?;
        Ok(Self {
            account: account(object)?,
            id: opaque_id(id)?,
        })
    }
}

impl TryFrom<&Value> for ActRequest {
    type Error = &'static str;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        let object = params_object(value, &["account", "operation", "ids", "execute"])?;
        let operation = object
            .get("operation")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "read" | "unread" | "star" | "unstar" | "archive" | "trash" | "spam"
                )
            })
            .ok_or("invalid_params")?;
        Ok(Self {
            account: account(object)?,
            operation: operation.to_owned(),
            ids: ids(object)?,
            execute: execute(object)?,
        })
    }
}

impl TryFrom<&Value> for SendRequest {
    type Error = &'static str;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        let object = params_object(
            value,
            &[
                "account",
                "from",
                "to",
                "cc",
                "bcc",
                "subject",
                "body",
                "attachments",
                "execute",
                "sendId",
            ],
        )?;
        let from = optional_string(object, "from", "")?;
        let subject = optional_string(object, "subject", "")?;
        if from.chars().any(char::is_control) || subject.chars().any(char::is_control) {
            return Err("invalid_params");
        }
        let attachments = match object.get("attachments") {
            Some(values) => values
                .as_array()
                .ok_or("invalid_params")?
                .iter()
                .map(|value| {
                    let object = params_object(value, &["path", "name", "size"])?;
                    let path = object
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or("invalid_params")?;
                    let name = object
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or("invalid_params")?;
                    let size = object
                        .get("size")
                        .and_then(Value::as_u64)
                        .ok_or("invalid_params")?;
                    Ok::<AttachmentInput, &'static str>(AttachmentInput {
                        path: PathBuf::from(path),
                        name: name.to_owned(),
                        size,
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
            None => Vec::new(),
        };
        Ok(Self {
            account: account(object)?,
            from,
            to: addresses(object, "to")?,
            cc: addresses(object, "cc")?,
            bcc: addresses(object, "bcc")?,
            subject,
            body: optional_string(object, "body", "")?,
            attachments,
            execute: execute(object)?,
            send_id: object
                .get("sendId")
                .map(|value| {
                    let value = value.as_str().ok_or("invalid_params")?;
                    if value.len() > 1024 {
                        return Err("invalid_params");
                    }
                    opaque_id(value)
                })
                .transpose()?,
        })
    }
}

pub struct ExportRequest {
    pub account: Account,
    pub id: String,
    pub suggested_name: String,
    /// A folder the user picked. `None` saves to Downloads.
    pub directory: Option<PathBuf>,
}

impl TryFrom<&Value> for ExportRequest {
    type Error = &'static str;

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        let object = params_object(value, &["account", "id", "suggestedName", "directory"])?;
        let wanted = object
            .get("account")
            .and_then(Value::as_str)
            .ok_or("invalid_params")?;
        let account = resolve_export_account(wanted)?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("invalid_params")?
            .to_owned();
        opaque_id(&id)?;
        let suggested_name = optional_string(object, "suggestedName", "")?;
        if suggested_name.chars().any(char::is_control) {
            return Err("invalid_params");
        }
        let directory = export_directory(object.get("directory"))?;
        Ok(Self {
            account,
            id,
            suggested_name,
            directory,
        })
    }
}

/// A chosen destination is an absolute, already normalized folder path. The
/// writer still anchors it by descriptor and refuses a missing or unsafe one;
/// this only rejects what can never name a folder before any work starts.
fn export_directory(value: Option<&Value>) -> Result<Option<PathBuf>, &'static str> {
    let Some(value) = value else {
        return Ok(None);
    };
    let text = value.as_str().ok_or("invalid_params")?;
    let path = std::path::Path::new(text);
    // `components()` quietly drops an inner `.`, a doubled or trailing
    // separator, so the path must also be exactly its own normal form.
    let normal: PathBuf = path.components().collect();
    if text.is_empty()
        || text.len() > 4096
        || text.chars().any(char::is_control)
        || !path.is_absolute()
        || normal.as_os_str() != path.as_os_str()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("invalid_params");
    }
    Ok(Some(path.to_path_buf()))
}

/// Export needs an explicit account. An empty or unknown id is refused and
/// never falls back to the registry's active account, unlike `resolve_account`.
fn resolve_export_account(wanted: &str) -> Result<Account, &'static str> {
    if wanted.len() > MAX_ID || wanted.chars().any(char::is_control) {
        return Err("mail_account_unknown");
    }
    let id = wanted.trim().to_lowercase();
    if id.is_empty() || id.len() > MAX_ID || id.chars().any(char::is_control) {
        return Err("mail_account_unknown");
    }
    let summary = crate::account::list_readonly()?;
    let row = summary["accounts"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == id))
        .ok_or("mail_account_unknown")?;
    Ok(Account {
        id,
        provider: Provider::try_from(row["provider"].as_str().unwrap_or(""))?,
    })
}
