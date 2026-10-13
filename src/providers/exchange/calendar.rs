//! The mailbox's default calendar: `exchange.calendarEvents` reads a range, and
//! `exchange.calendarCreate`, `exchange.calendarUpdate` and `exchange.calendarDelete` write personal
//! appointments (`ews::client::calendar` makes the requests and decides what a failure proves).
//!
//! Rules a change must not break:
//!
//! - **Nothing is mailed, ever, and only a plain appointment is written**: a single item with nobody
//!   else on it that its owner made. Each event of a range says whether it is one (`editable`, and
//!   `lock` naming why not), and the client decides again on a fresh read before every update and
//!   delete; what it refuses is `exchange_calendar_locked`. A meeting the owner organises is
//!   `editable` as a meeting (`meeting` true, `CalendarItem::meeting_lock`): it is changed only by
//!   the meeting calls (`meeting`), which these refuse to stand in for.
//! - **A write names the version it was drawn from** (`changeKey`); another one is
//!   `exchange_calendar_conflict` and nothing is applied. It is never retried with a fresh key.
//! - **A write is never cancelled, detached or repeated.** It takes no `requestToken`, waits for the
//!   account's turn only while its request could still end by the call's deadline, and a caller that
//!   goes away takes the connection with it. An outcome that cannot be known is
//!   `exchange_calendar_unconfirmed` ("look at your calendar").
//! - Every field is named, typed and bounded before an account is resolved or a socket opened: a
//!   range of at most 100 days; a title of 1 to 1000 bytes, a place of at most 500 and notes of at
//!   most 32 KiB, none with a control character (notes keep line breaks and tabs); a time that is
//!   two instants (`startMs`, `endMs`) or whole days (`startDate`, `endDate` the day after the last,
//!   `YYYY-MM-DD`), never both, never longer than a year. An update names the title, the place and
//!   the time only to change them, so what the screen drew (a placeholder for an empty subject, a
//!   title it trimmed, a place it could not write) is never sent back. A reminder is
//!   `reminderMinutes`, whole minutes before the start from 0 to 40320 (four weeks): a new
//!   appointment has none unless it names one, and an update leaves it alone unless it names one, or
//!   -1 for none. Notes are written when an appointment is made and never after: what the detail
//!   shows is text made from a body that may be HTML and may be cut, so an edit that sent it back
//!   would replace what was written with what was shown.
//! - **A private item is masked here**, before the answer leaves: Private, Confidential and any
//!   sensitivity not known is "Private" with its time and nothing else, so no cache file, bar widget
//!   or agent holds the real title. A cancelled item is left out, as Google's and Graph's are.
//! - **A repeating event is made, changed and deleted through a scope, never without one.**
//!   `recurrence` on a create makes a series (`recurrence::Recurrence::from_request` holds every bound
//!   Microsoft gives and refuses what the schema cannot say); its first day is the event's own for a
//!   whole day and the caller's local day (`firstDate`) for an instant. The server repeats a series in
//!   the zone it was made in, so a computer whose zone this does not know makes none
//!   (`exchange_calendar_zone_unknown`), rather than one in UTC that would move an hour when the clocks
//!   change. `scope` on an update or a delete is `occurrence` (this event, which an update makes an
//!   exception) or `series` (every event, through the master); every event's time of day is
//!   `startClock` and `durationMinutes`, never instants or days. A member of a series is `editable` in
//!   a range by the rule of its own kind, and named with no scope it is `exchange_calendar_locked`.
//! - A timed event is its UTC instants. An all-day event is the days of its wall clock (midnight in
//!   the zone it was made in), because a screen in another zone cannot recover them from instants;
//!   where a server gave no wall clock they are the UTC dates of the instants plus twelve hours,
//!   right for every zone from UTC-11 to UTC+12. A new or moved all-day event is made in the owner's
//!   zone (`zone`), which is looked up on the computer the backend runs on.

use chrono::{DateTime, Days, NaiveDate, NaiveTime};
use futures_util::FutureExt;
use serde_json::{Map, Value, json};

