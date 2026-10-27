//! On-premises Exchange over Exchange Web Services (EWS): the `exchange.*` methods over `ews`.
//!
//! Rules a change must not break:
//!
//! - A request names an account; settings and password are read for it (`account`) and a missing
//!   credential is `auth_signed_out` before any socket opens. Only `exchange.verify` takes a
//!   password in its body and nothing stores it.
//! - Every method answers within `account::TOTAL` (25 seconds, the wait for the account's turn
//!   included), inside the window's 30. Reads run on a task that outlives their caller until that
//!   deadline; mutations, sends and meetings take no token and are never cancelled, and a write is never cut
//!   once written; a send is never repeated and its failure codes say what is known of it
//!   (`ews::Client::send`).
//! - Errors are static codes. Only `exchange_unauthorized` (the login was refused) latches an
//!   account; `exchange_access_denied` (login taken, request refused) says nothing of the password.

mod account;
mod calendar;
mod check;
mod detail;
mod ews;
mod folders;
mod guests;
mod ids;
mod meeting;
mod query;
mod read;
mod recurrence;
mod resource;
mod verify;
mod write;
mod zone;

use serde_json::{Map, Value, json};

pub(crate) use check::check;

#[cfg(test)]
mod tests;

pub fn validate_message_id(id: &str) -> Result<(), &'static str> {
    ids::validate(id)
}

/// `exchange.send` for the outbox, which waits up to 25 seconds for a turn on the account where a
/// send asked for directly waits five: either way the message is written only while its 20-second
/// request still ends inside the caller's own deadline.
pub async fn send_queued(params: &Value) -> Result<Value, &'static str> {
    Box::pin(write::send_queued(params)).await
}

const INVALID: &str = "invalid_params";

/// Dispatches every `exchange.*` method. Handlers are boxed: their futures are large and the
/// backend's workers have small stacks.
pub async fn call(method: &str, params: &Value) -> Result<Value, &'static str> {
    match method {
        "exchange.verify" => Box::pin(verify::verify(params)).await,
        "exchange.list" => Box::pin(read::list(params)).await,
        "exchange.messages" => Box::pin(read::messages(params)).await,
        "exchange.read" => Box::pin(read::read(params)).await,
        "exchange.attachment" => Box::pin(read::attachment(params)).await,
        "exchange.modify" | "exchange.trash" | "exchange.untrash" => {
            Box::pin(write::modify(method, params)).await
        }
        "exchange.send" => Box::pin(write::send(params)).await,
        "exchange.saveDraft" => Box::pin(write::save_draft(params)).await,
        "exchange.deleteDraft" => Box::pin(write::delete_draft(params)).await,
        "exchange.calendars" => Box::pin(folders::calendars(params)).await,
        "exchange.calendarShared" => Box::pin(folders::shared(params)).await,
        "exchange.calendarEvents" => Box::pin(calendar::events(params)).await,
        "exchange.calendarEvent" => Box::pin(detail::detail(params)).await,
        "exchange.calendarCreate" => Box::pin(calendar::create(params)).await,
        "exchange.calendarUpdate" => Box::pin(calendar::update(params)).await,
        "exchange.calendarDelete" => Box::pin(calendar::delete(params)).await,
        "exchange.calendarRespond" => Box::pin(detail::respond(params)).await,
        "exchange.meetingCreate" => Box::pin(meeting::create(params)).await,
        "exchange.meetingUpdate" => Box::pin(meeting::update(params)).await,
        "exchange.meetingCancel" => Box::pin(meeting::cancel(params)).await,
        "exchange.meetingRemove" => Box::pin(meeting::remove(params)).await,
        "exchange.sendAs" => {
            let account = account(fields(params, &["accountId"])?)?;
            let address = ids::account(&account)?;
            Ok(json!([{"email": address, "displayName": "", "isPrimary": true, "isDefault": true}]))
        }
        "exchange.invalidate" => {
            account::invalidate(&account(fields(params, &["accountId"])?)?);
            Ok(json!({"invalidated": true}))
        }
        "exchange.cancel" => {
            let map = fields(params, &["accountId", "requestToken"])?;
            let token = token(map)?.ok_or(INVALID)?;
            Ok(json!({"cancelled": account::cancel(&account(map)?, &token)}))
        }
        _ => Err("method_not_found"),
    }
}

// Request fields: exactly the keys a method defines (an unknown key is a refusal, not an ignored
// typo), each typed and bounded before any account is resolved or socket opened.

fn fields<'a>(params: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, &'static str> {
    let map = params.as_object().ok_or(INVALID)?;
    if map.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(INVALID);
    }
    Ok(map)
}

fn text<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, &'static str> {
    map.get(key).and_then(Value::as_str).ok_or(INVALID)
}

fn account(map: &Map<String, Value>) -> Result<String, &'static str> {
    let id = text(map, "accountId")?;
    ids::account(id)?;
    Ok(id.to_owned())
}

/// `requestToken`: absent, or 1 to 128 bytes without control characters.
fn token(map: &Map<String, Value>) -> Result<Option<String>, &'static str> {
    match map.get("requestToken") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(token))
            if !token.is_empty() && token.len() <= 128 && !token.chars().any(char::is_control) =>
        {
            Ok(Some(token.clone()))
        }
        Some(_) => Err(INVALID),
    }
}

/// 1 to `max` Omamail message ids, each kept once at its first place.
fn message_ids(
    map: &Map<String, Value>,
    key: &str,
    max: usize,
) -> Result<Vec<String>, &'static str> {
    let list = map.get(key).and_then(Value::as_array).ok_or(INVALID)?;
    if list.is_empty() || list.len() > max {
        return Err(INVALID);
    }
    let mut out: Vec<String> = Vec::new();
    for value in list {
        let id = value.as_str().ok_or(INVALID)?;
        ids::validate(id)?;
        if !out.iter().any(|seen| seen == id) {
            out.push(id.to_owned());
        }
    }
    Ok(out)
}
