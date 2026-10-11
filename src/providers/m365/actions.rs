//! Changing mail: `m365.modify`, `m365.trash`, `m365.untrash`, and what `mail.act` plans around them.
//!
//! Labels map as: remove/add `UNREAD` is mark read/unread, add/remove `STARRED` sets/clears the flag,
//! add `INBOX` moves to the Inbox and remove `INBOX` archives (a move to the `archive` folder); trash
//! moves to Deleted Items, untrash to the Inbox. Any other label is never ignored: every id lands in
//! `failedIds` with `invalid_params` and nothing is sent. A message gets its property update (one
//! `PATCH` for read state and flag together) before its move, and is moved only if the update worked.
//!
//! The answer `{succeededIds, failedIds, error}` names every requested id once, in request order.
//! `failedIds` means "not confirmed", never "not applied": an unknown outcome is not retried and the
//! next listing is the truth. Mutations are never cancelled, so a batch always answers for every id:
//! the call's deadline is checked before each request, and a request already begun is waited for
//! (every request ends by the deadline at the latest). A message whose first request could not begin
//! in time fails with `m365_timeout` and nothing sent. In a combined change (mark read and archive,
//! say) a message whose update ran but whose move could not begin in time fails with `m365_timeout`
//! too, its update applied: only a message whose whole change was made is reported as done.

use futures_util::StreamExt as _;
use serde_json::{Map, Value, json};
use tokio::time::Instant;

use super::cancel::{self, guarded};
use super::graph::Graph;
use super::model::Role;
use super::{ids, params, read};

const MAX_IDS: usize = 1000;
const INVALID: &str = "invalid_params";
const NO_FOLDER: &str = "m365_folder_unavailable";
const LATE: &str = "m365_timeout";
pub(super) const ARCHIVE_REFUSAL: &str = "No Archive folder was found in this mailbox";

/// What a request does to each message.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Plan {
    pub read: Option<bool>,
    pub flag: Option<bool>,
    pub to: Option<Role>,
}

/// The plan a label change asks for, and whether it names a label with no meaning here. An empty
/// change, or one asking for a state and its opposite, is `invalid_params`.
pub(super) fn plan(add: &[&str], remove: &[&str]) -> Result<(Plan, bool), &'static str> {
    fn set<T: PartialEq + Copy>(slot: &mut Option<T>, value: T) -> Result<(), &'static str> {
        match slot {
            Some(old) if *old != value => Err(INVALID),
            _ => {
                *slot = Some(value);
                Ok(())
            }
        }
    }
    if add.is_empty() && remove.is_empty() {
        return Err(INVALID);
    }
    let (mut plan, mut unsupported) = (Plan::default(), false);
    for label in add {
        match *label {
            "UNREAD" => set(&mut plan.read, false)?,
            "STARRED" => set(&mut plan.flag, true)?,
            "INBOX" => set(&mut plan.to, Role::Inbox)?,
            _ => unsupported = true,
        }
    }
    for label in remove {
        match *label {
            "UNREAD" => set(&mut plan.read, true)?,
            "STARRED" => set(&mut plan.flag, false)?,
            // Leaving the Inbox with no other place named is archiving.
            "INBOX" => set(&mut plan.to, Role::Archive)?,
            _ => unsupported = true,
        }
    }
    Ok((plan, unsupported))
}

