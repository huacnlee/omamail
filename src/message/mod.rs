//! MIME normalization only. Returned HTML remains untrusted and must be sanitized.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

pub mod direction;
pub mod compose;
pub mod content;
pub mod html;
pub mod signature;

pub const MAX_MESSAGE: usize = 16 * 1024 * 1024;

#[cfg(test)]
mod tests;

pub fn parse(raw: &[u8]) -> Result<Value, &'static str> {
    if raw.len() > MAX_MESSAGE {
        return Err("message_too_large");
    }
    let parsed = mailparse::parse_mail(raw).map_err(|_| "invalid_message")?;
    let mut budget = 4096;
    entity(&parsed, "", &mut budget)
}

pub fn request(params: &Value) -> Result<Value, &'static str> {
    let object = params.as_object().ok_or("invalid_params")?;
    if object.len() != 1 {
        return Err("invalid_params");
    }
    let raw = object
        .get("raw")
        .and_then(Value::as_str)
        .ok_or("invalid_params")?;
    if raw.len() > MAX_MESSAGE * 4 / 3 + 4 {
        return Err("message_too_large");
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| "invalid_message_encoding")?;
    parse(&bytes)
}

fn entity(
    mail: &mailparse::ParsedMail<'_>,
    id: &str,
    budget: &mut usize,
) -> Result<Value, &'static str> {
    if *budget == 0 {
        return Err("too_many_mime_parts");
    }
    *budget -= 1;
    let disposition = mail.get_content_disposition();
    let filename = disposition
        .params
        .get("filename")
        .or_else(|| mail.ctype.params.get("name"))
        .cloned()
        .unwrap_or_default();
    let headers: Vec<Value> = mail
        .headers
        .iter()
        .map(|header| {
            json!({
                "name":header.get_key(), "value":unfold_header(header.get_value_raw())
            })
        })
        .collect();
    let mut parts = Vec::new();
    for (index, child) in mail.subparts.iter().enumerate() {
        let child_id = if id.is_empty() {
            (index + 1).to_string()
        } else {
            format!("{id}.{}", index + 1)
        };
        parts.push(entity(child, &child_id, budget)?);
    }
    let mut body = json!({"size":0});
    let mut mime_type = mail.ctype.mimetype.clone();
    if parts.is_empty() {
        let bytes = if mime_type.starts_with("multipart/") {
            // mailparse treats a missing boundary's content as preamble and
            // discards it. Recover the original body before transfer decoding.
            let (_, offset) =
                mailparse::parse_headers(mail.raw_bytes).map_err(|_| "invalid_message")?;
            let encoding = mail
                .headers
                .iter()
                .find(|h| {
                    h.get_key()
                        .eq_ignore_ascii_case("Content-Transfer-Encoding")
                })
                .map(|h| h.get_value().to_ascii_lowercase())
                .unwrap_or_default();
            let encoding = match encoding.trim() {
                "base64" => "base64",
                "quoted-printable" => "quoted-printable",
                _ => "binary",
            };
            let mut repaired = format!(
                "Content-Type: text/plain\r\nContent-Transfer-Encoding: {encoding}\r\n\r\n"
            )
            .into_bytes();
            repaired.extend_from_slice(&mail.raw_bytes[offset..]);
            mailparse::parse_mail(&repaired)
                .map_err(|_| "invalid_message")?
                .get_body_raw()
                .map_err(|_| "invalid_transfer_encoding")?
        } else {
            mail.get_body_raw()
                .map_err(|_| "invalid_transfer_encoding")?
        };
        if mime_type.starts_with("multipart/") {
            mime_type = if looks_like_html(&bytes) {
                "text/html"
            } else {
                "text/plain"
            }
            .into();
        }
        body = json!({"size":bytes.len(),"data":URL_SAFE_NO_PAD.encode(&bytes)});
        if !filename.is_empty() || disposition.disposition == mailparse::DispositionType::Attachment
        {
            body["attachmentId"] = json!(format!("part:{id}"));
        }
    }
    Ok(json!({"partId":id,"mimeType":mime_type,"filename":filename,
        "headers":headers,"body":body,"parts":parts}))
}

// Match the existing byte-string adapter: unfold whitespace, but leave encoded
// words intact. The reader owns RFC 2047 decoding and must not decode twice.
fn unfold_header(raw: &[u8]) -> String {
    let mut result = String::new();
    let mut index = 0;
    while index < raw.len() {
        let newline = if raw[index..].starts_with(b"\r\n") {
            2
        } else if raw[index] == b'\n' {
            1
        } else {
            0
        };
        if newline > 0
            && raw
                .get(index + newline)
                .is_some_and(|b| matches!(b, b' ' | b'\t'))
        {
            index += newline;
            while raw.get(index).is_some_and(|b| matches!(b, b' ' | b'\t')) {
                index += 1;
            }
            result.push(' ');
        } else {
            result.push(char::from(raw[index]));
            index += 1;
        }
    }
    result.trim().to_string()
}

fn looks_like_html(raw: &[u8]) -> bool {
    let start = raw
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(raw.len());
    let raw = &raw[start..];
    [
        "<!doctype html",
        "<html",
        "<head",
        "<body",
        "<div",
        "<table",
        "<p",
    ]
    .iter()
    .any(|tag| {
        raw.len() >= tag.len()
            && raw[..tag.len()].eq_ignore_ascii_case(tag.as_bytes())
            && raw
                .get(tag.len())
                .is_none_or(|b| !b.is_ascii_alphanumeric() && *b != b'_')
    })
}

#[cfg(test)]
mod parity_tests;
