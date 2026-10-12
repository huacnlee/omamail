//! Calendar answers: the items of a `CalendarView`, the item read before a write, and what a write
//! answered. Written from Microsoft's CalendarView, CalendarItem, StartWallClock, Sensitivity,
//! LegacyFreeBusyStatus, CalendarItemType and MyResponseType pages. In addition to the rules of the
//! mail decoders:
//!
//! - `Start` and `End` are instants (EWS writes UTC) and are what a timed event is drawn from. They
//!   cannot give the *day* of an all-day event, which is midnight of the zone it was made in, so the
//!   wall clocks ("in the time zone of the location") are read as written, a zone suffix ignored.
//! - Only `CalendarItem` elements count; one whose `Start` or `End` cannot be read is left out, since
//!   it cannot be drawn, and one with no `ItemId` is a damaged answer.
//! - A closed vocabulary comes out as `&'static str`, so no server text is carried: an unknown word
//!   is `busy`, `unknown` and `unknown`. An unknown `Sensitivity` is private and an absent one
//!   normal. An unknown *kind* is not taken for a single event: what may be written is decided from
//!   it (`CalendarItem::lock`), and what nobody could classify is left alone.
//! - Strings are bounded, a uid that is too long is dropped (cut, it would be another uid), and a
//!   change key is kept only if a write could send it back.

use chrono::{DateTime, Datelike, NaiveDateTime};

use super::super::soap::calendar::{
    MAX_LOCATION_BYTES, MAX_REMINDER_MINUTES, MAX_TITLE_BYTES, is_change_key,
};
use super::{Rej, each, first_item, id_attr, messages};
use crate::providers::exchange::ews::xml::Node;

pub(super) const MAX_NAME_BYTES: usize = 320;
pub(super) const MAX_UID_BYTES: usize = 512;
/// More items than one answer can be asked for, by far: anything beyond is a damaged answer.
pub(super) const MAX_ELEMENTS: usize = 1000;
/// Attendees counted per list: enough to know there are some.
const MAX_ATTENDEES: usize = 200;

/// One calendar item as a view or a read answers it: a single event or one occurrence of a series.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CalendarItem {
    /// `ItemId/@Id` as sent (base64).
    pub id: String,
    /// The version a screen was drawn from; empty when absent or unusable.
    pub change_key: String,
    /// `ParentFolderId/@Id`, which only the read before a write asks for.
    pub folder: String,
    pub uid: String,
    pub subject: String,
    pub location: String,
    /// The organizer's display name: `FindItem` gives no address for it.
    pub organizer: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub start_wall: Option<NaiveDateTime>,
    pub end_wall: Option<NaiveDateTime>,
    pub all_day: bool,
    pub cancelled: bool,
    pub meeting: bool,
    pub recurring: bool,
    /// Attendees in the three lists, which only a read that asked for them can say (0 in a view).
    pub attendees: usize,
    /// How many of them are in `Resources` (rooms, equipment): a meeting with one is not written here.
    pub resources: usize,
    /// Private, Confidential or a sensitivity this decoder does not know: not to be shown.
    pub private: bool,
    /// `free`, `tentative`, `busy`, `oof`, `workingElsewhere` or `noData`.
    pub busy: &'static str,
    /// `organizer`, `tentative`, `accept`, `decline`, `none` or `unknown`.
    pub response: &'static str,
    /// `single`, `occurrence`, `exception`, `master` or `unknown`.
    pub kind: &'static str,
    /// Minutes before the start, when a reminder is set and within four weeks.
    pub reminder_minutes: Option<u32>,
}

/// Why an item is not one this client may change; `code` is what `exchange.calendarEvents` says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lock {
    Cancelled,
    Recurring,
    Meeting,
    /// An invitation from somebody else, answered or not: the item is theirs.
    Foreign,
    Private,
    /// The owner's meeting has a room or equipment on it, which this client does not write back.
    Room,
    /// The owner's meeting has somebody on it whose address was not read, or more people than are.
    Guests,
    Unknown,
}

impl Lock {
    pub const fn code(self) -> &'static str {
        match self {
            Lock::Cancelled => "cancelled",
            Lock::Recurring => "recurring",
            Lock::Meeting => "meeting",
            Lock::Foreign => "foreign",
            Lock::Private => "private",
            Lock::Room => "room",
            Lock::Guests => "guests",
            Lock::Unknown => "unknown",
        }
    }
}

