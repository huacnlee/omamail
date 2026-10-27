//! The requests that read the calendar and an event's detail, create, change and delete a personal
//! appointment, and answer an invitation, written from Microsoft's CalendarView, FieldURI, GetItem,
//! ItemShape, BodyType, CreateItem (calendar item and meeting request), UpdateItem, DeleteItem,
//! CalendarItem, AcceptItem, TentativelyAcceptItem, DeclineItem, ReferenceItemId,
//! ReminderMinutesBeforeStart, TimeZoneContext and StartTimeZone pages and "Time zones and EWS in
//! Exchange", "Create all-day events", "Update appointments and meetings", "Delete appointments and
//! cancel meetings" and "Responding to meeting invitations".
//!
//! - **No write of an appointment is sent to anybody.** Every one carries the option that says so:
//!   `SendMeetingInvitations`, `SendMeetingInvitationsOrCancellations` and
//!   `SendMeetingCancellations` are `SendToNone` (Microsoft warns that leaving it out of an update can
//!   turn an appointment into a meeting). A new item names no attendee; the caller has refused any
//!   item that is not a plain appointment, so the option is the second guard, not the first.
//! - **Time is UTC instants, and a zone only where an all-day event needs one.** A range and a timed
//!   event's `Start` and `End` go out with their `Z` ("interpreted as UTC" in every row of Table 2),
//!   and the header names no zone. An all-day event is its days, `YYYY-MM-DDT00:00:00` with no zone,
//!   with the owner's zone as a `TimeZoneContext` (a bare Windows `Id`, as Microsoft's examples write
//!   it): the server keeps the midnights of that zone, so the days are the ones typed. An update to a
//!   day also sets `StartTimeZone` and `EndTimeZone`, as Microsoft's update example does.
//! - **A write names the version it was drawn from** (`ChangeKey`) and an update says
//!   `NeverOverwrite`, so a change made elsewhere since is a conflict and not an overwrite. A delete
//!   moves the item to Deleted Items, where the owner can get it back.
//! - **A string is refused, never repaired**: over its bound, blank where it is required, a control
//!   character (notes keep line breaks and tabs) or what XML cannot carry.
//! - A calendar view asks for no body, preview or attendee: the view's own properties, plus the wall
//!   clocks and the reminder, which are what a server might refuse (their element pages are muddled)
//!   and the calendar can do without (`optional`).
//! - **A reminder is only what the caller names**: none on a new appointment unless asked, and an
//!   update touches `ReminderIsSet` and `ReminderMinutesBeforeStart` only when the caller changes
//!   them, at most four weeks (Outlook's longest; Microsoft's page gives the unit and no range).
//! - **The detail read changes nothing**: `GetItem` of one item, the body asked for as `Text` ("the
//!   response will return an item body as plain text"), and what a detail view shows. `IsOrganizer`
//!   and `JoinOnlineMeetingUrl` came with Exchange 2013, so the shape can be asked for without them.
//! - **An answer to an invitation is the one request here that reaches another person**, and only
//!   the organizer: `CreateItem` of an `AcceptItem`, `TentativelyAcceptItem` or `DeclineItem` whose
//!   `ReferenceItemId` names the calendar item and the version the caller drew ("you can respond to
//!   either the meeting request message or its associated calendar item"). `SendAndSaveCopy`, the
//!   disposition of Microsoft's example and what Outlook does, or `SaveOnly` when the caller asked
//!   for nothing to be sent. Nothing else is written: no body, no recipient, no `SendOnly`, no
//!   `SendMeetingInvitations`. The caller has decided on a fresh read that the owner may answer.
//! - The Inbox's meeting cancellations are found by `item:ItemClass`, the class Microsoft gives one
//!   (`IPM.Schedule.Meeting.Canceled`), newest first.
//!
//! **Meetings with other people** (CreateItem for a calendar item, UpdateItem, RequiredAttendees,
//! Attendee, DeleteItemField, CancelCalendarItem, RemoveItem and MeetingCancellation pages, "Update
//! appointments and meetings" and "Delete appointments and cancel meetings") are the only requests that
//! mail a person who did not ask, so each says whom it mails in the one attribute the schema has for it,
//! and nothing else here can:
//!
//! - `create_meeting`: `SendMeetingInvitations="SendToAllAndSaveCopy"` with the people as
//!   `RequiredAttendees` and `OptionalAttendees` after the place, where the schema keeps them. Nobody
//!   to mail is refused: that is an appointment, which says `SendToNone`.
//! - `update_meeting`: `SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy"` and
//!   `NeverOverwrite`, a list changed only whole (`SetItemField`) or emptied (`DeleteItemField`): the
//!   server sends anybody taken off a list a cancellation. Both lists emptied is refused. A change of
//!   the owner's own reminder alone goes with `SendToNone`.
//!
//! Every builder checks the people's addresses, count and duplicates (`guests::check`); the mailbox's
//! own address is refused by the handler and the client, which know it.
//! - `cancel_meeting`: `CreateItem MessageDisposition="SendAndSaveCopy"` of a `CancelCalendarItem`
//!   naming the meeting and its version, with the organizer's optional note as `NewBodyContent`, never a
//!   bare `DeleteItem` that would not say so to every attendee.
//! - `remove_cancellation`: `CreateItem MessageDisposition="SaveOnly"` of a `RemoveItem` naming a
//!   `MeetingCancellation` message ("valid only for a MeetingCancellation"): it has no recipient and
//!   is saved, not sent, so the meeting leaves the calendar and nobody is mailed.
//!
//! The appointment builders share the item's shape with these (`create_item`, `update_item`), keep
//! `SendToNone`, and refuse a change that names people: that would be a meeting.
//!
//! **A repeating event is made in the owner's zone, named twice** ("Create a recurring series", "Time
//! zones and EWS", the Recurrence and pattern pages). The server expands a series in the zone it was
//! made in, so a weekly 03:00 made in UTC would move an hour when the clocks change. `Start` and `End`
//! stay UTC instants with their `Z` (or days, for whole days), and the zone is the request's
//! `TimeZoneContext` and the item's `StartTimeZone` and `EndTimeZone`, which Table 2 names as the
//! creation time zone of an appointment. The `Recurrence` follows the attendee lists and precedes the
//! zones, where the schema lists them. A change of the time of day of every event is a clock time on
//! the series' first day (`When::Wall`) with the series' own zone, never an instant, so it holds across
//! a change of the clocks. A master is read through one of its events (`RecurringMasterItemId`, "the
//! identifiers of one of its related occurrence items") with its rule and its zone.

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat};

