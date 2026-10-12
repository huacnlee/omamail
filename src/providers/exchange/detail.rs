//! `exchange.calendarEvent`, what a list of events cannot hold, read when one is opened, and
//! `exchange.calendarRespond`, the owner's answer to an invitation (`ews::client::detail` makes the
//! requests and decides what may be answered).
//!
//! Rules a change must not break:
//!
//! - **The detail is a read**, bounded like every other: one account turn, an optional
//!   `requestToken`, notes as plain text of at most 16 KiB, at most 200 people, every string bounded
//!   by the decoder, a join link only when it is `https`. No error carries a name, an address or
//!   server text.
//! - **A private event is the same "Private" the list shows, with nothing else**: no notes, place,
//!   organizer, people, link or reminder, and it cannot be answered. It is masked here, before the
//!   answer leaves.
//! - The answer carries what a screen needs to draw the event whole and to write to it: the
//!   `changeKey` of the version it read (which an answer names), the title, place and time a screen
//!   compares with what it drew (version keys are not comparable across a view and a read for an
//!   occurrence of a series), and `editable` and `lock` from `CalendarItem::lock` on this fresh read,
//!   which can see the people the list could not (an item outside the default calendar folder is
//!   locked, as an appointment's write is), and a meeting the owner organises is unlocked as a meeting
//!   when `EventDetail::organised` says so. `canRespond` is `EventDetail::invitation`, so a detail
//!   read without the Exchange 2013 properties offers no answer, which would always fail. `cancelled`
//!   is said only when it is certain; `unplacedCancellation` says one event of the meeting was
//!   cancelled and this one does not say whether it is that event. `canRemove` is
//!   `EventDetail::removal` (`exchange.meetingRemove`).
//! - The owner is told from the other people by their address (the account's), and the owner's line
//!   says what `MyResponseType` says: anybody else's `ResponseType` is "only relevant to a meeting
//!   organizer's calendar item", so on an invitation it says nothing, and the answer never claims it
//!   does (`unknown`).
//! - **A member of a series says what the series is** (`series`: how it repeats, in bounded words,
//!   read from its master; the master's version, which a write to all of it names; whether all of it
//!   may be changed or answered, judged on the master) and is locked by the rule for a series
//!   (`EventDetail::screen_lock`). The master read is one the detail can do without: when it fails the
//!   series is "Repeats" and nothing is offered for all of it. `canRemoveSeries` says the event is a
//!   removable one of a series its organizer cancelled, which `exchange.meetingRemove` with `scope`
//!   `series` takes off whole, and `cancelledEvents` how many of its events they cancelled one by one
//!   (0 for the series as a whole).
//! - **In a calendar that is not the mailbox's default one** (`calendar`, `folders`) the detail is the item
//!   alone: it cannot be answered or removed there, says no series, and is locked by that calendar's rule
//!   (`EventDetail::other_lock`), a meeting whoever organises it. An answer is the default calendar's: a
//!   request naming any other is `exchange_calendar_locked` before anything is looked up.
//! - **An answer is the one call that mails a person, and only the organizer of the invitation.**
//!   `send` is required, so no default decides whether somebody is mailed; `remove` goes only with a
//!   sent decline. Like every write it takes no `requestToken`, waits for its turn only while its
//!   request could still end inside the call, and is never cancelled, detached or repeated.

use futures_util::FutureExt;
use serde_json::{Value, json};

use super::calendar::{scope, target};
use super::ews::{
    Answer, Attendee, Calendar, Cancelled, EventDetail, Lock, Party, Scope, Series,
    respond as answer_request,
};
use super::{INVALID, account, fields, folders, ids, text, token, write::turn, zone};

pub async fn detail(params: &Value) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "id", "calendar", "requestToken"])?;
    let id = text(map, "id")?.to_owned();
    ids::validate(&id)?;
    let account = account(map)?;
    let owner = ids::account(&account)?.to_owned();
    // The zone this computer is in, which says whether the time of every event may change here.
    let zone = zone::known();
    let calendar = folders::calendar(map, &account)?;
    super::account::read(&account, token(map)?, move |client| {
        async move {
            let found = client.event_detail(&id, &calendar).await?;
            let shown = match calendar {
                Calendar::Default => reply(&found, &owner, zone),
                _ => reply_in_other(&found, &owner),
            };
            shown.ok_or("exchange_invalid_response")
        }
        .boxed()
    })
    .await
}

pub async fn respond(params: &Value) -> Result<Value, &'static str> {
    let map = fields(
        params,
        &[
            "accountId",
            "id",
            "changeKey",
            "response",
            "send",
            "remove",
            "scope",
            "calendar",
        ],
    )?;
    let (id, key) = target(map)?;
    // One event is answered by its own id, as ever: the one thing a scope says here is all of them.
    let series = match scope(map)? {
        Some(Scope::Occurrence) => return Err(INVALID),
        scope => scope == Some(Scope::Series),
    };
    let reply = Answer::parse(text(map, "response")?).ok_or(INVALID)?;
    let flag = |name| map.get(name).map(|value| value.as_bool().ok_or(INVALID));
    let send = flag("send").ok_or(INVALID)??;
    let remove = flag("remove").transpose()?.unwrap_or(false);
    // Taking the meeting off the calendar goes with a decline that is sent: an unsent one would leave
    // the organizer waiting for somebody whose calendar no longer has the meeting.
    if remove && (reply != Answer::Decline || !send) {
        return Err(INVALID);
    }
    answer_request("A", &key, reply, send)?;
    let account = account(map)?;
    // An answer is the default calendar's: any other is locked, with nothing looked up.
    folders::default_only(map, &account)?;
    let mut lease = turn(&account).await?;
    let answered = lease
        .client()
        .respond(&id, &key, reply, send, remove, series)
        .await?;
    let mut done = json!({
        "id": answered.written.id,
        "changeKey": answered.written.change_key,
        "response": reply.word(),
        "sent": send,
    });
    if remove {
        done["removed"] = json!(answered.removed == Some(true));
    }
    Ok(done)
}

