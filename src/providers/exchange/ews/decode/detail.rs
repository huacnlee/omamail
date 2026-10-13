//! An event's detail (`soap::calendar::event_detail`) and the Inbox's meeting cancellations
//! (`soap::calendar::find_cancellations`). Written from Microsoft's CalendarItem, Body, BodyType,
//! Attendee, Mailbox, ResponseType, MyResponseType, AppointmentState, IsOrganizer, ResponseObjects,
//! JoinOnlineMeetingUrl, MeetingCancellation, AssociatedCalendarItemId and UID pages. Beyond the rules
//! of `calendar`:
//!
//! - **The notes are plain text, always.** The request asks for `BodyType` `Text`, "the item body as
//!   plain text"; a server that answers `HTML` anyway is not believed, and the body goes through
//!   `html_to_text`, which keeps text and nothing of the markup. Either way control characters are
//!   removed and the text is cut at `MAX_NOTES_BYTES` on a character boundary and says so.
//! - **The people are bounded**: at most `MAX_PEOPLE` in the three lists together (`attendees_cut`
//!   when more were listed), a name cut and an address over its bound dropped (cut, it would be
//!   another address). A response word that is not Microsoft's is `unknown`.
//! - **A link is only an `https` address** of printable ASCII with no user name, at most
//!   `MAX_JOIN_URL_BYTES`: anything else is no link.
//! - What may be shown and answered is decided elsewhere: the provider masks a private item, and
//!   `EventDetail::invitation` says whether the owner may answer, every signal agreeing.

use std::collections::BTreeSet;

use super::super::soap::calendar::is_change_key;
use super::calendar::{self, MAX_ELEMENTS, MAX_NAME_BYTES, MAX_UID_BYTES, cap, instant};
use super::calendar::{CalendarItem, Lock};
use super::{Party, Rej, check, each, first_item, id_attr, messages, party};
use crate::providers::exchange::ews::xml::Node;
use crate::providers::exchange::recurrence::Repeat;

/// A page and a half of notes is what a detail view shows; the rest is cut and said to be.
const MAX_NOTES_BYTES: usize = 16 * 1024;
/// What is read of a body before it is cleaned: markup around the text can be most of it.
const MAX_RAW_NOTES_BYTES: usize = 8 * MAX_NOTES_BYTES;
const MAX_JOIN_URL_BYTES: usize = 2048;
const MAX_ADDRESS_BYTES: usize = 320;
/// People returned for one item, the three lists together.
const MAX_PEOPLE: usize = 200;
/// Attendee elements looked at per list.
const PEOPLE_EXAMINED: usize = 1000;
/// `AppointmentState`: "the appointment was received, which means that someone sent it to the user".
const RECEIVED: u32 = 0x2;
/// Exceptions of a series whose people are read before all of it is changed or cancelled; past this
/// the series is locked rather than guessed.
pub const MAX_EXCEPTIONS: usize = 50;

/// The people on one item, and whether more were listed than were kept (`people`).
pub type People = (Vec<Attendee>, bool);

/// One person on an item, as a `GetItem` lists them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attendee {
    pub who: Party,
    /// `required`, `optional` or `resource`: the list the server named them in.
    pub kind: &'static str,
    /// Their `ResponseType`, which Microsoft says is "only relevant to a meeting organizer's calendar
    /// item": on an invitation it says nothing about the others.
    pub response: &'static str,
}

