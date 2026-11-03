//! A private calendar copy of an invitation answered through another mailbox.
//! RSVP remains mail; import and silent patches never notify the guests again.
//! Google copies use its import API. A CalDAV copy is the invitation's own
//! event without ORGANIZER or ATTENDEE lines, so the server has nothing to
//! schedule and sends no second reply.
use super::ics::{self, Component};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::future::Future;

const COPY_LIMIT: usize = 512 * 1024;
const CALENDAR_PROPERTIES: &[&str] = &["VERSION", "PRODID", "CALSCALE"];
const ZONE_PROPERTIES: &[&str] = &["TZID", "LAST-MODIFIED", "X-LIC-LOCATION"];
const RULE_PROPERTIES: &[&str] = &[
    "DTSTART",
    "TZOFFSETFROM",
    "TZOFFSETTO",
    "RRULE",
    "RDATE",
    "TZNAME",
    "COMMENT",
];
// No ORGANIZER, ATTENDEE, VALARM or URL: the sender does not get to put
// people, alarms or links into the copy beyond the text the card shows.
const EVENT_PROPERTIES: &[&str] = &[
    "UID",
    "DTSTAMP",
    "SEQUENCE",
    "DTSTART",
    "DTEND",
    "DURATION",
    "RECURRENCE-ID",
    "SUMMARY",
    "DESCRIPTION",
    "LOCATION",
    "RRULE",
    "RDATE",
    "EXDATE",
    "STATUS",
    "TRANSP",
];
const SINGLE_PROPERTIES: &[&str] = &[
    "UID",
    "DTSTAMP",
    "SEQUENCE",
    "DTSTART",
    "DTEND",
    "DURATION",
    "RECURRENCE-ID",
    "SUMMARY",
    "DESCRIPTION",
    "LOCATION",
    "STATUS",
    "TRANSP",
];
const MAILBOX: &str = "X-OMAMAIL-MAILBOX";
const ORGANIZER: &str = "X-OMAMAIL-ORGANIZER";
const SEQUENCE: &str = "X-OMAMAIL-SEQUENCE";

static WRITES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn validate(p: &Value) -> Result<(), &'static str> {
    let fields = p.as_object().ok_or("invalid_params")?;
    if fields.keys().any(|k| {
        ![
            "source",
            "mailbox",
            "uid",
            "organizer",
            "response",
            "sequence",
            "event",
            "calendar",
            "originalStart",
        ]
        .contains(&k.as_str())
    }) {
        return Err("invalid_params");
    }
    let source = &p["source"];
    if source["readOnly"] == true {
        return Err("invalid_params");
    }
    let google = match source["kind"].as_str() {
        Some("google") => true,
        Some("caldav" | "icloud") => false,
        _ => return Err("invalid_params"),
    };
    if google {
        let account = super::text(source, "accountId")?;
        if !account.contains('@')
            || account.contains(':')
            || account.chars().any(char::is_whitespace)
        {
            return Err("invalid_params");
        }
        destination_owner(source)?;
    }
    super::text(p, "mailbox")?;
    super::text(p, "uid")?;
    let organizer = super::text(p, "organizer")?;
    if !organizer.contains('@') || organizer.chars().any(char::is_whitespace) {
        return Err("invalid_params");
    }
    if !matches!(
        p["response"].as_str(),
        Some("accepted" | "tentative" | "declined" | "cancelled")
    ) || p["sequence"].as_u64().is_none_or(|n| n > i32::MAX as u64)
    {
        return Err("invalid_params");
    }
    if let Some(start) = p.get("originalStart") {
        let start = start.as_str().ok_or("invalid_params")?;
        if chrono::DateTime::parse_from_rfc3339(start).is_err()
            && chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d").is_err()
        {
            return Err("invalid_params");
        }
    }
    if !google {
        if p.get("event").is_some() {
            return Err("invalid_params");
        }
        let removal = matches!(p["response"].as_str(), Some("cancelled" | "declined"));
        match p.get("calendar") {
            Some(text) => {
                copy(text.as_str().ok_or("invalid_params")?, p)?;
            }
            // A removed series needs only its UID; anything else is written
            // from, or matched against, the invitation's own event.
            None if removal && p.get("originalStart").is_none() => {}
            None => return Err("invalid_params"),
        }
        return super::validate(&json!({"source":source,"operation":"list","body":"lookup"}))
            .map_err(|_| "invalid_params");
    }
    if p.get("calendar").is_some() {
        return Err("invalid_params");
    }
    if !matches!(p["response"].as_str(), Some("cancelled" | "declined")) {
        let event = p["event"].as_object().ok_or("invalid_params")?;
        if event.keys().any(|k| {
            ![
                "summary",
                "description",
                "location",
                "start",
                "end",
                "recurrence",
            ]
            .contains(&k.as_str())
        }) || event.len() > 6
            || p["event"].to_string().len() > 512 * 1024
        {
            return Err("invalid_params");
        }
        for key in ["summary", "description", "location"] {
            if event
                .get(key)
                .is_some_and(|v| !v.is_string() || v.as_str().unwrap().contains('\0'))
            {
                return Err("invalid_params");
            }
        }
        for key in ["start", "end"] {
            let time = event
                .get(key)
                .and_then(Value::as_object)
                .ok_or("invalid_params")?;
            if time
                .keys()
                .any(|k| !["date", "dateTime", "timeZone"].contains(&k.as_str()))
            {
                return Err("invalid_params");
            }
            let valid = match (time.get("date"), time.get("dateTime")) {
                (Some(d), None) => d
                    .as_str()
                    .is_some_and(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()),
                (None, Some(d)) => d
                    .as_str()
                    .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok()),
                _ => false,
            };
            if !valid
                || time.get("timeZone").is_some_and(|z| {
                    z.as_str().is_none_or(|s| {
                        s.is_empty() || s.len() > 256 || s.chars().any(char::is_control)
                    })
                })
            {
                return Err("invalid_params");
            }
        }
        let instant = |time: &Value| -> Option<i64> {
            if let Some(date) = time["date"].as_str() {
                return chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .ok()?
                    .and_hms_opt(0, 0, 0)
                    .map(|v| v.and_utc().timestamp());
            }
            chrono::DateTime::parse_from_rfc3339(time["dateTime"].as_str()?)
                .ok()
                .map(|v| v.timestamp())
        };
        if event["start"].get("date").is_some() != event["end"].get("date").is_some()
            || instant(&event["end"]) <= instant(&event["start"])
        {
            return Err("invalid_params");
        }
        if let Some(rules) = event.get("recurrence") {
            let rules = rules.as_array().ok_or("invalid_params")?;
            if rules.len() > 128
                || rules.iter().any(|v| {
                    v.as_str().is_none_or(|s| {
                        s.len() > 8192
                            || s.chars().any(char::is_control)
                            || !(s.starts_with("RRULE:")
                                || s.starts_with("EXDATE:")
                                || s.starts_with("EXDATE;VALUE=DATE:"))
                    })
                })
            {
                return Err("invalid_params");
            }
        }
    }
    super::validate(&json!({"source":source,"operation":"lookup","uid":p["uid"]}))
}

