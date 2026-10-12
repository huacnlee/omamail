//! Changing mail: `exchange.modify`, `exchange.trash`, `exchange.untrash`, `exchange.send`,
//! `exchange.saveDraft` and `exchange.deleteDraft`.
//!
//! Labels map as: removing or adding `UNREAD` is mark read or unread, `STARRED` sets or clears the
//! flag, adding `INBOX` moves to the Inbox; trash moves to Trash and untrash to the Inbox. Any other
//! label (removing `INBOX` would be archiving) is never ignored: every id lands in `failedIds` with
//! `invalid_params` and nothing is sent. Updates run before moves, since a move changes the id.
//!
//! The answer `{succeededIds, failedIds, error}` names every requested id once, in request order;
//! `error` is the code of the first failed id in that order, whatever the others failed with (it
//! can be `exchange_message_not_found` while later ids timed out). A failure before anything
//! reached the server is a bare error; from then on `failedIds` means "not confirmed", never "not
//! applied", and the next listing is the truth. The work runs on a task of its own: a caller that
//! goes away cannot leave a batch half applied.
//!
//! Every method answers within `account::TOTAL`, its turn on the account included. A write starts
//! only while its whole request deadline ends by then and is never cut once written, so a change
//! waits for its turn only as long as a write could still start after it, and a batch stops between
//! requests. An id is reported done only when every step it needed was confirmed: one whose first
//! step ran but whose second could not start in time is in `failedIds` ("not confirmed") with those
//! never reached, each for `exchange_timeout` (which `error` names only if no earlier id failed).

use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Map, Value, json};

use super::ews::{Change, Client, MAX_IDS, Outcome, Role};
use super::{INVALID, account, fields, ids, message_ids, text};

const MAX_REQUEST: usize = 1000;
const NOT_FOUND: &str = "exchange_message_not_found";
const NOT_ATTEMPTED: &str = "exchange_send_not_attempted";
const TIMEOUT: &str = "exchange_timeout";
/// The outbox's send: 25 seconds for the account's turn, a stream and the signed-in folder lookup,
/// then the 20-second request that carries the message, inside the outbox's minute. A send asked
/// for directly has `account::TOTAL`, which leaves five seconds before the write.
const QUEUED_TOTAL: Duration = Duration::from_secs(45);

#[derive(Clone, Copy)]
enum Step {
    Read(bool),
    Flag(bool),
    Move(Role),
}

/// The steps a label change asks for, and whether it names a label with no meaning here. An empty
/// change, or one asking for a state and its opposite, is `invalid_params`.
fn plan(add: &[&str], remove: &[&str]) -> Result<(Vec<Step>, bool), &'static str> {
    let (mut read, mut flag, mut inbox, mut unsupported) = (None, None, false, false);
    let set = |slot: &mut Option<bool>, value| match slot.replace(value) {
        Some(old) if old != value => Err(INVALID),
        _ => Ok(()),
    };
    for label in add {
        match *label {
            "UNREAD" => set(&mut read, false)?,
            "STARRED" => set(&mut flag, true)?,
            "INBOX" => inbox = true,
            _ => unsupported = true,
        }
    }
    for label in remove {
        match *label {
            "UNREAD" => set(&mut read, true)?,
            "STARRED" => set(&mut flag, false)?,
            _ => unsupported = true,
        }
    }
    let mut steps: Vec<Step> = read
        .map(Step::Read)
        .into_iter()
        .chain(flag.map(Step::Flag))
        .collect();
    if inbox {
        steps.push(Step::Move(Role::Inbox));
    }
    if steps.is_empty() && !unsupported {
        return Err(INVALID);
    }
    Ok((steps, unsupported))
}

