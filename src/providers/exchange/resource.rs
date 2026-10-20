//! EWS items as the shared Gmail-shaped message resource. A list row is built from server
//! properties alone, so its synthesized headers hold values written by strangers, and the shared
//! summarizer reads them as raw header text: decoding RFC 2047 words over a whole value before it
//! looks for `<address>`, and splitting recipients at commas outside quotes with no backslash
//! escape. So nothing here lets a value start a header, a recipient or an encoded word: line breaks
//! become spaces, syntax characters leave names, `=?` is broken, and an address that is not plain
//! is not used. A full message is the server's MIME through the shared parser with server state on
//! top.

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::DateTime;
use serde_json::{Value, json};

use super::ews::{Folders, Item, MAX_MIME, Party, Role};

const HEADER_MAX: usize = 998;
const NAME_MAX: usize = 256;
const ADDRESS_MAX: usize = 320;
const SNIPPET_CHARS: usize = 200;

fn flat(text: &str, max: usize) -> String {
    let spaced: String = text
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let mut out = spaced.trim().to_owned();
    while out.len() > max {
        out.pop();
    }
    out.trim_end().to_owned()
}

fn labels(item: &Item, folders: &Folders) -> Vec<&'static str> {
    let role = folders.role_of(&item.folder);
    let mut labels = Vec::new();
    if !item.read {
        labels.push("UNREAD");
    }
    if item.flagged {
        labels.push("STARRED");
    }
    if item.draft || role == Some(Role::Drafts) {
        labels.push("DRAFT");
    }
    match role {
        Some(Role::Inbox) => labels.push("INBOX"),
        Some(Role::Sent) => labels.push("SENT"),
        Some(Role::Trash) => labels.push("TRASH"),
        Some(Role::Junk) => labels.push("SPAM"),
        Some(Role::Drafts) | None => {}
    }
    labels
}

/// A conservative addr-spec: one `@`, nothing the reader splits or decodes on.
fn address_ok(address: &str) -> bool {
    address.len() <= ADDRESS_MAX
        && address.matches('@').count() == 1
        && !address.starts_with('@')
        && !address.ends_with('@')
        && !address.contains("=?")
        && !address
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "<>()[]\\,;:\"".contains(c))
}

/// A display name with every character that could read as syntax replaced by a space, quoted when
/// it holds punctuation a bare phrase may not.
fn name(raw: &str) -> String {
    let plain: String = flat(raw, NAME_MAX)
        .chars()
        .map(|c| if "\"\\<>".contains(c) { ' ' } else { c })
        .collect();
    let plain = plain
        .replace("=?", "= ?")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if plain.contains(|c| ",;:()[]@.".contains(c)) {
        format!("\"{plain}\"")
    } else {
        plain
    }
}

fn mailbox(party: &Party) -> Option<String> {
    let address = party.address.trim();
    // A sender with no display name is given their address as one. That is no name: kept, the
    // address learned as a contact's name came back in a To that Exchange refused.
    let shown = if party.name.trim().eq_ignore_ascii_case(address) {
        String::new()
    } else {
        name(&party.name)
    };
    match (address_ok(address), shown.is_empty()) {
        (true, true) => Some(address.to_owned()),
        (true, false) => Some(format!("{shown} <{address}>")),
        // Without a usable address only the name can be shown, stripped of what could read as one.
        (false, false) => Some(shown.replace(['"', ','], " ").trim().to_owned()),
        (false, true) => None,
    }
}

