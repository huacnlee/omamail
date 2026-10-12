//! Meetings with other people: making one, changing and cancelling one the owner organises, and taking
//! one somebody else organised and cancelled (or the owner declined) off the calendar. The requests are
//! `soap::calendar`'s; this decides when one is sent and what each failure proves.
//!
//! Everything here that mails a person works as a write to an appointment does (`calendar`), with
//! somebody else on the other end:
//!
//! 1. **Nothing is sent before the item has been read again, now**: the detail read with its people
//!    and folder, and only a meeting `EventDetail::organised` calls the owner's own goes on (a single
//!    meeting of the default calendar the owner sent, with somebody besides the owner on it, every
//!    person read with an address, no room, not private or cancelled). Anything else is
//!    `exchange_calendar_locked`, whatever the screen drew. Then the change key: another one is `exchange_calendar_conflict`, never retried
//!    with a fresh one, because a retry would tell the people about a change made over somebody
//!    else's.
//! 2. **The write is sent once.** A failure that proves the server did nothing keeps its code; any
//!    other failure once the request was written is `exchange_calendar_unconfirmed`: the people may
//!    have been told.
//! 3. **An update names the whole of each list it changes and nothing else.** The people are compared
//!    with what the server holds by address, ignoring case: a list that is the same is not written,
//!    and a change that changes nothing sends nothing; one of the owner's reminder alone tells nobody
//!    (`soap::calendar::update_meeting`) and answers `sent: false`. A list with somebody on it whose address the
//!    server did not give cannot be written back whole and is not written (`exchange_calendar_locked`),
//!    because rewriting it would take them off and tell them so. The owner, whom the server may list on
//!    their own meeting, is carried over: the person editing the list cannot name themselves.
//!
//! **Taking a meeting off the calendar mails nobody.** The organizer's cancellation arrives in the
//! Inbox as a `MeetingCancellation`, found by the `UID` it shares with the item
//! (`Cancellation::is_for`, which a cancellation the server says is out of date never matches: the
//! organizer took the owner off and put them back), and is processed with a `RemoveItem` response
//! object; a refusal of it is said, and the calendar item is never deleted instead. Only a meeting the
//! server itself flags cancelled, and one the owner declined, are moved to Deleted Items with
//! `SendToNone` ("a calendar item is deleted without sending a cancellation message"). An invitation nobody cancelled or declined is
//! `exchange_calendar_not_removable`: deleting it would leave its organizer waiting.

use std::collections::HashSet;

use super::super::decode::calendar as view;
use super::super::decode::detail::{self as answer, Cancellation, Cancelled, EventDetail};
use super::super::decode::{self, Rej};
use super::super::soap::calendar::{self as soap, Appointment, Change};
use super::Client;
use super::calendar::{CONFLICT, Edit, LOCKED, Written, changes, failure, refusal, written};
use crate::providers::exchange::guests::{self, Guests};
use crate::providers::exchange::ids;

pub const NOT_REMOVABLE: &str = "exchange_calendar_not_removable";

/// A change of a meeting the owner organises: what `Edit` says, and each list of people as it is to
/// be when it is to change (`None` leaves it as the server has it).
pub struct MeetingEdit {
    pub edit: Edit,
    pub required: Option<Vec<String>>,
    pub optional: Option<Vec<String>>,
}

/// What a change of a meeting did; `sent` is false when the server already held what was asked for.
pub struct Changed {
    pub written: Written,
    pub sent: bool,
}

fn is_owner(who: &str, owner: &str) -> bool {
    !owner.is_empty() && who.eq_ignore_ascii_case(owner)
}

/// The addresses the server holds in one list of the meeting, the owner's own left out, and whether
/// the owner was on it. `None` for a list that cannot be written back whole: somebody on it has no
/// address.
fn held(current: &EventDetail, kind: &str, owner: &str) -> Option<(Vec<String>, bool)> {
    let (mut list, mut own) = (Vec::new(), false);
    for who in current.attendees.iter().filter(|who| who.kind == kind) {
        match who.who.address.as_str() {
            "" => return None,
            address if is_owner(address, owner) => own = true,
            address => list.push(address.to_owned()),
        }
    }
    Some((list, own))
}

fn lower(list: &[String]) -> HashSet<String> {
    list.iter()
        .map(|address| address.to_ascii_lowercase())
        .collect()
}