/// One calendar item with what a detail view shows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EventDetail {
    pub item: CalendarItem,
    pub notes: String,
    pub notes_cut: bool,
    pub organizer: Option<Party>,
    pub attendees: Vec<Attendee>,
    pub attendees_cut: bool,
    /// `JoinOnlineMeetingUrl`, an `https` address or empty.
    pub join_url: String,
    /// `IsOrganizer`, `None` when the server did not say.
    pub is_organizer: Option<bool>,
    /// `AppointmentState`, `None` when the server did not say.
    pub state: Option<u32>,
    /// Whether the response objects listed for the item include `AcceptItem`; `None` when none were.
    pub can_accept: Option<bool>,
    /// Whether they include `CancelCalendarItem`, which Microsoft says only the organizer sees.
    pub can_cancel: Option<bool>,
    /// Where an event of a series sits: its `RecurrenceId`, else its `OriginalStart` (both asked for
    /// with the Exchange 2013 properties); `None` when the server did not say.
    pub position: Option<i64>,
    /// What the Inbox's cancellations say of this meeting. Not part of a `GetItem`: the client looks.
    pub cancellation: Cancelled,
    /// The item is not in the calendar folder the read named (the mailbox's default one unless the call
    /// named another), so nothing is written to it from here: an answer no more than a change. Not part
    /// of a `GetItem`: the client compares.
    pub elsewhere: bool,
    /// Read without the Exchange 2013 properties, which an answer's read cannot go without: an answer
    /// from this screen would always fail, so none is offered. Not part of a `GetItem`.
    pub reduced: bool,
    /// For a member of a series, what a read of its master said; `None` when it could not be read.
    /// Not part of a `GetItem`.
    pub series: Option<Series>,
    /// For a master read with its `ModifiedOccurrences`, the ids of its exceptions, at most one past
    /// `MAX_EXCEPTIONS` (an exception listed with no id is an empty one).
    pub modified: Vec<String>,
}

/// What a read of a series' master shows a screen that has one of its events.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Series {
    /// The master as it was read, which all of the series is judged on.
    pub master: Box<EventDetail>,
    /// The master's change key, which a write to all of the series names.
    pub key: String,
    pub repeat: Repeat,
    /// All of it may be answered (`EventDetail::series_invitation`).
    pub can_respond: bool,
    /// `EventDetail::series_removal`: its organizer cancelled it.
    pub removal: Option<u32>,
    /// The people on each of its exceptions, for a meeting the owner may organise; `None` when they
    /// were not all read.
    pub exceptions: Option<Vec<People>>,
}

impl Series {
    /// Why `owner` may not change all of it from here: `EventDetail::screen_lock` of the master, and
    /// for a meeting, an exception whose people are not the master's (`exceptions_agree`).
    pub fn lock(&self, owner: &str) -> Option<Lock> {
        let master = &self.master;
        master.screen_lock(owner).or_else(|| {
            let agree = master.exceptions_agree(self.exceptions.as_deref(), owner);
            (master.item.meeting && !agree).then_some(Lock::ExceptionGuests)
        })
    }

    /// Whether the time of day of every event may be changed on a computer in `zone`: a series of
    /// timed events whose rule and first day were read, recurring in that very zone (a time typed on
    /// this clock is another time on another zone's wall).
    pub fn time_editable(&self, zone: Option<&str>) -> bool {
        let (item, repeat) = (&self.master.item, &self.repeat);
        let here = zone.is_some_and(|zone| !item.zone.is_empty() && item.zone == zone);
        here && !item.all_day && repeat.start.is_some() && repeat.rule.is_some()
    }
}

/// What the Inbox's cancellations say of an item, the strongest of them deciding.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum Cancelled {
    #[default]
    No,
    /// One event of its series was cancelled and this item does not say where in the series it sits:
    /// it may be that event or another. It is not answered, and not said to be cancelled.
    Unplaced,
    /// The organizer cancelled this meeting, or this event of it.
    Yes,
}

impl EventDetail {
    /// Whether this is a meeting somebody else sent the owner: a single item or one event of a series
    /// (the master is `series_incoming`'s), shown with its real title, on which the owner is an
    /// attendee. Every signal the server gave must agree, and one that says otherwise vetoes.
    pub fn incoming(&self) -> bool {
        matches!(self.item.kind, "single" | "occurrence" | "exception") && self.received()
    }

    /// `incoming` for the master of a series, which an answer to all of it is made to.
    pub fn series_incoming(&self) -> bool {
        self.item.kind == "master" && self.received()
    }