fn person(who: &Party) -> Value {
    json!({"name": who.name, "email": who.address})
}

fn attendee(found: &Attendee, response: &str, owner: &str) -> Value {
    let own = !owner.is_empty() && found.who.address.eq_ignore_ascii_case(owner);
    json!({
        "name": found.who.name,
        "email": found.who.address,
        "kind": found.kind,
        // The owner's line is what the owner's own item says; anybody else's is theirs only on the
        // organizer's copy, and on an invitation it says nothing.
        "response": match (own, response) {
            (true, _) => response,
            (false, "organizer") => found.response,
            (false, _) => "unknown",
        },
        "self": own,
    })
}

/// What is said of the series an event belongs to; `null` for an event of none and for a private one.
fn series(detail: &EventDetail, owner: &str, zone: Option<&str>) -> Value {
    if !detail.item.is_series() || detail.item.private {
        return Value::Null;
    }
    let mut unread = Series::default();
    unread.repeat.text = "Repeats".to_owned();
    let found = detail.series.as_ref().unwrap_or(&unread);
    let master = &found.master;
    // The people a change or a cancellation of all of it tells: the master's, which an event's own
    // list (an exception's) may not be.
    let people: Vec<Value> = master
        .attendees
        .iter()
        .map(|who| attendee(who, master.item.response, owner))
        .collect();
    let lock = found.lock(owner);
    json!({
        "text": found.repeat.text,
        "kind": found.repeat.kind,
        "key": found.key,
        "editable": lock.is_none(),
        "lock": lock.map_or("", Lock::code),
        "timeEditable": lock.is_none() && found.time_editable(zone),
        "canRespond": found.can_respond,
        "attendees": people,
        "attendeesCut": master.attendees_cut,
        // Events changed on their own (the master's `ModifiedOccurrences`, at most one past the bound),
        // which a change of the time of every event undoes.
        "exceptions": master.modified.len(),
    })
}

/// The detail of an item of a calendar that is not the mailbox's default one. Nothing is said there that
/// only the default calendar does: the item is answered and
/// removed nowhere but there and nothing of a series is read, so it cannot be answered or removed and
/// says no series; and it is locked by that calendar's rule (`EventDetail::other_lock`), a meeting
/// whoever organises it. A private item is masked as in the default calendar.
fn reply_in_other(detail: &EventDetail, owner: &str) -> Option<Value> {
    let mut shown = reply(detail, owner, None)?;
    let lock = detail.other_lock();
    for (key, value) in [
        ("canRespond", json!(false)),
        ("canRemove", json!(false)),
        ("canRemoveSeries", json!(false)),
        ("cancelledEvents", json!(0)),
        ("cancelled", json!(detail.item.cancelled)),
        ("unplacedCancellation", json!(false)),
        ("series", Value::Null),
        ("editable", json!(lock.is_none())),
        ("lock", json!(lock.map_or("", Lock::code))),
    ] {
        shown[key] = value;
    }
    Some(shown)
}

/// The detail as the answer lists it; `None` for an item whose id the codec does not take.
pub fn reply(detail: &EventDetail, owner: &str, zone: Option<&str>) -> Option<Value> {
    let item = &detail.item;
    // Outside the default calendar nothing is written from here, whatever the item is; a meeting the
    // owner organises is unlocked as a meeting, which the screen tells by `meeting`; an event of a
    // series is judged by the rule for a series.
    let lock = detail.screen_lock(owner);
    let private = item.private;
    // A removable event of a series its organizer cancelled: all of it may go in one call.
    let removal = detail
        .series
        .as_ref()
        .and_then(|found| found.removal)
        .filter(|_| !private && detail.removal().is_some());
    let people: Vec<Value> = match private {
        true => Vec::new(),
        false => detail
            .attendees
            .iter()
            .map(|found| attendee(found, item.response, owner))
            .collect(),
    };
    let shown = |text: &str| {
        if private {
            String::new()
        } else {
            text.to_owned()
        }
    };
    Some(json!({
        "id": ids::encode(&item.id).ok()?,
        "changeKey": item.change_key,
        "title": if private { "Private" } else { item.subject.as_str() },
        "location": shown(&item.location),
        // What a screen compares with what it drew; an all-day item's instants are midnights of the
        // zone it was made in, so they say the day only to a screen that knows that zone.
        "allDay": item.all_day,
        "startMs": item.start_ms,
        "endMs": item.end_ms.max(item.start_ms),
        "notes": shown(&detail.notes),
        "notesCut": !private && detail.notes_cut,
        "organizer": detail.organizer.as_ref().filter(|_| !private).map(person),
        "attendees": people,
        "attendeesCut": !private && detail.attendees_cut,
        "response": item.response,
        "reminderMinutes": if private { None } else { item.reminder_minutes },
        "joinUrl": shown(&detail.join_url),
        "sensitivity": if private { "private" } else { "normal" },
        "meeting": item.meeting,
        "recurring": item.recurring,
        "cancelled": item.cancelled || detail.cancellation == Cancelled::Yes,
        "unplacedCancellation": !item.cancelled && detail.cancellation == Cancelled::Unplaced,
        "canRemove": detail.removal().is_some(),
        "canRemoveSeries": removal.is_some(),
        "cancelledEvents": removal.unwrap_or(0),
        "kind": item.kind,
        "series": series(detail, owner, zone),
        "canRespond": detail.invitation(),
        "editable": lock.is_none(),
        "lock": lock.map_or("", Lock::code),
    }))
}