use super::folders::{Where, folder_element};
use super::{envelope, envelope_in, esc, field};
use crate::providers::exchange::guests::{self, Guests};
use crate::providers::exchange::recurrence::{
    DAYS, End, MONTHS, Pattern, Recurrence, WEEKS, day_name, plausible_first_day,
};

const INVALID: &str = "invalid_params";
const CALENDAR: &str = r#"<t:DistinguishedFolderId Id="calendar"/>"#;
/// 9999-12-31T23:59:58.999Z, so the end of its second is still a four-digit year.
pub const MAX_CURSOR_MS: i64 = 253_402_300_798_999;
/// Most items one calendar view answer may hold.
pub const MAX_ENTRIES: usize = 100;
pub const MAX_TITLE_BYTES: usize = 1000;
pub const MAX_LOCATION_BYTES: usize = 500;
/// Notes are plain text: a page and a half, a note and not a document.
pub const MAX_NOTES_BYTES: usize = 32 * 1024;
/// The longest an appointment may last, so a mistyped year is a refusal and not an event.
const MAX_SPAN_DAYS: i64 = 366;
/// The longest time of day every event of a series may be given.
pub const MAX_SPAN_MINUTES: u32 = 366 * 24 * 60;
/// Real change keys are about 40 characters; the bound only stops a forged one.
const MAX_CHANGE_KEY: usize = 200;
/// Four weeks, the longest reminder Outlook sets.
pub const MAX_REMINDER_MINUTES: u32 = 40_320;
/// What a cancellation says besides that it is one: a note, not a document.
pub const MAX_CANCEL_NOTE_BYTES: usize = 2000;

/// What a view asks for: the properties its fast path lists, and no body, preview or attendee.
const VIEW: &str = "item:Subject item:Sensitivity calendar:Start calendar:End \
    calendar:IsAllDayEvent calendar:LegacyFreeBusyStatus calendar:Location calendar:IsCancelled \
    calendar:IsMeeting calendar:IsRecurring calendar:CalendarItemType calendar:MyResponseType \
    calendar:Organizer calendar:UID";
/// What a server might refuse in a view, and the calendar can do without.
const OPTIONAL: &str = "calendar:StartWallClock calendar:EndWallClock item:ReminderIsSet \
    item:ReminderMinutesBeforeStart";
/// What the read before a write judges, the attendee lists a view cannot show included. Not the body
/// (never read) and not the wall clocks (which a server might refuse, failing every write).
const READ: &str = "item:ParentFolderId item:Subject item:Sensitivity item:ReminderIsSet \
    item:ReminderMinutesBeforeStart calendar:Start calendar:End calendar:IsAllDayEvent \
    calendar:Location calendar:IsCancelled calendar:IsMeeting calendar:IsRecurring \
    calendar:CalendarItemType calendar:MyResponseType calendar:RequiredAttendees \
    calendar:OptionalAttendees calendar:Resources";
/// What a detail view shows and what decides whether the owner may answer: the folder too, which
/// must be the default calendar for anything to be written to the item. No wall clocks (which a
/// server might refuse) and no `UniqueBody`: the body is `item:Body`, asked for as text.
const DETAIL: &str = "item:ParentFolderId item:Subject item:Sensitivity item:Body item:ReminderIsSet \
    item:ReminderMinutesBeforeStart item:ResponseObjects calendar:Start calendar:End \
    calendar:IsAllDayEvent calendar:Location calendar:IsCancelled calendar:IsMeeting \
    calendar:IsRecurring calendar:CalendarItemType calendar:MyResponseType calendar:UID \
    calendar:AppointmentState calendar:Organizer calendar:RequiredAttendees \
    calendar:OptionalAttendees calendar:Resources calendar:OriginalStart";
