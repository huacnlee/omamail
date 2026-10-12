//! `exchange.meetingCreate`, `exchange.meetingUpdate`, `exchange.meetingCancel` and
//! `exchange.meetingRemove`: meetings with other people (`ews::client::meeting` decides what may be
//! done and what a failure proves; this is the fields and the turn).
//!
//! Rules a change must not break:
//!
//! - **The three that tell other people refuse unless the caller says, in so many words, that it
//!   knows they will.** `sendInvitations`, `sendUpdates` and `sendCancellations` are required and must
//!   be the boolean `true`: absent, `false`, `"true"` or `1` is `invalid_params`, judged right after
//!   the request's own keys and before the account is resolved, the keyring read or a socket opened.
//!   No default decides whether somebody is mailed. The one change that tells nobody is of the owner's
//!   own reminder alone, which `meetingUpdate` writes with `SendToNone` and answers `sent: false`.
//! - **The people are a list of addresses to be mailed** (`guests::check`), checked here, with the
//!   mailbox's own address refused, and again by every builder for their shape and count (a builder
//!   does not know the mailbox): a meeting needs at least one, and an update names a list only to
//!   change it, whole.
//! - **Only a meeting the owner organises is changed or cancelled**, decided by the client on a fresh
//!   read (`EventDetail::organised`): `exchange_calendar_locked` otherwise, and a `changeKey` that is
//!   not the item's is `exchange_calendar_conflict`, nothing sent and nothing retried. Meetings are the
//!   default calendar's alone: a request that names another calendar (`calendar`) is
//!   `exchange_calendar_locked` once the rest of it is judged and before the account is looked up
//!   (`folders::default_only`), and an item found anywhere else is locked.
//! - **`exchange.meetingRemove` mails nobody**, so it asks for nothing: it takes a meeting somebody
//!   else organised and cancelled, or the owner declined, off the calendar, and refuses anything else
//!   with `exchange_calendar_not_removable`.
//! - **A write is never cancelled, detached or repeated**, as an appointment's (`calendar`): no
//!   `requestToken`, a turn only while the request can still end inside the call, and an outcome that
//!   cannot be known is `exchange_calendar_unconfirmed`: the people may have been told.
//! - **A meeting that repeats is made, changed and cancelled as a repeating appointment is**
//!   (`calendar`): `recurrence` on a create (the invitations are for every event), and `scope` on a
//!   change (with the time of day of every event as `startClock` and `durationMinutes`) and on a
//!   cancellation; each still refused without its word that people are mailed, and a change of one
//!   event names no people (they are the series'). A change or cancellation of all of it also names
//!   the people its question named (`seriesAttendees`, required with `scope` `series` and refused
//!   otherwise), which the client holds against the master's people on its fresh read: the server
//!   mails the master's, which one event's own list need not be; and while any exception of the series
//!   has people of its own, all of it is locked (`EventDetail::exceptions_agree`), because what the
//!   master would mail them is not documented. `exchange.meetingRemove` with `scope`
//!   `series` takes a whole series its organizer cancelled off the calendar in one call (`{removed,
//!   because, count, more, seriesLeft}`: at most 50 cancellations, `more` when some are left,
//!   `seriesLeft` when its master is still there), decided on its master before any write and refused
//!   unless it is cancelled (`EventDetail::series_removal`); one event of a series is removed with
//!   `scope` `occurrence`, and named with none it is locked.
//! - The fields of an event are an appointment's (`calendar::appointment`, `calendar::edit`): notes
//!   are written when a meeting is made and never after. A cancellation may carry a note of at most
//!   2000 bytes, the organizer's own words in the message the people get.

use serde_json::{Map, Value, json};

use super::calendar::{appointment, edit, reply, scope, target, zone_of, zone_of_change};
use super::ews::{
    CalendarChange, MeetingEdit, Scope, When, cancel_meeting, create_meeting, update_meeting,
};
use super::guests::{self, Guests, MAX_GUESTS};
use super::{INVALID, account, fields, folders, ids, write::turn, zone};

/// The appointment's members that a meeting's create and update share with it.
const CREATE: [&str; 11] = [
    "accountId",
    "calendar",
    "title",
    "location",
    "notes",
    "reminderMinutes",
    "allDay",
    "startMs",
    "endMs",
    "startDate",
    "endDate",
];
const UPDATE: [&str; 16] = [
    "accountId",
    "calendar",
    "id",
    "changeKey",
    "title",
    "location",
    "reminderMinutes",
    "allDay",
    "startMs",
    "endMs",
    "startDate",
    "endDate",
    "scope",
    "startClock",
    "durationMinutes",
    "seriesAttendees",
];

/// A member that must be the boolean `true`: the caller's word that it knows who will be mailed.
fn confirmed(map: &Map<String, Value>, key: &str) -> Result<(), &'static str> {
    match map.get(key) {
        Some(Value::Bool(true)) => Ok(()),
        _ => Err(INVALID),
    }
}

/// An optional list of addresses: absent, or an array of at most `MAX_GUESTS` strings.
fn people(map: &Map<String, Value>, key: &str) -> Result<Option<Vec<String>>, &'static str> {
    match map.get(key) {
        None => Ok(None),
        Some(Value::Array(list)) if list.len() <= MAX_GUESTS => list
            .iter()
            .map(|value| value.as_str().map(str::to_owned).ok_or(INVALID))
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err(INVALID),
    }
}