pub async fn google(p: &Value, token: &str) -> Result<Value, &'static str> {
    validate(p)?;
    tokio::time::timeout(std::time::Duration::from_secs(50), async {
        // Serialize the lookup/import pair, including retries from another reader.
        let _guard = WRITES.lock().await;
        save(p, |params| async move {
            let result = super::call(&params, Some(token)).await?;
            let body = result["body"].as_str().ok_or("calendar_invalid_response")?;
            if body.is_empty() {
                return Ok(json!({}));
            }
            serde_json::from_str(body).map_err(|_| "calendar_invalid_response")
        })
        .await
    })
    .await
    .map_err(|_| "calendar_timeout")?
}

fn destination_owner(source: &Value) -> Result<&str, &'static str> {
    let calendar = source["calendarId"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != "primary");
    let owner = calendar.unwrap_or(super::text(source, "accountId")?);
    if !owner.contains('@') || owner.chars().any(char::is_whitespace) {
        return Err("calendar_invalid_input");
    }
    Ok(owner)
}

async fn save<F, Fut>(p: &Value, mut request: F) -> Result<Value, &'static str>
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = Result<Value, &'static str>>,
{
    validate(p)?;
    let source = &p["source"];
    let found = request(json!({"source":source,"operation":"lookup","uid":p["uid"]})).await?;
    if found.get("nextPageToken").is_some() {
        return Err("calendar_ambiguous_invitation");
    }
    let items = found["items"]
        .as_array()
        .ok_or("calendar_invalid_response")?;
    let matching: Vec<&Value> = items
        .iter()
        .filter(|e| e["iCalUID"] == p["uid"] && e.get("recurringEventId").is_none())
        .collect();
    if matching.len() > 1 {
        return Err("calendar_ambiguous_invitation");
    }
    let parent = matching.first().copied();
    if let Some(event) = parent {
        check_owner(event, p)?;
        // An existing native/manual copy belongs to its calendar, not this importer.
        if event["extendedProperties"]["private"]["omamailMailbox"] != p["mailbox"] {
            return Ok(json!({"status":"existing"}));
        }
        if event["extendedProperties"]["private"]["omamailSequence"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
            > p["sequence"].as_u64().unwrap()
        {
            return Ok(json!({"status":"newer"}));
        }
    }
    let mut occurrence = None;
    if let Some(original) = p.get("originalStart") {
        let parent = parent.ok_or("calendar_invitation_series_required")?;
        let instances = request(json!({"source":source,"operation":"instances","eventId":super::text(parent,"id")?,"originalStart":original})).await?;
        if instances.get("nextPageToken").is_some() {
            return Err("calendar_ambiguous_invitation");
        }
        let matches: Vec<Value> = instances["items"]
            .as_array()
            .ok_or("calendar_invalid_response")?
            .iter()
            .filter(|e| {
                let start = &e["originalStartTime"];
                start["date"] == *original
                    || start["dateTime"] == *original
                    || start["dateTime"]
                        .as_str()
                        .zip(original.as_str())
                        .is_some_and(|(a, b)| {
                            chrono::DateTime::parse_from_rfc3339(a)
                                .ok()
                                .zip(chrono::DateTime::parse_from_rfc3339(b).ok())
                                .is_some_and(|(a, b)| a == b)
                        })
            })
            .cloned()
            .collect();
        if matches.len() != 1 {
            return Err("calendar_invitation_not_found");
        }
        check_owner(&matches[0], p)?;
        if matches[0]["extendedProperties"]["private"]["omamailSequence"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
            > p["sequence"].as_u64().unwrap()
        {
            return Ok(json!({"status":"newer"}));
        }
        occurrence = matches.into_iter().next();
    }
    let existing = occurrence.as_ref().or(parent);
    let remove = matches!(p["response"].as_str(), Some("cancelled" | "declined"));
    if remove && existing.is_none() {
        return Ok(json!({"status":"absent"}));
    }
    let mut body = if remove {
        json!({"status":"cancelled"})
    } else {
        p["event"].clone()
    };
    // Google import requires the destination calendar to be a participant.
    // Include only that calendar, never guests from the invitation. This remains
    // a private import; updates suppress notifications and preserve other guests.
    if !remove {
        body["status"] = json!(if p["response"] == "tentative" {
            "tentative"
        } else {
            "confirmed"
        });
        body["transparency"] = json!("opaque");
        body["attendees"] =
            json!([{"email":destination_owner(source)?,"responseStatus":p["response"]}]);
        if existing.is_some() {
            body["attendeesOmitted"] = json!(true);
        }
    }
    body["extendedProperties"] = json!({"private":{"omamailMailbox":p["mailbox"],"omamailSequence":p["sequence"].to_string()}});
    if let Some(event) = existing {
        request(json!({"source":source,"operation":"update","eventId":super::text(event,"id")?,"ifMatch":super::text(event,"etag")?,"sendUpdates":"none","body":body.to_string()})).await?;
    } else {
        body["iCalUID"] = p["uid"].clone();
        body["organizer"] = json!({"email":p["organizer"]});
        request(json!({"source":source,"operation":"import","body":body.to_string()})).await?;
    }
    Ok(json!({"status":if remove { "removed" } else { "saved" }}))
}

/// The invitation's event as the copy will hold it, refused outright if it
/// carries anything outside the fields an invitation copy keeps.
fn copy(text: &str, p: &Value) -> Result<Component, &'static str> {
    if text.len() > COPY_LIMIT || text.contains('\0') {
        return Err("invalid_params");
    }
    let calendar = Component::parse(text).map_err(|_| "invalid_params")?;
    // The markers are this importer's; a sender may not write them, not even
    // as a parameter.
    let allowed = |c: &Component, names: &[&str]| {
        c.lines
            .iter()
            .all(|line| names.contains(&ics::name(line).as_str()) && !marker_parameter(line))
    };
    let mut events = 0;
    for child in &calendar.children {
        let valid = match child.name.as_str() {
            "VTIMEZONE" => {
                allowed(child, ZONE_PROPERTIES)
                    && child.property("TZID").is_some()
                    && child.children.iter().all(|rule| {
                        matches!(rule.name.as_str(), "STANDARD" | "DAYLIGHT")
                            && rule.children.is_empty()
                            && allowed(rule, RULE_PROPERTIES)
                    })
            }
            "VEVENT" => {
                events += 1;
                allowed(child, EVENT_PROPERTIES)
                    && child.children.is_empty()
                    && SINGLE_PROPERTIES.iter().all(|wanted| {
                        child
                            .lines
                            .iter()
                            .filter(|l| ics::name(l) == *wanted)
                            .count()
                            <= 1
                    })
            }
            _ => false,
        };
        if !valid {
            return Err("invalid_params");
        }
    }
    let event = calendar
        .children
        .iter()
        .find(|c| c.name == "VEVENT")
        .ok_or("invalid_params")?;
    if events != 1
        || !allowed(&calendar, CALENDAR_PROPERTIES)
        || event.text("UID").as_deref() != p["uid"].as_str()
        || event.property("DTSTART").is_none()
        || event.property("RECURRENCE-ID").is_some() != p.get("originalStart").is_some()
    {
        return Err("invalid_params");
    }
    Ok(calendar)
}

fn recurrence_key(event: &Component) -> Option<(String, String)> {
    let line = event.property("RECURRENCE-ID")?;
    Some((
        ics::param(line, "TZID").unwrap_or_default(),
        ics::value(line).trim().to_ascii_uppercase(),
    ))
}

fn is_exdate(line: &str) -> bool {
    line.get(..7).is_some_and(|name| {
        name.eq_ignore_ascii_case("EXDATE;") || name.eq_ignore_ascii_case("EXDATE:")
    })
}

fn marker_parameter(line: &str) -> bool {
    let head = &line[..line.len() - ics::value(line).len()];
    head.split(';').skip(1).any(|piece| {
        piece
            .get(..9)
            .is_some_and(|key| key.eq_ignore_ascii_case("X-OMAMAIL"))
    })
}

/// Whether an EXDATE line excludes this occurrence; a line may list several dates.
fn excludes(line: &str, key: &(String, String)) -> bool {
    is_exdate(line)
        && ics::param(line, "TZID").unwrap_or_default() == key.0
        && ics::value(line)
            .split(',')
            .any(|date| date.trim().eq_ignore_ascii_case(&key.1))
}

/// The EXDATE line without this occurrence's date, or nothing when that was
/// its only date.
fn without_date(line: &str, key: &(String, String)) -> Option<String> {
    if !excludes(line, key) {
        return Some(line.to_owned());
    }
    let value = ics::value(line);
    let rest: Vec<&str> = value
        .split(',')
        .filter(|date| !date.trim().eq_ignore_ascii_case(&key.1))
        .collect();
    (!rest.is_empty()).then(|| format!("{}{}", &line[..line.len() - value.len()], rest.join(",")))
}

/// The sequence of a decline this importer wrote as an EXDATE.
fn decline_sequence(line: &str) -> Option<u64> {
    if !is_exdate(line) {
        return None;
    }
    ics::param(line, SEQUENCE)?.trim().parse().ok()
}

fn declined_sequence(master: &Component, key: &(String, String)) -> Option<u64> {
    master
        .lines
        .iter()
        .filter(|line| excludes(line, key))
        .filter_map(|line| decline_sequence(line))
        .max()
}

fn copy_organizer(event: &Component) -> Option<String> {
    event.text(ORGANIZER).or_else(|| {
        let address = ics::value(event.property("ORGANIZER")?);
        let address = address
            .get(..7)
            .filter(|scheme| scheme.eq_ignore_ascii_case("mailto:"))
            .map_or(address, |_| &address[7..]);
        Some(address.trim().to_owned())
    })
}

fn copy_sequence(event: &Component) -> u64 {
    event
        .text(SEQUENCE)
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// The invitation's event, marked as this mailbox's managed copy.
fn managed(event: &Component, p: &Value) -> Component {
    let mut event = event.clone();
    event.remove(&["STATUS", "TRANSP", MAILBOX, ORGANIZER, SEQUENCE]);
    let status = if p["response"] == "tentative" {
        "TENTATIVE"
    } else {
        "CONFIRMED"
    };
    event.lines.extend([
        format!("STATUS:{status}"),
        "TRANSP:OPAQUE".into(),
        format!(
            "{MAILBOX}:{}",
            ics::escape(p["mailbox"].as_str().unwrap_or(""))
        ),
        format!(
            "{ORGANIZER}:{}",
            ics::escape(p["organizer"].as_str().unwrap_or(""))
        ),
        format!("{SEQUENCE}:{}", p["sequence"].as_u64().unwrap_or(0)),
    ]);
    event
}

pub async fn caldav(p: &Value) -> Result<Value, &'static str> {
    validate(p)?;
    tokio::time::timeout(std::time::Duration::from_secs(50), async {
        let _guard = WRITES.lock().await;
        save_caldav(p, |params| async move { super::call(&params, None).await }).await
    })
    .await
    .map_err(|_| "calendar_timeout")?
}

fn uid_query(uid: &str) -> String {
    let uid = uid
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><c:calendar-query xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name=\"VCALENDAR\"><c:comp-filter name=\"VEVENT\"><c:prop-filter name=\"UID\"><c:text-match collation=\"i;octet\">{uid}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"
    )
}

