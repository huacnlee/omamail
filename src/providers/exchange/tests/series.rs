//! Repeating events end to end: what a request may say of a repeat and a scope, judged before any
//! account, credential or socket; and a series made, read, changed, deleted and, cancelled by its
//! organizer, removed in one call through the scripted calendar of `ews::tests::calendar`.

use super::*;
use crate::providers::exchange::ews::tests::calendar::{cal_id, operation, script, secs, store};
use crate::providers::exchange::ews::tests::detail::INVITED;
use crate::providers::exchange::ews::tests::series::{
    attendee, exception, monday, organised, weekly,
};
use crate::providers::exchange::zone::TEST_ZONE;

const VIENNA: &str = "W. Europe Standard Time";

fn ms(text: &str) -> i64 {
    secs(text) * 1000
}

fn merged(mut base: Value, extra: Value) -> Value {
    for (key, value) in extra.as_object().unwrap() {
        match value {
            Value::Null => base.as_object_mut().unwrap().remove(key),
            value => base
                .as_object_mut()
                .unwrap()
                .insert(key.clone(), value.clone()),
        };
    }
    base
}

/// A weekly backup at 03:00 in Vienna, a week before the clocks change there.
fn backup() -> Value {
    json!({"accountId": ACCOUNT, "title": "Backup", "allDay": false,
        "startMs": ms("2026-10-19T01:00:00Z"), "endMs": ms("2026-10-19T02:00:00Z"),
        "recurrence": {"frequency": "weekly", "end": "count", "count": 3, "firstDate": "2026-10-19"}})
}

#[tokio::test]
async fn a_repeat_or_a_scope_a_request_cannot_have_is_refused_before_anything_is_asked() {
    let (id, key) = (cal_id(2), "DwAAABYAAAB0001");
    let weekly = |extra: Value| {
        merged(
            json!({"frequency": "weekly", "firstDate": "2026-10-19"}),
            extra,
        )
    };
    // Each case's members over a valid request (a create's is `backup`); a null takes one out.
    let table = json!([
        ["calendarCreate", {"recurrence": weekly(json!({"firstDate": null}))}],
        ["calendarCreate", {"recurrence": weekly(json!({"firstDate": "2026-10-21"}))}],
        ["calendarCreate", {"recurrence": weekly(json!({"frequency": "yearly", "interval": 2}))}],
        ["calendarCreate", {"recurrence": weekly(json!({"end": "count", "count": 1000}))}],
        ["calendarCreate", {"endMs": ms("2026-10-26T01:01:00Z")}],
        ["calendarCreate", {"allDay": true, "startMs": null, "endMs": null,
            "startDate": "2026-10-19", "endDate": "2026-10-20"}],
        ["calendarUpdate", {"title": "x", "scope": "all"}],
        ["calendarUpdate", {"scope": "occurrence", "startClock": "10:15", "durationMinutes": 45}],
        ["calendarUpdate", {"startClock": "10:15", "durationMinutes": 45}],
        ["calendarUpdate", {"scope": "series", "startClock": "10:15"}],
        ["calendarUpdate", {"scope": "series", "startClock": "9:15", "durationMinutes": 45}],
        ["calendarUpdate", {"scope": "series", "startClock": "10:15", "durationMinutes": 0}],
        ["calendarUpdate", {"scope": "series", "allDay": false,
            "startMs": ms("2026-10-19T01:00:00Z"), "endMs": ms("2026-10-19T02:00:00Z")}],
        ["calendarDelete", {"scope": 1}],
        ["calendarRespond", {"response": "accept", "send": true, "scope": "occurrence"}],
        ["meetingUpdate", {"sendUpdates": true, "scope": "occurrence", "requiredAttendees": ["bob@example.org"]}],
        ["meetingUpdate", {"scope": "series", "title": "x"}],
        ["meetingCancel", {"scope": "series"}],
        ["meetingUpdate", {"sendUpdates": true, "scope": "series", "title": "x"}],
        ["meetingUpdate", {"sendUpdates": true, "scope": "occurrence", "title": "x",
            "seriesAttendees": ["bob@example.org"]}],
        ["meetingUpdate", {"sendUpdates": true, "title": "x", "seriesAttendees": ["bob@example.org"]}],
        ["meetingCancel", {"sendCancellations": true, "scope": "series"}],
        ["meetingCancel", {"sendCancellations": true, "scope": "series", "seriesAttendees": []}],
        ["meetingCancel", {"sendCancellations": true, "scope": "series",
            "seriesAttendees": ["Bob <bob@example.org>"]}],
        ["meetingCancel", {"sendCancellations": true, "scope": "series",
            "seriesAttendees": ["bob@example.org", "BOB@example.org"]}],
        ["meetingCancel", {"sendCancellations": true, "scope": "occurrence",
            "seriesAttendees": ["bob@example.org"]}],
        ["meetingCreate", {"requiredAttendees": ["bob@example.org"]}],
        ["meetingRemove", {"scope": "all"}],
        ["meetingRemove", {"scope": "series", "sendCancellations": true}],
    ]);
    for case in table.as_array().unwrap() {
        let method = case[0].as_str().unwrap();
        let base = match method.ends_with("Create") {
            true => backup(),
            false => json!({"accountId": ACCOUNT, "id": id, "changeKey": key}),
        };
        let params = merged(base, case[1].clone());
        let refused = rpc(method, params.clone()).await.err();
        assert_eq!(refused, Some("invalid_params"), "{method} {params}");
    }
}