fn mailboxes(list: &[Party]) -> String {
    let mut out = String::new();
    for entry in list.iter().filter_map(mailbox) {
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

/// The summarizer decodes the Subject again, so text holding a word opener travels as a word.
fn subject(raw: &str) -> String {
    let text = flat(raw, 700);
    if text.contains("=?") {
        format!("=?UTF-8?B?{}?=", STANDARD.encode(text))
    } else {
        text
    }
}

fn date(ms: Option<i64>) -> Option<DateTime<chrono::Utc>> {
    DateTime::from_timestamp_millis(ms.filter(|ms| *ms > 0)?)
        .filter(|date| chrono::Datelike::year(date) <= 9999)
}

fn headers(item: &Item) -> Vec<Value> {
    let id = item
        .message_id
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>');
    let id_ok = !id.is_empty()
        && id.len() < HEADER_MAX
        && !id
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "<>".contains(c));
    [
        (
            "From",
            item.from.as_ref().and_then(mailbox).unwrap_or_default(),
        ),
        ("To", mailboxes(&item.to)),
        ("Cc", mailboxes(&item.cc)),
        ("Subject", subject(&item.subject)),
        (
            "Date",
            date(item.sent_ms)
                .or_else(|| date(item.received_ms))
                .map(|d| d.format("%a, %-d %b %Y %H:%M:%S +0000").to_string())
                .unwrap_or_default(),
        ),
        (
            "Message-ID",
            if id_ok {
                format!("<{id}>")
            } else {
                String::new()
            },
        ),
    ]
    .into_iter()
    .filter(|(_, value)| !value.is_empty())
    .map(|(name, value)| json!({"name": name, "value": value}))
    .collect()
}

/// The snippet as the summarizer expects it (Gmail's is HTML it strips), so `a < b` is escaped; the
/// cap applies before escaping so an entity is never cut and `&#` is broken so a typed `&#27;`
/// cannot become ESC.
fn snippet(preview: &str) -> String {
    let flat = flat(preview, usize::MAX)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace("&#", "& #");
    let cut: String = flat.chars().take(SNIPPET_CHARS).collect();
    cut.trim_end()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn resource(
    item: &Item,
    folders: &Folders,
    payload: Value,
    received: Option<i64>,
) -> Result<Value, &'static str> {
    let id = super::ids::encode(&item.id)?;
    Ok(json!({
        "id": id,
        "threadId": id,
        "labelIds": labels(item, folders),
        "internalDate": date(received).map(|d| d.timestamp_millis().to_string()).unwrap_or_default(),
        "sizeEstimate": item.size,
        "snippet": snippet(&item.preview),
        "payload": payload,
    }))
}

/// A header-only row.
pub fn row(item: &Item, folders: &Folders) -> Result<Value, &'static str> {
    let payload = json!({"partId": "", "mimeType": "text/plain", "filename": "", "headers": headers(item), "body": {"size": 0}, "parts": []});
    resource(item, folders, payload, item.received_ms.or(item.sent_ms))
}

fn parse(mime: &[u8]) -> Result<Value, &'static str> {
    crate::message::parse_up_to(mime, MAX_MIME).map_err(|code| match code {
        "message_too_large" | "too_many_mime_parts" => "exchange_message_too_large",
        _ => "exchange_invalid_response",
    })
}

/// The whole message: the shared parser's tree for the MIME.
pub fn message(item: &Item, folders: &Folders) -> Result<Value, &'static str> {
    let mime = item.mime.as_deref().ok_or("exchange_invalid_response")?;
    let mut message = resource(item, folders, parse(mime)?, item.received_ms)?;
    if message["internalDate"] == "" {
        // Some drafts have no received time; they sort by the date they were written.
        let written = item.sent_ms.and_then(|ms| date(Some(ms)));
        message["internalDate"] = json!(
            written
                .map(|d| d.timestamp_millis().to_string())
                .unwrap_or_default()
        );
    }
    if item.size == 0 {
        message["sizeEstimate"] = json!(mime.len());
    }
    Ok(message)
}

/// The decoded bytes of the attachment `id` names: ids come from the parser that built the resource,
/// and only a leaf it marked as an attachment has one.
pub fn attachment(mime: &[u8], id: &str) -> Result<Vec<u8>, &'static str> {
    let payload = parse(mime)?;
    let mut stack = vec![&payload];
    while let Some(part) = stack.pop() {
        if part["body"]["attachmentId"].as_str() == Some(id) {
            let data = part["body"]["data"]
                .as_str()
                .ok_or("exchange_attachment_not_found")?;
            return URL_SAFE_NO_PAD
                .decode(data)
                .map_err(|_| "exchange_invalid_response");
        }
        stack.extend(part["parts"].as_array().into_iter().flatten());
    }
    Err("exchange_attachment_not_found")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn party(name: &str, address: &str) -> Party {
        Party {
            name: name.into(),
            address: address.into(),
        }
    }

    #[test]
    fn a_name_that_is_only_the_address_is_no_name() {
        let address = "ada@example.org";
        assert_eq!(mailbox(&party(address, address)).as_deref(), Some(address));
        assert_eq!(
            mailbox(&party("ADA@Example.org", address)).as_deref(),
            Some(address)
        );
        assert_eq!(mailbox(&party("", address)).as_deref(), Some(address));
        assert_eq!(
            mailbox(&party("Ada Lovelace", address)).as_deref(),
            Some("Ada Lovelace <ada@example.org>")
        );
        assert_eq!(
            mailbox(&party("Lovelace, Ada", address)).as_deref(),
            Some("\"Lovelace, Ada\" <ada@example.org>")
        );
    }
}