/// The people a write to all of a series is to tell, as the question named them (`seriesAttendees`):
/// required with `scope` `series` and refused without it. The client compares them with the master's
/// people on its fresh read, so nobody the question did not name is mailed.
fn told(
    map: &Map<String, Value>,
    scope: Option<Scope>,
    owner: &str,
) -> Result<Option<Vec<String>>, &'static str> {
    let told = people(map, "seriesAttendees")?;
    match (&told, scope) {
        (Some(list), Some(Scope::Series)) if !list.is_empty() => guests::check(list, &[], owner)?,
        (None, scope) if scope != Some(Scope::Series) => {}
        _ => return Err(INVALID),
    }
    Ok(told)
}

/// The request's members, its word that people will be mailed, and the mailbox and its address.
fn judged<'a>(
    params: &'a Value,
    allowed: &[&str],
    word: &str,
) -> Result<(&'a Map<String, Value>, String, String), &'static str> {
    let map = fields(params, allowed)?;
    confirmed(map, word)?;
    let account = account(map)?;
    let owner = ids::account(&account)?.to_owned();
    Ok((map, account, owner))
}

pub async fn create(params: &Value) -> Result<Value, &'static str> {
    let allowed = [
        &CREATE[..],
        &[
            "requiredAttendees",
            "optionalAttendees",
            "sendInvitations",
            "recurrence",
        ],
    ]
    .concat();
    let (map, account, owner) = judged(params, &allowed, "sendInvitations")?;
    let guests = Guests {
        required: people(map, "requiredAttendees")?.unwrap_or_default(),
        optional: people(map, "optionalAttendees")?.unwrap_or_default(),
    };
    guests::check(&guests.required, &guests.optional, &owner)?;
    let item = appointment(map)?;
    create_meeting(&item, &guests, zone::UTC)?;
    let zone = zone_of(&item)?;
    folders::default_only(map, &account)?;
    let mut lease = turn(&account).await?;
    let client = lease.client();
    let written = client.create_meeting(&item, &guests, zone).await?;
    let mut done = reply(&written);
    done["invited"] = json!(guests.len());
    Ok(done)
}

pub async fn update(params: &Value) -> Result<Value, &'static str> {
    let allowed = [
        &UPDATE[..],
        &["requiredAttendees", "optionalAttendees", "sendUpdates"],
    ]
    .concat();
    let (map, account, owner) = judged(params, &allowed, "sendUpdates")?;
    let (id, key) = target(map)?;
    let (edit, scope) = edit(map)?;
    let told = told(map, scope, &owner)?;
    let wanted = MeetingEdit {
        edit,
        required: people(map, "requiredAttendees")?,
        optional: people(map, "optionalAttendees")?,
    };
    let (required, optional) = (wanted.required.as_deref(), wanted.optional.as_deref());
    // The people of a series are the series': one event of it names none.
    if scope == Some(Scope::Occurrence) && (required.is_some() || optional.is_some()) {
        return Err(INVALID);
    }
    guests::check(
        required.unwrap_or_default(),
        optional.unwrap_or_default(),
        &owner,
    )?;
    // Only what is named is judged and sent.
    let whole = CalendarChange {
        title: wanted.edit.title.as_deref(),
        location: wanted.edit.location.as_deref(),
        reminder: wanted.edit.reminder,
        when: wanted.edit.when.map(When::judged),
        required,
        optional,
    };
    if whole != CalendarChange::default() {
        update_meeting("A", &key, &whole, zone::UTC)?;
    }
    let zone = zone_of_change(&wanted.edit)?;
    folders::default_only(map, &account)?;
    let mut lease = turn(&account).await?;
    let client = lease.client();
    let changed = client
        .change_meeting(&id, &key, &wanted, &owner, zone, scope, told.as_deref())
        .await?;
    let mut done = reply(&changed.written);
    done["sent"] = json!(changed.sent);
    Ok(done)
}

pub async fn cancel(params: &Value) -> Result<Value, &'static str> {
    let allowed = [
        "accountId",
        "id",
        "changeKey",
        "message",
        "sendCancellations",
        "scope",
        "seriesAttendees",
        "calendar",
    ];
    let (map, account, owner) = judged(params, &allowed, "sendCancellations")?;
    let (id, key) = target(map)?;
    let scope = scope(map)?;
    let told = told(map, scope, &owner)?;
    let note = match map.get("message") {
        None => None,
        Some(Value::String(note)) if note.is_empty() => None,
        Some(Value::String(note)) => Some(note.clone()),
        Some(_) => return Err(INVALID),
    };
    cancel_meeting("A", &key, note.as_deref())?;
    folders::default_only(map, &account)?;
    let mut lease = turn(&account).await?;
    let client = lease.client();
    let told = client
        .cancel_meeting(&id, &key, note.as_deref(), &owner, scope, told.as_deref())
        .await?;
    Ok(json!({"cancelled": true, "told": told}))
}

pub async fn remove(params: &Value) -> Result<Value, &'static str> {
    let map = fields(
        params,
        &["accountId", "id", "changeKey", "scope", "calendar"],
    )?;
    let (id, key) = target(map)?;
    let scope = scope(map)?;
    let account = account(map)?;
    folders::default_only(map, &account)?;
    let mut lease = turn(&account).await?;
    let client = lease.client();
    if scope == Some(Scope::Series) {
        let done = client.remove_series(&id, &key).await?;
        let (count, more, left) = (done.count, done.more, done.left);
        return Ok(
            json!({"removed": true, "because": "cancelled", "count": count, "more": more, "seriesLeft": left}),
        );
    }
    let because = client.remove_meeting(&id, &key, scope).await?;
    Ok(json!({"removed": true, "because": because}))
}
