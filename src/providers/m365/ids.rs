//! Identifiers and the small validators of what the desktop sends.
//!
//! A Graph message id (asked for as an immutable id, so a move keeps it) is an opaque,
//! case-sensitive string of up to about 150 URL-safe base64 characters. The body cache names a
//! file `<id>.json` and spells every byte outside `[a-z0-9.-]` as `_xx`, refusing names over 255
//! bytes, so the Omamail id is the lower-case base32 of the Graph id's ASCII bytes without
//! padding: one cache byte per character, 250 for the longest id, and exactly one spelling.

const MIN_GRAPH_ID: usize = 8;
const MAX_GRAPH_ID: usize = 156;
const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
const INVALID: &str = "invalid_params";

pub(super) fn encode(graph_id: &str) -> Result<String, &'static str> {
    let bytes = graph_id.as_bytes();
    // Anything outside URL-safe base64 could change meaning inside a URL path segment.
    if !(MIN_GRAPH_ID..=MAX_GRAPH_ID).contains(&bytes.len())
        || !bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'='))
    {
        return Err("m365_bad_response");
    }
    let (mut out, mut acc, mut bits) = (String::new(), 0u32, 0u32);
    for &byte in bytes {
        acc = acc << 8 | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(ALPHABET[(acc >> bits & 31) as usize]));
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(char::from(ALPHABET[(acc << (5 - bits) & 31) as usize]));
    }
    Ok(out)
}

/// The Graph id of an Omamail id. Re-encoding the result accepts one spelling only: no upper case,
/// padding, stray bits or length the codec would not have made.
pub(super) fn decode(id: &str) -> Result<String, &'static str> {
    let (mut bytes, mut acc, mut bits) = (Vec::new(), 0u32, 0u32);
    for c in id.bytes().take(250) {
        let value = ALPHABET.iter().position(|&a| a == c).ok_or(INVALID)? as u32;
        acc = acc << 5 | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    let graph = String::from_utf8(bytes).map_err(|_| INVALID)?;
    (encode(&graph).as_deref() == Ok(id))
        .then_some(graph)
        .ok_or(INVALID)
}

pub(super) fn validate_message_id(id: &str) -> Result<(), &'static str> {
    decode(id).map(|_| ())
}

/// `m365:` and a lower-case mailbox address, as the account registry spells one.
pub(super) fn account_id(id: &str) -> Result<&str, &'static str> {
    let address = id.strip_prefix("m365:").ok_or(INVALID)?;
    (id == id.to_lowercase() && id.len() <= 320 && crate::account::valid_email(address))
        .then_some(id)
        .ok_or(INVALID)
}

/// An application (client) id: a GUID, which is all the login endpoints take, in the one spelling
/// the keyring and the refresh lane know it by.
pub(super) fn client_id(text: &str) -> Result<String, &'static str> {
    crate::auth::m365::client_id(text).ok_or(INVALID)
}