    fn received(&self) -> bool {
        let item = &self.item;
        item.meeting
            && !item.private
            && matches!(item.response, "none" | "accept" | "tentative" | "decline")
            && self.is_organizer != Some(true)
            && self.state.is_none_or(|bits| bits & RECEIVED != 0)
    }

    /// Whether the owner may answer it: in the default calendar, read whole, `incoming`, not
    /// cancelled (by the server's flag or by a cancellation in the Inbox, or perhaps by one: an
    /// answer would tell the organizer the owner is coming to something that is over), and not an
    /// item whose listed response objects leave out `AcceptItem`.
    pub fn invitation(&self) -> bool {
        self.incoming() && self.answerable()
    }

    /// `invitation` for the master of a series: all of it may be answered at once.
    pub fn series_invitation(&self) -> bool {
        self.series_incoming() && self.answerable()
    }

    fn answerable(&self) -> bool {
        !self.elsewhere
            && !self.reduced
            && !self.item.cancelled
            && self.cancellation == Cancelled::No
            && self.can_accept != Some(false)
    }

    /// What a screen is told: `None` when the owner may change the item as it is (a plain appointment,
    /// an event or the master of a plain series, or a meeting they organise, single or repeating), else
    /// why not. `CalendarItem::screen_lock` with what only a read of the item adds: the people.
    pub fn screen_lock(&self, owner: &str) -> Option<Lock> {
        let (item, series) = (&self.item, self.item.is_series());
        if self.elsewhere {
            Some(Lock::Unknown)
        } else if item.meeting {
            self.organiser_lock(owner, series)
        } else if series {
            item.series_lock()
        } else {
            item.lock()
        }
    }

    /// What a screen is told of an item of a calendar that is not the mailbox's default one
    /// (`CalendarItem::other_lock`), by the item's own rights, which the read asked for; an item the read
    /// did not find in the folder named is locked.
    pub fn other_lock(&self) -> Option<Lock> {
        if self.elsewhere {
            return Some(Lock::Unknown);
        }
        self.item.other_lock(self.item.rights.unwrap_or_default())
    }

    /// Why the owner may not change or cancel this meeting as its organizer from here, `None` when
    /// they may; decided again on a fresh read before anybody is told. `CalendarItem::meeting_lock`
    /// first (a single meeting the owner sent, or with `series` a member of a series of them, no room,
    /// not private or cancelled), then the read itself (in the default calendar, with the Exchange 2013
    /// properties), then the people: every one of them read with an address, since a change or a
    /// cancellation mails them all and the question names them (`Guests`), and somebody on it besides
    /// `owner`, the mailbox's own address. Last `IsOrganizer` not false, `AppointmentState` without the
    /// received bit and `CancelCalendarItem` among the response objects when they are listed. Every
    /// signal must agree and one that says otherwise vetoes, as for an invitation.
    pub fn organiser_lock(&self, owner: &str, series: bool) -> Option<Lock> {
        if let Some(lock) = self.item.meeting_lock(series) {
            return Some(lock);
        }
        if self.elsewhere || self.reduced {
            return Some(Lock::Unknown);
        }
        let people = &self.attendees;
        if self.attendees_cut || people.iter().any(|who| who.who.address.is_empty()) {
            return Some(Lock::Guests);
        }
        let others = people
            .iter()
            .any(|who| !who.who.address.eq_ignore_ascii_case(owner));
        let sent = self.is_organizer != Some(false)
            && self.state.is_none_or(|bits| bits & RECEIVED == 0)
            && self.can_cancel != Some(false);
        (!(others && sent)).then_some(Lock::Meeting)
    }

    /// Whether the owner organises this meeting and may change or cancel it: `organiser_lock` clear.
    pub fn organised(&self, owner: &str) -> bool {
        self.organiser_lock(owner, false).is_none()
    }

    /// `organised` for a member of a series of meetings: an occurrence, an exception or the master.
    pub fn series_organised(&self, owner: &str) -> bool {
        self.organiser_lock(owner, true).is_none()
    }