/// What the signed-in user may do to an item, asked of one in another mailbox.
const RIGHTS: &str = "item:EffectiveRights";
/// Introduced in Exchange Server 2013 (the first two), or the second word on where an event of a
/// series sits: what a detail view can do without, so a server that refuses them is asked again with
/// none (never for an answer).
const DETAIL_OPTIONAL: &str = "calendar:IsOrganizer calendar:JoinOnlineMeetingUrl \
    calendar:RecurrenceId";

/// When an appointment happens: in the two forms the server keeps one in, or (for every event of a
/// series) a time of day.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum When {
    /// Unix milliseconds; whole seconds are written.
    Timed { start_ms: i64, end_ms: i64 },
    /// The first day and the day after the last.
    AllDay { first: NaiveDate, after: NaiveDate },
    /// Every event of a series at this time of day for this many minutes, in the zone it recurs in:
    /// no time at all until the client puts it on the series' first day (`on`).
    Clock { start: NaiveTime, minutes: u32 },
    /// A clock time on a day, read in the zone the request names.
    Wall {
        start: NaiveDateTime,
        end: NaiveDateTime,
    },
}

impl When {
    /// A `Clock` put on `day`; any other time as it is.
    pub fn on(self, day: NaiveDate) -> When {
        match self {
            When::Clock { start, minutes } => {
                let start = day.and_time(start);
                let end = start + chrono::Duration::minutes(minutes.into());
                When::Wall { start, end }
            }
            other => other,
        }
    }

    /// The time as a builder can judge it before the series is read: on a day, any day.
    pub fn judged(self) -> When {
        self.on(NaiveDate::from_ymd_opt(2000, 1, 3).unwrap_or_default())
    }
}

/// The part of a series a write is for: one event of it (an occurrence, which an update makes an
/// exception) or all of them (the master).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Occurrence,
    Series,
}

impl Scope {
    pub fn parse(word: &str) -> Option<Scope> {
        match word {
            "occurrence" => Some(Scope::Occurrence),
            "series" => Some(Scope::Series),
            _ => None,
        }
    }

    /// Whether an item of `kind` is what a write naming `scope` is for: an event of a series for one
    /// event, the master for all of them, anything for none (the lock then decides).
    pub fn names(scope: Option<Scope>, kind: &str) -> bool {
        match scope {
            None => true,
            Some(Scope::Occurrence) => matches!(kind, "occurrence" | "exception"),
            Some(Scope::Series) => kind == "master",
        }
    }
}

/// A new personal appointment. `notes` is the body as plain text; `reminder` the minutes before
/// the start, `None` for no reminder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Appointment {
    pub title: String,
    pub location: String,
    pub notes: Option<String>,
    pub reminder: Option<u32>,
    pub when: When,
    /// How it repeats, for the first event of a series; made in the owner's zone, which it recurs in.
    pub recurrence: Option<Recurrence>,
}

/// What a change does with an appointment's reminder.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Reminder {
    #[default]
    Keep,
    Off,
    Minutes(u32),
}

/// What an update sets: each member `None` (or `Keep`) when it stays as it is. Notes are never part
/// of one: what the detail shows is text made from a body that may be HTML and may be cut, so a
/// rewrite would replace what was written with what was shown. `required` and `optional` are, for a
/// meeting, the whole of a list as it is to be (an empty one takes everybody off it).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Change<'a> {
    pub title: Option<&'a str>,
    pub location: Option<&'a str>,
    pub reminder: Reminder,
    pub when: Option<When>,
    pub required: Option<&'a [String]>,
    pub optional: Option<&'a [String]>,
}

impl Change<'_> {
    /// Whether this changes the owner's own reminder and nothing else, which tells nobody.
    pub fn reminder_only(&self) -> bool {
        self.reminder != Reminder::Keep
            && *self
                == Change {
                    reminder: self.reminder,
                    ..Change::default()
                }
    }
}

/// The owner's answer to an invitation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Accept,
    Tentative,
    Decline,
}

impl Answer {
    pub fn parse(word: &str) -> Option<Answer> {
        match word {
            "accept" => Some(Answer::Accept),
            "tentative" => Some(Answer::Tentative),
            "decline" => Some(Answer::Decline),
            _ => None,
        }
    }

    /// The `MyResponseType` the item carries once the answer is taken, as the answer says it.
    pub const fn word(self) -> &'static str {
        match self {
            Answer::Accept => "accept",
            Answer::Tentative => "tentative",
            Answer::Decline => "decline",
        }
    }
}

/// Whether `key` is a change key a write may send back: the alphabet and bound of ids.
pub fn is_change_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_CHANGE_KEY
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'_' | b'-'))
}

fn instant(ms: i64) -> Result<String, &'static str> {
    DateTime::from_timestamp(ms.div_euclid(1000), 0)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Secs, true))
        .ok_or(INVALID)
}

fn fields(uris: &str) -> String {
    uris.split_whitespace().map(field).collect()
}

/// `calendar_view_in` of the mailbox's own `calendar` folder.
pub fn calendar_view(
    start_ms: i64,
    end_ms: i64,
    max: usize,
    optional: bool,
) -> Result<String, &'static str> {
    calendar_view_in(start_ms, end_ms, max, optional, Where::Default)
}