fn labels<'a>(
    map: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<Vec<&'a str>, &'static str> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(list)) if list.len() <= 32 => list
            .iter()
            .map(|label| {
                label
                    .as_str()
                    .filter(|l| !l.is_empty() && l.len() <= 64 && !l.chars().any(char::is_control))
                    .ok_or(INVALID)
            })
            .collect(),
        Some(_) => Err(INVALID),
    }
}

pub async fn modify(method: &str, params: &Value) -> Result<Value, &'static str> {
    let (map, steps, unsupported) = if method == "exchange.modify" {
        let map = fields(
            params,
            &["accountId", "ids", "addLabelIds", "removeLabelIds"],
        )?;
        let (steps, unsupported) = plan(
            &labels(map, "addLabelIds")?,
            &labels(map, "removeLabelIds")?,
        )?;
        (map, steps, unsupported)
    } else {
        let to = if method == "exchange.trash" {
            Role::Trash
        } else {
            Role::Inbox
        };
        (
            fields(params, &["accountId", "ids"])?,
            vec![Step::Move(to)],
            false,
        )
    };
    let (account, ids) = (account(map)?, message_ids(map, "ids", MAX_REQUEST)?);
    if unsupported {
        return Ok(reply(&ids, vec![Err(INVALID); ids.len()]));
    }
    let mut lease = turn(&account).await?;
    // Detached: the batch ends on its own whatever the caller does.
    tokio::spawn(async move {
        let client = lease.client();
        client.ready().await?;
        Ok(reply(&ids, apply(client, &ids, &steps).await))
    })
    .await
    .map_err(|_| "worker_failed")?
}

/// Every step for each chunk of ids, each on the ids that have not failed yet. A chunk that fails
/// as a whole for one reason stops the batch: the next chunk would meet the same thing. Messages
/// that are gone are not such a reason.
async fn apply(client: &mut Client, ids: &[String], steps: &[Step]) -> Vec<Outcome> {
    let mut outcomes: Vec<Outcome> = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(MAX_IDS) {
        let mut done: Vec<Outcome> = vec![Ok(()); chunk.len()];
        for step in steps {
            let todo: Vec<usize> = (0..chunk.len()).filter(|&at| done[at].is_ok()).collect();
            if todo.is_empty() {
                break;
            }
            let asked: Vec<String> = todo.iter().map(|&at| chunk[at].clone()).collect();
            let answers = match *step {
                // Out of time between requests: this and every later step is not applied.
                _ if !client.may_write() => Err(TIMEOUT),
                Step::Read(read) => client.mark(&asked, Change::Read(read)).await,
                Step::Flag(flagged) => client.mark(&asked, Change::Flag(flagged)).await,
                Step::Move(role) => client.move_to(&asked, role).await,
            };
            match answers {
                Ok(answers) if answers.len() == todo.len() => todo
                    .iter()
                    .zip(answers)
                    .for_each(|(&at, answer)| done[at] = answer),
                Ok(_) => todo
                    .iter()
                    .for_each(|&at| done[at] = Err("exchange_invalid_response")),
                Err(code) => todo.iter().for_each(|&at| done[at] = Err(code)),
            }
        }
        let whole = done.first().copied().filter(|first| {
            *first != Err(NOT_FOUND) && first.is_err() && done.iter().all(|d| d == first)
        });
        outcomes.extend(done);
        if let Some(failed) = whole {
            outcomes.resize(ids.len(), failed);
            break;
        }
    }
    outcomes
}

fn reply(ids: &[String], outcomes: Vec<Outcome>) -> Value {
    let (mut succeeded, mut failed, mut error) = (Vec::new(), Vec::new(), None);
    for (id, outcome) in ids.iter().zip(outcomes) {
        match outcome {
            Ok(()) => succeeded.push(id),
            Err(code) => {
                failed.push(id);
                error.get_or_insert(code);
            }
        }
    }
    json!({"succeededIds": succeeded, "failedIds": failed, "error": error})
}