    /// What taking this received meeting off the calendar is, `None` when it may not be: `cancelled`
    /// (the server's flag, or a cancellation in the Inbox that is certainly this meeting's) or
    /// `declined` (the owner answered No), for a single meeting; an event of a series only when it is
    /// cancelled (a declined one stays, declined). An invitation nobody cancelled or declined is
    /// answered first: deleting it would leave its organizer waiting.
    pub fn removal(&self) -> Option<&'static str> {
        let item = &self.item;
        let cancelled = item.cancelled || self.cancellation == Cancelled::Yes;
        let single = item.kind == "single" && !item.recurring;
        let member = matches!(item.kind, "occurrence" | "exception") && cancelled;
        if self.elsewhere || self.reduced || !(single || member) {
            return None;
        }
        if !(self.incoming() || self.flagged()) {
            return None;
        }
        match cancelled {
            true => Some("cancelled"),
            false => (item.response == "decline").then_some("declined"),
        }
    }

    /// A meeting somebody else sent that the server flags cancelled. It may have lost the owner's
    /// answer, so any answer but the organizer's own will do, the received signals still agreeing.
    fn flagged(&self) -> bool {
        let item = &self.item;
        item.cancelled
            && item.meeting
            && !item.private
            && item.response != "organizer"
            && self.is_organizer != Some(true)
            && self.state.is_none_or(|bits| bits & RECEIVED != 0)
    }

    /// The master, with a `UID`, of a series somebody else sent the owner: an invitation to all of
    /// it, or one the server flags cancelled.
    /// Whether every exception (`exceptions`, `None` when they were not all read) lists the people this
    /// master does: the same addresses, ignoring case, the owner and rooms left out, every one read.
    /// What else an exception changed (its time, its place) does not count.
    pub fn exceptions_agree(&self, exceptions: Option<&[People]>, owner: &str) -> bool {
        let Some(exceptions) = exceptions else {
            return false;
        };
        let set = |people: &[Attendee]| -> BTreeSet<String> {
            let mailed = people.iter().filter(|who| who.kind != "resource");
            let others = mailed.filter(|who| !who.who.address.eq_ignore_ascii_case(owner));
            others
                .map(|who| who.who.address.to_ascii_lowercase())
                .collect()
        };
        let read = |people: &[Attendee]| people.iter().all(|who| !who.who.address.is_empty());
        let mine = set(&self.attendees);
        exceptions
            .iter()
            .all(|(people, cut)| !cut && read(people) && set(people) == mine)
    }

    pub fn received_master(&self) -> bool {
        self.item.kind == "master"
            && !self.item.uid.is_empty()
            && !self.elsewhere
            && (self.received() || self.flagged())
    }

    /// For a `received_master`, whether its organizer cancelled it: `Some(0)` for the series as a whole
    /// (the server flags the master, or a cancellation of its `UID` names no event), `Some(n)` when they
    /// cancelled n of its events one by one, n at least two (one cancelled event is that event's own
    /// removal, and the rest of the series goes on), else `None`. `messages` are the Inbox's
    /// cancellations, matched by `UID` alone (`Cancellation::is_for_series`).
    pub fn series_removal(&self, messages: &[Cancellation]) -> Option<u32> {
        if !self.received_master() {
            return None;
        }
        let mine = || messages.iter().filter(|m| m.is_for_series(&self.item));
        if self.item.cancelled || mine().any(|message| message.occurrence.is_none()) {
            return Some(0);
        }
        let events: BTreeSet<i64> = mine().filter_map(|message| message.occurrence).collect();
        u32::try_from(events.len()).ok().filter(|count| *count >= 2)
    }
}

/// A `MeetingCancellation` message in the Inbox: the organizer's cancellation of a meeting.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cancellation {
    /// The message's own `ItemId`, which a `RemoveItem` names; its change key is empty when unusable.
    pub id: String,
    pub change_key: String,
    /// The `UID` of the meeting it cancels, empty when the server gave none.
    pub uid: String,
    /// `RecurrenceId`: the one event of a series it cancels; `None` for the whole series, and for a
    /// meeting that does not repeat.
    pub occurrence: Option<i64>,
    /// `AssociatedCalendarItemId/@Id`, empty when none.
    pub associated: String,
    /// `IsOutOfDate`: a newer message of the meeting arrived after it (the organizer took the owner off
    /// and put them back, say), so it cancels nothing any more. Absent is not out of date.
    pub out_of_date: bool,
}