impl CalendarItem {
    /// `None` for a personal appointment, the only thing this client writes: one single item that no
    /// other person is on (so nothing done to it can be mailed), that its owner made and that is shown
    /// with its real title. Anything the properties cannot show to be that is locked.
    pub fn lock(&self) -> Option<Lock> {
        if self.cancelled {
            return Some(Lock::Cancelled);
        }
        match self.kind {
            "single" if self.recurring => return Some(Lock::Recurring),
            "single" => {}
            "occurrence" | "exception" | "master" => return Some(Lock::Recurring),
            _ => return Some(Lock::Unknown),
        }
        if self.meeting || self.attendees > 0 {
            return Some(Lock::Meeting);
        }
        // An appointment the owner has answered as an attendee, or not yet, came from somebody else.
        if !matches!(self.response, "organizer" | "unknown") {
            return Some(Lock::Foreign);
        }
        self.private.then_some(Lock::Private)
    }

    /// `None` for a meeting the owner may change and cancel as its organizer: a single item, a
    /// meeting they sent (`MyResponseType` Organizer) with no room or equipment on it, shown with its
    /// real title. What a view cannot show (the people, the response objects) is judged again on a
    /// fresh read before anything is sent (`EventDetail::organised`), so this is the first half of the
    /// stricter of two.
    pub fn meeting_lock(&self) -> Option<Lock> {
        if self.cancelled {
            return Some(Lock::Cancelled);
        }
        match self.kind {
            "single" if self.recurring => return Some(Lock::Recurring),
            "single" => {}
            "occurrence" | "exception" | "master" => return Some(Lock::Recurring),
            _ => return Some(Lock::Unknown),
        }
        // An invitation somebody else sent is theirs: answered, never changed.
        if !self.meeting || self.response != "organizer" {
            return Some(Lock::Meeting);
        }
        if self.resources > 0 {
            return Some(Lock::Room);
        }
        self.private.then_some(Lock::Private)
    }

    /// The lock a screen shows: the meeting's rule for a meeting, the appointment's for the rest.
    pub fn screen_lock(&self) -> Option<Lock> {
        if self.meeting {
            self.meeting_lock()
        } else {
            self.lock()
        }
    }
}

/// One answer of a calendar view.
pub struct CalendarPage {
    pub items: Vec<CalendarItem>,
    /// How many elements the server sent, those left out included.
    pub elements: usize,
    /// `IncludesLastItemInRange`, when the answer said.
    pub includes_last: Option<bool>,
}

pub fn calendar_view(body: &Node) -> Result<CalendarPage, Rej> {
    let [message] = messages(body, "FindItemResponse", "FindItemResponseMessage", 1)?[..] else {
        return Err(Rej::INVALID);
    };
    super::check(message)?;
    let root = message.child("RootFolder").ok_or(Rej::INVALID)?;
    let elements = root
        .child("Items")
        .map_or(&[][..], |items| &items.children[..]);
    if elements.len() > MAX_ELEMENTS {
        return Err(Rej::INVALID);
    }
    let mut items = Vec::with_capacity(elements.len());
    for element in elements.iter().filter(|e| e.name == "CalendarItem") {
        items.extend(item(element)?);
    }
    let includes_last = match root.attr("IncludesLastItemInRange").map(str::trim) {
        None => None,
        Some("true") => Some(true),
        Some("false") => Some(false),
        Some(_) => return Err(Rej::INVALID),
    };
    Ok(CalendarPage {
        items,
        elements: elements.len(),
        includes_last,
    })
}

/// The one item a `GetItem` read for a write: `None` for what is no calendar item or cannot be drawn,
/// which a write refuses either way.
pub fn appointment(body: &Node) -> Result<Option<CalendarItem>, Rej> {
    let found = each(
        body,
        "GetItemResponse",
        "GetItemResponseMessage",
        1,
        |message| match first_item(message)? {
            item if item.name == "CalendarItem" => self::item(item),
            _ => Ok(None),
        },
    )?;
    found.into_iter().next().unwrap_or(Err(Rej::INVALID))
}

/// The id of the one folder a `GetFolder` asked for.
pub fn folder_id(body: &Node) -> Result<String, Rej> {
    let found = each(
        body,
        "GetFolderResponse",
        "GetFolderResponseMessage",
        1,
        |message| {
            let folder = message
                .child("Folders")
                .and_then(|list| list.children.first());
            id_attr(folder.and_then(|folder| folder.child("FolderId")), "Id").ok_or(Rej::INVALID)
        },
    )?;
    found.into_iter().next().unwrap_or(Err(Rej::INVALID))
}

/// The answer to a `CreateItem` or `UpdateItem` of one item: its id and change key, empty where the
/// server echoed none (it still did what it was asked).
pub fn written(body: &Node, kind: &str) -> Result<Result<(String, String), Rej>, Rej> {
    let found = each(
        body,
        &format!("{kind}Response"),
        &format!("{kind}ResponseMessage"),
        1,
        |message| {
            let id = message
                .child("Items")
                .and_then(|items| items.children.first())
                .and_then(|item| item.child("ItemId"));
            let key = id_attr(id, "ChangeKey").filter(|key| is_change_key(key));
            Ok((
                id_attr(id, "Id").unwrap_or_default(),
                key.unwrap_or_default(),
            ))
        },
    )?;
    Ok(found.into_iter().next().unwrap_or(Err(Rej::INVALID)))
}