/// A repeating appointment and a repeating meeting made, and every event of each moved: each
/// needs this computer's zone.
fn series_writes(id: &str, key: &str) -> Vec<(&'static str, Value)> {
    let clock = json!({"accountId": ACCOUNT, "id": id, "changeKey": key, "scope": "series",
        "startClock": "10:15", "durationMinutes": 45});
    let meeting = merged(
        clock.clone(),
        json!({"sendUpdates": true, "seriesAttendees": ["bob@example.org"]}),
    );
    let invited = json!({"requiredAttendees": ["bob@example.org"], "sendInvitations": true});
    vec![
        ("calendarCreate", backup()),
        ("meetingCreate", merged(backup(), invited)),
        ("calendarUpdate", clock),
        ("meetingUpdate", meeting),
    ]
}

#[tokio::test]
async fn a_computer_whose_zone_is_not_known_makes_no_series_and_moves_none_and_asks_nothing() {
    if isolated() {
        return;
    }
    let w = world(Offer::Basic, Some(PASSWORD), script(store(weekly(3, "")))).await;
    // A mailbox nobody registered names no credential, whatever zone this computer is in: the
    // account is looked up before the zone, so the answer is the same on every computer.
    let absent = json!({"accountId": "exchange:absent@example.org"});
    for (method, params) in series_writes(&cal_id(2), "DwAAABYAAAB0001") {
        let elsewhere = merged(params.clone(), absent.clone());
        let answer = TEST_ZONE.scope("", rpc(method, elsewhere.clone())).await;
        assert_eq!(
            answer.err(),
            Some("auth_account_missing"),
            "{method} {elsewhere}"
        );
        let answer = TEST_ZONE.scope("", rpc(method, params.clone())).await;
        assert_eq!(
            answer.err(),
            Some("exchange_calendar_zone_unknown"),
            "{method} {params}"
        );
    }
    let opened = w
        .fake
        .log
        .connections
        .load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(opened, 0, "nothing was asked of the server");
}

