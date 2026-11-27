//! Request parameters: every field named, typed and bounded before the registry is read, a credential
//! is touched or a socket is opened. A request is an object with exactly the keys its method defines
//! (an unknown key is a refusal, not an ignored typo); every refusal is `invalid_params` and echoes
//! no input byte.

use serde_json::{Map, Value};

use super::ids;

const INVALID: &str = "invalid_params";

pub(super) type Fields<'a> = &'a Map<String, Value>;

/// The members of `params`, if it is an object with none outside `allowed`.
pub(super) fn object<'a>(params: &'a Value, allowed: &[&str]) -> Result<Fields<'a>, &'static str> {
    let map = params.as_object().ok_or(INVALID)?;
    if map.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(INVALID);
    }
    Ok(map)
}

pub(super) fn text<'a>(map: Fields<'a>, key: &str) -> Result<&'a str, &'static str> {
    map.get(key).and_then(Value::as_str).ok_or(INVALID)
}

/// An optional string member; absent and null are `None`.
pub(super) fn optional<'a>(map: Fields<'a>, key: &str) -> Result<Option<&'a str>, &'static str> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(INVALID),
    }
}

pub(super) fn account<'a>(map: Fields<'a>) -> Result<&'a str, &'static str> {
    ids::account_id(text(map, "accountId")?)
}

/// `requestToken`: absent, or 1 to 128 bytes without control characters.
pub(super) fn request_token<'a>(map: Fields<'a>) -> Result<Option<&'a str>, &'static str> {
    optional(map, "requestToken")?
        .map(|token| {
            (!token.is_empty() && token.len() <= 128 && !token.chars().any(char::is_control))
                .then_some(token)
                .ok_or(INVALID)
        })
        .transpose()
}

pub(super) fn message_id<'a>(map: Fields<'a>, key: &str) -> Result<&'a str, &'static str> {
    let id = text(map, key)?;
    ids::validate_message_id(id)?;
    Ok(id)
}

/// 1 to `max` message ids; a repeated id is kept once, at its first place.
pub(super) fn message_ids(map: Fields, max: usize) -> Result<Vec<String>, &'static str> {
    let list = map.get("ids").and_then(Value::as_array).ok_or(INVALID)?;
    if list.is_empty() || list.len() > max {
        return Err(INVALID);
    }
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    for value in list {
        let id = value.as_str().ok_or(INVALID)?;
        ids::validate_message_id(id)?;
        if !out.iter().any(|seen| seen == id) {
            out.push(id.to_owned());
        }
    }
    Ok(out)
}

/// An optional list of label names (at most 32, each 1 to 64 bytes without control characters);
/// what a name means is the action's business.
pub(super) fn labels<'a>(map: Fields<'a>, key: &str) -> Result<Vec<&'a str>, &'static str> {
    let list = match map.get(key) {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(list)) if list.len() <= 32 => list,
        Some(_) => return Err(INVALID),
    };
    list.iter()
        .map(|value| {
            value
                .as_str()
                .filter(|name| {
                    !name.is_empty() && name.len() <= 64 && !name.chars().any(char::is_control)
                })
                .ok_or(INVALID)
        })
        .collect()
}

/// An integer member in `low..=high`; a float or a string is refused even if it looks whole.
pub(super) fn bounded(map: Fields, key: &str, low: u64, high: u64) -> Result<usize, &'static str> {
    map.get(key)
        .and_then(Value::as_u64)
        .filter(|n| (low..=high).contains(n))
        .map(|n| n as usize)
        .ok_or(INVALID)
}

pub(super) fn flag(map: Fields, key: &str) -> Result<bool, &'static str> {
    map.get(key).and_then(Value::as_bool).ok_or(INVALID)
}

/// An attachment id as `message::parse` writes one: `part:` and dot-separated part numbers (none
/// for a message that is itself the attachment).
pub(super) fn attachment_id<'a>(map: Fields<'a>, key: &str) -> Result<&'a str, &'static str> {
    let id = text(map, key)?;
    let numbers = id.strip_prefix("part:").ok_or(INVALID)?;
    let sound = id.len() <= 64
        && (numbers.is_empty()
            || numbers
                .split('.')
                .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())));
    sound.then_some(id).ok_or(INVALID)
}
