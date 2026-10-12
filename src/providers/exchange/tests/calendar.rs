//! `exchange.calendar*` end to end: fields judged before any lookup, the answer the views are drawn
//! from, and appointments written to the scripted calendar of `ews::tests::calendar`.

use super::*;
use crate::providers::exchange::calendar::event;
use crate::providers::exchange::ews::CalendarItem;
use crate::providers::exchange::ews::tests::calendar::{
    Cal, cal_id, operation, script, secs, store,
};
use crate::providers::exchange::ews::tests::detail::INVITED;
use crate::providers::exchange::zone::TEST_ZONE;

fn ms(text: &str) -> i64 {
    secs(text) * 1000
}

fn october() -> Value {
    json!({"accountId": ACCOUNT, "startMs": ms("2026-10-01T00:00:00Z"), "endMs": ms("2026-11-06T00:00:00Z")})
}

#[tokio::test]
async fn calendar_requests_are_refused_before_any_account_credential_or_socket_is_touched() {
    let (id, key) = (cal_id(1), "DwAAABYAAAB0001");
    let timed = json!({"title": "x", "allDay": false, "startMs": 1_790_000_000_000i64, "endMs": 1_790_001_800_000i64});
    // Each case's members over a valid request; a null takes the member out.
    let table = json!([
        ["calendarEvents", {"startMs": 0, "endMs": 1000, "unexpected": true}],
        ["calendarEvents", {"startMs": 0, "endMs": 8_640_000_001i64}],
        ["calendarEvents", {"startMs": 1000, "endMs": 1000}],
        ["calendarEvents", {"startMs": 1.5, "endMs": 1000}],
        ["calendarEvents", {"startMs": "0", "endMs": 1000}],
        ["calendarEvents", {"startMs": 0, "endMs": 1000, "requestToken": ""}],
        ["calendarCreate", {"unexpected": true}],
        ["calendarCreate", {"title": "a\nb"}],
        ["calendarCreate", {"title": " "}],
        ["calendarCreate", {"location": 5}],
        ["calendarCreate", {"notes": 5}],
        ["calendarCreate", {"startDate": "2026-10-05"}],
        ["calendarCreate", {"allDay": true}],
        ["calendarCreate", {"allDay": true, "startDate": "2026-10-05", "endDate": "2026-10-06"}],
        ["calendarCreate", {"allDay": null}],
        ["calendarCreate", {"endMs": 1_790_000_000_000i64}],
        ["calendarCreate", {"endMs": 1_821_800_000_000i64}],
        ["calendarCreate", {"allDay": true, "startMs": null, "endMs": null, "startDate": "2026-1-5", "endDate": "2026-01-06"}],
        ["calendarCreate", {"allDay": true, "startMs": null, "endMs": null, "startDate": "2026-02-30", "endDate": "2026-03-01"}],
        ["calendarUpdate", {"id": "NOT-CANONICAL", "changeKey": key, "title": "x"}],
        ["calendarUpdate", {"id": id, "changeKey": "a b", "title": "x"}],
        ["calendarUpdate", {"id": id, "title": "x"}],
        ["calendarUpdate", {"id": id, "changeKey": key, "title": 5}],
        ["calendarUpdate", {"id": id, "changeKey": key, "location": "a\tb"}],
        ["calendarUpdate", {"id": id, "changeKey": key, "title": "x", "notes": "y"}],
        ["calendarUpdate", {"id": id, "changeKey": key, "title": "x", "requestToken": "t"}],
        ["calendarDelete", {"id": id, "changeKey": ""}],
        ["calendarDelete", {"id": id, "changeKey": key, "scope": "series"}],
        ["calendarCreate", {"reminderMinutes": 40_321}],
        ["calendarCreate", {"reminderMinutes": -1}],
        ["calendarCreate", {"reminderMinutes": 1.5}],
        ["calendarCreate", {"reminderMinutes": "15"}],
        ["calendarUpdate", {"id": id, "changeKey": key, "title": "x", "reminderMinutes": -2}],
        ["calendarEvent", {"id": "NOT-CANONICAL"}],
        ["calendarEvent", {"id": id, "unexpected": true}],
        ["calendarEvent", {"id": id, "requestToken": ""}],
        ["calendarRespond", {"id": id, "changeKey": key, "response": "accept"}],
        ["calendarRespond", {"id": id, "changeKey": key, "response": "accept", "send": "true"}],
        ["calendarRespond", {"id": id, "changeKey": key, "response": "maybe", "send": true}],
        ["calendarRespond", {"id": id, "changeKey": "a b", "response": "accept", "send": true}],
        ["calendarRespond", {"id": id, "changeKey": key, "response": "accept", "send": true, "remove": true}],
        ["calendarRespond", {"id": id, "changeKey": key, "response": "decline", "send": false, "remove": true}],
        ["calendarRespond", {"id": id, "changeKey": key, "response": "decline", "send": true, "remove": 1}],
        ["calendarRespond", {"id": id, "changeKey": key, "response": "accept", "send": true, "requestToken": "t"}],
    ]);
    for case in table.as_array().unwrap() {
        let method = case[0].as_str().unwrap();
        let mut params = json!({"accountId": ACCOUNT}).as_object().unwrap().clone();
        if method == "calendarCreate" {
            params.extend(timed.as_object().unwrap().clone());
        }
        for (name, value) in case[1].as_object().unwrap() {
            match value {
                Value::Null => params.remove(name),
                value => params.insert(name.clone(), value.clone()),
            };
        }
        let params = Value::Object(params);
        let answer = rpc(method, params.clone()).await;
        assert_eq!(answer.err(), Some("invalid_params"), "{method} {params}");
    }
    let foreign = json!({"accountId": "imap:ada@example.org", "startMs": 0, "endMs": 1000});
    assert_eq!(
        rpc("calendarEvents", foreign).await.err(),
        Some("invalid_params")
    );
}