/// `FindItem` of the calendar folder `at` names over a `CalendarView` from the second `start_ms` falls
/// in to the end of the second `end_ms` falls in (a range never shrinks), at most `max` items. The
/// server expands a series into its occurrences, and "a start time that is on or after EndDate will
/// not be returned". A folder other than the default calendar is asked for each item's own rights too
/// (`item:EffectiveRights`, which Microsoft lists among what a `FindItem` answer carries): there they,
/// and not the folder's, say what the user may change.
pub fn calendar_view_in(
    start_ms: i64,
    end_ms: i64,
    max: usize,
    optional: bool,
    at: Where,
) -> Result<String, &'static str> {
    if !(1..=MAX_ENTRIES).contains(&max)
        || !(0..=MAX_CURSOR_MS).contains(&start_ms)
        || !(start_ms..=MAX_CURSOR_MS).contains(&end_ms)
    {
        return Err(INVALID);
    }
    let mut extra = if optional {
        fields(OPTIONAL)
    } else {
        String::new()
    };
    if at != Where::Default {
        extra += &field(RIGHTS);
    }
    Ok(envelope(&format!(
        concat!(
            r#"<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>"#,
            "<t:AdditionalProperties>{}{}</t:AdditionalProperties></m:ItemShape>",
            r#"<m:CalendarView MaxEntriesReturned="{}" StartDate="{}" EndDate="{}"/>"#,
            "<m:ParentFolderIds>{}</m:ParentFolderIds></m:FindItem>"
        ),
        fields(VIEW),
        extra,
        max,
        instant(start_ms)?,
        instant(end_ms + 999)?,
        folder_element(at)?
    )))
}

/// `GetItem` of one item (its EWS id, checked by `ids::decode`) for what a write must know first, and
/// with `rights` what the signed-in user may do to it (`item:EffectiveRights`): asked of an item of any
/// calendar but the default one, where the server alone says whether it may be changed.
pub fn get_appointment(id: &str, rights: bool) -> String {
    let rights = if rights { field(RIGHTS) } else { String::new() };
    envelope(&format!(
        r#"<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>{}{rights}</t:AdditionalProperties></m:ItemShape><m:ItemIds><t:ItemId Id="{}"/></m:ItemIds></m:GetItem>"#,
        fields(READ),
        esc(id)
    ))
}

/// `GetFolder` of the default calendar, for its id: the folder an item must be in to be written.
pub fn get_calendar_folder() -> String {
    envelope(&format!(
        "<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds>{CALENDAR}</m:FolderIds></m:GetFolder>"
    ))
}

