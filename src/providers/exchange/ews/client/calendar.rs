//! The calendar: reading a range, and writing personal appointments, never a mail to anybody
//! (`soap::calendar` holds the options that say so).
//!
//! A read is a calendar view, which has no offset: the next answer starts the range at the latest
//! `Start` seen and an item still running there comes again and is kept once (an occurrence has an
//! `ItemId` of its own). It relies on the view listing items by start, as Microsoft's example does.
//! An answer that brings nothing new ends it (as many items as an answer holds that all still run
//! where the next would start cannot be paged past), and so do `MAX_ANSWERS` answers and
//! `MAX_EVENTS` items: the result is then `truncated`, never silently short. An answer that does not
//! say whether it holds the last item is the last when it is short. The wall clocks and the reminder
//! are the part of the shape a server might refuse: when the first answer is a server error the
//! read is asked once more without them, and goes on that way (nothing is remembered).
//!
//! A write to an existing item is read first, and the read decides whether it is sent: the default
//! calendar's folder id, then a `GetItem` with the folder and the attendee lists a view cannot show,
//! refused as `exchange_calendar_locked` unless it is a plain appointment of that folder
//! (`CalendarItem::lock`, made again on what the server holds now, so an appointment somebody has
//! made into a meeting since is never written and no invitation, update or cancellation can follow),
//! and as `exchange_calendar_conflict` unless its change key is the one the caller drew (a delete
//! names no `ConflictResolution`, so this read is its version check). Then the write names that
//! version. A stale key is never read afresh and retried, as the mail side does for a flag: an edit
//! sent over a change made while the form was open would lose that change without a word. A create
//! has nothing to read; like every write it goes on a stream that the folder lookup has signed in,
//! so it is never the request that finds a wrong password.
//!
//! What a write's failure proves: the codes that say the server did nothing keep their names (a
//! stale version, an item not found, access denied, a folder not found, throttling, an unsupported
//! server, a refused login, a request never written); anything else after the request was written
//! (a lost stream, an HTTP status, a damaged answer, a deadline) is `exchange_calendar_unconfirmed`,
//! and the request is never sent again.

use std::collections::HashSet;

use super::super::decode::calendar::{self as answer, CalendarItem};
use super::super::decode::{self, Rej};
use super::super::soap::calendar::{self as soap, Appointment, Change, Reminder, When};
use super::{Client, Failed};
use crate::providers::exchange::ids;

pub const CONFLICT: &str = "exchange_calendar_conflict";
pub const LOCKED: &str = "exchange_calendar_locked";
pub const UNCONFIRMED: &str = "exchange_calendar_unconfirmed";
pub(super) const SERVER: &str = "exchange_server_error";
/// Most answers one read asks for.
const MAX_ANSWERS: usize = 12;
/// Most items one read returns: the figure Microsoft's default policy gives as a page limit.
pub const MAX_EVENTS: usize = 1000;

pub struct CalendarEvents {
    /// By start, then by id.
    pub items: Vec<CalendarItem>,
    /// The read stopped before the server said it had given the last item.
    pub truncated: bool,
}

/// What a change of an appointment asks for; `None` leaves that part as the server has it, so a
/// drag names the time alone and no title the screen drew is ever written back.
pub struct Edit {
    pub title: Option<String>,
    pub location: Option<String>,
    pub reminder: Reminder,
    pub when: Option<When>,
}

/// A written item's Omamail id and new change key, as far as the server named them.
pub struct Written {
    pub id: String,
    pub change_key: String,
}

/// A refusal that proves nothing was done.
fn definite(code: &str) -> bool {
    matches!(
        code,
        decode::NOT_FOUND
            | decode::DENIED
            | decode::FOLDER
            | decode::THROTTLED
            | decode::TOO_LARGE
            | "exchange_unsupported_server"
    )
}

/// The server's own answer about the item it was asked to write.
pub(super) fn refusal(rej: Rej) -> &'static str {
    match rej.code {
        decode::STALE => CONFLICT,
        code if definite(code) || rej.unprocessed => code,
        _ => UNCONFIRMED,
    }
}

/// A write request that failed as a whole: its own code when it was not applied or the server's
/// answer said it did nothing, else unknown. An HTTP 429 or 503 is a status, not such an answer: a
/// gateway can give one for a request its backend went on to run.
pub(super) fn failure((code, applied): Failed) -> &'static str {
    match code {
        decode::STALE => CONFLICT,
        code if !applied => code,
        decode::THROTTLED => UNCONFIRMED,
        code if definite(code) => code,
        _ => UNCONFIRMED,
    }
}

/// What differs between the item as the server holds it and the change asked for. Days are compared
/// with nothing (the read asks for no wall clock), so a day that was named is written.
fn changes<'a>(current: &CalendarItem, wanted: &'a Edit) -> Change<'a> {
    let same_time = match wanted.when {
        Some(When::Timed { start_ms, end_ms }) => {
            !current.all_day
                && current.start_ms.div_euclid(1000) == start_ms.div_euclid(1000)
                && current.end_ms.div_euclid(1000) == end_ms.div_euclid(1000)
        }
        Some(When::AllDay { .. }) => false,
        None => true,
    };
    let title = wanted.title.as_deref();
    let location = wanted.location.as_deref();
    // A reminder the server already has is not sent again.
    let reminder = match wanted.reminder {
        Reminder::Off if current.reminder_minutes.is_none() => Reminder::Keep,
        Reminder::Minutes(minutes) if current.reminder_minutes == Some(minutes) => Reminder::Keep,
        other => other,
    };
    Change {
        title: title.filter(|title| *title != current.subject),
        location: location.filter(|location| *location != current.location),
        reminder,
        when: if same_time { None } else { wanted.when },
    }
}

