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
//! **A calendar other than the default one** is named by its folder (`soap::folders::Calendar`) and asked
//! of the server first (`Client::home`, its `EffectiveRights`): a range is read only where the user may
//! read, and each item of it carries its own rights; an appointment is made only where they may read and
//! make things; an item is changed only when its own rights (asked on the read before the write) say they
//! may modify it, and deleted only in the owner's own mailbox and only when they say they may delete it
//! (in another mailbox a delete moves the item to a folder the share need not reach, so none is made).
//! There a series is written one event at a time.
//!
//! A write to an existing item is read first, and the read decides whether it is sent: the folder id of
//! the calendar named, then a `GetItem` with the folder and the attendee lists a view cannot show,
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
//! **A member of a series is written through a scope, never without one.** `Occurrence` is the event
//! the caller names (an update makes it an exception: "you use the item ID of the occurrence");
//! `Series` is the master, read through that event (`RecurringMasterItemId`) and written by its own
//! id, at the version the caller drew, which Microsoft says every event of a series shares. An item
//! that is not what the scope says (one event named for a single appointment, a master that is none)
//! is the item having changed since the screen was drawn: `exchange_calendar_conflict`. The time of
//! day of every event is a clock time, put on the master's first day in the zone it recurs in; a
//! master that says neither has no time of day to change from here (`exchange_calendar_locked`).
//!
//! What a write's failure proves: the codes that say the server did nothing keep their names (a
//! stale version, an item not found, access denied, a folder not found, throttling, an unsupported
//! server, a refused login, a request never written); anything else after the request was written
//! (a lost stream, an HTTP status, a damaged answer, a deadline) is `exchange_calendar_unconfirmed`,
//! and the request is never sent again.

use std::collections::HashSet;

use super::super::decode::calendar::{self as answer, CalendarItem};
use super::super::decode::{self, Rej};
use chrono::NaiveDate;

use super::super::soap::calendar::{self as soap, Appointment, Change, Reminder, Scope, When};
use super::super::soap::folders::Calendar;
use super::{Client, Failed};
use crate::providers::exchange::ids;

pub const CONFLICT: &str = "exchange_calendar_conflict";
pub const LOCKED: &str = "exchange_calendar_locked";
pub const UNCONFIRMED: &str = "exchange_calendar_unconfirmed";
/// The series repeats in another zone than this computer's: a time of day typed here is not its own.
pub const ZONE_DIFFERS: &str = "exchange_calendar_zone_differs";
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
    /// Read from a calendar other than the mailbox's default one: each item carries its own rights.
    pub other: bool,
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
pub(super) fn changes<'a>(current: &CalendarItem, wanted: &'a Edit) -> Change<'a> {
    let same_time = match wanted.when {
        Some(When::Timed { start_ms, end_ms }) => {
            !current.all_day
                && current.start_ms.div_euclid(1000) == start_ms.div_euclid(1000)
                && current.end_ms.div_euclid(1000) == end_ms.div_euclid(1000)
        }
        // A day, and a time of day of a series, are compared with nothing: the read has neither.
        Some(When::AllDay { .. } | When::Clock { .. } | When::Wall { .. }) => false,
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
        ..Change::default()
    }
}

/// Whether a time can be for the part of a series a write names: the time of day of every event and
/// nothing else for all of them, and never a time of day for one event or one that does not repeat.
pub(super) fn fits(when: Option<When>, scope: Option<Scope>) -> bool {
    match when {
        None => true,
        Some(When::Clock { .. }) => scope == Some(Scope::Series),
        Some(When::Wall { .. }) => false,
        Some(_) => scope != Some(Scope::Series),
    }
}

