//! JMAP wire resources adapted to the shared Gmail-shaped message contract.
//! MIME traversal is bounded; downloaded parts retain their original charset.
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde_json::{Value, json};
pub(super) const LIST_PROPERTIES: &[&str] = &[
    "id",
    "blobId",
    "threadId",
    "mailboxIds",
    "keywords",
    "size",
    "receivedAt",
    "from",
    "to",
    "cc",
    "subject",
    "preview",
    "messageId",
    "inReplyTo",
    "references",
    "header:List-Unsubscribe:asRaw",
    "header:List-Unsubscribe-Post:asRaw",
    "header:Date:asRaw",
];
pub(super) const BODY_PROPERTIES: &[&str] = &[
    "partId",
    "blobId",
    "size",
    "name",
    "type",
    "charset",
    "disposition",
    "cid",
    "headers",
];
pub(super) fn email_get(account: &str, ids: &[String], full: bool) -> Value {
    let mut properties = LIST_PROPERTIES.to_vec();
    if full {
        properties.extend(["headers", "bodyStructure", "bodyValues"]);
    }
    let mut args = json!({"accountId":account.trim(),"ids":ids,"properties":properties});
    if full {
        args["bodyProperties"] = json!(BODY_PROPERTIES);
        args["fetchTextBodyValues"] = json!(true);
        args["fetchHTMLBodyValues"] = json!(true);
    }
    args
}
const MAX_DEPTH: usize = 12;
const COMPOSED: &[&str] = &[
    "From",
    "To",
    "Cc",
    "Subject",
    "Date",
    "Message-ID",
    "In-Reply-To",
    "References",
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
];
fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        _ => value.to_string(),
    }
}
fn trim(value: &Value) -> String {
    text(value).trim().to_owned()
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn count(value: &Value) -> u64 {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n.floor() as u64)
        .unwrap_or(0)
}
fn set(value: &Value) -> bool {
    !value.is_null() && value != false
}
fn in_mailbox(email: &Value, id: &str) -> bool {
    !id.is_empty() && set(&email["mailboxIds"][id])
}
fn keyword(email: &Value, key: &str) -> bool {
    set(&email["keywords"][key])
}
fn label_ids(email: &Value, roles: &Value) -> Vec<&'static str> {
    let mut ids = Vec::new();
    if !keyword(email, "$seen") {
        ids.push("UNREAD");
    }
    if keyword(email, "$flagged") {
        ids.push("STARRED");
    }
    if keyword(email, "$draft") || in_mailbox(email, &trim(&roles["drafts"])) {
        ids.push("DRAFT");
    }
    for (role, label) in [
        ("inbox", "INBOX"),
        ("sent", "SENT"),
        ("trash", "TRASH"),
        ("junk", "SPAM"),
    ] {
        if in_mailbox(email, &trim(&roles[role])) {
            ids.push(label);
        }
    }
    ids
}
fn header_safe(value: &str) -> String {
    let mut out = String::new();
    let mut newline = false;
    for c in value.chars() {
        if c == '\r' || c == '\n' {
            if !newline {
                out.push(' ');
            }
            newline = true;
        } else {
            out.push(c);
            newline = false;
        }
    }
    out.trim().to_owned()
}
fn addresses(values: &Value) -> String {
    array(values)
        .iter()
        .filter_map(|value| {
            let email = header_safe(&trim(&value["email"]));
            if email.is_empty() {
                return None;
            }
            let name = header_safe(&trim(&value["name"]));
            if name.is_empty() {
                return Some(email);
            }
            let phrase = if name.bytes().all(|b| (32..=126).contains(&b)) {
                format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
            } else {
                format!("=?UTF-8?B?{}?=", STANDARD.encode(name.as_bytes()))
            };
            Some(format!("{phrase} <{email}>"))
        })
        .collect::<Vec<_>>()
        .join(", ")
}
fn bracketed(value: &Value) -> String {
    array(value)
        .iter()
        .map(trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.starts_with('<') && s.ends_with('>') {
                s
            } else {
                format!("<{s}>")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
fn raw_header(value: &Value, name: &str) -> String {
    let explicit = trim(&value[format!("header:{name}:asRaw")]);
    if explicit.is_empty() {
        trim(&value[format!("header:{name}")])
    } else {
        explicit
    }
}
fn composed(email: &Value) -> Vec<Value> {
    let mut headers = Vec::new();
    for (name, value) in [
        ("From", addresses(&email["from"])),
        ("To", addresses(&email["to"])),
        ("Cc", addresses(&email["cc"])),
        ("Subject", trim(&email["subject"])),
        ("Date", raw_header(email, "Date")),
        ("Message-ID", bracketed(&email["messageId"])),
        ("In-Reply-To", bracketed(&email["inReplyTo"])),
        ("References", bracketed(&email["references"])),
        ("List-Unsubscribe", raw_header(email, "List-Unsubscribe")),
        (
            "List-Unsubscribe-Post",
            raw_header(email, "List-Unsubscribe-Post"),
        ),
    ] {
        if !value.trim().is_empty() {
            headers.push(json!({"name":name,"value":value.trim()}));
        }
    }
    headers
}
fn part_headers(part: &Value) -> Vec<Value> {
    array(&part["headers"])
        .iter()
        .filter_map(|h| {
            let name = trim(&h["name"]);
            if name.is_empty() {
                None
            } else {
                Some(json!({"name":name,"value":trim(&h["value"])}))
            }
        })
        .collect()
}
fn mime_type(kind: &str, charset: &str) -> String {
    let mime = kind.trim().to_lowercase();
    let mime = if mime.is_empty() {
        "application/octet-stream".into()
    } else {
        mime
    };
    if mime.starts_with("text/") && !charset.trim().is_empty() {
        format!("{mime}; charset={}", charset.trim())
    } else {
        mime
    }
}

/// Refuse oversized expansion before constructing strings or a MIME tree.
/// Server-controlled repeated part IDs must pay for every reference, not merely
/// the single entry in bodyValues. Structural text has a conservative 6x budget
/// covering preview HTML escaping, JSON escaping and encoded address phrases.
pub(super) fn validate_budget(email: &Value, full: bool) -> Result<(), &'static str> {
    const LIMIT: usize = 32 * 1024 * 1024;
    struct Counter {
        used: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > LIMIT / 6 - self.used {
                return Err(std::io::Error::other("resource budget"));
            }
            self.used += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { used: 0 };
    if let Some(fields) = email.as_object() {
        for (name, value) in fields {
            if name == "bodyValues" || (name == "bodyStructure" && !full) {
                continue;
            }
            serde_json::to_writer(&mut counter, value).map_err(|_| "jmap_response_too_large")?;
        }
    }
    let mut remaining = LIMIT
        .checked_sub(counter.used * 6 + 1024)
        .ok_or("jmap_response_too_large")?;
    fn charge(remaining: &mut usize, n: usize) -> Result<(), &'static str> {
        *remaining = remaining.checked_sub(n).ok_or("jmap_response_too_large")?;
        Ok(())
    }
    fn walk(
        part: &Value,
        values: &Value,
        depth: usize,
        nodes: &mut usize,
        remaining: &mut usize,
    ) -> Result<(), &'static str> {
        *nodes += 1;
        if *nodes > 4096 {
            return Err("jmap_response_too_large");
        }
        charge(remaining, 256)?;
        let children = array(&part["subParts"]);
        if !children.is_empty() && depth < MAX_DEPTH {
            for child in children {
                walk(child, values, depth + 1, nodes, remaining)?;
            }
        } else if part["type"]
            .as_str()
            .unwrap_or("")
            .trim()
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("text/"))
        {
            // Match to_part coercion exactly, including malformed numeric IDs.
            let id = trim(&part["partId"]);
            if !id.is_empty()
                && let Some(body) = values
                    .get(&id)
                    .and_then(|v| v.get("value"))
                    .and_then(Value::as_str)
            {
                let encoded = body
                    .len()
                    .checked_add(2)
                    .and_then(|n| n.checked_div(3))
                    .and_then(|n| n.checked_mul(4))
                    .ok_or("jmap_response_too_large")?;
                charge(remaining, encoded)?;
            }
        }
        Ok(())
    }
    if full && email["bodyStructure"].is_object() {
        walk(
            &email["bodyStructure"],
            &email["bodyValues"],
            0,
            &mut 0,
            &mut remaining,
        )?;
    }
    Ok(())
}