/// `GetItem` of one calendar item (its EWS id, checked by `ids::decode`) for its detail view, the
/// body as text; `optional` asks for the Exchange 2013 properties too.
pub fn event_detail(id: &str, optional: bool) -> String {
    let item = format!(r#"<t:ItemId Id="{}"/>"#, esc(id));
    detail_read(&item, optional, "")
}

/// `event_detail` with what the signed-in user may do to the item, for an item of any calendar but the
/// default one.
pub fn event_detail_rights(id: &str, optional: bool) -> String {
    let item = format!(r#"<t:ItemId Id="{}"/>"#, esc(id));
    detail_read(&item, optional, RIGHTS)
}

/// The same read of the master of the series the event `id` belongs to (`RecurringMasterItemId`),
/// with what only a master says: its rule and the zone it recurs in.
pub fn master_detail(id: &str, optional: bool) -> String {
    let item = format!(r#"<t:RecurringMasterItemId OccurrenceId="{}"/>"#, esc(id));
    detail_read(
        &item,
        optional,
        "calendar:Recurrence calendar:StartTimeZone calendar:ModifiedOccurrences",
    )
}

/// `GetItem` of the people on the exceptions of a series (the ids its master's `ModifiedOccurrences`
/// lists), in one request: the three lists and nothing else.
pub fn exception_people(ids: &[String]) -> String {
    let items: String = ids
        .iter()
        .map(|id| format!(r#"<t:ItemId Id="{}"/>"#, esc(id)))
        .collect();
    envelope(&format!(
        r#"<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>{}</t:AdditionalProperties></m:ItemShape><m:ItemIds>{items}</m:ItemIds></m:GetItem>"#,
        fields("calendar:RequiredAttendees calendar:OptionalAttendees calendar:Resources")
    ))
}

fn detail_read(item: &str, optional: bool, more: &str) -> String {
    let extra = if optional { DETAIL_OPTIONAL } else { "" };
    envelope(&format!(
        r#"<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:BodyType>Text</t:BodyType><t:AdditionalProperties>{}{}{}</t:AdditionalProperties></m:ItemShape><m:ItemIds>{item}</m:ItemIds></m:GetItem>"#,
        fields(DETAIL),
        fields(more),
        fields(extra)
    ))
}

/// `CreateItem` of the owner's answer to the invitation `id` names at version `key`: sent to the
/// organizer with a copy kept (`send`), or saved and sent to nobody.
pub fn respond(id: &str, key: &str, answer: Answer, send: bool) -> Result<String, &'static str> {
    if !is_change_key(key) {
        return Err(INVALID);
    }
    let element = match answer {
        Answer::Accept => "AcceptItem",
        Answer::Tentative => "TentativelyAcceptItem",
        Answer::Decline => "DeclineItem",
    };
    let disposition = if send { "SendAndSaveCopy" } else { "SaveOnly" };
    Ok(envelope(&format!(
        r#"<m:CreateItem MessageDisposition="{disposition}"><m:Items><t:{element}><t:ReferenceItemId Id="{}" ChangeKey="{}"/></t:{element}></m:Items></m:CreateItem>"#,
        esc(id),
        esc(key)
    )))
}

/// `FindItem` of the Inbox's meeting cancellations, newest first, at most `MAX_ENTRIES`: each one's
/// id, when it came, the `UID` of the meeting it cancels, the event of a series it names, if one, the
/// calendar item it names as its own, and whether a newer message of the meeting has made it out of
/// date (`IsOutOfDate`: the organizer took the owner off and put them back, say).
pub fn find_cancellations() -> String {
    envelope(&format!(
        concat!(
            r#"<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>"#,
            "<t:AdditionalProperties>{}</t:AdditionalProperties></m:ItemShape>",
            r#"<m:IndexedPageItemView MaxEntriesReturned="{}" Offset="0" BasePoint="Beginning"/>"#,
            r#"<m:Restriction><t:IsEqualTo>{}<t:FieldURIOrConstant><t:Constant Value="IPM.Schedule.Meeting.Canceled"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>"#,
            r#"<m:SortOrder><t:FieldOrder Order="Descending">{}</t:FieldOrder></m:SortOrder>"#,
            r#"<m:ParentFolderIds><t:DistinguishedFolderId Id="inbox"/></m:ParentFolderIds></m:FindItem>"#
        ),
        fields(
            "item:DateTimeReceived calendar:UID calendar:RecurrenceId meeting:AssociatedCalendarItemId \
            meeting:IsOutOfDate"
        ),
        MAX_ENTRIES,
        field("item:ItemClass"),
        field("item:DateTimeReceived")
    ))
}

/// Refused: over `max`, a control character (but the line breaks and tab of text that may have
/// them), what XML cannot carry, or blank when it is required.
fn check_text(text: &str, max: usize, lines: bool, required: bool) -> Result<(), &'static str> {
    let allowed = |c: char| {
        matches!(c, '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..)
            && !c.is_control()
            || lines && matches!(c, '\n' | '\r' | '\t')
    };
    if text.len() > max || !text.chars().all(allowed) || required && text.trim().is_empty() {
        return Err(INVALID);
    }
    Ok(())
}

/// Element text: a carriage return is a reference, or the server's parser would turn it into a
/// line feed.
fn text(value: &str) -> String {
    esc(value).replace('\r', "&#13;")
}

/// `Start` and `End` as a calendar item holds them: instants from 1970 on with their `Z`, or days or
/// clock times with no zone, running forwards, in four-digit years, lasting at most a year.
fn times(when: &When) -> Result<(String, String), &'static str> {
    let fits = match *when {
        When::Timed { start_ms, end_ms } => {
            let (start, end) = (start_ms.div_euclid(1000), end_ms.div_euclid(1000));
            (0..=MAX_CURSOR_MS).contains(&start_ms)
                && end_ms <= MAX_CURSOR_MS
                && end > start
                && end - start <= MAX_SPAN_DAYS * 86_400
        }
        When::AllDay { first, after } => {
            let days = (after - first).num_days();
            first.year() >= 1970 && after.year() <= 9999 && (1..=MAX_SPAN_DAYS).contains(&days)
        }
        When::Wall { start, end } => {
            let span = (end - start).num_seconds();
            start.year() >= 1970
                && end.year() <= 9999
                && (1..=MAX_SPAN_DAYS * 86_400).contains(&span)
        }
        When::Clock { .. } => false,
    };
    if !fits {
        return Err(INVALID);
    }
    match *when {
        When::Timed { start_ms, end_ms } => Ok((instant(start_ms)?, instant(end_ms)?)),
        When::AllDay { first, after } => {
            let day = |date: NaiveDate| date.format("%Y-%m-%dT00:00:00").to_string();
            Ok((day(first), day(after)))
        }
        When::Wall { start, end } => {
            let wall = |at: NaiveDateTime| at.format("%Y-%m-%dT%H:%M:%S").to_string();
            Ok((wall(start), wall(end)))
        }
        When::Clock { .. } => Err(INVALID),
    }
}

/// The zone a request names: the owner's for a day, the series' for a clock time, none for instants.
fn zone_for<'a>(when: &When, zone: &'a str) -> Result<Option<&'a str>, &'static str> {
    match when {
        When::Timed { .. } => Ok(None),
        _ => checked_zone(zone).map(Some),
    }
}

fn checked_zone(zone: &str) -> Result<&str, &'static str> {
    match crate::providers::exchange::zone::is_id(zone) {
        true => Ok(zone),
        false => Err(INVALID),
    }
}

/// The `Recurrence` of a new series: one pattern element and one range element, each with its
/// children in the order its page lists them. Dates have no zone: the day of the first event in the
/// zone of the series, as Microsoft's update example writes `StartDate`. `FirstDayOfWeek` is written
/// only for every second week or more, where it decides which days go together, and then as Monday.
/// The caller has checked the rule (`check_series`).
fn recurrence(rule: &Recurrence) -> String {
    let leaf = |name: &str, value: &str| format!("<t:{name}>{value}</t:{name}>");
    let every = |n: &u32| leaf("Interval", &n.to_string());
    let on = |weekday, week: &usize| {
        leaf("DaysOfWeek", day_name(weekday)) + &leaf("DayOfWeekIndex", WEEKS[*week])
    };
    let month = |m: &u32| leaf("Month", MONTHS[*m as usize - 1]);
    let (name, inner) = match &rule.pattern {
        Pattern::Daily(n) => ("DailyRecurrence", every(n)),
        Pattern::Weekly(n, days) => {
            let names: Vec<&str> = days.iter().map(|day| day_name(*day)).collect();
            let first = if *n > 1 {
                leaf("FirstDayOfWeek", DAYS[0])
            } else {
                String::new()
            };
            let inner = every(n) + &leaf("DaysOfWeek", &names.join(" ")) + &first;
            ("WeeklyRecurrence", inner)
        }
        Pattern::Monthly(n, day) => (
            "AbsoluteMonthlyRecurrence",
            every(n) + &leaf("DayOfMonth", &day.to_string()),
        ),
        Pattern::MonthlyBy(n, weekday, week) => {
            ("RelativeMonthlyRecurrence", every(n) + &on(*weekday, week))
        }
        Pattern::Yearly(m, day) => (
            "AbsoluteYearlyRecurrence",
            leaf("DayOfMonth", &day.to_string()) + &month(m),
        ),
        Pattern::YearlyBy(m, weekday, week) => {
            ("RelativeYearlyRecurrence", on(*weekday, week) + &month(m))
        }
    };
    let (range, end) = match rule.end {
        End::Never => ("NoEndRecurrence", String::new()),
        End::Until(day) => ("EndDateRecurrence", leaf("EndDate", &day.to_string())),
        End::Count(n) => (
            "NumberedRecurrence",
            leaf("NumberOfOccurrences", &n.to_string()),
        ),
    };
    let start = leaf("StartDate", &rule.start.to_string());
    format!(
        "<t:Recurrence><t:{name}>{inner}</t:{name}><t:{range}>{start}{end}</t:{range}></t:Recurrence>"
    )
}

/// A rule this event can be the first of: within its bounds, the first event on the rule's first day
/// (a day is that day; an instant is within a day of it, all a zone can move it) and on the rule, and
/// no event longer than the shortest gap between two.
fn check_series(rule: &Recurrence, when: &When) -> Result<(), &'static str> {
    let (on_day, minutes) = match *when {
        When::AllDay { first, after } => (first == rule.start, (after - first).num_minutes()),
        When::Timed { start_ms, end_ms } => (
            plausible_first_day(rule.start, start_ms),
            (end_ms.div_euclid(1000) - start_ms.div_euclid(1000)) / 60,
        ),
        _ => (false, 0),
    };
    match on_day && rule.in_range() && rule.starts_on_pattern() && rule.holds(minutes) {
        true => Ok(()),
        false => Err(INVALID),
    }
}

