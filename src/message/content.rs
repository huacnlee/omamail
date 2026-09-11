//! Provider-neutral message content prepared outside the QML event loop.
use super::MAX_MESSAGE;
use chrono::{DateTime, Datelike, Local, Timelike, Utc};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::OnceLock;
type Result<T> = std::result::Result<T, &'static str>;
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn number(v: &Value) -> f64 {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}
fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}
pub fn header(message: &Value, name: &str) -> String {
    part_header(&message["payload"], name)
}
fn part_header(part: &Value, name: &str) -> String {
    part["headers"]
        .as_array()
        .and_then(|headers| {
            headers
                .iter()
                .find(|h| text(&h["name"]).eq_ignore_ascii_case(name))
        })
        .map(|h| text(&h["value"]).into())
        .unwrap_or_default()
}
fn bytes64(value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0;
    for b in value.bytes() {
        let n = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        };
        buffer = (buffer << 6) | u32::from(n);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}
fn utf8(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut at = 0;
    while at < bytes.len() {
        match std::str::from_utf8(&bytes[at..]) {
            Ok(s) => {
                out.push_str(s);
                break;
            }
            Err(e) => {
                let n = e.valid_up_to();
                out.push_str(std::str::from_utf8(&bytes[at..at + n]).unwrap());
                at += n;
                if at < bytes.len() {
                    out.push(char::from(bytes[at]));
                    at += 1;
                }
            }
        }
    }
    out
}
fn decode(charset: &str, bytes: &[u8]) -> String {
    let charset = charset.to_ascii_lowercase();
    if (charset.starts_with("iso-8859")
        || charset.starts_with("windows-125")
        || charset.starts_with("us-ascii")
        || charset.is_empty())
        && std::str::from_utf8(bytes).is_err()
    {
        return bytes.iter().copied().map(char::from).collect();
    }
    utf8(bytes)
}
pub fn decoded_header(value: &str) -> String {
    if !value.contains("=?") {
        return value.into();
    }
    static WORDS: OnceLock<Regex> = OnceLock::new();
    let re = WORDS.get_or_init(|| Regex::new(r"=\?([^?]+)\?([BbQq])\?([^?]*)\?=").unwrap());
    let mut out = String::new();
    let mut end = 0;
    let mut previous = false;
    for cap in re.captures_iter(value) {
        let whole = cap.get(0).unwrap();
        let between = &value[end..whole.start()];
        if !(previous && between.chars().all(char::is_whitespace)) {
            out.push_str(between);
        }
        let bytes = if cap[2].eq_ignore_ascii_case("b") {
            bytes64(&cap[3])
        } else {
            let input = cap[3].as_bytes();
            let mut result = Vec::new();
            let mut at = 0;
            while at < input.len() {
                if input[at] == b'='
                    && at + 2 < input.len()
                    && input[at + 1].is_ascii_hexdigit()
                    && input[at + 2].is_ascii_hexdigit()
                {
                    result.push(
                        u8::from_str_radix(
                            std::str::from_utf8(&input[at + 1..at + 3]).unwrap(),
                            16,
                        )
                        .unwrap(),
                    );
                    at += 3;
                } else {
                    result.push(if input[at] == b'_' { b' ' } else { input[at] });
                    at += 1;
                }
            }
            result
        };
        out.push_str(&decode(&cap[1], &bytes));
        end = whole.end();
        previous = true;
    }
    out.push_str(&value[end..]);
    out
}
pub fn address(value: &str) -> Value {
    let raw = decoded_header(value);
    let raw = raw.trim();
    let mut name = String::new();
    let email = if raw.ends_with('>') {
        if let Some(at) = raw.rfind('<') {
            let phrase = raw[..at].trim();
            let phrase = phrase
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .unwrap_or(phrase);
            let mut chars = phrase.chars();
            while let Some(c) = chars.next() {
                name.push(if c == '\\' {
                    chars.next().unwrap_or(c)
                } else {
                    c
                });
            }
            name = name.trim().into();
            raw[at + 1..raw.len() - 1].trim().to_owned()
        } else {
            raw.into()
        }
    } else {
        raw.into()
    };
    if name.is_empty()
        && let Some((local, _)) = email.split_once('@')
        && !local.is_empty()
    {
        name = local.into();
    }
    json!({"name":name,"email":email,"display":if name.is_empty(){&email}else{&name}})
}
pub fn addresses(value: &str) -> Vec<Value> {
    let mut quotes = false;
    let mut angled = false;
    let mut start = 0;
    let mut result = Vec::new();
    for (i, c) in value.char_indices() {
        match c {
            '"' => quotes = !quotes,
            '<' => angled = true,
            '>' => angled = false,
            _ => {}
        }
        if c == ',' && !quotes && !angled {
            if !value[start..i].trim().is_empty() {
                result.push(address(&value[start..i]));
            }
            start = i + 1;
        }
    }
    if !value[start..].trim().is_empty() {
        result.push(address(&value[start..]));
    }
    result
}
/// Legacy list snippet text semantics, separate from the reader's HTML tree walk.
pub fn html_to_text(value: &str) -> String {
    static RULES: OnceLock<Vec<Regex>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            r"(?s)<!--[\s\S]*?-->",
            r"(?is)<script[\s\S]*?</script>",
            r"(?is)<style[\s\S]*?</style>",
            r#"(?i)<img\b(?:[^>"']|"[^"]*"|'[^']*')*>"#,
            r"(?i)<br\s*/?>",
            r"(?i)</(?:p|div|tr|li|h[1-6])>",
            r"(?i)<li[^>]*>",
            r"<[^>]+>",
            r"(?i)&nbsp;",
            r"(?i)&amp;",
            r"(?i)&lt;",
            r"(?i)&gt;",
            r"(?i)&quot;",
            r"(?i)&#39;|&apos;",
            r"&#([0-9]+);",
            r"&#x([0-9a-fA-F]+);",
            r"[ \t]+\n",
            r"\n{3,}",
        ]
        .iter()
        .map(|r| Regex::new(r).unwrap())
        .collect()
    });
    let mut out = value.to_owned();
    for re in &rules[..3] {
        out = re.replace_all(&out, "").into_owned();
    }
    let mut images = 0;
    out = rules[3]
        .replace_all(&out, |_: &regex::Captures| {
            images += 1;
            format!("[image {images}]")
        })
        .into_owned();
    for (i, replacement) in [
        (4, "\n"),
        (5, "\n"),
        (6, "• "),
        (7, ""),
        (8, " "),
        (9, "&"),
        (10, "<"),
        (11, ">"),
        (12, "\""),
        (13, "'"),
    ] {
        out = rules[i].replace_all(&out, replacement).into_owned();
    }
    for (i, radix) in [(14, 10), (15, 16)] {
        out = rules[i]
            .replace_all(&out, |c: &regex::Captures| {
                let n = u32::from_str_radix(&c[1], radix).unwrap_or(0) & 0xffff;
                char::from_u32(n).unwrap_or('\u{fffd}').to_string()
            })
            .into_owned();
    }
    out = rules[16].replace_all(&out, "\n").into_owned();
    out = rules[17].replace_all(&out, "\n\n").into_owned();
    out.trim().into()
}
fn date(message: &Value) -> Option<DateTime<Local>> {
    let millis = number(&message["internalDate"]);
    if millis > 0.0 {
        return DateTime::from_timestamp_millis(millis as i64).map(|d| d.with_timezone(&Local));
    }
    let header = header(message, "Date");
    DateTime::parse_from_rfc2822(&header)
        .or_else(|_| DateTime::parse_from_rfc3339(&header))
        .ok()
        .map(|d| d.with_timezone(&Local))
}
fn relative(date: Option<&DateTime<Local>>, now: i64) -> String {
    let Some(date) = date else {
        return String::new();
    };
    let reference = DateTime::from_timestamp_millis(now)
        .unwrap_or_else(Utc::now)
        .with_timezone(&Local);
    let elapsed = (reference.timestamp_millis() - date.timestamp_millis()).max(0);
    let minutes = elapsed / 60000;
    if minutes < 1 {
        return "now".into();
    }
    if minutes < 60 {
        return format!("{minutes}m");
    }
    if date.date_naive() == reference.date_naive() {
        return date.format("%H:%M").to_string();
    }
    if elapsed / 86400000 < 3 {
        return date.format("%a").to_string();
    }
    if elapsed / 86400000 < 365 {
        return format!("{} {}", date.format("%b"), date.day());
    }
    format!("{} {}, {}", date.format("%b"), date.day(), date.year())
}
fn thread(message: &Value) -> Value {
    let source = &message["thread"];
    let ids: Vec<_> = source["memberIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            let s = if v.is_null() {
                String::new()
            } else if let Some(s) = v.as_str() {
                s.into()
            } else {
                v.to_string()
            };
            let s = s.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_owned())
            }
        })
        .collect();
    json!({"id":if text(&source["id"]).is_empty(){text(&message["threadId"]).trim()}else{text(&source["id"]).trim()},"count":ids.len(),"unread":source["unread"]==true,"flagged":source["flagged"]==true,"memberIds":ids})
}
/// A list-row summary, with dates serialized like JSON.stringify(Date).
pub fn summarize(message: &Value, now: i64) -> Result<Value> {
    if !message.is_object() {
        return Err("invalid_params");
    }
    let date = date(message);
    let subject = collapse(&decoded_header(&header(message, "Subject")));
    let thread = thread(message);
    let labels = message["labelIds"].as_array().cloned().unwrap_or_default();
    let has = |s: &str| labels.iter().any(|v| v == s);
    Ok(
        json!({"id":text(&message["id"]),"threadId":text(&message["threadId"]),"from":address(&header(message,"From")),"replyTo":address(&header(message,"Reply-To")),"messageId":header(message,"Message-ID"),"to":addresses(&header(message,"To")),"cc":addresses(&header(message,"Cc")),"bcc":addresses(&header(message,"Bcc")),"inReplyTo":header(message,"In-Reply-To"),"subjectDirection":super::direction::resolve_subject(if subject.is_empty(){"(no subject)"}else{&subject}, super::direction::AUTO),"subject":if subject.is_empty(){"(no subject)"}else{&subject},"snippet":collapse(&html_to_text(text(&message["snippet"]))),"date":date.as_ref().map(|d|d.with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis,true)),"time":relative(date.as_ref(),now),"fullTime":date.as_ref().map(|d|format!("{} {}, {} {:02}:{:02}",d.format("%b"),d.day(),d.year(),d.hour(),d.minute())).unwrap_or_default(),"thread":thread,"unread":has("UNREAD")||thread["unread"]==true,"starred":has("STARRED")||thread["flagged"]==true,"important":has("IMPORTANT"),"inInbox":has("INBOX"),"inTrash":has("TRASH"),"inSpam":has("SPAM"),"isSent":has("SENT"),"isDraft":has("DRAFT"),"labelIds":labels,"sizeEstimate":number(&message["sizeEstimate"]).floor().max(0.0) as u64}),
    )
}
fn attachment(part: &Value) -> bool {
    !text(&part["filename"]).is_empty()
        || part_header(part, "Content-Disposition")
            .to_ascii_lowercase()
            .contains("attachment")
}
fn decode_part(part: &Value) -> Result<String> {
    let data = text(&part["body"]["data"]);
    if data.len() > MAX_MESSAGE * 4 / 3 + 4 {
        return Err("message_too_large");
    }
    static CHARSET: OnceLock<Regex> = OnceLock::new();
    let re = CHARSET.get_or_init(|| Regex::new(r#"(?i)charset="?([^";\s]+)"?"#).unwrap());
    let mime = text(&part["mimeType"]);
    let header = part_header(part, "Content-Type");
    let charset = re
        .captures(mime)
        .or_else(|| re.captures(&header))
        .map(|c| c[1].to_owned())
        .unwrap_or_else(|| "utf-8".into());
    Ok(decode(&charset, &bytes64(data)))
}
fn walk(
    part: &Value,
    depth: usize,
    budget: &mut usize,
    plain: &mut String,
    html: &mut String,
    files: &mut Vec<Value>,
) -> Result<()> {
    if depth > 12 {
        return Ok(());
    }
    if *budget == 0 {
        return Err("too_many_mime_parts");
    }
    *budget -= 1;
    let is_attachment = attachment(part);
    if is_attachment && !text(&part["body"]["attachmentId"]).is_empty() {
        files.push(json!({"filename":decoded_header(if text(&part["filename"]).is_empty(){"attachment"}else{text(&part["filename"])}),"mimeType":if text(&part["mimeType"]).is_empty(){"application/octet-stream"}else{text(&part["mimeType"])},"size":number(&part["body"]["size"]).floor().max(0.0) as u64,"attachmentId":text(&part["body"]["attachmentId"])}));
    }
    if let Some(children) = part["parts"].as_array().filter(|p| !p.is_empty()) {
        for child in children {
            walk(child, depth + 1, budget, plain, html, files)?;
        }
    } else if !is_attachment {
        let mime = text(&part["mimeType"]).to_ascii_lowercase();
        if plain.is_empty() && mime.starts_with("text/plain") {
            *plain = decode_part(part)?;
        } else if html.is_empty() && mime.starts_with("text/html") {
            *html = decode_part(part)?;
        }
    }
    Ok(())
}
pub fn prepare(message: &Value, now: i64) -> Result<Value> {
    prepare_content(message, now, true)
}

/// Reader rendering derives HTML text, direction and image markers together.
/// Avoid the preliminary regex reading that this caller would discard.
pub(crate) fn prepare_for_render(message: &Value, now: i64) -> Result<Value> {
    prepare_content(message, now, false)
}

fn prepare_content(message: &Value, now: i64, read_html: bool) -> Result<Value> {
    let mut plain = String::new();
    let mut html = String::new();
    let mut files = Vec::new();
    walk(
        &message["payload"],
        0,
        &mut 4096,
        &mut plain,
        &mut html,
        &mut files,
    )?;
    let source = if !plain.is_empty() {
        "plain"
    } else if !html.is_empty() {
        "html"
    } else {
        ""
    };
    let body = if source == "plain" {
        plain.replace("\r\n", "\n")
    } else if read_html {
        html_to_text(&html)
    } else {
        String::new()
    };
    Ok(
        json!({"summary":summarize(message,now)?,"body":{"text":body,"source":source,"bodyDirection":super::direction::resolve_body(&body,super::direction::AUTO)},"html":html,"attachments":files}),
    )
}
pub fn request(method: &str, params: &Value) -> Result<Value> {
    if !params.is_object() {
        return Err("invalid_params");
    }
    if serde_json::to_vec(params)
        .map_err(|_| "invalid_params")?
        .len()
        > MAX_MESSAGE * 2
    {
        return Err("message_too_large");
    }
    if params.get("now").is_some_and(|v| v.as_i64().is_none()) {
        return Err("invalid_params");
    }
    let now = if params.get("now").is_some() {
        number(&params["now"]) as i64
    } else {
        Utc::now().timestamp_millis()
    };
    match method {
        "message.composeText" => {
            let summary = &params["summary"];
            let quote = if params.get("body").is_some() {
                let prefix = if summary["from"].is_object() {
                    format!(
                        "On {}, {} wrote:\n",
                        text(&summary["fullTime"]),
                        text(&summary["from"]["display"])
                    )
                } else {
                    String::new()
                };
                prefix
                    + &text(&params["body"])
                        .split('\n')
                        .map(|line| format!("> {line}"))
                        .collect::<Vec<_>>()
                        .join("\n")
            } else {
                text(&params["quote"]).to_owned()
            };
            let sign = text(&params["signature"]).trim();
            let parts: Vec<_> = [sign, quote.as_str()]
                .into_iter()
                .filter(|p| !p.is_empty())
                .collect();
            let body = if parts.is_empty() {
                String::new()
            } else {
                format!("\n\n{}", parts.join("\n\n"))
            };
            let subject = params
                .get("subject")
                .unwrap_or(&summary["subject"])
                .as_str()
                .unwrap_or("")
                .trim();
            let reply = if subject
                .get(..3)
                .is_some_and(|s| s.eq_ignore_ascii_case("re:"))
            {
                subject.to_owned()
            } else {
                format!(
                    "Re: {}",
                    if subject.is_empty() {
                        "(no subject)"
                    } else {
                        subject
                    }
                )
            };
            Ok(json!({"body":body,"quote":quote,"replySubject":reply}))
        }
        "message.summarize" => summarize(&params["message"], now),
        "message.prepare" => prepare(&params["message"], now),
        "message.summaries" => {
            let messages = params["messages"]
                .as_array()
                .filter(|v| v.len() <= 500)
                .ok_or("invalid_params")?;
            Ok(
                json!({"summaries":messages.iter().map(|m|summarize(m,now)).collect::<Result<Vec<_>>>()?}),
            )
        }
        _ => Err("unknown_method"),
    }
}

#[cfg(test)]
mod date_tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn list_dates_show_month_after_three_days_and_year_after_one_year() {
        let now = Local.with_ymd_and_hms(2026, 9, 12, 15, 0, 0).unwrap();
        for (year, month, day, expected) in [
            (2026, 9, 9, "Sep 9"),
            (2025, 12, 21, "Dec 21"),
            (2025, 9, 10, "Sep 10, 2025"),
        ] {
            let date = Local.with_ymd_and_hms(year, month, day, 15, 0, 0).unwrap();
            assert_eq!(relative(Some(&date), now.timestamp_millis()), expected);
        }
    }
}
