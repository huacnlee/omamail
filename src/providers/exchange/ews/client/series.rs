//! A series seen from one of its events: what a screen is told of it, and taking a series its
//! organizer cancelled off the calendar in one call.
//!
//! A calendar view lists the occurrences and exceptions of a series and never its master ("this hides
//! recurring master appointments from the result set"); the master is what all of the series is
//! changed, deleted and answered through, and it is read through one of its events
//! (`Client::master`). Its change key is the version of the whole series: Microsoft says it "is the
//! same for the recurring master and all occurrences" and changes "if either the recurring master or
//! any of its occurrences change".
//!
//! **Taking a cancelled series off the calendar mails nobody**, and everything is judged before the
//! first write: the master read through the event named, the Inbox's cancellations of its `UID` and of
//! nothing else, and `EventDetail::series_removal`, which says the organizer cancelled the series as a
//! whole or at least two of its events; a cancellation the server says is out of date counts for
//! nothing. Each cancellation is then processed with a saved `RemoveItem`, the whole series' first
//! (where it takes the series, the rest is moot), at most `MAX_SERIES_REMOVALS` in a call; one the
//! server says is gone is skipped, a refusal is said and nothing is deleted instead, and `more` says
//! some are left (the bound, or no time for another write). A series whose whole cancellation was
//! processed is then read again by its master's own id, and where the server left it as a meeting the
//! owner was sent, the master is deleted with `SendToNone` at the version it has now, which takes every
//! event; so is one the server itself flags cancelled. Once anything was taken off, no failure after
//! it is the answer: the count is, with `more` or `left` saying it did not finish. A
//! series of which only some events were cancelled is never deleted by its master: the cancelled events
//! go and the rest stays.

use super::super::decode::NOT_FOUND;
use super::super::decode::detail::{
    self as answer, Cancellation, EventDetail, MAX_EXCEPTIONS, People, Series,
};
use super::super::soap::calendar as soap;
use super::Client;
use super::calendar::{CONFLICT, LOCKED};
use super::detail::series_cancelled;
use super::meeting::NOT_REMOVABLE;
use crate::providers::exchange::ids;

/// Cancellations one removal processes: below the hundred the Inbox read shows, so the bound is real.
const MAX_SERIES_REMOVALS: usize = 50;
const TIMEOUT: &str = "exchange_timeout";

/// What taking a cancelled series off the calendar did: the removals made (cancellations processed,
/// and the master deleted where they left it), whether cancellations of it are left (`more`: the
/// bound, no time for another write, or a refusal after some were processed), and whether what the
/// server left of a series cancelled as a whole may still be on the calendar (`left`: it could not be
/// read again or removed after its cancellation was processed).
pub struct SeriesRemoved {
    pub count: u32,
    pub more: bool,
    pub left: bool,
}

impl Client {
    /// What the series of the event `wire` (read as `found`) is: `None` when its master cannot be read.
    /// `inbox` is the Inbox's cancellations when the detail already read them.
    pub(super) async fn series_of(
        &mut self,
        wire: &str,
        found: &EventDetail,
        mut inbox: Option<Vec<Cancellation>>,
    ) -> Option<Series> {
        let mut master = match found.item.kind {
            "master" => found.clone(),
            _ => self.master(wire, true).await.ok()?,
        };
        if master.item.kind != "master" {
            return None;
        }
        if master.series_incoming() && !master.item.cancelled {
            if inbox.is_none() {
                inbox = self.cancellations().await.ok();
            }
            master.cancellation = series_cancelled(inbox.as_deref().unwrap_or_default(), &master);
        }
        let inbox = inbox.unwrap_or_default();
        // Only a meeting the owner may organise is changed for all of its people; a master opened by
        // its own id was read without its exceptions, which are then unknown.
        let exceptions = match (master.item.meeting, found.item.kind) {
            (false, _) => Some(Vec::new()),
            (true, _) if master.received_master() => Some(Vec::new()),
            (true, "master") => None,
            (true, _) => self.exception_people(&master).await,
        };
        Some(Series {
            key: master.item.change_key.clone(),
            repeat: master.item.repeat.clone().unwrap_or_default(),
            can_respond: master.series_invitation(),
            removal: master.series_removal(&inbox),
            master: Box::new(master),
            exceptions,
        })
    }