pub(super) fn to_message(email: &Value, roles: &Value, full: bool) -> Value {
    let mut headers = composed(email);
    let mut payload =
        json!({"mimeType":"text/plain","headers":headers,"body":{"size":0},"parts":[]});
    if full && email["bodyStructure"].is_object() {
        let built = to_part(&email["bodyStructure"], &email["bodyValues"], 0);
        headers.extend(part_headers(email).into_iter().filter(|h| {
            !COMPOSED
                .iter()
                .any(|name| name.eq_ignore_ascii_case(h["name"].as_str().unwrap_or("")))
        }));
        payload = json!({"partId":built["partId"],"mimeType":built["mimeType"],"filename":built["filename"],"headers":headers,"body":built["body"],"parts":built["parts"]});
    }
    let date = chrono::DateTime::parse_from_rfc3339(&trim(&email["receivedAt"]))
        .ok()
        .map(|d| d.timestamp_millis())
        .filter(|n| *n > 0)
        .map(|n| n.to_string())
        .unwrap_or_default();
    let preview = text(&email["preview"])
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    json!({"id":trim(&email["id"]),"threadId":trim(&email["threadId"]),"labelIds":label_ids(email,roles),"internalDate":date,"sizeEstimate":count(&email["size"]),"payload":payload,"snippet":preview})
}

