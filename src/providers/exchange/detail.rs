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
//!   locked, as an appointment's write is). `canRespond` is `EventDetail::invitation`, so a detail
//!   read without the Exchange 2013 properties offers no answer, which would always fail. `cancelled`
//!   is said only when it is certain; `unplacedCancellation` says one event of the meeting was
//!   cancelled and this one does not say whether it is that event.
//! - The owner is told from the other people by their address (the account's), and the owner's line
//!   says what `MyResponseType` says: anybody else's `ResponseType` is "only relevant to a meeting
//!   organizer's calendar item", so on an invitation it says nothing, and the answer never claims it
//!   does (`unknown`).
//! - **An answer is the one call that mails a person, and only the organizer of the invitation.**
//!   `send` is required, so no default decides whether somebody is mailed; `remove` goes only with a
//!   sent decline. Like every write it takes no `requestToken`, waits for its turn only while its
//!   request could still end inside the call, and is never cancelled, detached or repeated.

use futures_util::FutureExt;
use serde_json::{Value, json};

use super::calendar::target;
use super::ews::{
    Answer, Attendee, Cancelled, EventDetail, Lock, Party, respond as answer_request,
};
use super::{INVALID, account, fields, ids, text, token, write::turn};

pub async fn detail(params: &Value) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "id", "requestToken"])?;
    let id = text(map, "id")?.to_owned();
    ids::validate(&id)?;
    let account = account(map)?;
    let owner = ids::account(&account)?.to_owned();
    super::account::read(&account, token(map)?, move |client| {
        async move {
            let found = client.event_detail(&id).await?;
            reply(&found, &owner).ok_or("exchange_invalid_response")
        }
        .boxed()
    })
    .await
}

pub async fn respond(params: &Value) -> Result<Value, &'static str> {
    let map = fields(
        params,
        &["accountId", "id", "changeKey", "response", "send", "remove"],
    )?;
    let (id, key) = target(map)?;
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
    let mut lease = turn(&account(map)?).await?;
    let answered = lease
        .client()
        .respond(&id, &key, reply, send, remove)
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

/// The detail as the answer lists it; `None` for an item whose id the codec does not take.
pub fn reply(detail: &EventDetail, owner: &str) -> Option<Value> {
    let item = &detail.item;
    // Outside the default calendar nothing is written from here, whatever the item is.
    let lock = match detail.elsewhere {
        true => Some(Lock::Unknown),
        false => item.lock(),
    };
    let private = item.private;
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
        "kind": item.kind,
        "canRespond": detail.invitation(),
        "editable": lock.is_none(),
        "lock": lock.map_or("", Lock::code),
    }))
}