use super::ews::{
    Appointment, CalendarChange, CalendarItem, Edit, Lock, MAX_CURSOR_MS, MAX_ENTRIES,
    MAX_SPAN_MINUTES, Reminder, Scope, When, Written, create_appointment, is_change_key,
    update_appointment,
};
use super::recurrence::{self, Recurrence};
use super::{INVALID, account, fields, ids, text, token, write::turn, zone};

/// This computer's zone is not one a series could be made in, so none is made.
const ZONE_UNKNOWN: &str = "exchange_calendar_zone_unknown";

/// The widest range one request may ask for (a month grid is 42 days).
const MAX_RANGE_MS: i64 = 100 * 86_400_000;
const HALF_DAY_MS: i64 = 12 * 3_600_000;

pub async fn events(params: &Value) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "startMs", "endMs", "requestToken"])?;
    let (start_ms, end_ms) = (instant(map, "startMs")?, instant(map, "endMs")?);
    if end_ms <= start_ms || end_ms - start_ms > MAX_RANGE_MS {
        return Err(INVALID);
    }
    super::account::read(&account(map)?, token(map)?, move |client| {
        async move {
            let found = client
                .calendar_events(start_ms, end_ms, MAX_ENTRIES)
                .await?;
            let events: Vec<Value> = found.items.iter().filter_map(event).collect();
            Ok(json!({"events": events, "truncated": found.truncated}))
        }
        .boxed()
    })
    .await
}

pub async fn create(params: &Value) -> Result<Value, &'static str> {
    let map = fields(
        params,
        &[
            "accountId",
            "title",
            "location",
            "notes",
            "reminderMinutes",
            "allDay",
            "startMs",
            "endMs",
            "startDate",
            "endDate",
            "recurrence",
        ],
    )?;
    let item = appointment(map)?;
    create_appointment(&item, zone::UTC)?;
    let zone = zone_of(&item)?;
    let mut lease = turn(&account(map)?).await?;
    let written = lease.client().create_appointment(&item, zone).await?;
    Ok(reply(&written))
}

pub async fn update(params: &Value) -> Result<Value, &'static str> {
    let map = fields(
        params,
        &[
            "accountId",
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
        ],
    )?;
    let (id, key) = target(map)?;
    let (edit, scope) = edit(map)?;
    // Only what is named is judged and sent: a drag names the time alone.
    let whole = CalendarChange {
        title: edit.title.as_deref(),
        location: edit.location.as_deref(),
        reminder: edit.reminder,
        when: edit.when.map(When::judged),
        ..CalendarChange::default()
    };
    if whole != CalendarChange::default() {
        update_appointment("A", &key, &whole, zone::UTC)?;
    }
    let zone = zone_of_change(&edit)?;
    let mut lease = turn(&account(map)?).await?;
    let client = lease.client();
    let written = client
        .change_appointment(&id, &key, &edit, zone, scope)
        .await?;
    Ok(reply(&written))
}

pub async fn delete(params: &Value) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "id", "changeKey", "scope"])?;
    let (id, key) = target(map)?;
    let scope = scope(map)?;
    let mut lease = turn(&account(map)?).await?;
    lease.client().delete_appointment(&id, &key, scope).await?;
    Ok(json!({"deleted": true}))
}

pub(super) fn reply(written: &Written) -> Value {
    json!({"id": written.id, "changeKey": written.change_key})
}

/// A new event as a request names it: the members `calendarCreate` and `meetingCreate` share.
pub(super) fn appointment(map: &Map<String, Value>) -> Result<Appointment, &'static str> {
    let when = when(map)?.ok_or(INVALID)?;
    Ok(Appointment {
        title: text(map, "title")?.to_owned(),
        location: optional(map, "location")?.unwrap_or_default(),
        notes: optional(map, "notes")?,
        reminder: match reminder(map, false)? {
            Reminder::Minutes(minutes) => Some(minutes),
            _ => None,
        },
        recurrence: map
            .get("recurrence")
            .map(|value| rule(value, &when))
            .transpose()?,
        when,
    })
}

/// The zone a change is made in: the computer's. A time of day of every event of a series was typed on
/// this computer's clock, so it cannot do without it, and the client writes it only to a series that
/// recurs in this same zone.
pub(super) fn zone_of_change(edit: &Edit) -> Result<&'static str, &'static str> {
    match edit.when {
        Some(When::Clock { .. }) => zone::known().ok_or(ZONE_UNKNOWN),
        _ => Ok(zone::local()),
    }
}

