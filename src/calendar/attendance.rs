//! Match a mail invitation to its authoritative Google calendar copy before
//! changing attendance. An occurrence is identified by its original start,
//! never its (possibly moved) current start.
//!
//! A UID is not a secret: anyone who saw one invitation can write another
//! naming the same UID. The calendar copy is therefore only this invitation's
//! when its organizer is the one the invitation names, and nothing is read
//! back or written until that holds.
use serde_json::{Value, json};

fn same_organizer(event: &Value, organizer: &str) -> Result<(), &'static str> {
    match event["organizer"]["email"].as_str() {
        Some(email) if email.eq_ignore_ascii_case(organizer) => Ok(()),
        _ => Err("calendar_organizer_mismatch"),
    }
}

fn own_attendee<'a>(event: &'a Value, addresses: &[String]) -> Result<&'a Value, &'static str> {
    let mut matches = event["attendees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|attendee| {
            attendee["self"] == true
                && attendee["email"].as_str().is_some_and(|email| {
                    addresses
                        .iter()
                        .any(|address| email.eq_ignore_ascii_case(address))
                })
        });
    let found = matches.next().ok_or("calendar_attendee_not_found")?;
    if matches.next().is_some() {
        return Err("calendar_ambiguous_invitation");
    }
    Ok(found)
}

fn choose<'a>(
    items: &'a [Value],
    uid: &str,
    original: Option<&str>,
) -> Result<&'a Value, &'static str> {
    let mut matches = items.iter().filter(|event| {
        event["iCalUID"] == uid
            && match original {
                None => event.get("recurringEventId").is_none(),
                Some(start) => {
                    event["originalStartTime"]["dateTime"] == start
                        || event["originalStartTime"]["date"] == start
                        || event["originalStartTime"]["dateTime"]
                            .as_str()
                            .zip(chrono::DateTime::parse_from_rfc3339(start).ok())
                            .is_some_and(|(remote, expected)| {
                                chrono::DateTime::parse_from_rfc3339(remote).ok() == Some(expected)
                            })
                }
            }
    });
    let found = matches.next().ok_or("calendar_invitation_not_found")?;
    if matches.next().is_some() {
        return Err("calendar_ambiguous_invitation");
    }
    Ok(found)
}

async fn request(
    source: &Value,
    operation: &str,
    fields: Value,
    token: &str,
) -> Result<Value, &'static str> {
    let mut params = fields;
    params["source"] = source.clone();
    params["operation"] = json!(operation);
    let result = super::call(&params, Some(token)).await?;
    serde_json::from_str(result["body"].as_str().ok_or("calendar_invalid_response")?)
        .map_err(|_| "calendar_invalid_response")
}

pub fn validate(params: &Value) -> Result<(), &'static str> {
    let fields = params.as_object().ok_or("invalid_params")?;
    if fields
        .keys()
        .any(|key| {
            !["accountId", "uid", "organizer", "originalStart", "response"].contains(&key.as_str())
        })
    {
        return Err("invalid_params");
    }
    let account = super::text(params, "accountId")?;
    if !account.contains('@') || account.contains(':') || account.chars().any(char::is_whitespace) {
        return Err("invalid_params");
    }
    super::text(params, "uid")?;
    let organizer = super::text(params, "organizer").map_err(|_| "invalid_params")?;
    if !organizer.contains('@') || organizer.chars().any(char::is_whitespace) {
        return Err("invalid_params");
    }
    if params.get("originalStart").is_some() {
        let original = super::text(params, "originalStart")?;
        if chrono::DateTime::parse_from_rfc3339(original).is_err()
            && chrono::NaiveDate::parse_from_str(original, "%Y-%m-%d").is_err()
        {
            return Err("invalid_params");
        }
    }
    if !matches!(
        params["response"].as_str(),
        None | Some("accepted" | "tentative" | "declined")
    ) {
        return Err("invalid_params");
    }
    if fields
        .get("response")
        .is_some_and(|value| !value.is_string())
    {
        return Err("invalid_params");
    }
    Ok(())
}

pub async fn google(
    params: &Value,
    token: &str,
    addresses: &[String],
) -> Result<Value, &'static str> {
    tokio::time::timeout(
        std::time::Duration::from_secs(27),
        google_inner(params, token, addresses),
    )
    .await
    .map_err(|_| "calendar_timeout")?
}