/// A string cut to at most `max` bytes on a character boundary.
pub(super) fn cap(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

pub(super) fn instant(text: Option<&str>) -> Option<i64> {
    DateTime::parse_from_rfc3339(text?)
        .ok()
        .map(|date| date.timestamp_millis())
        .filter(|ms| *ms >= 0)
}

/// A wall clock: `YYYY-MM-DDThh:mm:ss`, fractions allowed. A `Z` or an offset after it is dropped,
/// not applied: the value is already the event's own clock.
fn wall_clock(text: Option<&str>) -> Option<NaiveDateTime> {
    let (moment, rest) = NaiveDateTime::parse_and_remainder(text?, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    let offset = |rest: &str| {
        let bytes = rest.as_bytes();
        bytes.len() == 6
            && matches!(bytes[0], b'+' | b'-')
            && bytes[3] == b':'
            && [1, 2, 4, 5].iter().all(|&at| bytes[at].is_ascii_digit())
    };
    (moment.year() >= 1970 && (rest.is_empty() || rest == "Z" || offset(rest))).then_some(moment)
}

pub(super) fn item(node: &Node) -> Result<Option<CalendarItem>, Rej> {
    let id = node.child("ItemId");
    let id_text = id_attr(id, "Id").ok_or(Rej::INVALID)?;
    let text = |name: &str| node.text_at(&[name]);
    // Text as the server wrote it, spaces included, as a write compares it.
    let raw = |path: &[&str]| node.at(path).map_or("", |found| found.text.as_str());
    let (Some(start_ms), Some(end_ms)) = (instant(text("Start")), instant(text("End"))) else {
        return Ok(None);
    };
    let flag = |name: &str| matches!(text(name), Some("true" | "1"));
    let uid = text("UID").unwrap_or("");
    let count = |list: &str| {
        node.child(list).map_or(0, |list| {
            let listed = list.children.iter().filter(|a| a.name == "Attendee");
            listed.take(MAX_ATTENDEES).count()
        })
    };
    let resources = count("Resources");
    let reminder = text("ReminderMinutesBeforeStart")
        .and_then(|minutes| minutes.parse::<u32>().ok())
        .filter(|minutes| flag("ReminderIsSet") && *minutes <= MAX_REMINDER_MINUTES);
    Ok(Some(CalendarItem {
        id: id_text,
        change_key: id_attr(id, "ChangeKey")
            .filter(|key| is_change_key(key))
            .unwrap_or_default(),
        folder: id_attr(node.child("ParentFolderId"), "Id").unwrap_or_default(),
        uid: if uid.len() > MAX_UID_BYTES { "" } else { uid }.to_owned(),
        subject: cap(raw(&["Subject"]), MAX_TITLE_BYTES),
        location: cap(raw(&["Location"]), MAX_LOCATION_BYTES),
        organizer: cap(raw(&["Organizer", "Mailbox", "Name"]), MAX_NAME_BYTES),
        start_ms,
        end_ms,
        start_wall: wall_clock(text("StartWallClock")),
        end_wall: wall_clock(text("EndWallClock")),
        all_day: flag("IsAllDayEvent"),
        cancelled: flag("IsCancelled"),
        meeting: flag("IsMeeting"),
        recurring: flag("IsRecurring"),
        attendees: count("RequiredAttendees") + count("OptionalAttendees") + resources,
        resources,
        private: !matches!(text("Sensitivity"), None | Some("Normal" | "Personal")),
        busy: match text("LegacyFreeBusyStatus") {
            Some("Free") => "free",
            Some("Tentative") => "tentative",
            Some("OOF") => "oof",
            Some("WorkingElsewhere") => "workingElsewhere",
            Some("NoData") => "noData",
            _ => "busy",
        },
        response: response(text("MyResponseType")),
        kind: match text("CalendarItemType") {
            Some("Single") => "single",
            Some("Occurrence") => "occurrence",
            Some("Exception") => "exception",
            Some("RecurringMaster") => "master",
            _ => "unknown",
        },
        reminder_minutes: reminder,
    }))
}

/// `MyResponseType`, or an attendee's `ResponseType`: anything else, or nothing, is `unknown`.
pub(super) fn response(word: Option<&str>) -> &'static str {
    match word {
        Some("Organizer") => "organizer",
        Some("Tentative") => "tentative",
        Some("Accept") => "accept",
        Some("Decline") => "decline",
        Some("NoResponseReceived") => "none",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests;