/// The list of one kind to write, `None` to leave it: what the caller wants, with the owner carried
/// over, when that differs from what the server holds.
fn list_to_write(
    current: &EventDetail,
    kind: &str,
    wanted: Option<&Vec<String>>,
    owner: &str,
) -> Result<Option<Vec<String>>, &'static str> {
    let Some(wanted) = wanted else {
        return Ok(None);
    };
    let (held, own) = held(current, kind, owner).ok_or(LOCKED)?;
    if lower(&held) == lower(wanted) {
        return Ok(None);
    }
    let mut list = wanted.clone();
    if own {
        list.push(owner.to_owned());
    }
    Ok(Some(list))
}

impl Client {
    /// Creates a meeting in the default calendar and mails its invitations to `guests` (at least one
    /// person), a copy kept in Sent Items. `zone` is the Windows id an all-day meeting is made in. Like
    /// every write it goes on a stream the folder lookup has signed in, so a refused password never
    /// leaves a meeting made and mailed.
    pub async fn create_meeting(
        &mut self,
        item: &Appointment,
        guests: &Guests,
        zone: &str,
    ) -> Result<Written, &'static str> {
        let request = soap::create_meeting(item, guests, zone)?;
        let (id, key) = self
            .exchange(&request, false, |node| view::written(node, "CreateItem"))
            .await
            .map_err(failure)?
            .map_err(refusal)?;
        Ok(written(&id, key, None))
    }

    /// The meeting `wire` names as the server holds it now, if the owner organises it and it is still
    /// at `change_key`. Nothing has been sent when this fails.
    async fn organised_meeting(
        &mut self,
        wire: &str,
        change_key: &str,
        owner: &str,
    ) -> Result<EventDetail, &'static str> {
        let current = self.detail(wire, false).await?;
        if !current.organised(owner) {
            return Err(LOCKED);
        }
        if current.item.change_key.is_empty() {
            return Err("exchange_invalid_response");
        }
        if current.item.change_key != change_key {
            return Err(CONFLICT);
        }
        Ok(current)
    }

    /// Changes a meeting the owner organises to what `wanted` says, if it is still at `change_key`,
    /// and tells everybody on it (and anybody it takes off). `owner` is the mailbox's own address.
    pub async fn change_meeting(
        &mut self,
        id: &str,
        change_key: &str,
        wanted: &MeetingEdit,
        owner: &str,
        zone: &str,
    ) -> Result<Changed, &'static str> {
        let wire = ids::decode(id)?;
        let (required, optional) = (wanted.required.as_deref(), wanted.optional.as_deref());
        guests::check(
            required.unwrap_or_default(),
            optional.unwrap_or_default(),
            owner,
        )?;
        // Judged before the connection is touched: the whole change, as it would go at the most.
        let edit = &wanted.edit;
        let whole = Change {
            title: edit.title.as_deref(),
            location: edit.location.as_deref(),
            reminder: edit.reminder,
            when: edit.when,
            required,
            optional,
        };
        if whole != Change::default() {
            soap::update_meeting(&wire, change_key, &whole, zone)?;
        }
        let current = self.organised_meeting(&wire, change_key, owner).await?;
        let new_required = list_to_write(&current, "required", wanted.required.as_ref(), owner)?;
        let new_optional = list_to_write(&current, "optional", wanted.optional.as_ref(), owner)?;
        // The people as they will be: nobody left is an appointment (cancelled, not changed), and a
        // person is on one list only.
        let after = |list: &Option<Vec<String>>, kind| match list {
            Some(list) => Some(
                list.iter()
                    .filter(|a| !is_owner(a, owner))
                    .cloned()
                    .collect(),
            ),
            None => held(&current, kind, owner).map(|(list, _)| list),
        };
        let (required_after, optional_after): (Option<Vec<String>>, Option<Vec<String>>) = (
            after(&new_required, "required"),
            after(&new_optional, "optional"),
        );
        if required_after.as_ref().map_or(1, Vec::len) + optional_after.as_ref().map_or(1, Vec::len)
            == 0
        {
            return Err("invalid_params");
        }
        let (both_required, both_optional) = (
            required_after.unwrap_or_default(),
            optional_after.unwrap_or_default(),
        );
        guests::check(&both_required, &both_optional, "")?;
        let change = Change {
            required: new_required.as_deref(),
            optional: new_optional.as_deref(),
            ..changes(&current.item, edit)
        };
        if change == Change::default() {
            let written = Written {
                id: id.to_owned(),
                change_key: current.item.change_key,
            };
            return Ok(Changed {
                written,
                sent: false,
            });
        }
        let request = soap::update_meeting(&wire, change_key, &change, zone)?;
        let (new_id, key) = self
            .exchange(&request, false, |node| view::written(node, "UpdateItem"))
            .await
            .map_err(failure)?
            .map_err(refusal)?;
        Ok(Changed {
            written: written(&new_id, key, Some(id)),
            sent: !change.reminder_only(),
        })
    }

    /// Cancels a meeting the owner organises, if it is still at `change_key`: everybody on it is told,
    /// with `note` as the organizer's words, and it leaves the owner's calendar. The answer is how many
    /// people were on it besides the owner.
    pub async fn cancel_meeting(
        &mut self,
        id: &str,
        change_key: &str,
        note: Option<&str>,
        owner: &str,
    ) -> Result<usize, &'static str> {
        let wire = ids::decode(id)?;
        let request = soap::cancel_meeting(&wire, change_key, note)?;
        let current = self.organised_meeting(&wire, change_key, owner).await?;
        let others = current.attendees.iter();
        let told = others
            .filter(|who| !is_owner(&who.who.address, owner))
            .count();
        self.exchange(&request, false, |node| view::written(node, "CreateItem"))
            .await
            .map_err(failure)?
            .map_err(refusal)?;
        Ok(told)
    }

    /// Takes a meeting somebody else organised off the calendar, if they cancelled it or the owner
    /// declined it, and it is still at `change_key`. Nobody is mailed. The answer is why it could go:
    /// `cancelled` or `declined`.
    pub async fn remove_meeting(
        &mut self,
        id: &str,
        change_key: &str,
    ) -> Result<&'static str, &'static str> {
        let wire = ids::decode(id)?;
        let delete = soap::delete_appointment(&wire, change_key)?;
        let mut current = self.detail(&wire, false).await?;
        if current.elsewhere {
            return Err(LOCKED);
        }
        let message = match current.incoming() && !current.item.cancelled {
            true => {
                let request = soap::find_cancellations();
                let found = self.call(&request, true, answer::cancellations).await?;
                // Only a cancellation certainly this meeting's: a doubt removes nothing.
                let certain = |message: &Cancellation| message.is_for(&current) == Cancelled::Yes;
                found.into_iter().find(certain)
            }
            false => None,
        };
        current.cancellation = match message {
            Some(_) => Cancelled::Yes,
            None => Cancelled::No,
        };
        let why = current.removal().ok_or(NOT_REMOVABLE)?;
        if current.item.change_key.is_empty() {
            return Err("exchange_invalid_response");
        }
        if current.item.change_key != change_key {
            return Err(CONFLICT);
        }
        if let Some(message) = message {
            self.remove_message(&message).await?;
            return Ok(why);
        }
        // A meeting the server itself flags cancelled, or one the owner declined: Microsoft's
        // `DeleteItem` with `SendToNone`, "a calendar item is deleted without sending a cancellation
        // message".
        self.exchange(&delete, false, |node| {
            decode::outcomes(node, "DeleteItem", 1)
        })
        .await
        .map_err(failure)?
        .pop()
        .unwrap_or(Err(Rej::INVALID))
        .map_err(refusal)?;
        Ok(why)
    }

    /// The `RemoveItem` for a cancellation, the way Microsoft documents to process one ("used to
    /// remove a meeting item when a MeetingCancellation message is received"). A refusal is said and
    /// nothing else is tried: deleting the calendar item instead would take off a meeting the server
    /// may know is still on. A message with no version to name is a damaged answer.
    async fn remove_message(&mut self, message: &Cancellation) -> Result<(), &'static str> {
        let request = soap::remove_cancellation(&message.id, &message.change_key)
            .map_err(|_| "exchange_invalid_response")?;
        self.exchange(&request, false, |node| {
            decode::outcomes(node, "CreateItem", 1)
        })
        .await
        .map_err(failure)?
        .pop()
        .unwrap_or(Err(Rej::INVALID))
        .map_err(refusal)
    }
}