impl Cancellation {
    /// Whether this cancels some or all of the series whose master is `master`: the same `UID` and
    /// nothing else (never the title, never the item it names as its own), unless the server says it
    /// is out of date.
    pub fn is_for_series(&self, master: &CalendarItem) -> bool {
        !self.out_of_date && !self.uid.is_empty() && self.uid == master.uid
    }

    /// Whether this cancels the item of `detail`: the same `UID` when both have one (two different
    /// ones are two meetings, whatever else points at them), else the calendar item the message names
    /// as its own (`AssociatedCalendarItemId`). One that names no event is for the whole meeting. One
    /// that names an event of a series (`RecurrenceId`, which with the `UID` "identify a specific
    /// instance of a recurring calendar item") is for the item at that place (its own `RecurrenceId`,
    /// else its `OriginalStart`), whatever kind the server calls it; an item that does not say where
    /// it sits may be that event, which is `Unplaced`. What this decides is that no answer is sent, so
    /// a doubt falls on the side of sending none, and is said as a doubt. A cancellation the server
    /// says is out of date cancels nothing: the meeting went on after it.
    pub fn is_for(&self, detail: &EventDetail) -> Cancelled {
        let item = &detail.item;
        if self.out_of_date {
            return Cancelled::No;
        }
        if self.uid.is_empty() || item.uid.is_empty() {
            let named = !self.associated.is_empty() && self.associated == item.id;
            return if named { Cancelled::Yes } else { Cancelled::No };
        }
        match (self.uid == item.uid, self.occurrence, detail.position) {
            (false, ..) => Cancelled::No,
            (true, None, _) => Cancelled::Yes,
            (true, Some(which), Some(at)) if at == which => Cancelled::Yes,
            (true, Some(_), Some(_)) => Cancelled::No,
            (true, Some(_), None) => Cancelled::Unplaced,
        }
    }
}

/// The one item a detail `GetItem` read: `None` for what is no calendar item or cannot be drawn.
pub fn detail(body: &Node) -> Result<Option<EventDetail>, Rej> {
    let found = each(
        body,
        "GetItemResponse",
        "GetItemResponseMessage",
        1,
        |message| match first_item(message)? {
            node if node.name == "CalendarItem" => Ok(calendar::item(node)?.map(|item| {
                let (notes, notes_cut) = notes(node);
                let (attendees, attendees_cut) = people(node);
                let objects = node.child("ResponseObjects");
                let offered = |name| objects.map(|listed| listed.child(name).is_some());
                let flag = |name: &str| match node.text_at(&[name]) {
                    Some("true" | "1") => Some(true),
                    Some("false" | "0") => Some(false),
                    _ => None,
                };
                EventDetail {
                    item,
                    notes,
                    notes_cut,
                    organizer: node.at(&["Organizer", "Mailbox"]).and_then(person),
                    attendees,
                    attendees_cut,
                    join_url: node
                        .text_at(&["JoinOnlineMeetingUrl"])
                        .and_then(https_url)
                        .unwrap_or_default(),
                    is_organizer: flag("IsOrganizer"),
                    state: node
                        .text_at(&["AppointmentState"])
                        .and_then(|bits| bits.parse().ok()),
                    can_accept: offered("AcceptItem"),
                    can_cancel: offered("CancelCalendarItem"),
                    position: instant(node.text_at(&["RecurrenceId"]))
                        .or_else(|| instant(node.text_at(&["OriginalStart"]))),
                    cancellation: Cancelled::No,
                    elsewhere: false,
                    reduced: false,
                    series: None,
                    modified: modified(node),
                }
            })),
            _ => Ok(None),
        },
    )?;
    found.into_iter().next().unwrap_or(Err(Rej::INVALID))
}

