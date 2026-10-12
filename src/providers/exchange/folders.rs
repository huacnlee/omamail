//! `exchange.calendars` and `exchange.calendarShared`: the calendars a mailbox can reach, and one other
//! mailbox's calendar opened by its address; and the reference by which every other calendar call
//! names the calendar it is for (`ews::client::folders` makes the requests and decides what is
//! believed of the answers). Rules a change must not break:
//!
//! - **A calendar is named by an opaque reference, and none means the default one.**
//!   `exchange.calendarEvents`, `calendarEvent`, `calendarCreate`, `calendarUpdate`, `calendarDelete`,
//!   `calendarRespond` and the meeting calls take an optional `calendar`: `<folder>` for a folder of
//!   the signed-in mailbox, `<folder>:<address>` for a folder of another, where `<folder>` is the id the
//!   server gave spelled as a message id is (`ids`) and `<address>` the other mailbox's primary address
//!   in lower case (`ids::mailbox`), never the mailbox's own. Nothing else parses (not an empty string,
//!   not upper case, not a second member), so one calendar has one spelling, and a request that names
//!   none is what it was before there was a choice.
//! - **Nothing is trusted that the server did not just say.** What a person may do in a calendar
//!   (`rights`, `readOnly`, `canCreate`) is the server's own `EffectiveRights` as this call found them,
//!   and every call that writes asks again, of the item it writes. Discovery finds the mailbox's own
//!   calendar folders; another mailbox's calendar is added by its address and listed only after the
//!   server opened it, called it a calendar and said the signed-in user may read it.
//! - **An incomplete answer says so**: `steps.folders.code` when the folder search failed and
//!   `truncated` when calendars were left out, so the window keeps what an earlier discovery found
//!   instead of taking a partial list for the whole.
//! - **Meetings with other people, answers to invitations and the removal of cancelled meetings are the
//!   default calendar's alone** (`default_only`): a call that names any other is
//!   `exchange_calendar_locked` once the rest of the request is judged and before the account is looked
//!   up. In another mailbox, Microsoft says a user granted folder permissions and not delegate access
//!   "might be able to create items in the folders, but they cannot send the items", and sending on the
//!   owner's behalf is a permission this client does not use; in any calendar but the default one, the
//!   cancellations and invitations these calls are judged on are looked for in an Inbox that says
//!   nothing of that calendar's meetings.
//! - **The answer is bounded and plain**: at most `MAX_CALENDARS` calendars, a name cleaned of control
//!   and invisible characters and cut, an address of `ids::mailbox`'s shape, and no server text, id or
//!   URL beyond the reference itself. A source id is the account's for the default calendar, as it
//!   always was, and a digest of the account and the reference for any other, so it is short and the
//!   same from one discovery to the next.
//! - Both methods are reads: one account turn, an optional `requestToken` that `exchange.cancel` ends.
//!   `exchange.calendarShared` judges the address before anything is looked up and refuses the
//!   mailbox's own, whose calendars are found, not added; an address that the server answers with the
//!   owner's own default calendar (an alias) is `exchange_calendar_own_mailbox`.

use futures_util::FutureExt;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::ews::{Calendar, Discovered, Found, Origin, Rights};
use super::{INVALID, account, fields, ids, text, token};

const LOCKED: &str = "exchange_calendar_locked";
/// The longest reference: a folder id's spelling, a colon and the longest address.
const MAX_REFERENCE_BYTES: usize = 240 + 1 + 254;

/// The calendar a reference names; `invalid_params` for anything that is not one, and for one that
/// names the signed-in mailbox `owner` as another.
pub fn parse(reference: &str, owner: &str) -> Result<Calendar, &'static str> {
    if reference.len() > MAX_REFERENCE_BYTES {
        return Err(INVALID);
    }
    let (folder, mailbox) = match reference.split_once(':') {
        Some((folder, mailbox)) => (folder, Some(ids::mailbox(mailbox)?)),
        None => (reference, None),
    };
    if mailbox.is_some_and(|address| address.eq_ignore_ascii_case(owner)) {
        return Err(INVALID);
    }
    Ok(Calendar::Folder {
        id: ids::decode(folder)?,
        mailbox: mailbox.map(str::to_owned),
    })
}