/// The zone a new event is made in: the computer's, which a series cannot do without.
pub(super) fn zone_of(item: &Appointment) -> Result<&'static str, &'static str> {
    match item.recurrence {
        Some(_) => zone::known().ok_or(ZONE_UNKNOWN),
        None => Ok(zone::local()),
    }
}

/// A repeat as a request names it, from the day of the first event: its own for a whole day, and for
/// an instant the local day the caller names (`firstDate`), which this side has no zone rules to find.
fn rule(value: &Value, when: &When) -> Result<Recurrence, &'static str> {
    let first = match (when, value.get("firstDate")) {
        (When::AllDay { first, .. }, None) => *first,
        (When::Timed { .. }, Some(Value::String(text))) => recurrence::day(text)?,
        _ => return Err(INVALID),
    };
    Recurrence::from_request(value, first)
}

/// A change as a request names it, and the part of a series it is for: the members `calendarUpdate`
/// and `meetingUpdate` share. Every event of a series is given a time of day and no instant or day;
/// one event, or one that does not repeat, never a time of day.
pub(super) fn edit(map: &Map<String, Value>) -> Result<(Edit, Option<Scope>), &'static str> {
    let scope = scope(map)?;
    let (clock, instants) = (clock(map)?, when(map)?);
    match (scope, &clock, &instants) {
        (Some(Scope::Series), _, Some(_)) | (Some(Scope::Occurrence) | None, Some(_), _) => {
            return Err(INVALID);
        }
        _ => {}
    }
    let edit = Edit {
        title: optional(map, "title")?,
        location: optional(map, "location")?,
        reminder: reminder(map, true)?,
        when: clock.or(instants),
    };
    Ok((edit, scope))
}

/// `scope`: absent for an event that does not repeat, else `occurrence` or `series`.
pub(super) fn scope(map: &Map<String, Value>) -> Result<Option<Scope>, &'static str> {
    match map.get("scope") {
        None => Ok(None),
        Some(Value::String(word)) => Scope::parse(word).map(Some).ok_or(INVALID),
        Some(_) => Err(INVALID),
    }
}

/// The time of day of every event of a series: `startClock` (`HH:MM`, spelled so) and
/// `durationMinutes`, both or neither.
fn clock(map: &Map<String, Value>) -> Result<Option<When>, &'static str> {
    let (start, minutes) = match (map.get("startClock"), map.get("durationMinutes")) {
        (None, None) => return Ok(None),
        (Some(Value::String(start)), Some(minutes)) => (start, minutes),
        _ => return Err(INVALID),
    };
    let spelled = |time: &NaiveTime| time.format("%H:%M").to_string() == *start;
    let start = NaiveTime::parse_from_str(start, "%H:%M")
        .ok()
        .filter(spelled);
    let minutes = minutes.as_u64().and_then(|n| u32::try_from(n).ok());
    let minutes = minutes.filter(|n| (1..=MAX_SPAN_MINUTES).contains(n));
    match (start, minutes) {
        (Some(start), Some(minutes)) => Ok(Some(When::Clock { start, minutes })),
        _ => Err(INVALID),
    }
}

/// Whole milliseconds since the epoch, up to the end of the year 9999; a float or a string is
/// refused even if it looks whole.
fn instant(map: &Map<String, Value>, key: &str) -> Result<i64, &'static str> {
    map.get(key)
        .and_then(Value::as_i64)
        .filter(|ms| (0..=MAX_CURSOR_MS).contains(ms))
        .ok_or(INVALID)
}

/// `reminderMinutes`: absent (`Keep`), or whole minutes before the start from 0 to four weeks; an
/// update may also say -1, which is no reminder.
fn reminder(map: &Map<String, Value>, update: bool) -> Result<Reminder, &'static str> {
    match map.get("reminderMinutes").map(Value::as_i64) {
        None => Ok(Reminder::Keep),
        Some(Some(-1)) if update => Ok(Reminder::Off),
        // The builders refuse more than four weeks, before any lookup.
        Some(Some(minutes)) => u32::try_from(minutes)
            .map(Reminder::Minutes)
            .map_err(|_| INVALID),
        Some(None) => Err(INVALID),
    }
}