/// A reminder Outlook could have set.
fn check_reminder(minutes: u32) -> Result<(), &'static str> {
    (minutes <= MAX_REMINDER_MINUTES)
        .then_some(())
        .ok_or(INVALID)
}

/// `CreateItem` of one appointment in the `calendar` folder, invitations to none. A new item has a
/// title, a start and an end, a reminder only if the caller asked for one (not this client's to
/// invent), `Free` for a day and `Busy` for a time, as Outlook does, and the place and notes if there
/// are any. `zone` is the Windows id
/// a day is made in. The children are in the order the schema keeps them.
pub fn create_appointment(item: &Appointment, zone: &str) -> Result<String, &'static str> {
    create_appointment_in(item, zone, Where::Default)
}

/// `create_appointment` in the calendar folder `at` names (`SavedItemFolderId`, "the target folder for
/// operations that ... create items"): nobody is mailed there either.
pub fn create_appointment_in(
    item: &Appointment,
    zone: &str,
    at: Where,
) -> Result<String, &'static str> {
    create_item(item, None, zone, "SendToNone", at)
}

/// `CreateItem` of a meeting: an appointment with `guests` on it, who are mailed their invitations
/// with a copy kept. At least one person, or it is an appointment and refused.
pub fn create_meeting(
    item: &Appointment,
    guests: &Guests,
    zone: &str,
) -> Result<String, &'static str> {
    if guests.len() == 0 {
        return Err(INVALID);
    }
    // Meetings are the default calendar's alone (`folders::default_only`).
    create_item(
        item,
        Some(guests),
        zone,
        "SendToAllAndSaveCopy",
        Where::Default,
    )
}

/// One attendee list of a `CalendarItem`, nothing for an empty one.
fn attendees(list: &str, who: &[String]) -> String {
    if who.is_empty() {
        return String::new();
    }
    let people: String = who
        .iter()
        .map(|address| {
            format!(
                "<t:Attendee><t:Mailbox><t:EmailAddress>{}</t:EmailAddress></t:Mailbox></t:Attendee>",
                esc(address)
            )
        })
        .collect();
    format!("<t:{list}>{people}</t:{list}>")
}