    /// The people on each exception of the series whose master (read with its `ModifiedOccurrences`)
    /// is `master`, in one `GetItem`; `None` when they were not all read: more than `MAX_EXCEPTIONS`,
    /// one listed with no id, or a read that failed.
    pub(super) async fn exception_people(&mut self, master: &EventDetail) -> Option<Vec<People>> {
        let ids = &master.modified;
        if ids.is_empty() {
            return Some(Vec::new());
        }
        if ids.len() > MAX_EXCEPTIONS || ids.iter().any(String::is_empty) {
            return None;
        }
        let request = soap::exception_people(ids);
        let expected = ids.len();
        let read = self
            .call(&request, true, |node| {
                answer::exception_people(node, expected)
            })
            .await
            .ok()?;
        read.into_iter().collect::<Result<Vec<_>, _>>().ok()
    }

    /// Takes the whole series the event `id` belongs to off the calendar, if its organizer cancelled it
    /// and it is still at `change_key` (the series' version: its master's). Nobody is mailed.
    pub async fn remove_series(
        &mut self,
        id: &str,
        change_key: &str,
    ) -> Result<SeriesRemoved, &'static str> {
        let wire = ids::decode(id)?;
        // Judged before the connection is touched: the delete, as it would go.
        soap::delete_appointment(&wire, change_key)?;
        let master = self.master(&wire, false).await?;
        if master.elsewhere {
            return Err(LOCKED);
        }
        // A series the server flags cancelled needs no look in the Inbox.
        let inbox = match master.item.cancelled {
            true => Vec::new(),
            false => self.cancellations().await?,
        };
        let events = master.series_removal(&inbox).ok_or(NOT_REMOVABLE)?;
        if master.item.change_key.is_empty() {
            return Err("exchange_invalid_response");
        }
        if master.item.change_key != change_key {
            return Err(CONFLICT);
        }
        let mut mine: Vec<&Cancellation> = inbox
            .iter()
            .filter(|message| message.is_for_series(&master.item))
            .collect();
        mine.sort_by_key(|message| message.occurrence.is_some());
        let (mut count, mut stopped, mut whole) = (0u32, false, false);
        let mut queue = mine.into_iter();
        for message in queue.by_ref().take(MAX_SERIES_REMOVALS) {
            match self.remove_message(message).await {
                Ok(()) => {
                    count += 1;
                    // The whole series' cancellation, processed: the rest is moot.
                    if message.occurrence.is_none() {
                        whole = true;
                        break;
                    }
                }
                // Gone already: an earlier cancellation took it, or another client did.
                Err(NOT_FOUND) => {}
                // Nothing was sent for this one: no time was left to write it in.
                Err(TIMEOUT) => {
                    stopped = true;
                    break;
                }
                // A refusal is said, and nothing is deleted instead (as for a single meeting); once
                // something was taken off, that is said, with the rest left for the next call.
                Err(code) if count == 0 => return Err(code),
                Err(_) => {
                    stopped = true;
                    break;
                }
            }
        }
        if events == 0 && (whole || master.item.cancelled) {
            // What the server left once the whole cancellation was processed, or a master it flags
            // cancelled, is deleted by its master, at the version it has now.
            let left = match whole {
                false => Ok(Some(master)),
                true => match self.detail(&master.item.id, false).await {
                    Err(NOT_FOUND) => Ok(None),
                    found => found.map(Some),
                },
            };
            let deleted = match left {
                Ok(None) => Ok(false),
                Ok(Some(left)) if left.received_master() => {
                    match soap::delete_appointment(&left.item.id, &left.item.change_key) {
                        Ok(request) => self.delete_item(&request).await.map(|()| true),
                        Err(_) => Err(CONFLICT),
                    }
                }
                Ok(Some(_)) => Err(CONFLICT),
                Err(code) => Err(code),
            };
            return match deleted {
                Ok(master) => Ok(SeriesRemoved {
                    count: count + u32::from(master),
                    more: false,
                    left: false,
                }),
                // Cancellations were processed: that is said, with what may be left of the series.
                Err(_) if count > 0 => Ok(SeriesRemoved {
                    count,
                    more: false,
                    left: true,
                }),
                Err(code) => Err(code),
            };
        }
        match count {
            0 if stopped => Err(TIMEOUT),
            0 => Err(NOT_FOUND),
            _ => Ok(SeriesRemoved {
                count,
                more: stopped || queue.len() > 0,
                left: false,
            }),
        }
    }
}