/// What a write the server confirmed answers. An id it echoed that the codec refuses is answered
/// like none (the asked id, or empty for a new item): the write happened, and the screen reads the
/// range again, so it is never reported as a failure that a retry would repeat.
pub(super) fn written(id: &str, change_key: String, asked: Option<&str>) -> Written {
    let id = ids::encode(id).unwrap_or_else(|_| asked.unwrap_or_default().to_owned());
    Written { id, change_key }
}

impl Client {
    /// The items of the mailbox's own calendar between two instants (milliseconds), a series as its
    /// occurrences, cancelled ones included, `page` (1 to 100) to an answer.
    pub async fn calendar_events(
        &mut self,
        start_ms: i64,
        end_ms: i64,
        page: usize,
    ) -> Result<CalendarEvents, &'static str> {
        soap::calendar_view(start_ms, end_ms, page, true)?;
        let (mut items, mut seen) = (Vec::new(), HashSet::new());
        let (mut from, mut optional, mut done) = (start_ms, true, false);
        for asked in 0..MAX_ANSWERS {
            let view = |from, optional| soap::calendar_view(from, end_ms, page, optional);
            let found = match self
                .call(&view(from, optional)?, true, answer::calendar_view)
                .await
            {
                Err(SERVER) if asked == 0 => {
                    optional = false;
                    let plain = view(from, false)?;
                    self.call(&plain, true, answer::calendar_view).await?
                }
                found => found?,
            };
            let newest = found.items.iter().map(|item| item.start_ms).max();
            let before = items.len();
            for item in found.items {
                if seen.insert(item.id.clone()) {
                    items.push(item);
                }
            }
            if found.includes_last.unwrap_or(found.elements < page) {
                done = true;
                break;
            }
            // Nothing new: asking again would be the same request.
            if items.len() == before || items.len() >= MAX_EVENTS {
                break;
            }
            from = newest.map_or(from, |newest| newest.max(from)).min(end_ms);
        }
        items.sort_by(|a: &CalendarItem, b| (a.start_ms, &a.id).cmp(&(b.start_ms, &b.id)));
        if items.len() > MAX_EVENTS {
            items.truncate(MAX_EVENTS);
            done = false;
        }
        Ok(CalendarEvents {
            items,
            truncated: !done,
        })
    }

    /// Creates one appointment in the `calendar` folder; `zone` is the Windows id a day is made in.
    pub async fn create_appointment(
        &mut self,
        item: &Appointment,
        zone: &str,
    ) -> Result<Written, &'static str> {
        let request = soap::create_appointment(item, zone)?;
        let (id, key) = self
            .exchange(&request, false, |node| answer::written(node, "CreateItem"))
            .await
            .map_err(failure)?
            .map_err(refusal)?;
        Ok(written(&id, key, None))
    }

    /// Changes one appointment to what `wanted` says, if it is a plain appointment still at
    /// `change_key`. What the server already has is not sent again; when that is everything, nothing
    /// is sent and the answer is the item as it is.
    pub async fn change_appointment(
        &mut self,
        id: &str,
        change_key: &str,
        wanted: &Edit,
        zone: &str,
    ) -> Result<Written, &'static str> {
        let wire = ids::decode(id)?;
        let whole = Change {
            title: wanted.title.as_deref(),
            location: wanted.location.as_deref(),
            reminder: wanted.reminder,
            when: wanted.when,
        };
        // Judged before the connection is touched: what was named, as it would go at the most.
        if !soap::is_change_key(change_key) {
            return Err("invalid_params");
        }
        if whole != Change::default() {
            soap::update_appointment(&wire, change_key, &whole, zone)?;
        }
        let current = self.plain_appointment(&wire, change_key).await?;
        let change = changes(&current, wanted);
        if change == Change::default() {
            return Ok(Written {
                id: id.to_owned(),
                change_key: current.change_key,
            });
        }
        let request = soap::update_appointment(&wire, change_key, &change, zone)?;
        let (new_id, key) = self
            .exchange(&request, false, |node| answer::written(node, "UpdateItem"))
            .await
            .map_err(failure)?
            .map_err(refusal)?;
        Ok(written(&new_id, key, Some(id)))
    }

    /// Moves one appointment to Deleted Items, if it is a plain appointment still at `change_key`.
    pub async fn delete_appointment(
        &mut self,
        id: &str,
        change_key: &str,
    ) -> Result<(), &'static str> {
        let wire = ids::decode(id)?;
        let request = soap::delete_appointment(&wire, change_key)?;
        self.plain_appointment(&wire, change_key).await?;
        self.exchange(&request, false, |node| {
            decode::outcomes(node, "DeleteItem", 1)
        })
        .await
        .map_err(failure)?
        .pop()
        .unwrap_or(Err(Rej::INVALID))
        .map_err(refusal)
    }

    /// The item as the server holds it, if it is a plain appointment of the default calendar folder
    /// (resolved by its distinguished name, as the view reads it) at `change_key`. A delete names no
    /// `ConflictResolution`, so this read is its version check. Nothing has been written when this
    /// fails.
    async fn plain_appointment(
        &mut self,
        wire: &str,
        change_key: &str,
    ) -> Result<CalendarItem, &'static str> {
        let calendar = soap::get_calendar_folder();
        let calendar = self.call(&calendar, true, answer::folder_id).await?;
        let request = soap::get_appointment(wire);
        let item = self.call(&request, true, answer::appointment).await?;
        let mine = |item: &CalendarItem| item.lock().is_none() && item.folder == calendar;
        let item = item.filter(mine).ok_or(LOCKED)?;
        if item.change_key.is_empty() {
            return Err("exchange_invalid_response");
        }
        if item.change_key != change_key {
            return Err(CONFLICT);
        }
        Ok(item)
    }
}