/// The one `CreateItem` of a calendar item: `invitations` is what the caller's own function says about
/// mailing the people on it, and `guests` who they are (none for an appointment).
fn create_item(
    item: &Appointment,
    guests: Option<&Guests>,
    zone: &str,
    invitations: &str,
    at: Where,
) -> Result<String, &'static str> {
    let folder = folder_element(at)?;
    if let Some(guests) = guests {
        guests::check(&guests.required, &guests.optional, "")?;
    }
    check_text(&item.title, MAX_TITLE_BYTES, false, true)?;
    check_text(&item.location, MAX_LOCATION_BYTES, false, false)?;
    if let Some(notes) = &item.notes {
        check_text(notes, MAX_NOTES_BYTES, true, false)?;
    }
    if let Some(minutes) = item.reminder {
        check_reminder(minutes)?;
    }
    let (start, end) = times(&item.when)?;
    let all_day = matches!(item.when, When::AllDay { .. });
    // A series is made in the zone it recurs in, named twice, after the people.
    let (named, series) = match &item.recurrence {
        Some(rule) => {
            check_series(rule, &item.when)?;
            let zone = checked_zone(zone)?;
            let id = esc(zone);
            let zones = format!(r#"<t:StartTimeZone Id="{id}"/><t:EndTimeZone Id="{id}"/>"#);
            (Some(zone), recurrence(rule) + &zones)
        }
        None => (zone_for(&item.when, zone)?, String::new()),
    };
    let body = item.notes.as_deref().map_or_else(String::new, |notes| {
        format!(r#"<t:Body BodyType="Text">{}</t:Body>"#, text(notes))
    });
    let location = if item.location.is_empty() {
        String::new()
    } else {
        format!("<t:Location>{}</t:Location>", text(&item.location))
    };
    let reminder = item.reminder.map_or_else(
        || "<t:ReminderIsSet>false</t:ReminderIsSet>".to_owned(),
        |minutes| {
            format!("<t:ReminderIsSet>true</t:ReminderIsSet><t:ReminderMinutesBeforeStart>{minutes}</t:ReminderMinutesBeforeStart>")
        },
    );
    let people = guests.map_or_else(String::new, |guests| {
        attendees("RequiredAttendees", &guests.required)
            + &attendees("OptionalAttendees", &guests.optional)
    });
    Ok(envelope_in(
        named,
        &format!(
            concat!(
                r#"<m:CreateItem SendMeetingInvitations="{}"><m:SavedItemFolderId>{}</m:SavedItemFolderId>"#,
                "<m:Items><t:CalendarItem><t:Subject>{}</t:Subject>{}{}",
                "<t:Start>{}</t:Start><t:End>{}</t:End><t:IsAllDayEvent>{}</t:IsAllDayEvent>",
                "<t:LegacyFreeBusyStatus>{}</t:LegacyFreeBusyStatus>{}{}{}</t:CalendarItem></m:Items></m:CreateItem>"
            ),
            invitations,
            folder,
            text(&item.title),
            body,
            reminder,
            start,
            end,
            all_day,
            if all_day { "Free" } else { "Busy" },
            location,
            people,
            series
        ),
    ))
}

/// One `SetItemField` of a calendar item property.
fn set(uri: &str, value: &str) -> String {
    format!(
        "<t:SetItemField>{}<t:CalendarItem>{value}</t:CalendarItem></t:SetItemField>",
        field(uri)
    )
}

/// `UpdateItem` of one appointment (EWS id and the change key it was drawn at), setting what
/// `change` names and nothing else, with `NeverOverwrite` and no mail. A new time sets
/// `IsAllDayEvent` first, then for a day the owner's zone, and then the start and end. An empty
/// change is refused: there is nothing to send. So is one that names people: an appointment has
/// none, and a request that gave it some would be a meeting.
pub fn update_appointment(
    id: &str,
    key: &str,
    change: &Change,
    zone: &str,
) -> Result<String, &'static str> {
    if change.required.is_some() || change.optional.is_some() {
        return Err(INVALID);
    }
    update_item(id, key, change, zone, "SendToNone")
}

/// `UpdateItem` of a meeting the caller organises, the update sent to everybody on it (and a
/// cancellation to anybody a list no longer names). A reminder is the owner's own, so a change of it
/// alone goes with `SendToNone`, as Outlook sends nothing for one. Changing nothing, or leaving nobody
/// on it (both lists named and both empty), is refused.
pub fn update_meeting(
    id: &str,
    key: &str,
    change: &Change,
    zone: &str,
) -> Result<String, &'static str> {
    if change.required.is_some_and(<[String]>::is_empty)
        && change.optional.is_some_and(<[String]>::is_empty)
    {
        return Err(INVALID);
    }
    let sending = match change.reminder_only() {
        true => "SendToNone",
        false => "SendToAllAndSaveCopy",
    };
    update_item(id, key, change, zone, sending)
}

/// One `SetItemField` of an attendee list, or the `DeleteItemField` that empties it.
fn set_attendees(list: &str, who: &[String]) -> String {
    let uri = format!("calendar:{list}");
    if who.is_empty() {
        format!("<t:DeleteItemField>{}</t:DeleteItemField>", field(&uri))
    } else {
        set(&uri, &attendees(list, who))
    }
}