/// The day the time of day of every event of a series is put on: the master's first day, read in the
/// zone it says it recurs in, which must be `zone`, the computer's: the time was typed on this clock,
/// and on another zone's wall it would be another time. Converting a clock time to instants would need
/// zone rules this client does not have, so a master that says no first day, rule or zone is locked,
/// and so is a series of whole days; an event of `minutes` that would outlast the gap of its rule is
/// refused, as it is when a series is made.
pub(super) fn series_day(
    master: &CalendarItem,
    zone: &str,
    minutes: u32,
) -> Result<NaiveDate, &'static str> {
    let repeat = master.repeat.as_ref();
    let (Some(first), Some(rule)) = (
        repeat.and_then(|r| r.start),
        repeat.and_then(|r| r.rule.as_ref()),
    ) else {
        return Err(LOCKED);
    };
    if master.all_day || master.zone.is_empty() {
        return Err(LOCKED);
    }
    if master.zone != zone {
        return Err(ZONE_DIFFERS);
    }
    match rule.holds(i64::from(minutes)) {
        true => Ok(first),
        false => Err("invalid_params"),
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
    /// The items of the calendar `calendar` names between two instants (milliseconds), a series as its
    /// occurrences, cancelled ones included, `page` (1 to 100) to an answer. A calendar that is not the
    /// mailbox's default one is read by its folder after the server has said the user may read it, and
    /// the answer carries what they may do there.
    pub async fn calendar_events(
        &mut self,
        start_ms: i64,
        end_ms: i64,
        page: usize,
        calendar: &Calendar,
    ) -> Result<CalendarEvents, &'static str> {
        let at = calendar.place();
        soap::calendar_view_in(start_ms, end_ms, page, true, at)?;
        let other = !calendar.is_default();
        if other && !self.home(calendar).await?.rights.read {
            return Err(decode::DENIED);
        }
        let (mut items, mut seen) = (Vec::new(), HashSet::new());
        let (mut from, mut optional, mut done) = (start_ms, true, false);
        for asked in 0..MAX_ANSWERS {
            let view = |from, optional| soap::calendar_view_in(from, end_ms, page, optional, at);
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
            other,
        })
    }

    /// Creates one appointment in the calendar `calendar` names; `zone` is the Windows id a day is made
    /// in. Any calendar but the default one is first asked of the server, and is written to only if the
    /// signed-in user may read it and make things in it: otherwise `exchange_calendar_locked`, nothing
    /// sent.
    pub async fn create_appointment(
        &mut self,
        item: &Appointment,
        zone: &str,
        calendar: &Calendar,
    ) -> Result<Written, &'static str> {
        let request = soap::create_appointment_in(item, zone, calendar.place())?;
        if !calendar.is_default() {
            let rights = self.home(calendar).await?.rights;
            if !(rights.read && rights.create) {
                return Err(LOCKED);
            }
        }
        let (id, key) = self
            .exchange(&request, false, |node| answer::written(node, "CreateItem"))
            .await
            .map_err(failure)?
            .map_err(refusal)?;
        Ok(written(&id, key, None))
    }

    /// Changes one appointment, or the part of a series `scope` names, to what `wanted` says, if it is
    /// a plain appointment still at `change_key`. What the server already has is not sent again; when
    /// that is everything, nothing is sent and the answer is the item as it is.
    pub async fn change_appointment(
        &mut self,
        id: &str,
        change_key: &str,
        wanted: &Edit,
        zone: &str,
        scope: Option<Scope>,
        calendar: &Calendar,
    ) -> Result<Written, &'static str> {
        let wire = ids::decode(id)?;
        let whole = Change {
            title: wanted.title.as_deref(),
            location: wanted.location.as_deref(),
            reminder: wanted.reminder,
            when: wanted.when.map(When::judged),
            ..Change::default()
        };
        // Judged before the connection is touched: what was named, as it would go at the most.
        if !soap::is_change_key(change_key) || !fits(wanted.when, scope) {
            return Err("invalid_params");
        }
        if whole != Change::default() {
            soap::update_appointment(&wire, change_key, &whole, zone)?;
        }
        let aim = Aim {
            scope,
            calendar,
            delete: false,
        };
        let (current, target) = self.plain_appointment(&wire, change_key, &aim).await?;
        let mut change = changes(&current, wanted);
        if let Some(when @ When::Clock { minutes, .. }) = change.when {
            change.when = Some(when.on(series_day(&current, zone, minutes)?));
        }
        let asked = ids::encode(&target)?;
        if change == Change::default() {
            return Ok(Written {
                id: asked,
                change_key: current.change_key,
            });
        }
        let request = soap::update_appointment(&target, change_key, &change, zone)?;
        let (new_id, key) = self
            .exchange(&request, false, |node| answer::written(node, "UpdateItem"))
            .await
            .map_err(failure)?
            .map_err(refusal)?;
        Ok(written(&new_id, key, Some(&asked)))
    }

    /// Moves one appointment to Deleted Items, if it is a plain appointment still at `change_key`: for
    /// a series, the one event (`Occurrence`: "only that occurrence will be deleted") or all of it
    /// (`Series`, the master: "the entire series will be deleted").
    pub async fn delete_appointment(
        &mut self,
        id: &str,
        change_key: &str,
        scope: Option<Scope>,
        calendar: &Calendar,
    ) -> Result<(), &'static str> {
        let wire = ids::decode(id)?;
        soap::delete_appointment(&wire, change_key)?;
        let aim = Aim {
            scope,
            calendar,
            delete: true,
        };
        let (_, target) = self.plain_appointment(&wire, change_key, &aim).await?;
        self.delete_item(&soap::delete_appointment(&target, change_key)?)
            .await
    }

    /// One `DeleteItem` into Deleted Items, nobody told; what its failure proves is a write's.
    pub(super) async fn delete_item(&mut self, request: &str) -> Result<(), &'static str> {
        self.exchange(request, false, |node| {
            decode::outcomes(node, "DeleteItem", 1)
        })
        .await
        .map_err(failure)?
        .pop()
        .unwrap_or(Err(Rej::INVALID))
        .map_err(refusal)
    }

    /// The item a write is for as the server holds it, and the id the write goes to: a plain
    /// appointment of the calendar folder `aim` names (the default one resolved by its distinguished
    /// name, as the view reads it, any other by its id), one event of a plain series, or the master of
    /// one (read through the event the caller names and written by its own id), at `change_key`. A
    /// delete names no `ConflictResolution`, so this read is its version check. Outside the default
    /// calendar a series is written one event at a time, nothing is deleted in another mailbox, and the
    /// item is read with the signed-in user's rights over it and written only when they include modifying
    /// it (deleting it, for a delete): the server decides, and an answer that names none grants none.
    /// Nothing has been written when this fails.
    async fn plain_appointment(
        &mut self,
        wire: &str,
        change_key: &str,
        aim: &Aim<'_>,
    ) -> Result<(CalendarItem, String), &'static str> {
        let (scope, calendar) = (aim.scope, aim.calendar);
        let other = !calendar.is_default();
        if other && scope == Some(Scope::Series) || aim.delete && calendar.is_shared() {
            return Err(LOCKED);
        }
        let (item, elsewhere) = if scope == Some(Scope::Series) {
            let master = self.master(wire, false).await?;
            (Some(master.item), master.elsewhere)
        } else {
            let home = self.home(calendar).await?;
            let request = soap::get_appointment(wire, other);
            let item = self.call(&request, true, answer::appointment).await?;
            let elsewhere = item.as_ref().is_some_and(|item| item.folder != home.id);
            (item, elsewhere)
        };
        let item = item.ok_or(LOCKED)?;
        // Another kind than the one the caller named is the item having changed since it was drawn.
        if !Scope::names(scope, item.kind) {
            return Err(CONFLICT);
        }
        let lock = match scope {
            Some(_) => item.series_lock(),
            None => item.lock(),
        };
        if lock.is_some() || elsewhere {
            return Err(LOCKED);
        }
        let rights = item.rights.unwrap_or_default();
        let allowed = if aim.delete {
            rights.delete
        } else {
            rights.modify
        };
        if other && !allowed {
            return Err(LOCKED);
        }
        if item.change_key.is_empty() {
            return Err("exchange_invalid_response");
        }
        if item.change_key != change_key {
            return Err(CONFLICT);
        }
        let target = match scope {
            Some(Scope::Series) => item.id.clone(),
            _ => wire.to_owned(),
        };
        Ok((item, target))
    }
}

/// What a write to an existing item is aimed at: the part of a series, the calendar it is in, and whether
/// it is a delete (which needs the right to delete rather than to modify).
pub(super) struct Aim<'a> {
    pub scope: Option<Scope>,
    pub calendar: &'a Calendar,
    pub delete: bool,
}