async fn save_caldav<F, Fut>(p: &Value, mut request: F) -> Result<Value, &'static str>
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = Result<Value, &'static str>>,
{
    validate(p)?;
    let source = &p["source"];
    let uid = p["uid"].as_str().unwrap();
    let organizer = p["organizer"].as_str().unwrap();
    let sequence = p["sequence"].as_u64().unwrap();
    let remove = matches!(p["response"].as_str(), Some("cancelled" | "declined"));
    let invitation = p["calendar"]
        .as_str()
        .map(|text| copy(text, p))
        .transpose()?;
    let found = request(json!({"source":source,"operation":"list","body":uid_query(uid)})).await?;
    let body = found["body"].as_str().ok_or("calendar_invalid_response")?;
    // text-match is a substring match: keep only resources holding this UID.
    let mut matching = Vec::new();
    for object in super::discovery::dav_objects(body)? {
        // An object this cannot read might be the saved copy; creating a
        // second one beside it would be worse than refusing.
        let Ok(calendar) = Component::parse(&object.data) else {
            return Err("calendar_invalid_response");
        };
        if calendar
            .children
            .iter()
            .any(|c| c.name == "VEVENT" && c.text("UID").as_deref() == Some(uid))
        {
            matching.push((object, calendar));
        }
    }
    if matching.len() > 1 {
        return Err("calendar_ambiguous_invitation");
    }
    let existing = matching.into_iter().next();
    if let Some((_, calendar)) = &existing {
        let events: Vec<&Component> = calendar
            .children
            .iter()
            .filter(|c| c.name == "VEVENT")
            .collect();
        let master = events
            .iter()
            .find(|e| e.property("RECURRENCE-ID").is_none())
            .or(events.first())
            .unwrap();
        if copy_organizer(master).is_none_or(|found| !found.eq_ignore_ascii_case(organizer)) {
            return Err("calendar_organizer_mismatch");
        }
        // An existing native/manual copy belongs to its calendar, not this importer.
        if master.text(MAILBOX).as_deref() != p["mailbox"].as_str() {
            return Ok(json!({"status":"existing"}));
        }
        let key = invitation
            .as_ref()
            .and_then(|c| c.children.iter().find(|c| c.name == "VEVENT"))
            .and_then(recurrence_key);
        // An occurrence not saved on its own yet is as new as its series.
        let current = key
            .as_ref()
            .and_then(|key| {
                events
                    .iter()
                    .find(|e| recurrence_key(e).as_ref() == Some(key))
            })
            .unwrap_or(master);
        let declined = key.as_ref().and_then(|key| declined_sequence(master, key));
        if copy_sequence(current) > sequence || declined.is_some_and(|s| s > sequence) {
            return Ok(json!({"status":"newer"}));
        }
    }
    let event = invitation
        .as_ref()
        .and_then(|c| c.children.iter().find(|c| c.name == "VEVENT"))
        .cloned();
    let occurrence = event.as_ref().and_then(recurrence_key);
    let Some((object, mut calendar)) = existing else {
        if occurrence.is_some() {
            return Err("calendar_invitation_series_required");
        }
        if remove {
            return Ok(json!({"status":"absent"}));
        }
        let invitation = invitation.ok_or("invalid_params")?;
        let mut copy = Component::new("VCALENDAR");
        copy.lines = vec![
            "VERSION:2.0".into(),
            "PRODID:-//Omamail//Invitation copy//EN".into(),
        ];
        for child in &invitation.children {
            copy.children.push(if child.name == "VEVENT" {
                managed(child, p)
            } else {
                child.clone()
            });
        }
        let digest = Sha256::digest(uid.as_bytes());
        let href = format!("omamail-invitation-{:x}.ics", digest);
        request(json!({"source":source,"operation":"create","href":href,"ifNoneMatch":"*","body":copy.write()})).await?;
        return Ok(json!({"status":"saved"}));
    };
    if object.etag.is_empty() {
        return Err("calendar_invalid_response");
    }
    let target = json!({"source":source,"href":object.href,"ifMatch":object.etag});
    if remove && occurrence.is_none() {
        request(json!({"operation":"delete","source":target["source"],"href":target["href"],"ifMatch":target["ifMatch"]})).await?;
        return Ok(json!({"status":"removed"}));
    }
    let invitation = invitation.ok_or("invalid_params")?;
    let event = event.ok_or("invalid_params")?;
    match &occurrence {
        // A whole series or single event replaces the saved one. Occurrence
        // changes and declines from later mail than this one stay.
        None => {
            let declines: Vec<String> = calendar
                .children
                .iter()
                .find(|c| c.name == "VEVENT" && c.property("RECURRENCE-ID").is_none())
                .map(|master| {
                    master
                        .lines
                        .iter()
                        .filter(|line| decline_sequence(line).is_some_and(|s| s > sequence))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            calendar.children.retain(|c| {
                c.name != "VEVENT"
                    || (c.property("RECURRENCE-ID").is_some() && copy_sequence(c) > sequence)
            });
            let mut master = managed(&event, p);
            master.lines.extend(declines);
            calendar.children.push(master);
        }
        Some(key) => {
            calendar
                .children
                .retain(|c| c.name != "VEVENT" || recurrence_key(c).as_ref() != Some(key));
            let master = calendar
                .children
                .iter_mut()
                .find(|c| c.name == "VEVENT" && c.property("RECURRENCE-ID").is_none())
                .ok_or("calendar_invitation_series_required")?;
            // This answer replaces any earlier decline of the same occurrence.
            master.lines = master
                .lines
                .iter()
                .filter_map(|line| without_date(line, key))
                .collect();
            if remove {
                // The decline's sequence travels in the EXDATE, so an older
                // acceptance cannot bring the occurrence back.
                let line = event.property("RECURRENCE-ID").unwrap();
                // RANGE belongs to RECURRENCE-ID only; the decline excludes this date.
                let value = ics::value(line);
                let head: String = line["RECURRENCE-ID".len()..line.len() - value.len() - 1]
                    .split(';')
                    .skip(1)
                    .filter(|piece| {
                        !piece
                            .get(..6)
                            .is_some_and(|key| key.eq_ignore_ascii_case("RANGE="))
                    })
                    .map(|piece| format!(";{piece}"))
                    .collect();
                master
                    .lines
                    .push(format!("EXDATE{head};{SEQUENCE}={sequence}:{value}"));
            } else {
                calendar.children.push(managed(&event, p));
            }
        }
    }
    for zone in invitation.children.iter().filter(|c| c.name == "VTIMEZONE") {
        let tzid = zone.text("TZID");
        if !calendar
            .children
            .iter()
            .any(|c| c.name == "VTIMEZONE" && c.text("TZID") == tzid)
        {
            calendar.children.insert(0, zone.clone());
        }
    }
    request(json!({"operation":"update","source":target["source"],"href":target["href"],"ifMatch":target["ifMatch"],"body":calendar.write()})).await?;
    Ok(json!({"status":if remove { "removed" } else { "saved" }}))
}

fn check_owner(event: &Value, p: &Value) -> Result<(), &'static str> {
    if event["organizer"]["email"]
        .as_str()
        .is_none_or(|s| !s.eq_ignore_ascii_case(p["organizer"].as_str().unwrap()))
    {
        return Err("calendar_organizer_mismatch");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn params() -> Value {
        json!({"source":{"kind":"google","accountId":"calendar@example.org","calendarId":"work@example.org"},
            "mailbox":"imap:me@example.org","uid":"meeting","organizer":"host@example.org","response":"accepted","sequence":2,
            "event":{"summary":"Quoted \"title\" \\ 日本語","description":"Line one\nLine two","location":"Office",
                "start":{"dateTime":"2026-10-27T10:00:00Z"},"end":{"dateTime":"2026-10-27T11:00:00Z"}}})
    }
    fn existing() -> Value {
        json!({"id":"copy","etag":"\"version\"","iCalUID":"meeting","organizer":{"email":"host@example.org"},
            "extendedProperties":{"private":{"omamailMailbox":"imap:me@example.org","omamailSequence":"1"}}})
    }
    async fn run(p: &Value, replies: Vec<Value>) -> (Result<Value, &'static str>, Vec<Value>) {
        let mut replies = replies.into_iter();
        let mut calls = Vec::new();
        let result = save(p, |request| {
            calls.push(request);
            std::future::ready(Ok(replies.next().expect("unexpected request")))
        })
        .await;
        (result, calls)
    }
    #[tokio::test]
    async fn import_is_private_and_retry_updates_the_same_uid_without_inviting_guests() {
        let p = params();
        let (result, calls) = run(&p, vec![json!({"items":[]}), existing()]).await;
        assert_eq!(result.unwrap()["status"], "saved");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1]["operation"], "import");
        let body: Value = serde_json::from_str(calls[1]["body"].as_str().unwrap()).unwrap();
        assert_eq!(body["iCalUID"], "meeting");
        assert_eq!(body["organizer"]["email"], "host@example.org");
        assert_eq!(body["description"], "Line one\nLine two");
        assert_eq!(
            body["attendees"],
            json!([{"email":"work@example.org","responseStatus":"accepted"}])
        );
        let (result, calls) = run(&p, vec![json!({"items":[existing()]}), existing()]).await;
        assert_eq!(result.unwrap()["status"], "saved");
        assert_eq!(calls[1]["operation"], "update");
        assert_eq!(calls[1]["eventId"], "copy");
        assert_eq!(calls[1]["ifMatch"], "\"version\"");
        assert_eq!(calls[1]["sendUpdates"], "none");
        let body: Value = serde_json::from_str(calls[1]["body"].as_str().unwrap()).unwrap();
        assert_eq!(body["attendeesOmitted"], true);
        assert_eq!(
            body["attendees"],
            json!([{"email":"work@example.org","responseStatus":"accepted"}])
        );
    }
    #[tokio::test]
    async fn private_import_adds_only_the_destination_calendar_participant() {
        for (calendar, owner) in [
            (None, "calendar@example.org"),
            (Some("primary"), "calendar@example.org"),
            (
                Some("shared@group.calendar.google.com"),
                "shared@group.calendar.google.com",
            ),
        ] {
            let mut p = params();
            if let Some(calendar) = calendar {
                p["source"]["calendarId"] = json!(calendar);
            } else {
                p["source"].as_object_mut().unwrap().remove("calendarId");
            }
            p["response"] = json!("tentative");
            let (_, calls) = run(&p, vec![json!({"items":[]}), existing()]).await;
            let body: Value = serde_json::from_str(calls[1]["body"].as_str().unwrap()).unwrap();
            assert_eq!(calls[1]["operation"], "import");
            assert!(calls[1].get("sendUpdates").is_none());
            assert_eq!(
                body["attendees"],
                json!([{"email":owner,"responseStatus":"tentative"}])
            );
            assert!(body.get("attendeesOmitted").is_none());
            assert_eq!(body["organizer"]["email"], "host@example.org");
        }
        let mut p = params();
        p["source"]["calendarId"] = json!("not-an-email");
        let (result, calls) = run(&p, vec![]).await;
        assert!(result.is_err());
        assert!(
            calls.is_empty(),
            "refuse an invalid participant before network access"
        );
    }
    #[tokio::test]
    async fn mismatched_organizer_duplicates_manual_copies_and_old_updates_never_write() {
        let p = params();
        let mut wrong = existing();
        wrong["organizer"]["email"] = json!("other@example.org");
        let mut manual = existing();
        manual.as_object_mut().unwrap().remove("extendedProperties");
        let mut newer = existing();
        newer["extendedProperties"]["private"]["omamailSequence"] = json!("3");
        for event in [wrong, manual, newer] {
            let (_, calls) = run(&p, vec![json!({"items":[event]})]).await;
            assert_eq!(calls.len(), 1, "no mutation or import");
        }
        let (_, calls) = run(&p, vec![json!({"items":[existing(),existing()]})]).await;
        assert_eq!(calls.len(), 1);
        let (_, calls) = run(&p, vec![json!({"items":[],"nextPageToken":"more"})]).await;
        assert_eq!(calls.len(), 1);
    }
    #[tokio::test]
    async fn invalid_destinations_and_attendee_injection_do_not_make_even_a_lookup() {
        for key in ["attendees", "organizer", "id", "conferenceData"] {
            let mut p = params();
            p["event"][key] = json!({"email":"attacker@example.org"});
            let (result, calls) = run(&p, vec![]).await;
            assert!(result.is_err());
            assert!(calls.is_empty());
        }
        for id in ["..", ".", "calendar\r\nHost: attacker", "calendar\0"] {
            let mut p = params();
            p["source"]["calendarId"] = json!(id);
            let (result, calls) = run(&p, vec![]).await;
            assert!(result.is_err());
            assert!(calls.is_empty());
        }
        let mut p = params();
        p["source"]["kind"] = json!("caldav");
        let (_, calls) = run(&p, vec![]).await;
        assert!(calls.is_empty());
    }
    #[tokio::test]
    async fn declines_and_cancellations_only_remove_managed_copies() {
        for response in ["declined", "cancelled"] {
            let mut p = params();
            p["response"] = json!(response);
            let (result, calls) = run(&p, vec![json!({"items":[]})]).await;
            assert_eq!(result.unwrap()["status"], "absent");
            assert_eq!(calls.len(), 1);
            let (result, calls) = run(&p, vec![json!({"items":[existing()]}), json!({})]).await;
            assert_eq!(result.unwrap()["status"], "removed");
            let body: Value = serde_json::from_str(calls[1]["body"].as_str().unwrap()).unwrap();
            assert_eq!(body["status"], "cancelled");
            assert_eq!(calls[1]["sendUpdates"], "none");
        }
    }
    #[tokio::test]
    async fn an_occurrence_targets_its_original_start_and_never_imports_a_second_series() {
        let mut p = params();
        p["originalStart"] = json!("2026-10-27T10:00:00Z");
        let (result, calls) = run(&p, vec![json!({"items":[]})]).await;
        assert_eq!(result, Err("calendar_invitation_series_required"));
        assert_eq!(calls.len(), 1);
        let mut instance = existing();
        instance["id"] = json!("instance");
        instance["originalStartTime"] = json!({"dateTime":"2026-10-27T11:00:00+01:00"});
        let (result, calls) = run(
            &p,
            vec![
                json!({"items":[existing()]}),
                json!({"items":[instance]}),
                json!({}),
            ],
        )
        .await;
        assert!(result.is_ok());
        assert_eq!(calls[1]["operation"], "instances");
        assert_eq!(calls[2]["eventId"], "instance");
    }
    const ZONE: &str = "BEGIN:VTIMEZONE\r\nTZID:Europe/Stockholm\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n";
    fn invitation(extra: &str) -> String {
        format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{ZONE}BEGIN:VEVENT\r\nUID:meeting\r\nSEQUENCE:2\r\nDTSTART;TZID=Europe/Stockholm:20261027T100000\r\nDTEND;TZID=Europe/Stockholm:20261027T110000\r\nSUMMARY:Plan\\, review\r\nRRULE:FREQ=WEEKLY\r\n{extra}END:VEVENT\r\nEND:VCALENDAR\r\n"
        )
    }
    fn caldav_params() -> Value {
        json!({"source":{"kind":"caldav","id":"personal","username":"me","url":"https://dav.example.org/calendars/me/personal/"},
            "mailbox":"imap:me@example.org","uid":"meeting","organizer":"host@example.org","response":"accepted","sequence":2,
            "calendar":invitation("")})
    }
    fn report(objects: &[(&str, &str)]) -> Value {
        let mut xml = String::from(
            "<d:multistatus xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\">",
        );
        for (href, data) in objects {
            xml.push_str(&format!("<d:response><d:href>{href}</d:href><d:propstat><d:prop><d:getetag>\"v1\"</d:getetag><c:calendar-data>{}</c:calendar-data></d:prop></d:propstat></d:response>",
                data.replace('&', "&amp;").replace('<', "&lt;")));
        }
        xml.push_str("</d:multistatus>");
        json!({"body":xml,"status":207})
    }
    fn saved(mailbox: &str, sequence: u64) -> String {
        invitation(&format!(
            "X-OMAMAIL-MAILBOX:{mailbox}\r\nX-OMAMAIL-ORGANIZER:host@example.org\r\nX-OMAMAIL-SEQUENCE:{sequence}\r\n"
        ))
    }
    async fn run_caldav(
        p: &Value,
        replies: Vec<Value>,
    ) -> (Result<Value, &'static str>, Vec<Value>) {
        let mut replies = replies.into_iter();
        let mut calls = Vec::new();
        let result = save_caldav(p, |request| {
            calls.push(request);
            std::future::ready(Ok(replies.next().expect("unexpected request")))
        })
        .await;
        (result, calls)
    }
    #[tokio::test]
    async fn caldav_copy_is_created_once_without_guests_then_updated_in_place() {
        let mut p = caldav_params();
        p["response"] = json!("tentative");
        let (result, calls) = run_caldav(&p, vec![report(&[]), json!({})]).await;
        assert_eq!(result.unwrap()["status"], "saved");
        assert_eq!(calls[0]["operation"], "list");
        assert!(
            calls[0]["body"]
                .as_str()
                .unwrap()
                .contains(">meeting</c:text-match>")
        );
        assert_eq!(calls[1]["operation"], "create");
        assert_eq!(calls[1]["ifNoneMatch"], "*");
        assert!(
            calls[1]["href"]
                .as_str()
                .unwrap()
                .starts_with("omamail-invitation-")
        );
        let body = calls[1]["body"].as_str().unwrap();
        for line in [
            "STATUS:TENTATIVE",
            "TRANSP:OPAQUE",
            "X-OMAMAIL-MAILBOX:imap:me@example.org",
            "X-OMAMAIL-ORGANIZER:host@example.org",
            "X-OMAMAIL-SEQUENCE:2",
            "TZID:Europe/Stockholm",
            "DTSTART;TZID=Europe/Stockholm:20261027T100000",
            "RRULE:FREQ=WEEKLY",
        ] {
            assert!(body.contains(line), "{line}");
        }
        assert!(!body.contains("ATTENDEE") && !body.contains("ORGANIZER:mailto"));
        let (result, calls) = run_caldav(
            &p,
            vec![
                report(&[(
                    "/calendars/me/personal/copy.ics",
                    &saved("imap:me@example.org", 1),
                )]),
                json!({}),
            ],
        )
        .await;
        assert_eq!(result.unwrap()["status"], "saved");
        assert_eq!(calls[1]["operation"], "update");
        assert_eq!(calls[1]["href"], "/calendars/me/personal/copy.ics");
        assert_eq!(calls[1]["ifMatch"], "\"v1\"");
        assert_eq!(
            calls[1]["body"]
                .as_str()
                .unwrap()
                .matches("BEGIN:VEVENT")
                .count(),
            1
        );
        assert_eq!(
            calls[1]["body"]
                .as_str()
                .unwrap()
                .matches("BEGIN:VTIMEZONE")
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn caldav_copies_refuse_guests_alarms_and_foreign_or_newer_events() {
        for extra in [
            "ATTENDEE:mailto:victim@example.org\r\n",
            "ORGANIZER:mailto:host@example.org\r\n",
            "BEGIN:VALARM\r\nACTION:EMAIL\r\nEND:VALARM\r\n",
            "UID:other\r\n",
            "URL:https://example.org\r\n",
            "EXDATE;X-OMAMAIL-SEQUENCE=9999:20261103T100000Z\r\n",
        ] {
            let mut p = caldav_params();
            p["calendar"] = json!(invitation(extra));
            let (result, calls) = run_caldav(&p, vec![]).await;
            assert!(result.is_err(), "{extra}");
            assert!(calls.is_empty());
        }
        let mut p = caldav_params();
        p["calendar"] = json!(invitation("").replace(
            "TZID:Europe/Stockholm\r\n",
            "TZID:Europe/Stockholm\r\nTZURL:https://tz.example.org/zone\r\n"
        ));
        let (result, calls) = run_caldav(&p, vec![]).await;
        assert!(
            result.is_err() && calls.is_empty(),
            "a sender's zone URL is refused"
        );
        let mut p = caldav_params();
        p["event"] = json!({});
        assert!(validate(&p).is_err());
        let p = caldav_params();
        let native =
            invitation("ORGANIZER:mailto:host@example.org\r\nATTENDEE:mailto:me@example.org\r\n");
        let foreign = invitation("ORGANIZER:mailto:other@example.org\r\n");
        let newer = saved("imap:me@example.org", 3);
        let cases = [
            (native, Ok("existing")),
            (foreign, Err("calendar_organizer_mismatch")),
            (newer, Ok("newer")),
        ];
        for (data, expected) in cases {
            let (result, calls) = run_caldav(&p, vec![report(&[("/x.ics", &data)])]).await;
            assert_eq!(
                result.map(|v| v["status"].as_str().unwrap().to_owned()),
                expected.map(str::to_owned)
            );
            assert_eq!(calls.len(), 1, "no write");
        }
        let (result, calls) = run_caldav(
            &p,
            vec![report(&[
                ("/a.ics", &saved("imap:me@example.org", 1)),
                ("/b.ics", &saved("imap:me@example.org", 1)),
            ])],
        )
        .await;
        assert_eq!(result, Err("calendar_ambiguous_invitation"));
        assert_eq!(calls.len(), 1);
    }
    #[tokio::test]
    async fn caldav_declines_remove_only_the_managed_copy() {
        let mut p = caldav_params();
        p["response"] = json!("declined");
        p.as_object_mut().unwrap().remove("calendar");
        let (result, calls) = run_caldav(&p, vec![report(&[])]).await;
        assert_eq!(result.unwrap()["status"], "absent");
        assert_eq!(calls.len(), 1);
        let (result, calls) = run_caldav(
            &p,
            vec![
                report(&[("/copy.ics", &saved("imap:me@example.org", 1))]),
                json!({}),
            ],
        )
        .await;
        assert_eq!(result.unwrap()["status"], "removed");
        assert_eq!(calls[1]["operation"], "delete");
        assert_eq!(calls[1]["ifMatch"], "\"v1\"");
    }
    #[tokio::test]
    async fn caldav_occurrences_join_their_saved_series() {
        let occurrence = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:meeting\r\nRECURRENCE-ID;TZID=Europe/Stockholm:20261103T100000\r\nDTSTART;TZID=Europe/Stockholm:20261103T120000\r\nDTEND;TZID=Europe/Stockholm:20261103T130000\r\nSUMMARY:Moved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let mut p = caldav_params();
        p["calendar"] = json!(occurrence);
        p["originalStart"] = json!("2026-11-03T09:00:00Z");
        let (result, calls) = run_caldav(&p, vec![report(&[])]).await;
        assert_eq!(result, Err("calendar_invitation_series_required"));
        assert_eq!(calls.len(), 1);
        let series = saved("imap:me@example.org", 1);
        let (result, calls) =
            run_caldav(&p, vec![report(&[("/copy.ics", &series)]), json!({})]).await;
        assert_eq!(result.unwrap()["status"], "saved");
        let body = calls[1]["body"].as_str().unwrap();
        assert_eq!(body.matches("BEGIN:VEVENT").count(), 2);
        assert!(body.contains("RRULE:FREQ=WEEKLY") && body.contains("SUMMARY:Moved"));
        p["response"] = json!("declined");
        let (result, calls) =
            run_caldav(&p, vec![report(&[("/copy.ics", &series)]), json!({})]).await;
        assert_eq!(result.unwrap()["status"], "removed");
        let body = calls[1]["body"].as_str().unwrap();
        assert_eq!(body.matches("BEGIN:VEVENT").count(), 1);
        assert!(body.contains("EXDATE;TZID=Europe/Stockholm;X-OMAMAIL-SEQUENCE=2:20261103T100000"));
    }
    const MOVED: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:meeting\r\nRECURRENCE-ID;TZID=Europe/Stockholm:20261103T100000\r\nDTSTART;TZID=Europe/Stockholm:20261103T120000\r\nDTEND;TZID=Europe/Stockholm:20261103T130000\r\nSUMMARY:Moved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    fn occurrence_params(sequence: u64, response: &str) -> Value {
        let mut p = caldav_params();
        p["calendar"] = json!(MOVED);
        p["originalStart"] = json!("2026-11-03T09:00:00Z");
        p["sequence"] = json!(sequence);
        p["response"] = json!(response);
        p
    }
    /// The saved series with a managed moved occurrence or a declined one.
    fn saved_with(extra_master: &str, override_sequence: Option<u64>) -> String {
        let marks =
            "X-OMAMAIL-MAILBOX:imap:me@example.org\r\nX-OMAMAIL-ORGANIZER:host@example.org\r\n";
        let mut text = invitation(&format!("{marks}X-OMAMAIL-SEQUENCE:2\r\n{extra_master}"));
        if let Some(sequence) = override_sequence {
            let child = format!(
                "BEGIN:VEVENT\r\nUID:meeting\r\nRECURRENCE-ID;TZID=Europe/Stockholm:20261103T100000\r\nDTSTART;TZID=Europe/Stockholm:20261103T120000\r\nDTEND;TZID=Europe/Stockholm:20261103T130000\r\nSUMMARY:Moved\r\n{marks}X-OMAMAIL-SEQUENCE:{sequence}\r\nEND:VEVENT\r\n"
            );
            text = text.replace("END:VCALENDAR", &format!("{child}END:VCALENDAR"));
        }
        text
    }
    #[tokio::test]
    async fn caldav_occurrence_without_override_is_checked_against_its_series() {
        let series = saved("imap:me@example.org", 5);
        let (result, calls) = run_caldav(
            &occurrence_params(1, "accepted"),
            vec![report(&[("/copy.ics", &series)])],
        )
        .await;
        assert_eq!(result.unwrap()["status"], "newer");
        assert_eq!(calls.len(), 1, "a stale occurrence writes nothing");
    }
    #[tokio::test]
    async fn caldav_series_resave_keeps_newer_occurrence_changes() {
        let series = saved_with("", Some(3));
        let (result, calls) = run_caldav(
            &caldav_params(),
            vec![report(&[("/copy.ics", &series)]), json!({})],
        )
        .await;
        assert_eq!(result.unwrap()["status"], "saved");
        let body = calls[1]["body"].as_str().unwrap();
        assert_eq!(
            body.matches("BEGIN:VEVENT").count(),
            2,
            "the moved occurrence survives a retry of the series"
        );
        assert!(body.contains("SUMMARY:Moved"));
        let mut newer = caldav_params();
        newer["sequence"] = json!(4);
        let (result, calls) =
            run_caldav(&newer, vec![report(&[("/copy.ics", &series)]), json!({})]).await;
        assert_eq!(result.unwrap()["status"], "saved");
        assert_eq!(
            calls[1]["body"]
                .as_str()
                .unwrap()
                .matches("BEGIN:VEVENT")
                .count(),
            1,
            "a newer series replaces older occurrence changes"
        );
    }
    #[tokio::test]
    async fn caldav_declined_occurrence_keeps_its_sequence() {
        let series = saved("imap:me@example.org", 2);
        let (result, calls) = run_caldav(
            &occurrence_params(4, "declined"),
            vec![report(&[("/copy.ics", &series)]), json!({})],
        )
        .await;
        assert_eq!(result.unwrap()["status"], "removed");
        let declined = calls[1]["body"].as_str().unwrap().to_owned();
        let (result, calls) = run_caldav(
            &occurrence_params(3, "accepted"),
            vec![report(&[("/copy.ics", &declined)])],
        )
        .await;
        assert_eq!(
            result.unwrap()["status"],
            "newer",
            "an older acceptance does not undo a newer decline"
        );
        assert_eq!(calls.len(), 1);
        let (result, calls) = run_caldav(
            &occurrence_params(5, "accepted"),
            vec![report(&[("/copy.ics", &declined)]), json!({})],
        )
        .await;
        assert_eq!(result.unwrap()["status"], "saved");
        let body = calls[1]["body"].as_str().unwrap();
        assert!(
            !body.contains("EXDATE"),
            "a newer acceptance brings the occurrence back"
        );
        assert!(body.contains("SUMMARY:Moved"));
        let resaved = saved_with("", None).replace(
            "X-OMAMAIL-SEQUENCE:2\r\n",
            &format!(
                "X-OMAMAIL-SEQUENCE:2\r\n{}\r\n",
                declined.lines().find(|l| l.starts_with("EXDATE")).unwrap()
            ),
        );
        let (result, calls) = run_caldav(
            &caldav_params(),
            vec![report(&[("/copy.ics", &resaved)]), json!({})],
        )
        .await;
        assert_eq!(result.unwrap()["status"], "saved");
        assert!(
            calls[1]["body"].as_str().unwrap().contains("EXDATE"),
            "a series retry keeps a newer decline"
        );
    }
    #[tokio::test]
    async fn caldav_grouped_exdates_are_matched_date_by_date() {
        let grouped =
            "EXDATE;TZID=Europe/Stockholm;X-OMAMAIL-SEQUENCE=4:20261103T100000,20261110T100000\r\n";
        let series = saved_with(grouped, None);
        let (result, calls) = run_caldav(
            &occurrence_params(3, "accepted"),
            vec![report(&[("/copy.ics", &series)])],
        )
        .await;
        assert_eq!(result.unwrap()["status"], "newer");
        assert_eq!(calls.len(), 1);
        let (result, calls) = run_caldav(
            &occurrence_params(5, "accepted"),
            vec![report(&[("/copy.ics", &series)]), json!({})],
        )
        .await;
        assert_eq!(result.unwrap()["status"], "saved");
        let body = calls[1]["body"].as_str().unwrap();
        assert!(
            body.contains("EXDATE;TZID=Europe/Stockholm;X-OMAMAIL-SEQUENCE=4:20261110T100000\r\n"),
            "{body}"
        );
        assert!(!body.contains("20261103T100000,"));
    }
    #[tokio::test]
    async fn caldav_repeat_declines_keep_one_exdate_without_range() {
        let series = saved("imap:me@example.org", 2);
        let mut p = occurrence_params(3, "declined");
        p["calendar"] = json!(MOVED.replace(
            "RECURRENCE-ID;TZID",
            "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID"
        ));
        let (result, calls) =
            run_caldav(&p, vec![report(&[("/copy.ics", &series)]), json!({})]).await;
        assert_eq!(result.unwrap()["status"], "removed");
        let once = calls[1]["body"].as_str().unwrap().to_owned();
        assert!(
            once.contains("EXDATE;TZID=Europe/Stockholm;X-OMAMAIL-SEQUENCE=3:20261103T100000\r\n"),
            "{once}"
        );
        p["sequence"] = json!(4);
        let (result, calls) =
            run_caldav(&p, vec![report(&[("/copy.ics", &once)]), json!({})]).await;
        assert_eq!(result.unwrap()["status"], "removed");
        let twice = calls[1]["body"].as_str().unwrap();
        assert_eq!(twice.matches("EXDATE").count(), 1, "{twice}");
        assert!(twice.contains("X-OMAMAIL-SEQUENCE=4:20261103T100000"));
    }
    #[tokio::test]
    async fn caldav_unreadable_report_object_stops_the_save() {
        let (result, calls) = run_caldav(
            &caldav_params(),
            vec![report(&[("/broken.ics", "BEGIN:VCALENDAR\r\nmeeting")])],
        )
        .await;
        assert_eq!(result, Err("calendar_invalid_response"));
        assert_eq!(calls.len(), 1, "no second copy is created");
    }
    #[test]
    fn import_transport_is_fixed_origin_post_and_contains_no_notification_parameter() {
        let p = json!({"source":params()["source"],"operation":"import","body":"{}"});
        let request = super::super::prepare(&p).unwrap();
        assert_eq!(request.method, reqwest::Method::POST);
        assert_eq!(
            request.url.as_str(),
            "https://www.googleapis.com/calendar/v3/calendars/work@example.org/events/import"
        );
        assert!(request.url.query().is_none());
    }
}
