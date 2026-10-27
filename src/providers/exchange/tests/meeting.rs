//! `exchange.meeting*` end to end: the word that people will be mailed and the people themselves,
//! judged before any account, credential or socket; a meeting made, listed, read, changed and cancelled
//! through the scripted calendar of `ews::tests::calendar`, with the appointment calls refusing it; and a
//! cancelled invitation taken off the calendar.

use super::*;
use crate::providers::exchange::ews::tests::calendar::{Cal, cal_id, script, secs, store};
use crate::providers::exchange::ews::tests::detail::INVITED;

fn ms(text: &str) -> i64 {
    secs(text) * 1000
}

fn with(mut base: Value, extra: Value) -> Value {
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

fn lunch() -> Value {
    json!({"accountId": ACCOUNT, "title": "Lunch", "location": "Canteen", "allDay": false,
        "startMs": ms("2026-10-25T11:00:00Z"), "endMs": ms("2026-10-25T12:00:00Z"),
        "requiredAttendees": ["bob@example.org"], "optionalAttendees": ["cy@example.org"],
        "sendInvitations": true})
}

#[tokio::test]
async fn a_request_that_would_tell_people_is_refused_unless_it_says_so_before_any_socket_opens() {
    if isolated() {
        return;
    }
    let w = world(Offer::Basic, Some(PASSWORD), script(store(Vec::new()))).await;
    let key = "DwAAABYAAAB0001";
    let update = json!({"accountId": ACCOUNT, "id": cal_id(1), "changeKey": key, "title": "x", "sendUpdates": true});
    let cancel =
        json!({"accountId": ACCOUNT, "id": cal_id(1), "changeKey": key, "sendCancellations": true});
    let remove = json!({"accountId": ACCOUNT, "id": cal_id(1), "changeKey": key});
    let many: Vec<String> = (0..201).map(|n| format!("p{n}@example.org")).collect();
    let mut cases = Vec::new();
    for word in [json!(null), json!(false), json!("true"), json!(1)] {
        cases.push((
            "meetingCreate",
            with(lunch(), json!({ "sendInvitations": word })),
        ));
        cases.push((
            "meetingUpdate",
            with(update.clone(), json!({ "sendUpdates": word })),
        ));
        cases.push((
            "meetingCancel",
            with(cancel.clone(), json!({ "sendCancellations": word })),
        ));
    }
    for people in [
        json!([]),
        json!("bob@example.org"),
        json!([5]),
        json!(["Bob <bob@example.org>"]),
        json!(["bob@example.org", "BOB@example.org"]),
        json!(["ADA@example.org"]),
        json!(["cy@example.org"]),
        json!(many),
    ] {
        let named = json!({"requiredAttendees": people, "optionalAttendees": null});
        let crossed = with(
            named.clone(),
            json!({"optionalAttendees": ["cy@example.org"]}),
        );
        // Nobody is a list an update may name (it empties the list), and so is one person.
        let listing = people == json!([]) || people == json!(["cy@example.org"]);
        let create = with(lunch(), if people == json!([]) { named } else { crossed });
        cases.push(("meetingCreate", create));
        if !listing {
            cases.push((
                "meetingUpdate",
                with(update.clone(), json!({ "requiredAttendees": people })),
            ));
        }
    }
    let note = "x".repeat(2001);
    for extra in [
        json!({"message": note}),
        json!({"message": 5}),
        json!({"message": "a\u{7}b"}),
    ] {
        cases.push(("meetingCancel", with(cancel.clone(), extra)));
    }
    for (method, base) in [
        ("meetingCreate", lunch()),
        ("meetingUpdate", update),
        ("meetingCancel", cancel),
        ("meetingRemove", remove.clone()),
    ] {
        cases.push((method, with(base.clone(), json!({"requestToken": "t"}))));
        cases.push((method, with(base, json!({"calendar": "elsewhere"}))));
    }
    cases.push((
        "meetingRemove",
        with(remove.clone(), json!({"changeKey": "a b"})),
    ));
    cases.push((
        "meetingRemove",
        with(remove, json!({"sendCancellations": true})),
    ));
    cases.push(("meetingCreate", with(lunch(), json!({"notes": 5}))));
    for (method, params) in cases {
        let answer = rpc(method, params.clone()).await;
        assert_eq!(answer.err(), Some("invalid_params"), "{method} {params}");
        // Judged before the account is looked up: a mailbox nobody registered is not what is said
        // (the owner's own address is only refused for the owner).
        if params.to_string().contains("ADA@") {
            continue;
        }
        let elsewhere = with(params, json!({"accountId": "exchange:absent@example.org"}));
        let answer = rpc(method, elsewhere.clone()).await;
        assert_eq!(answer.err(), Some("invalid_params"), "{method} {elsewhere}");
    }
    let opened = w
        .fake
        .log
        .connections
        .load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(opened, 0, "nothing was asked of the server");
}

#[tokio::test]
async fn a_meeting_is_made_listed_changed_and_cancelled_and_says_whom_it_told() {
    if isolated() {
        return;
    }
    let invited =
        Cal::new(9, "Review", "2026-10-26T09:00:00Z", "2026-10-26T10:00:00Z").with(INVITED);
    let calendar = store(vec![invited]);
    let w = world(Offer::Basic, Some(PASSWORD), script(calendar.clone())).await;
    let made = rpc("meetingCreate", lunch()).await.unwrap();
    assert_eq!(
        made,
        json!({"id": cal_id(10), "changeKey": "CK10v1", "invited": 2})
    );
    let month = json!({"accountId": ACCOUNT, "startMs": ms("2026-10-01T00:00:00Z"), "endMs": ms("2026-11-01T00:00:00Z")});
    let listed = rpc("calendarEvents", month).await.unwrap();
    let event = listed["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == cal_id(10))
        .unwrap()
        .clone();
    let shown = ["meeting", "editable", "lock"].map(|key| event[key].clone());
    assert_eq!(
        json!(shown),
        json!([true, true, ""]),
        "the owner's meeting, editable as a meeting"
    );
    let read = rpc(
        "calendarEvent",
        json!({"accountId": ACCOUNT, "id": cal_id(10)}),
    )
    .await
    .unwrap();
    let said =
        ["editable", "lock", "canRespond", "canRemove", "cancelled"].map(|key| read[key].clone());
    assert_eq!(json!(said), json!([true, "", false, false, false]));
    let people: Vec<&Value> = read["attendees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| &a["email"])
        .collect();
    assert_eq!(
        people,
        [&json!("bob@example.org"), &json!("cy@example.org")]
    );
    // The appointment calls tell nobody, so they refuse a meeting.
    let target = json!({"accountId": ACCOUNT, "id": cal_id(10), "changeKey": "CK10v1"});
    let plain = rpc(
        "calendarUpdate",
        with(target.clone(), json!({"title": "x"})),
    )
    .await;
    assert_eq!(plain.err(), Some("exchange_calendar_locked"));
    let gone = rpc("calendarDelete", target.clone()).await;
    assert_eq!(gone.err(), Some("exchange_calendar_locked"));
    let changed = rpc(
        "meetingUpdate",
        with(
            target,
            json!({"title": "Lunch, moved", "sendUpdates": true}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        changed,
        json!({"id": cal_id(10), "changeKey": "CK10v2", "sent": true})
    );
    let cancel = json!({"accountId": ACCOUNT, "id": cal_id(10), "changeKey": "CK10v2", "message": "Sorry", "sendCancellations": true});
    let cancelled = rpc("meetingCancel", cancel).await.unwrap();
    assert_eq!(cancelled, json!({"cancelled": true, "told": 2}));
    // An invitation its organizer cancelled says so, and leaves the calendar with nobody mailed.
    calendar.lock().unwrap().cancelled = vec![("uid-9@example.org".into(), None)];
    let read = rpc(
        "calendarEvent",
        json!({"accountId": ACCOUNT, "id": cal_id(9)}),
    )
    .await
    .unwrap();
    let said = ["cancelled", "canRemove", "canRespond"].map(|key| read[key].clone());
    assert_eq!(json!(said), json!([true, true, false]));
    let remove = json!({"accountId": ACCOUNT, "id": cal_id(9), "changeKey": "CK9v1"});
    let removed = rpc("meetingRemove", remove).await.unwrap();
    assert_eq!(removed, json!({"removed": true, "because": "cancelled"}));
    assert!(calendar.lock().unwrap().items.is_empty());
    assert_eq!(
        (
            w.fake.log.count("CreateItem"),
            w.fake.log.count("UpdateItem")
        ),
        (3, 1)
    );
}
