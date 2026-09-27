//! Exchange Web Services, for an Outlook calendar whose tenant grants the
//! mail client Exchange but refuses it Microsoft Graph.
//!
//! A locked-down Microsoft 365 tenant commonly lets users consent to IMAP,
//! SMTP and EWS for a desktop mail client while reserving Graph's
//! `Calendars.ReadWrite` for an administrator. The mailbox then signs in and
//! reads mail, and its calendar is out of reach through Graph for good. EWS is
//! the same Exchange resource the mail token already names, so the same
//! refresh token buys it, and its `FindItem` with a `CalendarView` reads the
//! same calendar.
//!
//! The answer is handed to the UI in the shape Graph's `calendarView` has, so
//! `Calendar.eventsFromGraph` draws it and nothing downstream learns a second
//! vocabulary. Read-only: listing is what a locked tenant loses, and writing
//! through EWS is a separate decision.
//!
//! Everything sent is built here from validated values - there is no field in
//! the request a caller writes verbatim - and everything received is parsed by
//! an event reader with a ceiling on how many items it keeps.

use quick_xml::{Reader, events::Event};
use serde_json::{Value, json};

/// The one place a request goes. Fixed, like Graph's: the destination is not
/// something a source, an account or a server answer can name.
pub const ENDPOINT: &str = "https://outlook.office365.com/EWS/Exchange.asmx";

/// A calendar view past this many occurrences is cut, and the answer says so.
pub const MAX_ITEMS: usize = 500;

const FIELDS: &[&str] = &[
    "item:Subject",
    "calendar:Start",
    "calendar:End",
    "calendar:IsAllDayEvent",
    "calendar:Location",
    "calendar:Organizer",
    "calendar:IsCancelled",
    "calendar:UID",
];

/// An instant as a caller may name one: digits, `T`, `:`, `-`, `+`, `.` and
/// `Z`, and nothing else. Stricter than escaping, because a view boundary has
/// no business carrying anything an XML parser would treat as markup.
fn instant(value: &str) -> Result<&str, &'static str> {
    if value.is_empty()
        || value.len() > 40
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'T' | b':' | b'-' | b'+' | b'.' | b'Z'))
    {
        return Err("calendar_invalid_input");
    }
    Ok(value)
}

/// The SOAP envelope for one calendar view of the default calendar.
pub fn list_body(start: &str, end: &str) -> Result<String, &'static str> {
    let start = instant(start)?;
    let end = instant(end)?;
    let fields: String = FIELDS
        .iter()
        .map(|field| format!(r#"<t:FieldURI FieldURI="{field}"/>"#))
        .collect();
    Ok(format!(
        concat!(
            r#"<?xml version="1.0" encoding="utf-8"?>"#,
            r#"<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" "#,
            r#"xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" "#,
            r#"xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">"#,
            r#"<soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header>"#,
            r#"<soap:Body><m:FindItem Traversal="Shallow"><m:ItemShape>"#,
            r#"<t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>{fields}"#,
            r#"</t:AdditionalProperties></m:ItemShape>"#,
            r#"<m:CalendarView MaxEntriesReturned="{max}" StartDate="{start}" EndDate="{end}"/>"#,
            r#"<m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"/></m:ParentFolderIds>"#,
            r#"</m:FindItem></soap:Body></soap:Envelope>"#
        ),
        fields = fields,
        max = MAX_ITEMS,
        start = start,
        end = end
    ))
}

/// The mailbox an EWS request is routed to, from the account id
/// (`outlook:<address>`). Exchange Online wants it named on every request.
pub fn anchor(account_id: &str) -> Result<&str, &'static str> {
    let address = account_id
        .strip_prefix("outlook:")
        .ok_or("calendar_invalid_input")?;
    if address.is_empty()
        || address.len() > 320
        || !address.contains('@')
        || address
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '<' | '>' | '"'))
    {
        return Err("calendar_invalid_input");
    }
    Ok(address)
}

#[derive(Default)]
struct Item {
    id: String,
    uid: String,
    subject: String,
    start: String,
    end: String,
    all_day: bool,
    cancelled: bool,
    location: String,
    organizer_name: String,
    organizer_address: String,
}

impl Item {
    fn to_graph(&self) -> Value {
        json!({
            "id": self.id,
            "iCalUId": self.uid,
            "subject": self.subject,
            "isAllDay": self.all_day,
            "isCancelled": self.cancelled,
            // EWS instants are UTC with a Z; the UI converts an all-day one
            // to its own local date and strips the Z from the rest - see
            // Calendar.eventsFromEws.
            "start": {"dateTime": self.start, "timeZone": "UTC"},
            "end": {"dateTime": self.end, "timeZone": "UTC"},
            "location": {"displayName": self.location},
            "organizer": {"emailAddress": {"name": self.organizer_name,
                                           "address": self.organizer_address}},
            "webLink": "",
        })
    }
}