/// `raw`: canonical unpadded base64url of at most 16 MiB, refused before any credential is read or
/// socket opened.
fn message(map: &Map<String, Value>) -> Result<Vec<u8>, &'static str> {
    let raw = text(map, "raw")?;
    if raw.len() > crate::message::MAX_MESSAGE.div_ceil(3) * 4 {
        return Err("exchange_message_too_large");
    }
    URL_SAFE_NO_PAD
        .decode(raw)
        .ok()
        .filter(|bytes| !bytes.is_empty() && URL_SAFE_NO_PAD.encode(bytes) == raw)
        .ok_or(INVALID)
}

/// `exchange.send`. A `Bcc` header goes out as written: Exchange takes the blind recipients from
/// it and keeps it out of the delivered copies.
pub async fn send(params: &Value) -> Result<Value, &'static str> {
    send_within(params, account::TOTAL).await
}

/// The outbox's `exchange.send`, which may wait longer for its turn.
pub async fn send_queued(params: &Value) -> Result<Value, &'static str> {
    send_within(params, QUEUED_TOTAL).await
}

/// A send that answers within `total` and writes the message only while its request can end by
/// then.
pub(super) async fn send_within(params: &Value, total: Duration) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "raw"])?;
    let account = account(map)?;
    let mime = message(map)?;
    let deadline = account::deadline(total);
    let last_start = deadline
        .checked_sub(super::ews::clock(super::ews::DEADLINE))
        .unwrap_or(deadline);
    // Everything before the request is written is "not attempted": the outbox may try again.
    let mut lease = tokio::time::timeout_at(last_start, account::lease(&account, deadline))
        .await
        .map_err(|_| NOT_ATTEMPTED)?
        .map_err(|_| NOT_ATTEMPTED)?;
    tokio::spawn(async move { lease.client().send(&mime).await })
        .await
        .map_err(|_| "worker_failed")??;
    Ok(json!({"sent": true, "warning": ""}))
}

/// The account's turn for a change, waited for only while a write could still start after it (its
/// whole request ending by the deadline); a change that never got it wrote nothing.
pub(super) async fn turn(account: &str) -> Result<account::Lease, &'static str> {
    let deadline = account::deadline(account::TOTAL);
    let last_start = deadline
        .checked_sub(super::ews::clock(super::ews::DEADLINE))
        .unwrap_or(deadline);
    tokio::time::timeout_at(last_start, account::lease(account, deadline))
        .await
        .unwrap_or(Err(TIMEOUT))
}

/// `exchange.saveDraft`: the message is filed in Drafts, then the draft it replaces (`draftId`,
/// empty for none) is deleted. The save is reported once the new draft exists: an old copy that
/// could not be removed is a warning, never a failed save.
pub async fn save_draft(params: &Value) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "raw", "draftId"])?;
    let account = account(map)?;
    let mime = message(map)?;
    let old = match map.get("draftId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if id.is_empty() => None,
        Some(Value::String(id)) => {
            ids::validate(id)?;
            Some(id.clone())
        }
        Some(_) => return Err(INVALID),
    };
    let mut lease = turn(&account).await?;
    tokio::spawn(async move {
        let client = lease.client();
        client.save_draft(&mime).await?;
        let warning = match old {
            Some(id) if client.delete_draft(&id).await.is_err() => {
                "The updated draft was saved, but the old copy could not be removed"
            }
            _ => "",
        };
        Ok(json!({"saved": true, "warning": warning}))
    })
    .await
    .map_err(|_| "worker_failed")?
}

/// `exchange.deleteDraft`: one message in Drafts, into the server's recoverable items.
pub async fn delete_draft(params: &Value) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "id"])?;
    let account = account(map)?;
    let id = text(map, "id")?.to_owned();
    ids::validate(&id)?;
    let mut lease = turn(&account).await?;
    tokio::spawn(async move { lease.client().delete_draft(&id).await })
        .await
        .map_err(|_| "worker_failed")??;
    Ok(json!({}))
}