#[tokio::test]
async fn a_series_is_made_in_the_owners_zone_read_with_its_rule_and_written_one_event_or_all() {
    if isolated() {
        return;
    }
    let shared = store(weekly(3, ""));
    let w = world(Offer::Basic, Some(PASSWORD), script(shared.clone())).await;
    let work = async {
        let made = rpc("calendarCreate", backup()).await.unwrap();
        assert_eq!(made, json!({"id": cal_id(5), "changeKey": "CK5v1"}));
        let range = json!({"accountId": ACCOUNT, "startMs": ms("2026-10-01T00:00:00Z"), "endMs": ms("2026-10-18T00:00:00Z")});
        let listed = rpc("calendarEvents", range).await.unwrap();
        let shown: Vec<String> = listed["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| format!("{} {} {}", e["kind"], e["editable"], e["changeKey"]))
            .collect();
        assert_eq!(shown, [r#""occurrence" true "CK1v1""#; 2]);
        let detail = rpc(
            "calendarEvent",
            json!({"accountId": ACCOUNT, "id": cal_id(3)}),
        )
        .await
        .unwrap();
        assert_eq!(
            detail["series"],
            json!({"text": "Every week on Monday, 3 times", "kind": "weekly", "key": "CK1v1",
            "editable": true, "lock": "", "timeEditable": true, "canRespond": false, "attendees": [],
            "attendeesCut": false, "exceptions": 0})
        );
        assert_eq!(
            (
                detail["editable"].clone(),
                detail["canRemoveSeries"].clone()
            ),
            (json!(true), json!(false))
        );
        // On a computer in another zone all of it may still change, but not its time of day.
        let read = json!({"accountId": ACCOUNT, "id": cal_id(3)});
        let there = TEST_ZONE
            .scope("GMT Standard Time", rpc("calendarEvent", read))
            .await;
        let there = &there.unwrap()["series"];
        assert_eq!(
            (&there["editable"], &there["timeEditable"]),
            (&json!(true), &json!(false))
        );
        let all = json!({"accountId": ACCOUNT, "id": cal_id(3), "changeKey": "CK1v1", "scope": "series",
            "startClock": "10:15", "durationMinutes": 45});
        assert_eq!(
            rpc("calendarUpdate", all).await.unwrap(),
            json!({"id": cal_id(1), "changeKey": "CK1v2"})
        );
        let none = json!({"accountId": ACCOUNT, "id": cal_id(2), "changeKey": "CK1v2"});
        assert_eq!(
            rpc("calendarDelete", none.clone()).await.err(),
            Some("exchange_calendar_locked")
        );
        let one = merged(none, json!({"scope": "occurrence"}));
        assert_eq!(
            rpc("calendarDelete", one).await.unwrap(),
            json!({"deleted": true})
        );
    };
    TEST_ZONE.scope(VIENNA, work).await;
    let store = shared.lock().unwrap();
    let ops: Vec<String> = store
        .requests
        .iter()
        .map(|body| operation(body).name)
        .collect();
    let writes: Vec<&str> = ops
        .iter()
        .map(String::as_str)
        .filter(|op| ["CreateItem", "UpdateItem", "DeleteItem"].contains(op))
        .collect();
    assert_eq!(
        writes,
        ["CreateItem", "UpdateItem", "DeleteItem"],
        "nothing written for the call that named no scope"
    );
    let create = store
        .requests
        .iter()
        .find(|body| operation(body).name == "CreateItem")
        .unwrap();
    for part in [
        r#"<t:TimeZoneDefinition Id="W. Europe Standard Time"/>"#,
        "<t:Start>2026-10-19T01:00:00Z</t:Start>",
        "<t:NumberedRecurrence><t:StartDate>2026-10-19</t:StartDate>",
        r#"<t:EndTimeZone Id="W. Europe Standard Time"/>"#,
    ] {
        assert!(create.contains(part), "{part}");
    }
    assert_eq!(w.fake.log.count("UpdateItem"), 1);
}

#[tokio::test]
async fn a_series_its_organizer_cancelled_says_so_and_is_removed_in_one_call_that_counts_what_it_did()
 {
    if isolated() {
        return;
    }
    // The event opened is an exception with its own people, which are not the series'.
    let mut items = weekly(3, INVITED);
    items[1].extra = format!(
        "<t:RequiredAttendees><t:Attendee><t:Mailbox><t:EmailAddress>bob@example.org</t:EmailAddress></t:Mailbox></t:Attendee></t:RequiredAttendees>{}",
        items[1].extra
    );
    let shared = store(items);
    shared.lock().unwrap().cancelled = vec![
        ("uid-1@example.org".into(), Some(monday(0))),
        ("uid-1@example.org".into(), Some(monday(2))),
    ];
    let _w = world(Offer::Basic, Some(PASSWORD), script(shared.clone())).await;
    let detail = rpc(
        "calendarEvent",
        json!({"accountId": ACCOUNT, "id": cal_id(2)}),
    )
    .await
    .unwrap();
    let said = [
        "cancelled",
        "canRemove",
        "canRemoveSeries",
        "cancelledEvents",
    ]
    .map(|key| detail[key].clone());
    assert_eq!(json!(said), json!([true, true, true, 2]));
    // The people all of it tells are its master's, as the server lists them.
    let people = &detail["series"]["attendees"];
    assert_eq!(
        (&people[0]["email"], people.as_array().map(Vec::len)),
        (&json!("ada@example.org"), Some(1))
    );
    assert_eq!(detail["series"]["attendeesCut"], json!(false));
    assert_eq!(detail["attendees"][0]["email"], json!("bob@example.org"));
    // Somebody else's series: nothing of it changes from here, its time included.
    let series = &detail["series"];
    assert_eq!(
        (&series["editable"], &series["timeEditable"]),
        (&json!(false), &json!(false))
    );
    assert_eq!(
        detail["series"]["canRespond"], true,
        "the rest may still be answered"
    );
    // An event nobody cancelled says nothing of removing the series it belongs to.
    let kept = rpc(
        "calendarEvent",
        json!({"accountId": ACCOUNT, "id": cal_id(3)}),
    )
    .await;
    let kept = kept.unwrap();
    let said = ["canRemove", "canRemoveSeries"].map(|key| kept[key].clone());
    assert_eq!(json!(said), json!([false, false]));
    let remove =
        json!({"accountId": ACCOUNT, "id": cal_id(2), "changeKey": "CK1v1", "scope": "series"});
    let done = rpc("meetingRemove", remove).await.unwrap();
    assert_eq!(
        done,
        json!({"removed": true, "because": "cancelled", "count": 2, "more": false, "seriesLeft": false})
    );
    let left: Vec<u16> = shared
        .lock()
        .unwrap()
        .items
        .iter()
        .map(|cal| cal.n)
        .collect();
    assert_eq!(
        left,
        [1, 3],
        "the master and the event nobody cancelled stay"
    );
}

#[tokio::test]
async fn a_cancelled_series_whose_master_stays_says_so_with_what_it_took_off() {
    if isolated() {
        return;
    }
    // The whole cancellation is processed and the server leaves a master the owner organises: it is not
    // deleted, and the answer says the series is still there.
    let shared = store(weekly(3, INVITED));
    {
        let mut store = shared.lock().unwrap();
        store.cancelled = vec![("uid-1@example.org".into(), None)];
        store.keeps_master = Some(
            "<t:MyResponseType>Organizer</t:MyResponseType><t:IsOrganizer>true</t:IsOrganizer>"
                .into(),
        );
    }
    let w = world(Offer::Basic, Some(PASSWORD), script(shared.clone())).await;
    let remove =
        json!({"accountId": ACCOUNT, "id": cal_id(2), "changeKey": "CK1v1", "scope": "series"});
    let done = rpc("meetingRemove", remove).await.unwrap();
    assert_eq!(
        done,
        json!({"removed": true, "because": "cancelled", "count": 1, "more": false, "seriesLeft": true})
    );
    assert_eq!(w.fake.log.count("DeleteItem"), 0);
}

#[tokio::test]
async fn a_series_with_an_event_of_its_own_guests_says_so_and_is_not_changed_for_all() {
    if isolated() {
        return;
    }
    // Dan was added to event 3 alone.
    let mut items = weekly(3, &organised(&["bob@example.org"]));
    let dan = format!(
        "<t:RequiredAttendees>{}{}</t:RequiredAttendees>",
        attendee("bob@example.org"),
        attendee("dan@example.org")
    );
    exception(&mut items[2], &dan);
    let shared = store(items);
    let w = world(Offer::Basic, Some(PASSWORD), script(shared.clone())).await;
    let read = json!({"accountId": ACCOUNT, "id": cal_id(2)});
    let detail = rpc("calendarEvent", read).await.unwrap();
    let series = &detail["series"];
    assert_eq!(
        (&series["editable"], &series["lock"], &detail["editable"]),
        (&json!(false), &json!("exceptionGuests"), &json!(true))
    );
    assert_eq!(series["exceptions"], json!(1));
    let all = json!({"accountId": ACCOUNT, "id": cal_id(2), "changeKey": "CK1v1", "scope": "series",
        "sendCancellations": true, "seriesAttendees": ["bob@example.org"]});
    let cancel = rpc("meetingCancel", all).await;
    assert_eq!(cancel.err(), Some("exchange_calendar_locked"));
    assert_eq!(w.fake.log.count("CreateItem"), 0);
}

#[tokio::test]
async fn a_plain_series_says_how_many_of_its_events_were_changed_on_their_own() {
    if isolated() {
        return;
    }
    // Event 3 has a title of its own; nobody is on any of it.
    let mut items = weekly(3, "");
    exception(&mut items[2], "<t:Subject>Backup, moved</t:Subject>");
    let _w = world(Offer::Basic, Some(PASSWORD), script(store(items))).await;
    let read = json!({"accountId": ACCOUNT, "id": cal_id(2)});
    let detail = rpc("calendarEvent", read).await.unwrap();
    let series = &detail["series"];
    assert_eq!(
        (&series["exceptions"], &series["editable"], &series["lock"]),
        (&json!(1), &json!(true), &json!(""))
    );
}