#[tokio::test]
async fn a_month_is_instants_and_days_with_what_is_private_masked_and_what_was_cancelled_left_out()
{
    if isolated() {
        return;
    }
    let mut standup = Cal::new(1, "Standup", "2026-10-23T07:00:00Z", "2026-10-23T07:30:00Z");
    (standup.location, standup.reminder) = ("Room 4".into(), Some(10));
    // A day as an Austrian server keeps it, and three days made in New York with no wall clock.
    let days = ("2026-10-05", "2026-10-06");
    let holiday = Cal::day(
        2,
        "Holiday",
        "2026-10-04T22:00:00Z",
        "2026-10-05T22:00:00Z",
        days,
    );
    let mut conference = Cal::new(
        3,
        "Conference",
        "2026-10-12T04:00:00Z",
        "2026-10-15T04:00:00Z",
    );
    conference.all_day = true;
    let at = |n, title| Cal::new(n, title, "2026-10-07T13:00:00Z", "2026-10-07T14:00:00Z");
    let mut private = at(6, "Salary review").with("<t:Sensitivity>Private</t:Sensitivity>");
    (private.location, private.reminder) = ("Clinic on Example Street".into(), Some(5));
    let series =
        "<t:CalendarItemType>Occurrence</t:CalendarItemType><t:IsRecurring>1</t:IsRecurring>";
    let items = vec![
        standup,
        holiday,
        conference,
        at(4, "Weekly").with(series),
        at(5, "Called off").with("<t:IsCancelled>true</t:IsCancelled>"),
        private,
        at(7, "Merger talks").with("<t:Sensitivity>Confidential</t:Sensitivity>"),
        at(8, "Lunch").with("<t:MyResponseType>NoResponseReceived</t:MyResponseType>"),
    ];
    let w = world(Offer::Basic, Some(PASSWORD), script(store(items))).await;
    let answer = rpc("calendarEvents", october()).await.unwrap();
    assert_eq!(answer["truncated"], false);
    let events = answer["events"].as_array().unwrap();
    assert_eq!(events.len(), 7, "the cancelled meeting is not listed");
    let by = |id: u16| events.iter().find(|e| e["id"] == cal_id(id)).unwrap();
    let expected = json!({"id": cal_id(1), "changeKey": "CK1v1", "editable": true, "lock": "",
        "uid": "uid-1@example.org", "title": "Standup", "location": "Room 4", "organizer": "Ada Example",
        "allDay": false, "startMs": ms("2026-10-23T07:00:00Z"), "endMs": ms("2026-10-23T07:30:00Z"),
        "busy": "busy", "meeting": false, "response": "organizer", "kind": "single", "recurring": false,
        "private": false, "reminderMinutes": 10});
    assert_eq!(by(1), &expected);
    let days = |id| format!("{} {}", by(id)["startDate"], by(id)["endDate"]);
    assert_eq!(days(2), r#""2026-10-05" "2026-10-06""#);
    assert_eq!(days(3), r#""2026-10-12" "2026-10-15""#, "from the instants");
    let locks = [4, 6, 7, 8].map(|id| by(id)["lock"].as_str().unwrap());
    assert_eq!(locks, ["recurring", "private", "private", "foreign"]);
    // Masked before the answer leaves: nothing of a private or confidential item's content anywhere.
    for id in [6, 7] {
        let shown =
            ["title", "location", "organizer", "reminderMinutes"].map(|k| by(id)[k].clone());
        assert_eq!(json!(shown), json!(["Private", "", "", null]));
    }
    for secret in ["Salary", "Clinic", "Merger", PASSWORD, LOGIN] {
        assert!(!answer.to_string().contains(secret), "{secret}");
    }
    assert_eq!(w.fake.log.count("FindItem"), 1);
}

#[test]
fn an_all_day_events_days_are_its_wall_clocks_and_without_them_the_same_where_it_matters() {
    let wall = |text: &str| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M").ok();
    let id = STANDARD.encode([1u8; 40]);
    let day = |start: &str, end: &str, walls: Option<(&str, &str)>| {
        let item = CalendarItem {
            id: id.clone(),
            all_day: true,
            start_ms: ms(start),
            end_ms: ms(end),
            start_wall: walls.and_then(|(start, _)| wall(start)),
            end_wall: walls.and_then(|(_, end)| wall(end)),
            ..CalendarItem::default()
        };
        let event = event(&item).unwrap();
        format!(
            "{} {}",
            event["startDate"].as_str().unwrap(),
            event["endDate"].as_str().unwrap()
        )
    };
    // Vienna in summer and in winter, the 25-hour day the clocks go back, New York, Tokyo.
    for (start, end, expected) in [
        (
            "2026-10-04T22:00:00Z",
            "2026-10-05T22:00:00Z",
            "2026-10-05 2026-10-06",
        ),
        (
            "2026-11-04T23:00:00Z",
            "2026-11-05T23:00:00Z",
            "2026-11-05 2026-11-06",
        ),
        (
            "2026-10-24T22:00:00Z",
            "2026-10-25T23:00:00Z",
            "2026-10-25 2026-10-26",
        ),
        // And the 23-hour day the clocks go forward.
        (
            "2026-03-28T23:00:00Z",
            "2026-03-29T22:00:00Z",
            "2026-03-29 2026-03-30",
        ),
        (
            "2026-10-12T04:00:00Z",
            "2026-10-15T04:00:00Z",
            "2026-10-12 2026-10-15",
        ),
        (
            "2026-10-04T15:00:00Z",
            "2026-10-05T15:00:00Z",
            "2026-10-05 2026-10-06",
        ),
    ] {
        let (first, after) = expected.split_once(' ').unwrap();
        let walls = (format!("{first}T00:00"), format!("{after}T00:00"));
        assert_eq!(
            day(start, end, Some((&walls.0, &walls.1))),
            expected,
            "{start}"
        );
        assert_eq!(
            day(start, end, None),
            expected,
            "{start} without wall clocks"
        );
    }
    // A wall clock that ends inside its day ends with it; an end before the start is one day.
    let (start, end) = ("2026-10-04T22:00:00Z", "2026-10-05T22:00:00Z");
    for last in ["2026-10-05T23:59", "2026-10-03T00:00"] {
        let walls = Some(("2026-10-05T00:00", last));
        assert_eq!(day(start, end, walls), "2026-10-05 2026-10-06");
    }
    // A timed event keeps its instants and an end before its start is a point; a cancelled one, or
    // one whose id the codec refuses, is not an event.
    let timed = CalendarItem {
        id,
        start_ms: 5000,
        end_ms: 1000,
        ..CalendarItem::default()
    };
    let answer = event(&timed).unwrap();
    assert_eq!(
        (&answer["endMs"], answer.get("startDate")),
        (&json!(5000), None)
    );
    let gone = [(true, timed.id.clone()), (false, "AAAA".into())];
    for (cancelled, id) in gone {
        let item = CalendarItem {
            cancelled,
            id,
            ..timed.clone()
        };
        assert_eq!(event(&item), None);
    }
}

#[tokio::test]
async fn an_appointment_is_made_changed_and_deleted_in_the_owners_zone_and_a_meeting_is_not() {
    if isolated() {
        return;
    }
    // Made into a meeting since the screen was drawn: the view cannot see the guest, a read can.
    let mut joined = Cal::new(
        9,
        "Planning",
        "2026-10-20T09:00:00Z",
        "2026-10-20T10:00:00Z",
    );
    joined.attendees = 1;
    // An empty subject the screen draws as a placeholder, and a place it could not write back.
    let mut bare = Cal::new(8, "", "2026-12-01T09:00:00Z", "2026-12-01T09:30:00Z");
    bare.location = "Room\t4".into();
    let shared = store(vec![joined, bare]);
    let w = world(Offer::Basic, Some(PASSWORD), script(shared.clone())).await;
    let work = async {
        let timed = json!({"accountId": ACCOUNT, "title": "Dentist", "location": "Room 4", "notes": "Card",
            "allDay": false, "startMs": ms("2026-10-05T07:00:00Z"), "endMs": ms("2026-10-05T07:30:00Z")});
        let made = rpc("calendarCreate", timed).await.unwrap();
        assert_eq!(made, json!({"id": cal_id(10), "changeKey": "CK10v1"}));
        let day = json!({"accountId": ACCOUNT, "title": "Holiday", "allDay": true,
            "startDate": "2026-10-25", "endDate": "2026-10-26"});
        rpc("calendarCreate", day).await.unwrap();
        let listed = rpc("calendarEvents", october()).await.unwrap();
        let events = listed["events"].as_array().unwrap();
        let shown = |e: &Value| format!("{} {} {}", e["title"], e["editable"], e["startDate"]);
        let shown: Vec<String> = events.iter().map(shown).collect();
        let expected = [r#""Dentist" true null"#, r#""Planning" true null"#];
        assert_eq!(
            shown,
            [expected[0], expected[1], r#""Holiday" true "2026-10-25""#]
        );
        let update = |key| json!({"accountId": ACCOUNT, "id": cal_id(10), "changeKey": key, "title": "Renamed", "location": "Room 4"});
        let renamed = rpc("calendarUpdate", update("CK10v1")).await.unwrap();
        assert_eq!(renamed, json!({"id": cal_id(10), "changeKey": "CK10v2"}));
        let stale = rpc("calendarUpdate", update("CK10v1")).await;
        assert_eq!(stale.err(), Some("exchange_calendar_conflict"));
        let planning =
            json!({"accountId": ACCOUNT, "id": cal_id(9), "changeKey": "CK9v1", "title": "x"});
        let locked = rpc("calendarUpdate", planning).await;
        assert_eq!(locked.err(), Some("exchange_calendar_locked"));
        // A drag names the time alone: neither the placeholder nor the place is judged or written.
        let drag = json!({"accountId": ACCOUNT, "id": cal_id(8), "changeKey": "CK8v1", "allDay": false,
            "startMs": ms("2026-12-01T10:00:00Z"), "endMs": ms("2026-12-01T10:30:00Z")});
        let dragged = rpc("calendarUpdate", drag).await.unwrap();
        assert_eq!(dragged, json!({"id": cal_id(8), "changeKey": "CK8v2"}));
        // Naming nothing to change reads the item and answers its version, and writes nothing.
        let nothing = json!({"accountId": ACCOUNT, "id": cal_id(8), "changeKey": "CK8v2"});
        let same = rpc("calendarUpdate", nothing).await.unwrap();
        assert_eq!(same, json!({"id": cal_id(8), "changeKey": "CK8v2"}));
        let delete = json!({"accountId": ACCOUNT, "id": cal_id(10), "changeKey": "CK10v2"});
        assert_eq!(
            rpc("calendarDelete", delete).await.unwrap(),
            json!({"deleted": true})
        );
    };
    TEST_ZONE.scope("W. Europe Standard Time", work).await;
    let store = shared.lock().unwrap();
    let left: Vec<(&str, &str)> = store
        .items
        .iter()
        .map(|cal| (cal.subject.as_str(), cal.location.as_str()))
        .collect();
    assert_eq!(left, [("Planning", ""), ("", "Room\t4"), ("Holiday", "")]);
    assert_eq!(store.items[1].start, secs("2026-12-01T10:00:00Z"));
    assert_eq!(
        w.fake.log.count("UpdateItem"),
        2,
        "nothing written to a stale version, a meeting or an update naming nothing"
    );
    // A day is made in the owner's zone, a time in none.
    let zones: Vec<Option<&str>> = store
        .requests
        .iter()
        .filter(|body| operation(body).name == "CreateItem")
        .map(|body| {
            body.split("TimeZoneDefinition Id=\"")
                .nth(1)?
                .split('"')
                .next()
        })
        .collect();
    assert_eq!(zones, [None, Some("W. Europe Standard Time")]);
}

#[tokio::test]
async fn a_detail_says_who_the_owner_is_and_masks_what_is_private_and_an_answer_says_what_it_did() {
    if isolated() {
        return;
    }
    let at = |n, title| Cal::new(n, title, "2026-10-07T13:00:00Z", "2026-10-07T14:00:00Z");
    let people = concat!(
        r#"<t:Body BodyType="Text">Agenda</t:Body>"#,
        "<t:JoinOnlineMeetingUrl>https://meet.example.org/j/7</t:JoinOnlineMeetingUrl>",
        "<t:RequiredAttendees><t:Attendee><t:Mailbox><t:Name>Ada</t:Name><t:EmailAddress>ADA@example.org</t:EmailAddress></t:Mailbox>",
        "<t:ResponseType>Accept</t:ResponseType></t:Attendee><t:Attendee><t:Mailbox><t:Name>Cy</t:Name>",
        "<t:EmailAddress>cy@example.org</t:EmailAddress></t:Mailbox><t:ResponseType>Accept</t:ResponseType></t:Attendee></t:RequiredAttendees>",
    );
    let mut invited = at(1, "Planning").with(people).with(INVITED);
    invited.reminder = Some(15);
    let mut private = at(2, "Salary review")
        .with("<t:Sensitivity>Private</t:Sensitivity>")
        .with(people)
        .with(INVITED);
    (private.location, private.reminder) = ("Clinic".into(), Some(5));
    // The same invitation, but in a folder that is not the default calendar.
    let elsewhere = at(0, "Planning")
        .with(r#"<t:ParentFolderId Id="elsewhere"/>"#)
        .with(people)
        .with(INVITED);
    let items = vec![invited, private, elsewhere];
    let w = world(Offer::Basic, Some(PASSWORD), script(store(items))).await;
    let read = |n| {
        rpc(
            "calendarEvent",
            json!({"accountId": ACCOUNT, "id": cal_id(n)}),
        )
    };
    let expected = json!({"id": cal_id(1), "changeKey": "CK1v1", "title": "Planning", "location": "",
        "allDay": false, "startMs": ms("2026-10-07T13:00:00Z"), "endMs": ms("2026-10-07T14:00:00Z"),
        "notes": "Agenda", "notesCut": false, "organizer": {"name": "Bob", "email": "bob@example.org"},
        // The owner's line is what the owner's own item says; on an invitation anybody else's says nothing.
        "attendees": [
            {"name": "Ada", "email": "ADA@example.org", "kind": "required", "response": "none", "self": true},
            {"name": "Cy", "email": "cy@example.org", "kind": "required", "response": "unknown", "self": false}],
        "attendeesCut": false, "response": "none", "reminderMinutes": 15,
        "joinUrl": "https://meet.example.org/j/7", "sensitivity": "normal", "meeting": true,
        "recurring": false, "cancelled": false, "unplacedCancellation": false, "kind": "single", "canRespond": true,
        "editable": false, "lock": "meeting"});
    assert_eq!(read(1).await.unwrap(), expected);
    let outside = read(0).await.unwrap();
    let said = ["editable", "lock", "canRespond"].map(|key| outside[key].clone());
    assert_eq!(
        json!(said),
        json!([false, "unknown", false]),
        "locked outside the calendar"
    );
    let masked = read(2).await.unwrap();
    let shown = [
        "title",
        "location",
        "notes",
        "organizer",
        "attendees",
        "joinUrl",
        "reminderMinutes",
        "canRespond",
    ];
    let shown = shown.map(|key| masked[key].clone());
    assert_eq!(
        json!(shown),
        json!(["Private", "", "", null, [], "", null, false])
    );
    for secret in [
        "Salary",
        "Clinic",
        "Agenda",
        "cy@",
        "meet.example",
        PASSWORD,
        LOGIN,
    ] {
        assert!(!masked.to_string().contains(secret), "{secret}");
    }
    let accept = json!({"accountId": ACCOUNT, "id": cal_id(1), "changeKey": "CK1v1", "response": "accept", "send": true});
    let done = rpc("calendarRespond", accept).await.unwrap();
    let named = json!({"id": cal_id(3), "changeKey": "CK3v1", "response": "accept", "sent": true});
    assert_eq!(
        done, named,
        "the item the server re-created, and no word of a removal not asked for"
    );
    let decline = json!({"accountId": ACCOUNT, "id": cal_id(3), "changeKey": "CK3v1", "response": "decline", "send": true, "remove": true});
    let done = rpc("calendarRespond", decline).await.unwrap();
    assert_eq!(
        (&done["response"], &done["removed"]),
        (&json!("decline"), &json!(true))
    );
    let private = json!({"accountId": ACCOUNT, "id": cal_id(2), "changeKey": "CK2v1", "response": "accept", "send": true});
    let refused = rpc("calendarRespond", private).await;
    assert_eq!(refused.err(), Some("exchange_calendar_not_invitation"));
    assert_eq!(w.fake.log.count("CreateItem"), 2);
}

#[tokio::test]
async fn a_detail_keeps_the_guests_answers_on_the_owners_meeting_and_says_a_doubt_as_one() {
    if isolated() {
        return;
    }
    let at = |n, title| Cal::new(n, title, "2026-10-07T13:00:00Z", "2026-10-07T14:00:00Z");
    let guests = concat!(
        "<t:IsMeeting>true</t:IsMeeting><t:RequiredAttendees><t:Attendee><t:Mailbox><t:Name>Cy</t:Name>",
        "<t:EmailAddress>cy@example.org</t:EmailAddress></t:Mailbox><t:ResponseType>Accept</t:ResponseType>",
        "</t:Attendee></t:RequiredAttendees>",
    );
    // The owner's own meeting (the item says `MyResponseType` Organizer): a guest's answer is theirs.
    let organised = at(1, "Review").with(guests);
    // An event of a series that does not say where it sits, while another event of it is cancelled.
    let unplaced = Cal {
        uid: Some(7),
        ..at(2, "Standup")
            .with("<t:CalendarItemType>Occurrence</t:CalendarItemType>")
            .with(INVITED)
    };
    let shared = store(vec![organised, unplaced]);
    let named = (
        "uid-7@example.org".into(),
        Some("2026-10-14T13:00:00Z".into()),
    );
    shared.lock().unwrap().cancelled = vec![named];
    let _w = world(Offer::Basic, Some(PASSWORD), script(shared.clone())).await;
    let read = |n| {
        rpc(
            "calendarEvent",
            json!({"accountId": ACCOUNT, "id": cal_id(n)}),
        )
    };
    let own = read(1).await.unwrap();
    let answers = (&own["response"], &own["attendees"][0]["response"]);
    assert_eq!(answers, (&json!("organizer"), &json!("accept")));
    let doubt = read(2).await.unwrap();
    let said = ["cancelled", "unplacedCancellation", "canRespond"].map(|key| doubt[key].clone());
    assert_eq!(
        json!(said),
        json!([false, true, false]),
        "a doubt is no certainty"
    );
}
