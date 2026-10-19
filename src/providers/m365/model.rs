//! The mailbox as the desktop sees it: folder roles, the query language and Graph messages as the
//! Gmail-shaped rows the shared list and reader take.
//!
//! Every value in a Graph message is a stranger's. The shared summary reads header values as raw
//! header text, so a row's headers are built here so that nothing in a name or subject can start a
//! new header or recipient: names always travel as one RFC 2047 word, an address that is not a
//! plain addr-spec is not written as one, and control characters become spaces.

use std::collections::HashMap;

use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Datelike, Utc};
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

use super::ids;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Role {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Junk,
    Archive,
}

impl Role {
    pub(super) const ALL: [Role; 6] = [
        Role::Inbox,
        Role::Sent,
        Role::Drafts,
        Role::Trash,
        Role::Junk,
        Role::Archive,
    ];

    /// Graph's well-known folder name, which is how a folder is found whatever it is called.
    pub(super) fn well_known(self) -> &'static str {
        match self {
            Role::Inbox => "inbox",
            Role::Sent => "sentitems",
            Role::Drafts => "drafts",
            Role::Trash => "deleteditems",
            Role::Junk => "junkemail",
            Role::Archive => "archive",
        }
    }

    pub(super) fn word(self) -> &'static str {
        match self {
            Role::Inbox => "inbox",
            Role::Sent => "sent",
            Role::Drafts => "drafts",
            Role::Trash => "trash",
            Role::Junk => "junk",
            Role::Archive => "archive",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Folder {
    pub id: String,
    pub total: u64,
    pub unread: u64,
}

/// The folders a mailbox has, by role: a mailbox without an Archive has no `Archive` entry.
pub(super) type Roles = HashMap<Role, Folder>;

/// The largest count a folder or a page reports; past this the figure is noise.
pub(super) const MAX_COUNT: u64 = 10_000_000;

pub(super) fn folder(value: &Value) -> Result<Folder, &'static str> {
    let id = value["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control))
        .ok_or("m365_invalid_response")?;
    let count = |name: &str| value[name].as_u64().unwrap_or(0).min(MAX_COUNT);
    Ok(Folder {
        id: id.to_owned(),
        total: count("totalItemCount"),
        unread: count("unreadItemCount"),
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Scope {
    Folder(Role),
    /// Words searched for across the mailbox (Trash and Junk are left out by the listing).
    Text(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Query {
    pub scope: Scope,
    pub unread: bool,
    pub flagged: bool,
}

const MAX_TEXT: usize = 4096;

/// `role:<inbox|sent|drafts|archive|junk|trash> [unseen] [flagged]` or `text:<words>`; keywords in any
/// case, anything else (an unprefixed query included) is `invalid_params`.
pub(super) fn parse(query: &str) -> Result<Query, &'static str> {
    const INVALID: &str = "invalid_params";
    if query.len() > MAX_TEXT + 64 || query.chars().any(char::is_control) {
        return Err(INVALID);
    }
    let query = query.trim();
    let keyword = |prefix: &str| {
        query
            .get(..prefix.len())
            .filter(|head| head.eq_ignore_ascii_case(prefix))
            .map(|_| &query[prefix.len()..])
    };
    if let Some(text) = keyword("text:") {
        if text.len() > MAX_TEXT {
            return Err(INVALID);
        }
        // Graph reads what is inside `$search="..."` as KQL, which takes `from:x`, `OR`, wildcards and
        // groups. The words are searched as words: whatever could be syntax (after NFKC, which turns
        // fullwidth spellings into ASCII) is a word break, and a bare connector is lower-cased.
        let normalized: String = text.nfkc().collect();
        let words: Vec<String> = normalized
            .split(|c: char| {
                c.is_whitespace()
                    || matches!(
                        c,
                        '"' | '\\' | '(' | ')' | ':' | '<' | '>' | '=' | '~' | '*'
                    )
                    || matches!(c, '\u{ab}' | '\u{bb}' | '\u{201c}'..='\u{201f}')
            })
            .map(|word| word.trim_start_matches(['+', '-']))
            .filter(|word| !word.is_empty())
            .map(|word| match word {
                "AND" | "OR" | "NOT" => word.to_ascii_lowercase(),
                _ => word.to_owned(),
            })
            .collect();
        if words.is_empty() {
            return Err(INVALID);
        }
        return Ok(Query {
            scope: Scope::Text(words.join(" ")),
            unread: false,
            flagged: false,
        });
    }
    let rest = keyword("role:").ok_or(INVALID)?;
    if rest.starts_with(char::is_whitespace) {
        return Err(INVALID);
    }
    let mut words = rest.split_whitespace();
    let name = words.next().ok_or(INVALID)?;
    let role = Role::ALL
        .into_iter()
        .find(|role| name.eq_ignore_ascii_case(role.word()))
        .ok_or(INVALID)?;
    let (mut unread, mut flagged) = (false, false);
    for word in words {
        let flag = match word.to_ascii_lowercase().as_str() {
            "unseen" => &mut unread,
            "flagged" => &mut flagged,
            _ => return Err(INVALID),
        };
        if std::mem::replace(flag, true) {
            return Err(INVALID);
        }
    }
    Ok(Query {
        scope: Scope::Folder(role),
        unread,
        flagged,
    })
}

impl Query {
    /// One spelling per meaning: the page token that continues a listing is bound to it.
    pub(super) fn canonical(&self) -> String {
        match &self.scope {
            Scope::Text(text) => format!("text:{text}"),
            Scope::Folder(role) => format!(
                "role:{}{}{}",
                role.word(),
                if self.unread { " unseen" } else { "" },
                if self.flagged { " flagged" } else { "" }
            ),
        }
    }
}

/// What a listing and a header read ask Graph for: the properties `row` shows, and no body.
pub(super) const ROW_SELECT: &str = "id,parentFolderId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,flag,isDraft,bodyPreview";

const HEADER_MAX: usize = 998;
const NAME_MAX: usize = 256;
const ADDRESS_MAX: usize = 320;

fn cut(text: &str, max: usize) -> &str {
    let mut end = max.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Header text from an untrusted string: control characters and line separators become spaces and
/// the ends are trimmed, at most `max` bytes of whole characters.
fn flat(value: &Value, max: usize) -> String {
    let text: String = value
        .as_str()
        .unwrap_or("")
        .chars()
        .take(max)
        .map(|c| {
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .collect();
    cut(text.trim(), max).to_owned()
}

fn word(text: &str) -> String {
    format!("=?UTF-8?B?{}?=", STANDARD.encode(text))
}

/// A conservative addr-spec: one `@`, none of the characters a header splitter or an encoded word
/// could take for syntax.
fn addr_spec(address: &str) -> bool {
    address.len() <= ADDRESS_MAX
        && address.matches('@').count() == 1
        && !address.starts_with('@')
        && !address.ends_with('@')
        && !address.contains("=?")
        && !address.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(
                    c,
                    '<' | '>' | '(' | ')' | '[' | ']' | '\\' | ',' | ';' | ':' | '"'
                )
        })
}

fn mailbox(party: &Value) -> Option<String> {
    let address = flat(&party["emailAddress"]["address"], ADDRESS_MAX);
    let name = flat(&party["emailAddress"]["name"], NAME_MAX);
    if addr_spec(&address) {
        if name.is_empty() || name.eq_ignore_ascii_case(&address) {
            return Some(address);
        }
        return Some(format!("{} <{address}>", word(&name)));
    }
    // Without a trustworthy address only a name can be shown, with nothing in it that reads as one.
    let shown = if name.is_empty() { address } else { name };
    let shown = shown.replace(['<', '>'], " ");
    (!shown.trim().is_empty()).then(|| word(shown.trim()))
}

fn mailboxes(list: &Value) -> String {
    let mut out = String::new();
    for entry in list
        .as_array()
        .into_iter()
        .flatten()
        .take(200)
        .filter_map(mailbox)
    {
        if out.len() + entry.len() + 2 > HEADER_MAX {
            break;
        }
        if !out.is_empty() {
            out.push_str(", ");
        }
        out.push_str(&entry);
    }
    out
}

/// A usable instant: after the epoch and inside the years RFC 5322 can write.
fn instant(value: &Value) -> Option<DateTime<Utc>> {
    let date =
        DateTime::parse_from_rfc3339(value.as_str().filter(|text| text.len() <= 64)?).ok()?;
    let date = date.with_timezone(&Utc);
    (date.timestamp_millis() > 0 && date.year() <= 9999).then_some(date)
}

/// The label ids the shared summary reads: folder role, read state and flag.
fn labels(message: &Value, roles: &Roles) -> Vec<&'static str> {
    let parent = message["parentFolderId"].as_str().unwrap_or("");
    let role = Role::ALL
        .into_iter()
        .find(|role| !parent.is_empty() && roles.get(role).is_some_and(|f| f.id == parent));
    let mut labels = Vec::new();
    // A message Graph does not say is unread is not shown as new mail.
    if message["isRead"].as_bool() == Some(false) {
        labels.push("UNREAD");
    }
    if message["flag"]["flagStatus"].as_str() == Some("flagged") {
        labels.push("STARRED");
    }
    if message["isDraft"].as_bool() == Some(true) || role == Some(Role::Drafts) {
        labels.push("DRAFT");
    }
    match role {
        Some(Role::Inbox) => labels.push("INBOX"),
        Some(Role::Sent) => labels.push("SENT"),
        Some(Role::Trash) => labels.push("TRASH"),
        Some(Role::Junk) => labels.push("SPAM"),
        _ => {}
    }
    labels
}

/// The preview as the shared summary expects it: HTML it strips and decodes, so `a < b` is escaped
/// (and `&#` split, which the decoder would turn into a typed control character).
fn snippet(value: &Value) -> String {
    let text = flat(value, 8192)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let text: String = text.replace("&#", "& #").chars().take(200).collect();
    text.trim_end()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn headers(message: &Value) -> Vec<Value> {
    let subject = flat(&message["subject"], HEADER_MAX);
    // The summary decodes encoded words again, so a typed one is sent as a word of its own.
    let subject = if subject.contains("=?") {
        word(cut(&subject, 600))
    } else {
        subject
    };
    let date = instant(&message["sentDateTime"])
        .or_else(|| instant(&message["receivedDateTime"]))
        .map(|date| date.format("%a, %-d %b %Y %H:%M:%S +0000").to_string());
    let id = flat(&message["internetMessageId"], HEADER_MAX);
    let id = id.trim_matches(['<', '>']);
    let id = (!id.is_empty()
        && !id
            .chars()
            .any(|c| c.is_whitespace() || c == '<' || c == '>'))
    .then(|| format!("<{id}>"));
    [
        ("From", mailbox(&message["from"])),
        ("To", Some(mailboxes(&message["toRecipients"]))),
        ("Cc", Some(mailboxes(&message["ccRecipients"]))),
        ("Subject", Some(subject)),
        ("Date", date),
        ("Message-ID", id),
    ]
    .into_iter()
    .filter_map(|(name, value)| Some(json!({"name":name,"value":value.filter(|v| !v.is_empty())?})))
    .collect()
}

/// A header-only row (a listing's, or a `messages` answer's): Gmail's resource with headers and no
/// parts. A message whose id cannot be carried is an error and the caller leaves it out.
pub(super) fn row(message: &Value, roles: &Roles) -> Result<Value, &'static str> {
    let id = ids::encode(message["id"].as_str().ok_or("m365_invalid_response")?)?;
    Ok(resource(
        message,
        roles,
        id,
        json!({
            "partId":"","mimeType":"text/plain","filename":"","headers":headers(message),
            "body":{"size":0},"parts":[],
        }),
    ))
}

/// The resource of a message with the payload the shared parser made of its MIME. The server's
/// words are only what MIME cannot know: the folder, the flags and when it arrived.
pub(super) fn full(
    message: &Value,
    roles: &Roles,
    id: String,
    payload: Value,
    size: usize,
) -> Value {
    let mut resource = resource(message, roles, id, payload);
    resource["sizeEstimate"] = json!(size);
    resource
}

fn resource(message: &Value, roles: &Roles, id: String, payload: Value) -> Value {
    let date = instant(&message["receivedDateTime"]).or_else(|| instant(&message["sentDateTime"]));
    json!({
        "id":id,"threadId":id,"labelIds":labels(message, roles),
        "internalDate":date.map(|date| date.timestamp_millis().to_string()).unwrap_or_default(),
        "sizeEstimate":0,"snippet":snippet(&message["bodyPreview"]),"payload":payload,
    })
}