/// The people on each exception a `GetItem` of `soap::calendar::exception_people` read, in the order
/// asked; an answer that is no calendar item is a failed read.
pub fn exception_people(body: &Node, expected: usize) -> Result<Vec<Result<People, Rej>>, Rej> {
    each(
        body,
        "GetItemResponse",
        "GetItemResponseMessage",
        expected,
        |message| match first_item(message)? {
            node if node.name == "CalendarItem" => Ok(people(node)),
            _ => Err(Rej::INVALID),
        },
    )
}

/// The ids of a master's `ModifiedOccurrences`, at most one past `MAX_EXCEPTIONS`.
fn modified(node: &Node) -> Vec<String> {
    let Some(list) = node.child("ModifiedOccurrences") else {
        return Vec::new();
    };
    let listed = list.children.iter().filter(|o| o.name == "Occurrence");
    listed
        .take(MAX_EXCEPTIONS + 1)
        .map(|o| id_attr(o.child("ItemId"), "Id").unwrap_or_default())
        .collect()
}

/// The cancellations a `FindItem` of the Inbox listed, in the order the server gave them.
pub fn cancellations(body: &Node) -> Result<Vec<Cancellation>, Rej> {
    let [message] = messages(body, "FindItemResponse", "FindItemResponseMessage", 1)?[..] else {
        return Err(Rej::INVALID);
    };
    check(message)?;
    let root = message.child("RootFolder").ok_or(Rej::INVALID)?;
    let elements = root
        .child("Items")
        .map_or(&[][..], |items| &items.children[..]);
    if elements.len() > MAX_ELEMENTS {
        return Err(Rej::INVALID);
    }
    let found = elements.iter().filter(|e| e.name == "MeetingCancellation");
    found
        .map(|element| {
            let uid = element.text_at(&["UID"]).unwrap_or("");
            let id = element.child("ItemId");
            Ok(Cancellation {
                id: id_attr(id, "Id").ok_or(Rej::INVALID)?,
                change_key: id_attr(id, "ChangeKey")
                    .filter(|key| is_change_key(key))
                    .unwrap_or_default(),
                uid: if uid.len() > MAX_UID_BYTES { "" } else { uid }.to_owned(),
                occurrence: instant(element.text_at(&["RecurrenceId"])),
                associated: id_attr(element.child("AssociatedCalendarItemId"), "Id")
                    .unwrap_or_default(),
                out_of_date: matches!(element.text_at(&["IsOutOfDate"]), Some("true" | "1")),
            })
        })
        .collect()
}

/// A mailbox with its name cut and an address over its bound dropped; `None` when neither is left.
fn person(node: &Node) -> Option<Party> {
    let found = party(node)?;
    let address = if found.address.len() > MAX_ADDRESS_BYTES {
        String::new()
    } else {
        found.address
    };
    let name = cap(&found.name, MAX_NAME_BYTES);
    (!name.is_empty() || !address.is_empty()).then_some(Party { name, address })
}

/// The three lists of attendees in one, required first; at most `MAX_PEOPLE`.
fn people(node: &Node) -> (Vec<Attendee>, bool) {
    let mut found = Vec::new();
    for (list, kind) in [
        ("RequiredAttendees", "required"),
        ("OptionalAttendees", "optional"),
        ("Resources", "resource"),
    ] {
        let Some(list) = node.child(list) else {
            continue;
        };
        let listed = list.children.iter().filter(|a| a.name == "Attendee");
        for attendee in listed.take(PEOPLE_EXAMINED) {
            let Some(who) = attendee.child("Mailbox").and_then(person) else {
                continue;
            };
            if found.len() == MAX_PEOPLE {
                return (found, true);
            }
            let response = calendar::response(attendee.text_at(&["ResponseType"]));
            found.push(Attendee {
                who,
                kind,
                response,
            });
        }
    }
    (found, false)
}

/// An address a person could be sent to: `https`, printable ASCII (a name in another script is its
/// punycode on the wire), a host and no user name.
fn https_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let plain = url.len() <= MAX_JOIN_URL_BYTES && url.bytes().all(|b| (0x21..=0x7e).contains(&b));
    (plain && !authority.is_empty() && !authority.contains('@')).then(|| url.to_owned())
}