pub(super) fn to_part(part: &Value, values: &Value, depth: usize) -> Value {
    let kind = trim(&part["type"]);
    let id = trim(&part["partId"]);
    let mut node = json!({"partId":id,"mimeType":mime_type(&kind,""),"filename":trim(&part["name"]),"headers":part_headers(part),"body":{"size":0},"parts":[]});
    let cid = trim(&part["cid"]);
    if !cid.is_empty() {
        node["cid"] = json!(cid);
    }
    let children = array(&part["subParts"]);
    if !children.is_empty() && depth < MAX_DEPTH {
        node["parts"] = json!(
            children
                .iter()
                .map(|child| to_part(child, values, depth + 1))
                .collect::<Vec<_>>()
        );
        return node;
    }
    if kind.to_lowercase().starts_with("text/")
        && !id.is_empty()
        && let Some(body) = values
            .get(&id)
            .and_then(|v| v.get("value"))
            .and_then(Value::as_str)
    {
        node["mimeType"] = json!(mime_type(&kind, "utf-8"));
        node["body"] = json!({"size":body.len(),"data":URL_SAFE_NO_PAD.encode(body.as_bytes())});
        return node;
    }
    node["mimeType"] = json!(mime_type(&kind, &trim(&part["charset"])));
    node["body"] = json!({"size":count(&part["size"])});
    let blob = trim(&part["blobId"]);
    if !blob.is_empty() {
        node["body"]["attachmentId"] = json!(blob);
    }
    node
}

pub(super) fn truncated_parts(email: &Value) -> Vec<Value> {
    fn walk(part: &Value, values: &Value, depth: usize, out: &mut Vec<Value>) {
        if !part.is_object() || depth > MAX_DEPTH {
            return;
        }
        let children = array(&part["subParts"]);
        if !children.is_empty() {
            for child in children {
                walk(child, values, depth + 1, out);
            }
            return;
        }
        let kind = trim(&part["type"]);
        let id = trim(&part["partId"]);
        let blob = trim(&part["blobId"]);
        if kind.to_lowercase().starts_with("text/")
            && !id.is_empty()
            && values[&id]["isTruncated"] == true
            && !blob.is_empty()
        {
            out.push(json!({"partId":id,"blobId":blob,"size":count(&part["size"]),"type":kind,"charset":trim(&part["charset"])}));
        }
    }
    let mut out = Vec::new();
    walk(&email["bodyStructure"], &email["bodyValues"], 0, &mut out);
    out
}

pub(super) fn substitute_part(payload: &mut Value, part: &Value, data: &str) -> bool {
    fn walk(node: &mut Value, part: &Value, id: &str, data: &str, depth: usize) -> bool {
        if !node.is_object() || depth > MAX_DEPTH {
            return false;
        }
        if array(&node["parts"]).is_empty() {
            if trim(&node["partId"]) != id {
                return false;
            }
            let kind = trim(&part["type"]);
            let charset = trim(&part["charset"]);
            node["mimeType"] = json!(mime_type(
                if kind.is_empty() {
                    node["mimeType"].as_str().unwrap_or("")
                } else {
                    &kind
                },
                if charset.is_empty() {
                    "utf-8"
                } else {
                    &charset
                }
            ));
            let n = data.trim_end_matches('=').len();
            node["body"] = json!({"size":n/4*3 + match n%4 { 2=>1,3=>2,_=>0 },"data":data});
            return true;
        }
        if let Some(children) = node["parts"].as_array_mut() {
            for child in children {
                if walk(child, part, id, data, depth + 1) {
                    return true;
                }
            }
        }
        false
    }
    let id = trim(&part["partId"]);
    if id.is_empty() || data.is_empty() {
        return false;
    }
    walk(payload, part, &id, data, 0)
}

/// `viewed_mailbox` is the native query filter's `inMailbox` value, or empty.
pub(super) fn thread_blocks(
    representatives: &Value,
    threads: &Value,
    members: &Value,
    roles: &Value,
    viewed_mailbox: &str,
) -> Value {
    let junk = trim(&roles["junk"]);
    let trash = trim(&roles["trash"]);
    let only = !viewed_mailbox.is_empty() && (viewed_mailbox == junk || viewed_mailbox == trash);
    let mut blocks = serde_json::Map::new();
    for representative in array(representatives) {
        let thread = trim(&representative["threadId"]);
        let mut ids = Vec::new();
        let mut unread = false;
        let mut flagged = false;
        for id in array(&threads[&thread]) {
            let member = &members[trim(id)];
            if !member.is_object() {
                continue;
            }
            if if only {
                !in_mailbox(member, viewed_mailbox)
            } else {
                in_mailbox(member, &junk) || in_mailbox(member, &trash)
            } {
                continue;
            }
            ids.push(trim(&member["id"]));
            unread |= !keyword(member, "$seen");
            flagged |= keyword(member, "$flagged");
        }
        blocks.insert(trim(&representative["id"]),json!({"id":thread,"count":ids.len(),"unread":unread,"flagged":flagged,"memberIds":ids}));
    }
    Value::Object(blocks)
}

#[cfg(test)]
#[path = "resource_tests.rs"]
mod tests;