pub(super) async fn run(method: &str, request: &Value) -> Result<Value, &'static str> {
    let (account, ids, plan, unsupported) = match method {
        "m365.modify" => {
            let map = params::object(
                request,
                &["accountId", "ids", "addLabelIds", "removeLabelIds"],
            )?;
            let (plan, unsupported) = plan(
                &params::labels(map, "addLabelIds")?,
                &params::labels(map, "removeLabelIds")?,
            )?;
            (
                params::account(map)?,
                params::message_ids(map, MAX_IDS)?,
                plan,
                unsupported,
            )
        }
        "m365.trash" | "m365.untrash" => {
            let map = params::object(request, &["accountId", "ids"])?;
            let to = if method == "m365.trash" {
                Role::Trash
            } else {
                Role::Inbox
            };
            let plan = Plan {
                to: Some(to),
                ..Plan::default()
            };
            (
                params::account(map)?,
                params::message_ids(map, MAX_IDS)?,
                plan,
                false,
            )
        }
        _ => return Err("method_not_found"),
    };
    if unsupported {
        return Ok(reply(&ids, &vec![Err(INVALID); ids.len()]));
    }
    // Not dropped at a deadline, which would lose what was done: every request ends by `end`, and
    // none is begun with less than a fifth of the call left.
    let limit = cancel::limit(cancel::DEADLINE);
    let end = Instant::now() + limit;
    let last_start = end - limit / 5;
    let graph = Graph::new(account).until(end);
    read::forget(account, Some(&ids));
    let graph = &graph;
    if let Some(role) = plan.to
        && !graph.roles(false).await?.contains_key(&role)
    {
        // The mailbox has nowhere to put them: nothing is sent, every id says so.
        return Ok(reply(&ids, &vec![Err(NO_FOLDER); ids.len()]));
    }
    let outcomes: Vec<_> = futures_util::stream::iter(ids.clone())
        .map(move |id| async move { change(graph, &id, plan, last_start).await })
        .buffered(4)
        .collect()
        .await;
    Ok(reply(&ids, &outcomes))
}

/// One message's update and move, each begun only before `last_start`.
async fn change(
    graph: &Graph,
    id: &str,
    plan: Plan,
    last_start: Instant,
) -> Result<(), &'static str> {
    let graph_id = ids::decode(id)?;
    let in_time = || {
        if Instant::now() < last_start {
            Ok(())
        } else {
            Err(LATE)
        }
    };
    if plan.read.is_some() || plan.flag.is_some() {
        in_time()?;
        graph.update(&graph_id, plan.read, plan.flag).await?;
    }
    if let Some(role) = plan.to {
        in_time()?;
        graph.move_to(&graph_id, role).await?;
    }
    Ok(())
}

fn reply(ids: &[String], outcomes: &[Result<(), &'static str>]) -> Value {
    let (mut succeeded, mut failed, mut error) = (Vec::new(), Vec::new(), None);
    for (id, outcome) in ids.iter().zip(outcomes) {
        match outcome {
            Ok(()) => succeeded.push(id),
            Err(code) => {
                failed.push(id);
                error.get_or_insert(*code);
            }
        }
    }
    json!({"succeededIds": succeeded, "failedIds": failed, "error": error})
}

/// What `mail.act` may plan: whether there is an Archive and a Trash to move to (never a Junk), and
/// `refusals` with an `archive` entry when the mailbox has no Archive folder. A plan changes nothing,
/// so its token is refreshed without saving a rotated refresh token.
pub(crate) async fn planned_action_availability(
    account: &str,
    refusals: Value,
) -> Result<crate::mail::action::ActionAvailability, &'static str> {
    let account = ids::account_id(account)?;
    let roles = guarded(account, None, async {
        Graph::read_only(account).roles(false).await
    })
    .await?;
    let has_archive = roles.contains_key(&Role::Archive);
    Ok(crate::mail::action::ActionAvailability {
        refusals: with_archive_refusal(refusals, has_archive),
        mailboxes: json!({"archive": has_archive, "trash": roles.contains_key(&Role::Trash), "spam": false}),
        mailbox_required: Value::Null,
        rows_context: Value::Null,
    })
}

/// `refusals` plus the `archive` sentence if the mailbox has no Archive folder; an existing one stays.
pub(super) fn with_archive_refusal(refusals: Value, has_archive: bool) -> Value {
    if has_archive {
        return refusals;
    }
    let mut map = match refusals {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        other => return other,
    };
    map.entry("archive")
        .or_insert_with(|| json!(ARCHIVE_REFUSAL));
    Value::Object(map)
}
