//! An event's detail, and the owner's answer to an invitation, which is decided on a detail read.
//!
//! **The detail read** is the default calendar's folder id and one `GetItem`, reads like any other.
//! For a detail view, a server that answers the `GetItem` with an error it has no name for is asked
//! once more without the Exchange 2013 properties; nothing is remembered, and the detail says it was
//! read so (`reduced`), which offers no answer. An answer never takes that reduced read: it fails with
//! the first read's code and sends nothing. An item that is not a calendar item, or has
//! no start or end, is `exchange_message_not_found`; one that is not in the default calendar folder
//! is said to be elsewhere and nothing is written to it from here, the rule of an appointment's
//! write (`calendar`). For an invitation the Inbox is also looked at for a cancellation of the same
//! meeting, a second read the detail can do without (it then says nothing of one).
//!
//! **An answer is the one thing this provider mails to somebody who asked for it**, the organizer,
//! so it is two requests and the first decides whether the second is sent:
//!
//! 1. The detail read again, now, whatever the screen drew (an item outside the default calendar is
//!    `exchange_calendar_locked`), and the Inbox's cancellations, which here must be read: an answer to a meeting its organizer has cancelled would tell them the owner is
//!    coming to something that is over. Only what `EventDetail::invitation` calls an invitation the
//!    owner may answer goes on, else `exchange_calendar_not_invitation`; then the version, and one
//!    that is not the caller's is `exchange_calendar_conflict`, never retried with a fresh key (the
//!    answer would be to something other than what the person saw). Nothing has been sent.
//! 2. `CreateItem` of the response object, never repeated. The server re-creates the calendar item
//!    under another id on every answer, and the answer names it when the server did.
//! 3. Only for a sent decline asked to `remove` the meeting, of a single item or a whole series: where
//!    the server left it on the calendar it is deleted into Deleted Items with nobody told (a single
//!    item found by its `UID` and start; a series by its master, looked for by its own id and the id
//!    the answer gave it). A best effort that never fails the answer, and never says the meeting is off
//!    unless the reads say so.
//!
//! **A whole series is answered through its master** ("the entire series"), read through the event
//! named: it must itself be an invitation the owner may answer (`EventDetail::series_invitation`,
//! only a cancellation of the whole series counting against it) at the version the caller drew. One
//! event is answered by its own id, as ever.
//!
//! What a failure of the answer proves is what it proves for an appointment (`calendar`): a code
//! that says the server did nothing keeps its name, and anything else once the request was written
//! is `exchange_calendar_unconfirmed`: the organizer may have been told.

use super::super::decode::NOT_FOUND;
use super::super::decode::calendar::{self as view, CalendarItem};
use super::super::decode::detail::{self as answer, Cancellation, Cancelled, EventDetail};
use super::super::soap::calendar::{self as soap, Answer, MAX_ENTRIES};
use super::Client;
use super::calendar::{CONFLICT, LOCKED, SERVER, Written, failure, refusal, written};
use crate::providers::exchange::ids;

pub const NOT_INVITATION: &str = "exchange_calendar_not_invitation";

/// What an answer did: the item as the server named it afterwards, and, for a decline asked to
/// remove the meeting, whether it is off the calendar.
pub struct Answered {
    pub written: Written,
    pub removed: Option<bool>,
}

