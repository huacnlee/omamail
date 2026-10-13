//! Message ids. An EWS `ItemId/@Id` is base64 of about 150 binary bytes, and the body cache names a
//! file after the id with every byte outside `[a-z0-9.-]` spelled `_xx` under a 255-byte limit. So
//! the Omamail id is the lowercase RFC 4648 base32 of those bytes without padding: one cache byte
//! per character, 240 at most (245 with `.json`), reversible, and one spelling per message.

use base64::{Engine, engine::general_purpose::STANDARD};

const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
const INVALID: &str = "invalid_params";
const BYTES: std::ops::RangeInclusive<usize> = 8..=150;

fn base32(bytes: &[u8]) -> String {
    let (mut out, mut acc, mut bits) = (String::new(), 0u32, 0);
    for byte in bytes {
        acc = acc << 8 | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(ALPHABET[(acc >> bits & 31) as usize]));
        }
    }
    if bits > 0 {
        out.push(char::from(ALPHABET[(acc << (5 - bits) & 31) as usize]));
    }
    out
}

/// The bytes of an Omamail id; only the canonical spelling of 8 to 150 bytes.
fn unbase32(id: &str) -> Result<Vec<u8>, &'static str> {
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0);
    for c in id.bytes() {
        let value = ALPHABET.iter().position(|a| *a == c).ok_or(INVALID)? as u32;
        acc = acc << 5 | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    (BYTES.contains(&out.len()) && base32(&out) == id)
        .then_some(out)
        .ok_or(INVALID)
}

/// The Omamail id of an EWS id; one the codec would refuse is the server's fault.
pub fn encode(ews_id: &str) -> Result<String, &'static str> {
    match STANDARD.decode(ews_id) {
        Ok(bytes) if BYTES.contains(&bytes.len()) => Ok(base32(&bytes)),
        _ => Err("exchange_invalid_response"),
    }
}

pub fn decode(id: &str) -> Result<String, &'static str> {
    unbase32(id).map(|bytes| STANDARD.encode(bytes))
}

pub fn validate(id: &str) -> Result<(), &'static str> {
    unbase32(id).map(|_| ())
}

/// `exchange:<address>`, the shape every provider's id has, before any lookup is made.
pub fn account(id: &str) -> Result<&str, &'static str> {
    id.strip_prefix("exchange:")
        .filter(|address| {
            id.len() <= 1024
                && address.contains('@')
                && !address.chars().any(|c| c.is_control() || c.is_whitespace())
        })
        .ok_or(INVALID)
}