/// The notes of an item: its `Body` as clean plain text, and whether it was cut.
fn notes(node: &Node) -> (String, bool) {
    let Some(body) = node.child("Body") else {
        return (String::new(), false);
    };
    let raw = cap(&body.text, MAX_RAW_NOTES_BYTES);
    let mut cut = raw.len() < body.text.len() || body.attr("IsTruncated") == Some("true");
    let text = if body.attr("BodyType").map(str::trim) == Some("HTML") {
        html_to_text(&raw)
    } else {
        raw
    };
    let text = clean(&text);
    if text.len() > MAX_NOTES_BYTES {
        cut = true;
    }
    (cap(&text, MAX_NOTES_BYTES).trim_end().to_owned(), cut)
}

/// Line ends as `\n`, every other control character but a tab gone, runs of blank lines shortened to
/// one and the ends trimmed: text that is safe to show whatever it came from.
fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = 0;
    for line in text.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        let line: String = line
            .chars()
            .filter(|c| *c == '\t' || !c.is_control())
            .collect();
        let line = line.trim_end();
        if line.is_empty() {
            blank += 1;
            if blank > 1 || out.is_empty() {
                continue;
            }
        } else {
            blank = 0;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    out.trim_end().to_owned()
}

/// The text of an HTML fragment and nothing of its markup: tags, comments and the content of
/// `script` and `style` are dropped, a block boundary or `<br>` is a line break, and the five
/// entities, `&nbsp;` and numeric references are decoded (an unknown entity is left as written). It
/// is no HTML parser and does not try to be: a tag it cannot finish takes the rest of the input with
/// it, which only ever costs text.
fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find(['<', '&']) {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        if let Some(after) = rest.strip_prefix("<!--") {
            rest = after.find("-->").map_or("", |end| &after[end + 3..]);
        } else if rest.starts_with('<') {
            let Some(end) = rest.find('>') else {
                return out;
            };
            let closing = rest[1..].starts_with('/');
            let tag = rest[1..end].trim_start_matches('/').trim();
            let name = tag
                .chars()
                .take_while(char::is_ascii_alphanumeric)
                .collect::<String>()
                .to_ascii_lowercase();
            rest = &rest[end + 1..];
            if !closing && matches!(name.as_str(), "script" | "style") {
                rest = after_close(rest, &name);
            } else if matches!(
                name.as_str(),
                "br" | "p" | "div" | "tr" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
            ) {
                out.push('\n');
            }
        } else {
            let (text, after) = entity(rest);
            out.push_str(&text);
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// What follows the closing tag of `name` in `rest`, or nothing when it never closes. Each `</` is
/// looked at once, so a body of nothing but openers costs one pass.
fn after_close<'a>(rest: &'a str, name: &str) -> &'a str {
    for (at, _) in rest.match_indices("</") {
        let tail = &rest[at + 2..];
        let named = tail.as_bytes().get(..name.len());
        if named.is_some_and(|word| word.eq_ignore_ascii_case(name.as_bytes())) {
            return tail.find('>').map_or("", |end| &tail[end + 1..]);
        }
    }
    ""
}

/// One entity at the start of `rest` (which begins with `&`), decoded, and what follows it. The `;`
/// is looked for in the next dozen bytes only, so a body of nothing but `&` costs one pass.
fn entity(rest: &str) -> (String, &str) {
    let Some(end) = rest.bytes().take(12).position(|byte| byte == b';') else {
        return ("&".to_owned(), &rest[1..]);
    };
    let name = &rest[1..end];
    let decoded = match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => name.strip_prefix('#').and_then(|number| {
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => number.parse().ok(),
            };
            code.and_then(char::from_u32)
        }),
    };
    match decoded {
        Some(c) => (c.to_string(), &rest[end + 1..]),
        None => ("&".to_owned(), &rest[1..]),
    }
}

#[cfg(test)]
mod tests;
