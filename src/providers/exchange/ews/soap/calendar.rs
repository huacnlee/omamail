//! The requests that read the calendar and read, create, change and delete a personal appointment,
//! written from Microsoft's CalendarView, FieldURI, CreateItem (calendar item), UpdateItem,
//! DeleteItem, CalendarItem, TimeZoneContext and StartTimeZone pages and "Time zones and EWS in
//! Exchange", "Create all-day events", "Update appointments and meetings" and "Delete appointments
//! and cancel meetings".
//!
//! - **Nothing is sent to anybody.** Every operation on a calendar item carries the option that says
//!   so: `SendMeetingInvitations`, `SendMeetingInvitationsOrCancellations` and
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

use chrono::{DateTime, Datelike, NaiveDate, SecondsFormat};

use super::{envelope, envelope_in, esc, field};

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
/// Real change keys are about 40 characters; the bound only stops a forged one.
const MAX_CHANGE_KEY: usize = 200;

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
const READ: &str = "item:ParentFolderId item:Subject item:Sensitivity calendar:Start calendar:End \
    calendar:IsAllDayEvent calendar:Location calendar:IsCancelled calendar:IsMeeting \
    calendar:IsRecurring calendar:CalendarItemType calendar:MyResponseType \
    calendar:RequiredAttendees calendar:OptionalAttendees calendar:Resources";

/// When an appointment happens, in the two forms the server keeps one in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum When {
    /// Unix milliseconds; whole seconds are written.
    Timed { start_ms: i64, end_ms: i64 },
    /// The first day and the day after the last.
    AllDay { first: NaiveDate, after: NaiveDate },
}

/// A new personal appointment. `notes` is the body as plain text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Appointment {
    pub title: String,
    pub location: String,
    pub notes: Option<String>,
    pub when: When,
}

/// What an update sets: each member `None` when it stays as it is. Notes are never part of one: the
/// body is not read, so a rewrite would replace what nobody saw.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Change<'a> {
    pub title: Option<&'a str>,
    pub location: Option<&'a str>,
    pub when: Option<When>,
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

/// `FindItem` of the `calendar` folder over a `CalendarView` from the second `start_ms` falls in to
/// the end of the second `end_ms` falls in (a range never shrinks), at most `max` items. The server
/// expands a series into its occurrences, and "a start time that is on or after EndDate will not be
/// returned".
pub fn calendar_view(
    start_ms: i64,
    end_ms: i64,
    max: usize,
    optional: bool,
) -> Result<String, &'static str> {
    if !(1..=MAX_ENTRIES).contains(&max)
        || !(0..=MAX_CURSOR_MS).contains(&start_ms)
        || !(start_ms..=MAX_CURSOR_MS).contains(&end_ms)
    {
        return Err(INVALID);
    }
    let extra = if optional {
        fields(OPTIONAL)
    } else {
        String::new()
    };
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
        CALENDAR
    )))
}

/// `GetItem` of one item (its EWS id, checked by `ids::decode`) for what a write must know first.
pub fn get_appointment(id: &str) -> String {
    envelope(&format!(
        r#"<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>{}</t:AdditionalProperties></m:ItemShape><m:ItemIds><t:ItemId Id="{}"/></m:ItemIds></m:GetItem>"#,
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

/// `Start` and `End` as a calendar item holds them: instants from 1970 on with their `Z`, or days
/// with no zone, running forwards, in four-digit years, lasting at most a year.
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
    }
}

/// The zone a request names: the owner's for a day, none for instants.
fn zone_for<'a>(when: &When, zone: &'a str) -> Result<Option<&'a str>, &'static str> {
    match when {
        When::Timed { .. } => Ok(None),
        When::AllDay { .. } if crate::providers::exchange::zone::is_id(zone) => Ok(Some(zone)),
        When::AllDay { .. } => Err(INVALID),
    }
}

/// `CreateItem` of one appointment in the `calendar` folder, invitations to none. A new item has a
/// title, a start and an end, no reminder (not this client's to invent), `Free` for a day and `Busy`
/// for a time, as Outlook does, and the place and notes if there are any. `zone` is the Windows id
/// a day is made in. The children are in the order the schema keeps them.
pub fn create_appointment(item: &Appointment, zone: &str) -> Result<String, &'static str> {
    check_text(&item.title, MAX_TITLE_BYTES, false, true)?;
    check_text(&item.location, MAX_LOCATION_BYTES, false, false)?;
    if let Some(notes) = &item.notes {
        check_text(notes, MAX_NOTES_BYTES, true, false)?;
    }
    let (start, end) = times(&item.when)?;
    let all_day = matches!(item.when, When::AllDay { .. });
    let body = item.notes.as_deref().map_or_else(String::new, |notes| {
        format!(r#"<t:Body BodyType="Text">{}</t:Body>"#, text(notes))
    });
    let location = if item.location.is_empty() {
        String::new()
    } else {
        format!("<t:Location>{}</t:Location>", text(&item.location))
    };
    Ok(envelope_in(
        zone_for(&item.when, zone)?,
        &format!(
            concat!(
                r#"<m:CreateItem SendMeetingInvitations="SendToNone"><m:SavedItemFolderId>{}</m:SavedItemFolderId>"#,
                "<m:Items><t:CalendarItem><t:Subject>{}</t:Subject>{}<t:ReminderIsSet>false</t:ReminderIsSet>",
                "<t:Start>{}</t:Start><t:End>{}</t:End><t:IsAllDayEvent>{}</t:IsAllDayEvent>",
                "<t:LegacyFreeBusyStatus>{}</t:LegacyFreeBusyStatus>{}</t:CalendarItem></m:Items></m:CreateItem>"
            ),
            CALENDAR,
            text(&item.title),
            body,
            start,
            end,
            all_day,
            if all_day { "Free" } else { "Busy" },
            location
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
/// change is refused: there is nothing to send.
pub fn update_appointment(
    id: &str,
    key: &str,
    change: &Change,
    zone: &str,
) -> Result<String, &'static str> {
    if !is_change_key(key) || *change == Change::default() {
        return Err(INVALID);
    }
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
    let mut named = None;
    if let Some(when) = &change.when {
        let (start, end) = times(when)?;
        named = zone_for(when, zone)?;
        let all_day = named.is_some();
        let flag = format!("<t:IsAllDayEvent>{all_day}</t:IsAllDayEvent>");
        updates += &set("calendar:IsAllDayEvent", &flag);
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
    Ok(envelope_in(
        named,
        &format!(
            concat!(
                r#"<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="NeverOverwrite" SendMeetingInvitationsOrCancellations="SendToNone">"#,
                r#"<m:ItemChanges><t:ItemChange><t:ItemId Id="{}" ChangeKey="{}"/><t:Updates>{}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>"#
            ),
            esc(id),
            esc(key),
            updates
        ),
    ))
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