/// The one `UpdateItem` of a calendar item: `sending` is what the caller's own function says about
/// telling the people on it.
fn update_item(
    id: &str,
    key: &str,
    change: &Change,
    zone: &str,
    sending: &str,
) -> Result<String, &'static str> {
    if !is_change_key(key) || *change == Change::default() {
        return Err(INVALID);
    }
    let (required, optional) = (change.required, change.optional);
    guests::check(
        required.unwrap_or_default(),
        optional.unwrap_or_default(),
        "",
    )?;
    let mut updates = String::new();
    if let Some(title) = change.title {
        check_text(title, MAX_TITLE_BYTES, false, true)?;
        updates += &set(
            "item:Subject",
            &format!("<t:Subject>{}</t:Subject>", text(title)),
        );
    }
    if let Some(location) = change.location {
        check_text(location, MAX_LOCATION_BYTES, false, false)?;
        let value = format!("<t:Location>{}</t:Location>", text(location));
        updates += &set("calendar:Location", &value);
    }
    let flag = |on: bool| format!("<t:ReminderIsSet>{on}</t:ReminderIsSet>");
    match change.reminder {
        Reminder::Keep => {}
        Reminder::Off => updates += &set("item:ReminderIsSet", &flag(false)),
        Reminder::Minutes(minutes) => {
            check_reminder(minutes)?;
            updates += &set("item:ReminderIsSet", &flag(true));
            let value =
                format!("<t:ReminderMinutesBeforeStart>{minutes}</t:ReminderMinutesBeforeStart>");
            updates += &set("item:ReminderMinutesBeforeStart", &value);
        }
    }
    let mut named = None;
    if let Some(when) = &change.when {
        let (start, end) = times(when)?;
        named = zone_for(when, zone)?;
        // A clock time of a series moves its time of day, never what kind of event it is.
        if !matches!(when, When::Wall { .. }) {
            let all_day = matches!(when, When::AllDay { .. });
            let flag = format!("<t:IsAllDayEvent>{all_day}</t:IsAllDayEvent>");
            updates += &set("calendar:IsAllDayEvent", &flag);
        }
        if let Some(zone) = named {
            let id = esc(zone);
            let start_zone = format!(r#"<t:StartTimeZone Id="{id}"/>"#);
            updates += &set("calendar:StartTimeZone", &start_zone);
            updates += &set(
                "calendar:EndTimeZone",
                &format!(r#"<t:EndTimeZone Id="{id}"/>"#),
            );
        }
        updates += &set("calendar:Start", &format!("<t:Start>{start}</t:Start>"));
        updates += &set("calendar:End", &format!("<t:End>{end}</t:End>"));
    }
    if let Some(who) = required {
        updates += &set_attendees("RequiredAttendees", who);
    }
    if let Some(who) = optional {
        updates += &set_attendees("OptionalAttendees", who);
    }
    Ok(envelope_in(
        named,
        &format!(
            concat!(
                r#"<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="NeverOverwrite" SendMeetingInvitationsOrCancellations="{}">"#,
                r#"<m:ItemChanges><t:ItemChange><t:ItemId Id="{}" ChangeKey="{}"/><t:Updates>{}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>"#
            ),
            sending,
            esc(id),
            esc(key),
            updates
        ),
    ))
}

/// `CreateItem` of a `CancelCalendarItem` for the meeting `id` names at version `key`, sent to
/// everybody on it with a copy kept; `note` is the organizer's own words, if any.
pub fn cancel_meeting(id: &str, key: &str, note: Option<&str>) -> Result<String, &'static str> {
    if !is_change_key(key) {
        return Err(INVALID);
    }
    let note = match note {
        Some(note) => {
            check_text(note, MAX_CANCEL_NOTE_BYTES, true, true)?;
            format!(
                r#"<t:NewBodyContent BodyType="Text">{}</t:NewBodyContent>"#,
                text(note)
            )
        }
        None => String::new(),
    };
    Ok(envelope(&format!(
        r#"<m:CreateItem MessageDisposition="SendAndSaveCopy"><m:Items><t:CancelCalendarItem><t:ReferenceItemId Id="{}" ChangeKey="{}"/>{note}</t:CancelCalendarItem></m:Items></m:CreateItem>"#,
        esc(id),
        esc(key)
    )))
}

/// `CreateItem` of a `RemoveItem` for the `MeetingCancellation` message `id` names at version `key`:
/// the meeting it cancels leaves the calendar and nobody is mailed.
pub fn remove_cancellation(id: &str, key: &str) -> Result<String, &'static str> {
    if !is_change_key(key) {
        return Err(INVALID);
    }
    Ok(envelope(&format!(
        r#"<m:CreateItem MessageDisposition="SaveOnly"><m:Items><t:RemoveItem><t:ReferenceItemId Id="{}" ChangeKey="{}"/></t:RemoveItem></m:Items></m:CreateItem>"#,
        esc(id),
        esc(key)
    )))
}

/// `DeleteItem` of one appointment into Deleted Items, cancellations to none, naming its version
/// as Microsoft's own example does.
pub fn delete_appointment(id: &str, key: &str) -> Result<String, &'static str> {
    if !is_change_key(key) {
        return Err(INVALID);
    }
    Ok(envelope(&format!(
        r#"<m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToNone"><m:ItemIds><t:ItemId Id="{}" ChangeKey="{}"/></m:ItemIds></m:DeleteItem>"#,
        esc(id),
        esc(key)
    )))
}

#[cfg(test)]
mod tests;