/// The reference of a folder: its id spelled as a message id, and the address of the mailbox it is in
/// when that is not the signed-in one.
fn reference(id: &str, mailbox: Option<&str>) -> Option<String> {
    let folder = ids::encode(id).ok()?;
    Some(match mailbox {
        Some(address) => format!("{folder}:{address}"),
        None => folder,
    })
}

/// The `calendar` member of a request of the mailbox `account`: absent (or null) is the default one.
pub fn calendar(map: &Map<String, Value>, account: &str) -> Result<Calendar, &'static str> {
    match map.get("calendar") {
        None | Some(Value::Null) => Ok(Calendar::Default),
        Some(Value::String(text)) => parse(text, ids::account(account)?),
        Some(_) => Err(INVALID),
    }
}

/// For a call only the default calendar takes part in: the member is judged (a malformed one is
/// `invalid_params`) and any calendar but the default is `exchange_calendar_locked`.
pub fn default_only(map: &Map<String, Value>, account: &str) -> Result<(), &'static str> {
    match calendar(map, account)? {
        Calendar::Default => Ok(()),
        Calendar::Folder { .. } => Err(LOCKED),
    }
}

/// The id a list of calendar sources keeps a calendar by: the account's own for the default one, a
/// digest of the account and the reference for any other.
fn source_id(account: &str, reference: Option<&str>) -> String {
    let Some(reference) = reference else {
        return format!("exchange:{account}");
    };
    let mut digest = Sha256::new();
    digest.update(b"exchange\0");
    digest.update(account.as_bytes());
    digest.update([0]);
    digest.update(reference.as_bytes());
    format!("exchange:{account}:{:x}", digest.finalize())
}

/// One calendar as the answers list it; `None` for a folder no reference can be made of.
fn entry(account: &str, found: &Found) -> Option<Value> {
    let default = found.origin == Origin::Default;
    let reference = match default {
        true => None,
        false => Some(reference(&found.folder.id, found.mailbox.as_deref())?),
    };
    let rights = found.folder.rights.unwrap_or_default();
    let writable = rights.read && rights.create;
    let own = found.mailbox.is_none();
    Some(json!({
        "sourceId": source_id(account, reference.as_deref()),
        "calendarId": reference.unwrap_or_default(),
        "name": found.folder.name,
        "isDefault": default,
        "own": own,
        "mailbox": found.mailbox.as_deref().unwrap_or_default(),
        "origin": found.origin.word(),
        "readOnly": !writable,
        "canCreate": writable,
        "accessRole": match (own, writable) {
            (true, true) => "owner",
            (false, true) => "writer",
            _ => "reader",
        },
        "rights": rights_json(rights),
    }))
}

fn rights_json(rights: Rights) -> Value {
    json!({"read": rights.read, "create": rights.create, "modify": rights.modify, "delete": rights.delete})
}

fn listing(account: &str, found: &Discovered) -> Value {
    let calendars: Vec<Value> = found
        .calendars
        .iter()
        .filter_map(|each| entry(account, each))
        .collect();
    let steps = &found.steps;
    json!({
        "provider": "exchange",
        "accountId": account,
        "calendars": calendars,
        "truncated": found.truncated,
        "steps": {"folders": {"found": steps.folders, "code": steps.folders_code}},
    })
}

pub async fn calendars(params: &Value) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "requestToken"])?;
    let account = account(map)?;
    let named = account.clone();
    super::account::read(&account, token(map)?, move |client| {
        async move {
            let found = client.discover_calendars().await?;
            Ok(listing(&named, &found))
        }
        .boxed()
    })
    .await
}

pub async fn shared(params: &Value) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "mailbox", "requestToken"])?;
    let account = account(map)?;
    let mailbox = text(map, "mailbox")?.to_ascii_lowercase();
    ids::mailbox(&mailbox)?;
    // The mailbox's own calendars are not shared with it: discovery lists them.
    if ids::account(&account)?.eq_ignore_ascii_case(&mailbox) {
        return Err(INVALID);
    }
    let named = account.clone();
    super::account::read(&account, token(map)?, move |client| {
        async move {
            let found = client.open_shared_calendar(&mailbox).await?;
            let calendar = entry(&named, &found).ok_or("exchange_invalid_response")?;
            Ok(json!({"provider": "exchange", "accountId": named, "calendar": calendar}))
        }
        .boxed()
    })
    .await
}

#[cfg(test)]
mod tests;