/// An optional text member: absent, or a string (never null).
fn optional(map: &Map<String, Value>, key: &str) -> Result<Option<String>, &'static str> {
    match map.get(key) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(INVALID),
    }
}

/// A `YYYY-MM-DD` that is a day, spelled one way only.
fn day(map: &Map<String, Value>, key: &str) -> Result<NaiveDate, &'static str> {
    recurrence::day(text(map, key)?)
}

/// The time members: none, or `allDay` with the pair that goes with it. A member of the other kind
/// of time is a refusal, so a request says one thing.
fn when(map: &Map<String, Value>) -> Result<Option<When>, &'static str> {
    let named = ["allDay", "startMs", "endMs", "startDate", "endDate"];
    if !named.iter().any(|key| map.contains_key(*key)) {
        return Ok(None);
    }
    let has = |keys: [&str; 2]| keys.iter().any(|key| map.contains_key(*key));
    match map.get("allDay").and_then(Value::as_bool).ok_or(INVALID)? {
        true if !has(["startMs", "endMs"]) => Ok(Some(When::AllDay {
            first: day(map, "startDate")?,
            after: day(map, "endDate")?,
        })),
        false if !has(["startDate", "endDate"]) => Ok(Some(When::Timed {
            start_ms: instant(map, "startMs")?,
            end_ms: instant(map, "endMs")?,
        })),
        _ => Err(INVALID),
    }
}

/// An item and the version of it a caller drew.
pub(super) fn target(map: &Map<String, Value>) -> Result<(String, String), &'static str> {
    let (id, key) = (text(map, "id")?, text(map, "changeKey")?);
    ids::validate(id)?;
    if !is_change_key(key) {
        return Err(INVALID);
    }
    Ok((id.to_owned(), key.to_owned()))
}

/// One item as the answer lists it; `None` for a cancelled one, and for one whose id the codec
/// refuses or whose days cannot be held.
pub fn event(item: &CalendarItem) -> Option<Value> {
    if item.cancelled {
        return None;
    }
    let (title, location, organizer) = if item.private {
        ("Private", "", "")
    } else {
        (
            item.subject.as_str(),
            item.location.as_str(),
            item.organizer.as_str(),
        )
    };
    let lock = item.screen_lock();
    let mut event = json!({
        "id": ids::encode(&item.id).ok()?,
        "changeKey": item.change_key,
        "editable": lock.is_none(),
        "lock": lock.map_or("", Lock::code),
        "uid": item.uid,
        "title": title,
        "location": location,
        "organizer": organizer,
        "allDay": item.all_day,
        "startMs": item.start_ms,
        "endMs": item.end_ms.max(item.start_ms),
        "busy": item.busy,
        "meeting": item.meeting,
        "response": item.response,
        "kind": item.kind,
        "recurring": item.recurring,
        "private": item.private,
        "reminderMinutes": if item.private { None } else { item.reminder_minutes },
    });
    if item.all_day {
        let (first, after) = days(item)?;
        event["startDate"] = json!(first.to_string());
        event["endDate"] = json!(after.to_string());
    }
    Some(event)
}

/// The first day of an all-day item and the day after its last. A wall clock that is not midnight
/// ends inside its day; an end that is not after the start makes a day of one.
fn days(item: &CalendarItem) -> Option<(NaiveDate, NaiveDate)> {
    let utc_date = |ms: i64| {
        let ms = ms.checked_add(HALF_DAY_MS)?;
        DateTime::from_timestamp_millis(ms).map(|moment| moment.date_naive())
    };
    let first = match item.start_wall {
        Some(wall) => wall.date(),
        None => utc_date(item.start_ms)?,
    };
    let after = match item.end_wall {
        Some(wall) if wall.time() == NaiveTime::MIN => wall.date(),
        Some(wall) => wall.date().checked_add_days(Days::new(1))?,
        None => utc_date(item.end_ms)?,
    };
    Some((first, after.max(first.checked_add_days(Days::new(1))?)))
}