async fn google_inner(
    params: &Value,
    token: &str,
    addresses: &[String],
) -> Result<Value, &'static str> {
    validate(params)?;
    let account = super::text(params, "accountId")?;
    let uid = super::text(params, "uid")?;
    let organizer = super::text(params, "organizer")?;
    let source = json!({"kind":"google", "accountId":account, "calendarId":"primary"});
    let listing = request(&source, "lookup", json!({"uid":uid}), token).await?;
    let mut items = listing["items"]
        .as_array()
        .cloned()
        .ok_or("calendar_invalid_response")?;
    let original = params["originalStart"].as_str();
    if let Some(start) = original {
        let parents: Vec<String> = items
            .iter()
            .filter(|event| event["iCalUID"] == uid && event["recurrence"].is_array())
            .filter_map(|event| event["id"].as_str().map(str::to_owned))
            .collect();
        if parents.len() > 1 {
            return Err("calendar_ambiguous_invitation");
        }
        if let Some(parent) = parents.first() {
            let instances = request(
                &source,
                "instances",
                json!({"eventId":parent,"originalStart":start}),
                token,
            )
            .await?;
            items = instances["items"]
                .as_array()
                .cloned()
                .ok_or("calendar_invalid_response")?;
        }
    }
    let event = choose(&items, uid, original)?;
    same_organizer(event, organizer)?;
    if event["status"] == "cancelled" {
        if params.get("response").is_some() {
            return Err("calendar_invitation_cancelled");
        }
        return Ok(json!({"event":event,"response":"","cancelled":true}));
    }
    // Primary-calendar self is additionally checked against the signed-in
    // account or its Gmail-verified send-as identities. A sender cannot
    // nominate an arbitrary attendee to modify.
    let own = own_attendee(event, addresses)?;
    let answering_as = super::text(own, "email")?;
    let id = super::text(event, "id")?;
    let result = if let Some(response) = params["response"].as_str() {
        let etag = super::text(event, "etag")?;
        request(&source, "update", json!({"eventId":id,"ifMatch":etag,"sendUpdates":"all",
            "body":json!({"attendeesOmitted":true,"attendees":[{"email":answering_as,"responseStatus":response}]}).to_string()}), token).await?;
        // Only a read-back confirms success, including propagation policies
        // which can reset an attendee to needsAction after a successful PATCH.
        request(&source, "get", json!({"eventId":id}), token).await?
    } else {
        event.clone()
    };
    same_organizer(&result, organizer)?;
    let attendee = own_attendee(&result, addresses)?;
    if let Some(expected) = params["response"].as_str() {
        if attendee["responseStatus"] != expected {
            return Err("calendar_attendance_unconfirmed");
        }
    }
    Ok(json!({"event":result,"response":attendee["responseStatus"]}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matching_never_uses_moved_start_or_another_attendee() {
        let event = json!({"iCalUID":"series","id":"instance","recurringEventId":"parent",
            "originalStartTime":{"dateTime":"2026-10-01T10:00:00+02:00"},
            "start":{"dateTime":"2026-10-02T08:00:00Z"},
            "attendees":[{"self":true,"email":"owner@example.org"}]});
        let items = vec![event.clone()];
        assert!(choose(&items, "series", Some("2026-10-01T08:00:00Z")).is_ok());
        assert!(choose(&items, "series", Some("2026-10-02T08:00:00Z")).is_err());
        assert!(choose(&items, "series", None).is_err());
        assert!(own_attendee(&event, &["attacker@example.org".into()]).is_err());
        assert!(
            own_attendee(
                &event,
                &["primary@example.org".into(), "owner@example.org".into()]
            )
            .is_ok()
        );
        assert!(
            choose(
                &[event.clone(), event],
                "series",
                Some("2026-10-01T08:00:00Z")
            )
            .is_err()
        );
    }

    #[test]
    fn an_invitation_reusing_a_uid_is_not_another_organizers_event() {
        let event = json!({"iCalUID":"meeting","organizer":{"email":"Boss@Example.org"}});
        assert!(same_organizer(&event, "boss@example.org").is_ok());
        assert_eq!(
            same_organizer(&event, "attacker@example.net"),
            Err("calendar_organizer_mismatch")
        );
        assert_eq!(
            same_organizer(&json!({"iCalUID":"meeting"}), "boss@example.org"),
            Err("calendar_organizer_mismatch")
        );
    }

    #[test]
    fn attendance_requires_the_invitation_organizer() {
        let base = json!({"accountId":"me@example.org","uid":"meeting","response":"accepted"});
        assert_eq!(validate(&base), Err("invalid_params"));
        for organizer in ["", "boss", "boss @example.org", "boss@example.org\n"] {
            let mut params = base.clone();
            params["organizer"] = json!(organizer);
            assert!(validate(&params).is_err(), "{organizer:?}");
        }
        let mut params = base;
        params["organizer"] = json!("boss@example.org");
        assert!(validate(&params).is_ok());
    }
}
