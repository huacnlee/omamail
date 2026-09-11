//! Native outgoing MIME. A header's bytes are normalized before interpolation.
/// Outgoing wire allowance preserves the UI 20 MiB attachment budget.
pub const MAX_RAW: usize = 32 * 1024 * 1024;
const MAX_ATTACHMENT: usize = 20 * 1024 * 1024;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::{DateTime, Datelike, Local};
use serde_json::{Value, json};
use std::io::Read;
type Result<T> = std::result::Result<T, &'static str>;
fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn header(value: &str) -> Result<String> {
    if value.len() > 65536
        || value
            .chars()
            .any(|c| c.is_control() && c != '\r' && c != '\n')
    {
        return Err("invalid_message_header");
    }
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
    Ok(out)
}
fn phrase(value: &str) -> Result<String> {
    let value = header(value)?;
    let value = value.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    if !value.is_ascii() {
        return Ok(format!("=?UTF-8?B?{}?=", STANDARD.encode(value)));
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}
fn fold(name: &str, value: &str) -> Result<String> {
    let value = header(value)?;
    Ok(if value.is_ascii() {
        format!("{name}: {value}")
    } else {
        format!("{name}: =?UTF-8?B?{}?=", STANDARD.encode(value))
    })
}
fn reference(value: &str) -> Result<String> {
    Ok(header(value)?
        .chars()
        .filter(|c| c.is_ascii() && !c.is_control())
        .take(512)
        .collect::<String>()
        .trim()
        .into())
}
fn base64(bytes: &[u8]) -> String {
    let data = STANDARD.encode(bytes);
    data.as_bytes()
        .chunks(76)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("\r\n")
}
fn attachment_bytes(data: &str) -> Result<Vec<u8>> {
    if data.len() > MAX_ATTACHMENT * 4 / 3 + 4 {
        return Err("message_too_large");
    }
    let encoded: String = data
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    let encoded = encoded.trim_end_matches('=');
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(encoded)
        .map_err(|_| "invalid_attachment_encoding")
}
fn boundary(value: &str) -> Result<String> {
    let stated: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "'()+_,-./:=?".contains(*c))
        .take(60)
        .collect();
    if !stated.is_empty() {
        return Ok(stated);
    }
    let mut random = [0; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut random))
        .map_err(|_| "random_unavailable")?;
    Ok(format!("=_Omamail_{}", URL_SAFE_NO_PAD.encode(random)))
}
fn nested(value: &str) -> String {
    let candidate: String = format!("alt_{value}").chars().take(60).collect();
    if candidate.starts_with(value) {
        format!("x_{value}").chars().take(60).collect()
    } else {
        candidate
    }
}
fn mime_type(value: &str) -> String {
    let value = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if let Some((a, b)) = value.split_once('/')
        && !a.is_empty()
        && !b.is_empty()
        && a.bytes()
            .chain(b.bytes())
            .all(|c| c.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&c))
    {
        return value;
    }
    "application/octet-stream".into()
}
fn domain(value: &str) -> String {
    value
        .rsplit_once('@')
        .map(|(_, s)| {
            s.chars()
                .filter(|c| c.is_ascii_alphanumeric() || ".-".contains(*c))
                .collect()
        })
        .unwrap_or_default()
}
fn valid_id(value: &str) -> bool {
    if value.len() > 250 {
        return false;
    }
    let Some(value) = value.strip_prefix('<').and_then(|s| s.strip_suffix('>')) else {
        return false;
    };
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    [local, domain].iter().all(|s| {
        s.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+/=?^_`{|}~-".contains(&b))
        })
    })
}
fn message_id(v: &Value) -> Result<String> {
    let supplied = field(v, "messageId");
    if valid_id(supplied) {
        return Ok(supplied.into());
    }
    let from = header(field(v, "from"))?;
    let mut host = domain(&from);
    if host.is_empty() {
        host = domain(field(v, "accountAddress"));
    }
    if host.is_empty() {
        host = "omamail.invalid".into();
    }
    let random = boundary("")?.replace('=', "");
    Ok(format!("<{}.omamail@{host}>", random))
}
fn date(v: &Value) -> String {
    let raw = header(field(v, "date")).unwrap_or_default();
    if let Ok(date) = DateTime::parse_from_rfc2822(raw.trim())
        && date.year() >= 1900
        && date.format("%a, %d %b %Y %H:%M:%S %z").to_string() == raw.trim()
    {
        return raw.trim().into();
    }
    Local::now().format("%a, %d %b %Y %H:%M:%S %z").to_string()
}
fn escaped(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn paragraphs(value: &str) -> String {
    let value = escaped(&value.replace("\r\n", "\n")).replace('\n', "<br>");
    if value.is_empty() {
        String::new()
    } else {
        format!("<div>{value}</div>")
    }
}
fn signed_html(body: &str, signature: &str, html: &str, rtl: bool) -> String {
    let sign = signature.trim();
    let dir = if rtl { " dir=\"rtl\"" } else { "" };
    let (before, after, include) = if !sign.is_empty() {
        if let Some(at) = body.find(sign) {
            (&body[..at], &body[at + sign.len()..], true)
        } else {
            (body, "", false)
        }
    } else {
        let at = if body.starts_with('>') {
            Some(0)
        } else {
            body.find("\n>")
        };
        match at {
            Some(at) => (&body[..at], &body[at..], true),
            None => (body, "", true),
        }
    };
    format!(
        "<html><body{dir}>{}{}{}</body></html>",
        paragraphs(before),
        if include { html } else { "" },
        paragraphs(after)
    )
}
fn text_part(lines: &mut Vec<String>, mime: &str, body: &str) {
    lines.extend([
        format!("Content-Type: {mime}; charset=UTF-8"),
        "Content-Transfer-Encoding: base64".into(),
        String::new(),
        base64(body.as_bytes()),
    ]);
}
fn alternative(lines: &mut Vec<String>, body: &str, html: &str, boundary: &str) {
    lines.extend([
        format!("Content-Type: multipart/alternative; boundary=\"{boundary}\""),
        String::new(),
        format!("--{boundary}"),
    ]);
    text_part(lines, "text/plain", body);
    lines.push(format!("--{boundary}"));
    text_part(lines, "text/html", html);
    lines.push(format!("--{boundary}--"));
}
fn body_part(lines: &mut Vec<String>, v: &Value, boundary: &str) -> Result<()> {
    let body = field(v, "body");
    let rtl = super::direction::strong_direction(body) == "rtl";
    if !field(v, "signatureHtml").is_empty() {
        let swapped = super::signature::inline_parts(field(v, "signatureHtml"), "sig");
        let parts = swapped["parts"].as_array().ok_or("invalid_signature")?;
        let html = signed_html(body, field(v, "signature"), field(&swapped, "html"), rtl);
        let alt = nested(boundary);
        if !parts.is_empty() {
            lines.extend([format!("Content-Type: multipart/related; boundary=\"{boundary}\"; type=\"multipart/alternative\""),String::new(),format!("--{boundary}")]);
        }
        alternative(lines, body, &html, &alt);
        for part in parts {
            let mime = mime_type(field(part, "mimeType"));
            let cid = header(field(part, "cid"))?;
            if cid.chars().any(|c| c.is_whitespace() || "<>".contains(c)) {
                return Err("invalid_signature");
            }
            lines.extend([
                format!("--{boundary}"),
                format!("Content-Type: {mime}"),
                "Content-Transfer-Encoding: base64".into(),
                format!("Content-ID: <{cid}>"),
                "Content-Disposition: inline".into(),
                String::new(),
                base64(&attachment_bytes(field(part, "data"))?),
            ]);
        }
        if !parts.is_empty() {
            lines.push(format!("--{boundary}--"));
        }
    } else if rtl {
        let html = format!(
            "<html><body dir=\"rtl\">{}</body></html>",
            escaped(&body.replace("\r\n", "\n")).replace('\n', "<br>\n")
        );
        alternative(lines, body, &html, boundary);
    } else {
        text_part(lines, "text/plain", body);
    }
    Ok(())
}
/// Build the existing provider-neutral send/draft payload without touching the network.
pub fn build(fields: &Value) -> Result<Value> {
    if !fields.is_object() {
        return Err("invalid_params");
    }
    // Bound every supplied value before decoding or constructing nested MIME.
    if serde_json::to_vec(fields)
        .map_err(|_| "invalid_params")?
        .len()
        > MAX_RAW * 2
    {
        return Err("message_too_large");
    }
    let mut lines = Vec::new();
    if !field(fields, "from").is_empty() {
        let address = header(field(fields, "from"))?;
        let name = phrase(field(fields, "fromName"))?;
        lines.push(format!(
            "From: {}",
            if name.is_empty() {
                address.trim().to_owned()
            } else {
                format!("{name} <{}>", address.trim())
            }
        ));
    }
    lines.push(fold("To", field(fields, "to"))?);
    for (key, name) in [("cc", "Cc"), ("bcc", "Bcc"), ("replyTo", "Reply-To")] {
        if !field(fields, key).is_empty() {
            lines.push(fold(name, field(fields, key))?);
        }
    }
    lines.push(fold("Subject", field(fields, "subject"))?);
    let reply = reference(field(fields, "inReplyTo"))?;
    if !reply.is_empty() {
        let refs = reference(field(fields, "references"))?;
        lines.push(format!("In-Reply-To: {reply}"));
        lines.push(format!(
            "References: {}",
            if refs.is_empty() { &reply } else { &refs }
        ));
    }
    lines.extend([
        format!("Date: {}", date(fields)),
        format!("Message-ID: {}", message_id(fields)?),
        "MIME-Version: 1.0".into(),
    ]);
    let boundary = boundary(field(fields, "boundary"))?;
    let attachments = fields["attachments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if attachments.len() > 256 {
        return Err("too_many_attachments");
    }
    let included: Vec<_> = attachments
        .iter()
        .filter(|v| v.get("data").is_some_and(|v| !v.is_null()))
        .collect();
    if !included.is_empty() {
        lines.extend([
            format!("Content-Type: multipart/mixed; boundary=\"{boundary}\""),
            String::new(),
            format!("--{boundary}"),
        ]);
        body_part(&mut lines, fields, &nested(&boundary))?;
        for file in included {
            let name = if field(file, "filename").is_empty() {
                "attachment"
            } else {
                field(file, "filename")
            };
            let name = phrase(name)?;
            lines.extend([
                format!("--{boundary}"),
                format!(
                    "Content-Type: {}; name={name}",
                    mime_type(field(file, "mimeType"))
                ),
                "Content-Transfer-Encoding: base64".into(),
                format!("Content-Disposition: attachment; filename={name}"),
                String::new(),
                base64(&attachment_bytes(field(file, "data"))?),
            ]);
        }
        lines.push(format!("--{boundary}--"));
    } else if !field(&fields["calendar"], "text").is_empty() {
        let method: String = field(&fields["calendar"], "method")
            .to_ascii_uppercase()
            .chars()
            .filter(char::is_ascii_uppercase)
            .take(20)
            .collect();
        let method = if method.is_empty() { "REPLY" } else { &method };
        lines.extend([
            format!("Content-Type: multipart/alternative; boundary=\"{boundary}\""),
            String::new(),
            format!("--{boundary}"),
        ]);
        text_part(&mut lines, "text/plain", field(fields, "body"));
        lines.extend([
            format!("--{boundary}"),
            format!("Content-Type: text/calendar; charset=UTF-8; method={method}"),
            "Content-Transfer-Encoding: base64".into(),
            String::new(),
            base64(field(&fields["calendar"], "text").as_bytes()),
            format!("--{boundary}--"),
        ]);
    } else {
        body_part(&mut lines, fields, &boundary)?;
    }
    let raw = lines.join("\r\n") + "\r\n";
    if raw.len() > MAX_RAW {
        return Err("message_too_large");
    }
    let mut payload = json!({"raw":URL_SAFE_NO_PAD.encode(raw),"draftId":field(fields,"draftId")});
    if !field(fields, "threadId").is_empty() {
        payload["threadId"] = fields["threadId"].clone();
    }
    let paths: Vec<_> = attachments
        .iter()
        .filter(|v| !field(v, "path").is_empty())
        .map(|v| json!({"path":field(v,"path"),"filename":field(v,"filename")}))
        .collect();
    if !paths.is_empty() {
        payload["attachments"] = json!(paths);
    }
    Ok(payload)
}

pub fn request(params: &Value) -> Result<Value> {
    if params.as_object().is_none_or(|p| p.len() != 1) {
        return Err("invalid_params");
    }
    build(&params["fields"])
}