fn local<'a>(name: &'a [u8]) -> &'a [u8] {
    name.rsplit(|b| *b == b':').next().unwrap_or(name)
}

/// What a tag says before its children: a fault or an error ends the read, an
/// `ItemId` names the item being read, and a `CalendarItem` starts one - or,
/// past the ceiling, marks the view truncated and leaves `current` empty so
/// the caller stops.
fn open(
    tag: &quick_xml::events::BytesStart<'_>,
    current: &mut Option<Item>,
    truncated: &mut bool,
    kept: usize,
) -> Result<Vec<u8>, &'static str> {
    let name = local(tag.name().as_ref()).to_vec();
    if name.as_slice() == b"Fault" {
        return Err("calendar_request_failed");
    }
    for attribute in tag.attributes().flatten() {
        let key = local(attribute.key.as_ref()).to_vec();
        let value = attribute
            .unescape_value()
            .map_err(|_| "calendar_invalid_response")?;
        if key.as_slice() == b"ResponseClass" && value == "Error" {
            return Err("calendar_request_failed");
        }
        if key.as_slice() == b"IncludesLastItemInRange" && value == "false" {
            *truncated = true;
        }
        if key.as_slice() == b"Id"
            && name.as_slice() == b"ItemId"
            && let Some(item) = current.as_mut()
        {
            item.id = value.chars().take(1024).collect();
        }
    }
    if name.as_slice() == b"CalendarItem" {
        if kept >= MAX_ITEMS {
            *truncated = true;
            *current = None;
        } else {
            *current = Some(Item::default());
        }
    }
    Ok(name)
}