impl Client {
    /// The calendar item `id` (an Omamail id) names, with its notes, people, reminder and link, for
    /// an invitation whether a cancellation of it waits in the Inbox, and for an event of a series
    /// what the series is (two reads the detail can do without).
    pub async fn event_detail(&mut self, id: &str) -> Result<EventDetail, &'static str> {
        let wire = ids::decode(id)?;
        let mut found = self.detail(&wire, true).await?;
        let mut inbox = None;
        if !found.elsewhere && found.incoming() && !found.item.cancelled {
            inbox = self.cancellations().await.ok();
            found.cancellation = verdict(inbox.as_deref().unwrap_or_default(), &found);
        }
        if !found.elsewhere && found.item.is_series() {
            found.series = self.series_of(&wire, &found, inbox).await;
        }
        Ok(found)
    }

    /// The detail read, and with `may_reduce` once more without the Exchange 2013 properties when a
    /// server refused the first with an error it has no name for; and whether the item is outside
    /// the default calendar.
    pub(super) async fn detail(
        &mut self,
        wire: &str,
        may_reduce: bool,
    ) -> Result<EventDetail, &'static str> {
        self.read_detail(wire, may_reduce, soap::event_detail).await
    }

    /// `detail` of the master of the series the event `wire` belongs to, with its rule and zone.
    pub(super) async fn master(
        &mut self,
        wire: &str,
        may_reduce: bool,
    ) -> Result<EventDetail, &'static str> {
        self.read_detail(wire, may_reduce, soap::master_detail)
            .await
    }

    async fn read_detail(
        &mut self,
        wire: &str,
        may_reduce: bool,
        read: fn(&str, bool) -> String,
    ) -> Result<EventDetail, &'static str> {
        let request = soap::get_calendar_folder();
        let calendar = self.call(&request, true, view::folder_id).await?;
        let (found, reduced) = match self.call(&read(wire, true), true, answer::detail).await {
            Err(SERVER) if may_reduce => {
                let plain = read(wire, false);
                (self.call(&plain, true, answer::detail).await?, true)
            }
            found => (found?, false),
        };
        let mut found = found.ok_or(NOT_FOUND)?;
        found.elsewhere = found.item.folder != calendar;
        found.reduced = reduced;
        Ok(found)
    }

    /// The `MeetingCancellation`s among the Inbox's newest.
    pub(super) async fn cancellations(&mut self) -> Result<Vec<Cancellation>, &'static str> {
        let request = soap::find_cancellations();
        self.call(&request, true, answer::cancellations).await
    }

    /// Answers the invitation `id` names, or with `series` the whole series it belongs to, if it is one
    /// the owner may answer and is still at `change_key`. `send` false asks the server to keep the
    /// answer and mail nobody; `remove`, for a sent decline of a single item or a whole series, also
    /// takes the meeting off the calendar, as Outlook does.
    pub async fn respond(
        &mut self,
        id: &str,
        change_key: &str,
        reply: Answer,
        send: bool,
        remove: bool,
        series: bool,
    ) -> Result<Answered, &'static str> {
        let wire = ids::decode(id)?;
        // Judged before the connection is touched: the request, as it would go.
        soap::respond(&wire, change_key, reply, send)?;
        if remove && (reply != Answer::Decline || !send) {
            return Err("invalid_params");
        }
        let mut current = match series {
            true => self.master(&wire, false).await?,
            false => self.detail(&wire, false).await?,
        };
        if current.elsewhere {
            return Err(LOCKED);
        }
        if (current.incoming() || current.series_incoming()) && !current.item.cancelled {
            let inbox = self.cancellations().await?;
            current.cancellation = match series {
                true => series_cancelled(&inbox, &current),
                false => verdict(&inbox, &current),
            };
        }
        let invitation = match series {
            true => current.series_invitation(),
            false => current.invitation(),
        };
        if !invitation {
            return Err(NOT_INVITATION);
        }
        // Without a key nothing says it is the version the caller drew.
        if current.item.change_key.is_empty() {
            return Err("exchange_invalid_response");
        }
        if current.item.change_key != change_key {
            return Err(CONFLICT);
        }
        // An answer to one event of a series leaves the series where it is.
        if remove && !series && (current.item.kind != "single" || current.item.recurring) {
            return Err(LOCKED);
        }
        // The answer goes to the item that was read: for a series, its master.
        let target = if series { &current.item.id } else { &wire };
        let request = soap::respond(target, change_key, reply, send)?;
        let (new_id, new_key) = self
            .exchange(&request, false, |node| view::written(node, "CreateItem"))
            .await
            .map_err(failure)?
            .map_err(refusal)?;
        let written = written(&new_id, new_key, None);
        let removed = match (remove, series) {
            (false, _) => None,
            (true, false) => Some(self.remove_declined(&current.item).await),
            (true, true) => Some(self.remove_declined_series(&current.item, &new_id).await),
        };
        Ok(Answered { written, removed })
    }

    /// After the owner's decline: whether the meeting is off the calendar. Where the server left it (the
    /// same `UID` and start, a single meeting the owner declined) it is deleted, nobody told.
    async fn remove_declined(&mut self, item: &CalendarItem) -> bool {
        if item.uid.is_empty() {
            return false;
        }
        let until = item.end_ms.max(item.start_ms.saturating_add(1000));
        let Ok(request) = soap::calendar_view(item.start_ms, until, MAX_ENTRIES, false) else {
            return false;
        };
        let Ok(page) = self.call(&request, true, view::calendar_view).await else {
            return false;
        };
        let left = page.items.into_iter().find(|found| {
            found.uid == item.uid && found.start_ms == item.start_ms && found.kind == "single"
        });
        let Some(left) = left else {
            return true;
        };
        if !left.meeting || left.response != "decline" || left.private {
            return false;
        }
        self.delete_left(&left).await
    }

    /// After the owner's decline of all of a series: whether it is off the calendar, as far as reads
    /// can tell. Microsoft says the entire series goes with its master, so the master is looked for by
    /// its own id and by the id the answer gave the item (`answered`, the server's, when it named one),
    /// whatever became of any one event: gone, or in another folder (Deleted Items), it is off; still on
    /// the calendar as a master of the same `UID` the owner declined, it is deleted, nobody told. A read
    /// that fails, or anything else found, is not called off.
    async fn remove_declined_series(&mut self, master: &CalendarItem, answered: &str) -> bool {
        let mut ids = vec![master.id.clone()];
        if !answered.is_empty() && answered != master.id {
            ids.push(answered.to_owned());
        }
        for id in ids {
            let found = match self.detail(&id, false).await {
                Err(NOT_FOUND) => continue,
                Err(_) => return false,
                Ok(found) if found.elsewhere => continue,
                Ok(found) => found.item,
            };
            let declined = found.kind == "master" && found.response == "decline";
            if !declined || found.uid.is_empty() || found.uid != master.uid {
                return false;
            }
            if !self.delete_left(&found).await {
                return false;
            }
        }
        true
    }

    /// Deletes what a decline left on the calendar, nobody told; whether the server confirmed it.
    async fn delete_left(&mut self, left: &CalendarItem) -> bool {
        let Ok(request) = soap::delete_appointment(&left.id, &left.change_key) else {
            return false;
        };
        self.delete_item(&request).await.is_ok()
    }
}

/// What the cancellations say of the item of `detail`, the strongest deciding.
pub(super) fn verdict(inbox: &[Cancellation], detail: &EventDetail) -> Cancelled {
    let said = inbox.iter().map(|message| message.is_for(detail));
    said.max().unwrap_or_default()
}

/// What the cancellations say of the series whose master is `master` as a whole: only one that names
/// no event cancels all of it (one event cancelled leaves the rest to answer).
pub(super) fn series_cancelled(inbox: &[Cancellation], master: &EventDetail) -> Cancelled {
    let whole = |message: &Cancellation| {
        message.occurrence.is_none() && message.is_for_series(&master.item)
    };
    match inbox.iter().any(whole) {
        true => Cancelled::Yes,
        false => Cancelled::No,
    }
}
