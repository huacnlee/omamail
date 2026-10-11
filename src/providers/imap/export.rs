//! Exact raw-message retrieval for export. The octets the server sends are
//! returned unchanged: nothing here parses the message or re-serializes it.
//!
//! Internal to the provider layer and deliberately absent from the advertised
//! public method inventory (`src/backend/methods.rs`), like the internal
//! `jmap.action*` planners. `mail.exportEml` consumes it.
use super::*;

/// Validate the export parameters before any socket is opened.
pub(super) fn validate(method: &str, p: &Value) -> Result<()> {
    if method != "imap.rawMessage" {
        return Ok(());
    }
    quote(p["folder"].as_str().ok_or("invalid_params")?)?;
    requested_uid(p)?;
    Ok(())
}

fn requested_uid(p: &Value) -> Result<u32> {
    p["uid"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .map(|n| n as u32)
        .ok_or("mail_export_message_invalid")
}

pub(super) async fn call(p: &Value) -> Result<Value> {
    let folder = p["folder"].as_str().ok_or("invalid_params")?;
    let bytes = raw_message(p, requested_uid(p)?, folder).await?;
    Ok(json!({"bytes": bytes.len(), "data": STANDARD.encode(&bytes)}))
}

/// Fetch one UID's complete message and return the server's literal octets.
/// `BODY.PEEK[]` keeps `\Seen` unchanged, and `EXAMINE` selects the mailbox
/// read-only, so nothing here changes flags, message location, or mailbox
/// state such as `\Recent`.
pub(super) async fn raw_message(p: &Value, uid: u32, folder: &str) -> Result<Vec<u8>> {
    let (mut w, key) = acquire(p).await?;
    let result = fetch_literal(&mut w, uid, folder).await;
    // A framing refusal can leave unread literal bytes on the socket. Only
    // a successful fetch is known to be synchronized and safe to reuse.
    if result.is_ok() {
        release(w, key).await;
    }
    match result {
        Err("mail_response_too_large") => Err("mail_export_too_large"),
        other => other,
    }
}

async fn fetch_literal(w: &mut Wire, uid: u32, folder: &str) -> Result<Vec<u8>> {
    command(w, &format!("EXAMINE {}", quote(folder)?)).await?;
    // Bound the message literal by the export's 25 MiB product limit, so an
    // over-limit message is refused when its length is announced rather than
    // after the whole literal has been read into memory.
    let data = command_limited(
        w,
        &format!("UID FETCH {uid} (UID BODY.PEEK[])"),
        crate::mail::export::MAX_BYTES,
    )
    .await?;
    single_literal(&data, uid)
}

/// Exactly one full `BODY[]` literal for the requested UID. Unsolicited records
/// for other UIDs are ignored; a missing record, a `NIL` body, a partial
/// section such as `BODY[HEADER]`, a list-valued body, a duplicated field, or
/// two literals for the requested UID are refused. The literal is length-framed,
/// so a payload that merely looks like a tagged completion or another FETCH
/// record cannot be mistaken for one.
///
/// A partial section and a second body field are refusals rather than
/// overwrites: the saved file would otherwise report success while holding
/// something that is not the complete original message.
fn single_literal(data: &[u8], uid: u32) -> Result<Vec<u8>> {
    let mut found: Option<Vec<u8>> = None;
    for row in read::nodes(data)? {
        if row.len() < 4 || !row[0].is("*") || !row[2].is("FETCH") {
            continue;
        }
        let fields = row[3].list();
        let mut row_uid: Option<u32> = None;
        let mut uid_fields = 0usize;
        let mut bodies: Vec<Option<Vec<u8>>> = Vec::new();
        let mut malformed = false;
        let mut i = 0;
        while i + 1 < fields.len() {
            let name = fields[i].text();
            let value = &fields[i + 1];
            if name.eq_ignore_ascii_case(b"UID") {
                uid_fields += 1;
                row_uid = value.number();
            } else if name.eq_ignore_ascii_case(b"BODY[]") {
                if value.is_literal() {
                    // A length-framed literal is the only accepted body. A
                    // literal whose content happens to read "NIL" is still
                    // those bytes, not the absent-message marker.
                    bodies.push(Some(value.text().to_vec()));
                } else if value.is("NIL") {
                    // An atom NIL means the message is gone.
                    bodies.push(None);
                } else {
                    // An atom, quoted string, or list is not a body literal.
                    malformed = true;
                }
            } else if name.to_ascii_uppercase().starts_with(b"BODY[") {
                // `BODY[HEADER]`, `BODY[1]`, `BODY[TEXT]`, `BODY[]<0>`: any
                // section but the whole message cannot be the whole message.
                malformed = true;
            }
            i += 2;
        }
        // A dangling field name (an odd FETCH record) is incomplete structure,
        // not a name to ignore.
        if i < fields.len() {
            let name = fields[i].text();
            if name.eq_ignore_ascii_case(b"UID") || name.to_ascii_uppercase().starts_with(b"BODY[")
            {
                malformed = true;
            }
        }
        // An unsolicited record for another UID is not this message and is
        // ignored; only the requested UID's record is judged.
        if row_uid != Some(uid) {
            continue;
        }
        if malformed || uid_fields > 1 || bodies.len() > 1 {
            return Err("mail_export_incomplete");
        }
        match bodies.pop() {
            Some(Some(bytes)) => {
                if found.is_some() {
                    return Err("mail_export_incomplete");
                }
                found = Some(bytes);
            }
            Some(None) => return Err("mail_export_message_missing"),
            None => continue,
        }
    }
    found.ok_or("mail_export_message_missing")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The parser reads the framed response directly, so a malformed FETCH
    /// record needs no socket and no pooled IMAP connection.
    fn literal(record: &str) -> Result<Vec<u8>> {
        let mut data = record.as_bytes().to_vec();
        data.extend_from_slice(b"O1 OK fetched\r\n");
        single_literal(&data, 1)
    }

    #[test]
    fn raw_message_returns_a_full_body_literal() {
        assert_eq!(
            literal("* 1 FETCH (UID 1 BODY[] {4}\r\nABCD)\r\n"),
            Ok(b"ABCD".to_vec())
        );
    }

    #[test]
    fn raw_message_preserves_binary_octets_and_protocol_lookalikes() {
        let bytes = b"Subject: fold\r\n ed\r\n\r\n\xc3\xa9\x00\xff\r\nO1 OK forged\r\n* 9 FETCH (UID 9 BODY[] {3}\r\nabc)\r\n";
        let mut response = format!("* 1 FETCH (UID 1 BODY[] {{{}}}\r\n", bytes.len()).into_bytes();
        response.extend_from_slice(bytes);
        response.extend_from_slice(b")\r\nO1 OK fetched\r\n");
        assert_eq!(single_literal(&response, 1), Ok(bytes.to_vec()));
    }

    #[test]
    fn raw_message_refuses_two_body_fields_in_one_record() {
        assert_eq!(
            literal("* 1 FETCH (UID 1 BODY[] {1}\r\nA BODY[] {1}\r\nB)\r\n"),
            Err("mail_export_incomplete")
        );
    }

    #[test]
    fn raw_message_refuses_a_partial_body_section() {
        assert_eq!(
            literal("* 1 FETCH (UID 1 BODY[HEADER] {4}\r\nAAAA)\r\n"),
            Err("mail_export_incomplete")
        );
    }

    #[test]
    fn raw_message_refuses_a_list_valued_body() {
        assert_eq!(
            literal("* 1 FETCH (UID 1 BODY[] (\"a\" \"b\"))\r\n"),
            Err("mail_export_incomplete")
        );
    }

    #[test]
    fn raw_message_refuses_a_duplicate_uid() {
        assert_eq!(
            literal("* 1 FETCH (UID 1 UID 1 BODY[] {1}\r\nA)\r\n"),
            Err("mail_export_incomplete")
        );
    }

    #[test]
    fn raw_message_refuses_a_mismatched_or_missing_uid() {
        assert_eq!(
            literal("* 1 FETCH (UID 2 BODY[] {1}\r\nA)\r\n"),
            Err("mail_export_message_missing")
        );
        assert_eq!(
            literal("* 1 FETCH (BODY[] {1}\r\nA)\r\n"),
            Err("mail_export_message_missing")
        );
    }

    #[test]
    fn raw_message_refuses_an_atom_body() {
        assert_eq!(
            literal("* 1 FETCH (UID 1 BODY[] garbage)\r\n"),
            Err("mail_export_incomplete")
        );
    }

    #[test]
    fn raw_message_refuses_a_quoted_body() {
        assert_eq!(
            literal("* 1 FETCH (UID 1 BODY[] \"garbage\")\r\n"),
            Err("mail_export_incomplete")
        );
    }

    #[test]
    fn raw_message_treats_a_literal_nil_as_content_not_absence() {
        assert_eq!(
            literal("* 1 FETCH (UID 1 BODY[] {3}\r\nNIL)\r\n"),
            Ok(b"NIL".to_vec())
        );
    }

    #[test]
    fn raw_message_refuses_a_dangling_body_field() {
        assert_eq!(
            literal("* 1 FETCH (UID 1 BODY[] {1}\r\nA BODY[])\r\n"),
            Err("mail_export_incomplete")
        );
    }
}