/// A `FindItem` answer as Graph's `{"value": [...]}`, plus `truncated` when the
/// view held more than `MAX_ITEMS`. An EWS error arrives as HTTP 200 with
/// `ResponseClass="Error"`, and a SOAP fault as 500; both are refusals here.
pub fn graph_shape(xml: &str) -> Result<Value, &'static str> {
    let mut reader = Reader::from_str(xml);
    let mut items: Vec<Item> = Vec::new();
    let mut current: Option<Item> = None;
    let mut path: Vec<Vec<u8>> = Vec::new();
    let mut text = String::new();
    let mut truncated = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = open(&tag, &mut current, &mut truncated, items.len())?;
                if name.as_slice() == b"CalendarItem" && current.is_none() {
                    break;
                }
                path.push(name);
                text.clear();
            }
            Ok(Event::Empty(tag)) => {
                open(&tag, &mut current, &mut truncated, items.len())?;
            }
            Ok(Event::Text(event)) if current.is_some() => {
                text.push_str(&event.decode().map_err(|_| "calendar_invalid_response")?);
            }
            Ok(Event::CData(event)) if current.is_some() => {
                text.push_str(&event.decode().map_err(|_| "calendar_invalid_response")?);
            }
            Ok(Event::GeneralRef(event)) if current.is_some() => {
                super::discovery::append_reference(&mut text, &event)?;
            }
            Ok(Event::End(_)) => {
                let name = path.pop().unwrap_or_default();
                if name.as_slice() == b"CalendarItem" {
                    if let Some(item) = current.take() {
                        items.push(item);
                    }
                } else if let Some(item) = current.as_mut() {
                    let parent = path.last().map(Vec::as_slice).unwrap_or(b"");
                    let in_organizer = path.iter().any(|p| p.as_slice() == b"Organizer");
                    let value: String = text
                        .trim()
                        .chars()
                        .filter(|c: &char| !c.is_control())
                        .take(2000)
                        .collect();
                    match name.as_slice() {
                        b"Subject" if parent == b"CalendarItem" => item.subject = value,
                        b"Start" if parent == b"CalendarItem" => item.start = value,
                        b"End" if parent == b"CalendarItem" => item.end = value,
                        b"IsAllDayEvent" => item.all_day = value == "true",
                        b"IsCancelled" => item.cancelled = value == "true",
                        b"Location" if parent == b"CalendarItem" => item.location = value,
                        b"UID" => item.uid = value,
                        b"Name" if in_organizer => item.organizer_name = value,
                        b"EmailAddress" if in_organizer => item.organizer_address = value,
                        _ => {}
                    }
                }
                text.clear();
            }
            Ok(Event::Eof) => break,
            Err(_) => return Err("calendar_invalid_response"),
            _ => {}
        }
    }
    Ok(json!({
        "value": items.iter().map(Item::to_graph).collect::<Vec<_>>(),
        "truncated": truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(items: &str, last: bool) -> String {
        format!(
            concat!(
                r#"<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">"#,
                r#"<s:Body><m:FindItemResponse xmlns:m="m" xmlns:t="t"><m:ResponseMessages>"#,
                r#"<m:FindItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>"#,
                r#"<m:RootFolder TotalItemsInView="1" IncludesLastItemInRange="{last}"><t:Items>{items}"#,
                r#"</t:Items></m:RootFolder></m:FindItemResponseMessage></m:ResponseMessages>"#,
                r#"</m:FindItemResponse></s:Body></s:Envelope>"#
            ),
            items = items,
            last = last
        )
    }

    const ITEM: &str = concat!(
        r#"<t:CalendarItem><t:ItemId Id="AAMk=" ChangeKey="DwAA"/>"#,
        r#"<t:Subject>Budget &amp; plan</t:Subject><t:Start>2026-09-28T08:00:00Z</t:Start>"#,
        r#"<t:End>2026-09-28T09:00:00Z</t:End><t:IsAllDayEvent>false</t:IsAllDayEvent>"#,
        r#"<t:Location>Room 2</t:Location><t:IsCancelled>false</t:IsCancelled><t:UID>uid-1</t:UID>"#,
        r#"<t:Organizer><t:Mailbox><t:Name>Dana</t:Name><t:EmailAddress>dana@example.org</t:EmailAddress>"#,
        r#"</t:Mailbox></t:Organizer></t:CalendarItem>"#
    );

    #[test]
    fn a_view_comes_back_in_graphs_shape() {
        let shaped = graph_shape(&answer(ITEM, true)).unwrap();
        let event = &shaped["value"][0];
        assert_eq!(event["id"], "AAMk=");
        assert_eq!(event["subject"], "Budget & plan");
        assert_eq!(event["start"]["dateTime"], "2026-09-28T08:00:00Z");
        assert_eq!(event["location"]["displayName"], "Room 2");
        assert_eq!(event["organizer"]["emailAddress"]["address"], "dana@example.org");
        assert_eq!(event["iCalUId"], "uid-1");
        assert_eq!(shaped["truncated"], false);
    }

    #[test]
    fn an_error_inside_a_success_status_is_a_refusal() {
        let error = answer("", true).replace(r#"ResponseClass="Success""#, r#"ResponseClass="Error""#);
        assert_eq!(graph_shape(&error), Err("calendar_request_failed"));
        let fault = r#"<s:Envelope xmlns:s="s"><s:Body><s:Fault><faultcode>x</faultcode></s:Fault></s:Body></s:Envelope>"#;
        assert_eq!(graph_shape(fault), Err("calendar_request_failed"));
    }

    #[test]
    fn a_view_past_the_ceiling_is_cut_and_says_so() {
        let many: String = ITEM.repeat(MAX_ITEMS + 3);
        let shaped = graph_shape(&answer(&many, true)).unwrap();
        assert_eq!(shaped["value"].as_array().unwrap().len(), MAX_ITEMS);
        assert_eq!(shaped["truncated"], true);
        assert_eq!(graph_shape(&answer(ITEM, false)).unwrap()["truncated"], true);
    }

    #[test]
    fn control_characters_never_reach_the_ui() {
        let item = ITEM.replace("Budget &amp; plan", "Budget&#10;plan&#0;");
        let shaped = graph_shape(&answer(&item, true));
        // A NUL reference is not XML at all; a newline is dropped from the text.
        if let Ok(shaped) = shaped {
            assert!(!shaped["value"][0]["subject"].as_str().unwrap().contains(['\n', '\0']));
        }
    }

    #[test]
    fn malformed_xml_is_refused() {
        assert_eq!(graph_shape("<a><b></a>"), Err("calendar_invalid_response"));
    }

    #[test]
    fn a_view_boundary_carries_nothing_but_an_instant() {
        assert!(list_body("2026-09-28T00:00:00Z", "2026-10-05T00:00:00Z").is_ok());
        for bad in ["", "2026\"/><x", "2026-09-28T00:00:00Z<", "2026 09", "2026-09-28\n", "&amp;"] {
            assert_eq!(list_body(bad, "2026-10-05T00:00:00Z"), Err("calendar_invalid_input"));
        }
    }

    #[test]
    fn the_anchor_is_the_accounts_own_address() {
        assert_eq!(anchor("outlook:jan@example.org"), Ok("jan@example.org"));
        for bad in ["jan@example.org", "imap:jan@example.org", "outlook:", "outlook:no-at",
                    "outlook:a@b\r\nX-Evil: 1", "outlook:a@b c"] {
            assert_eq!(anchor(bad), Err("calendar_invalid_input"), "{bad:?}");
        }
    }
}
