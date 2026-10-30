//! A private Google copy of an invitation answered through another mailbox.
//! RSVP remains mail; import and silent patches never notify the guests again.
use serde_json::{Value, json};
use std::future::Future;

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
            "originalStart",
        ]
        .contains(&k.as_str())
    }) {
        return Err("invalid_params");
    }
    let source = &p["source"];
    if source["kind"] != "google" || source["readOnly"] == true {
        return Err("invalid_params");
    }
    let account = super::text(source, "accountId")?;
    if !account.contains('@') || account.contains(':') || account.chars().any(char::is_whitespace) {
        return Err("invalid_params");
    }
    destination_owner(source)?;
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
