//! `exchange.calendars`, `exchange.calendarShared` and the `calendar` member of every calendar call, end
//! to end: what the answers hold, what is refused before any lookup, and what may be done where.

use super::*;
use crate::providers::exchange::ews::tests::calendar::{
    Cal, Shared, cal_id, folder_id, operation, script, secs, store,
};
use crate::providers::exchange::ews::tests::detail::INVITED;
use crate::providers::exchange::ews::tests::folders::mailbox;

const BOB: &str = "bob@example.org";
const CAROL: &str = "carol@example.org";
const LOCKED: Option<&str> = Some("exchange_calendar_locked");

fn ms(text: &str) -> i64 {
    secs(text) * 1000
}

/// The reference of the scripted folder `n`, in the mailbox's own or in another's.
fn own(n: u16) -> String {
    ids::encode(&folder_id(n)).unwrap()
}

fn theirs(n: u16, address: &str) -> String {
    format!("{}:{address}", own(n))
}

fn october(calendar: Option<String>) -> Value {
    let mut range = json!({"accountId": ACCOUNT, "startMs": ms("2026-10-01T00:00:00Z"), "endMs": ms("2026-11-01T00:00:00Z")});
    if let Some(reference) = calendar {
        range["calendar"] = json!(reference);
    }
    range
}

async fn mailbox_world(items: Vec<Cal>) -> (World, Shared) {
    let shared = store(items);
    mailbox(&shared);
    let w = world(Offer::Basic, Some(PASSWORD), script(shared.clone())).await;
    (w, shared)
}

fn at(n: u16, title: &str, folder: u16) -> Cal {
    Cal::new(n, title, "2026-10-07T13:00:00Z", "2026-10-07T14:00:00Z").within(&folder_id(folder))
}

#[tokio::test]
async fn discovery_answers_a_source_per_calendar_with_what_the_user_may_do_in_it() {
    if isolated() {
        return;
    }
    let (_w, shared) = mailbox_world(Vec::new()).await;
    let answer = rpc("calendars", json!({"accountId": ACCOUNT}))
        .await
        .unwrap();
    assert_eq!(
        (&answer["provider"], &answer["accountId"]),
        (&json!("exchange"), &json!(ACCOUNT))
    );
    assert_eq!(answer["truncated"], false);
    let steps = json!({"folders": {"found": 2, "code": null}});
    assert_eq!(answer["steps"], steps);
    let calendars = answer["calendars"].as_array().unwrap();
    let all = json!({"read": true, "create": true, "modify": true, "delete": true});
    let source = |reference: &str| {
        let calendars = calendars.iter();
        let found = calendars
            .clone()
            .find(|c| c["calendarId"] == reference)
            .unwrap();
        found["sourceId"].as_str().unwrap().to_owned()
    };
    let expected = json!([
        {"sourceId": "exchange:exchange:ada@example.org", "calendarId": "", "name": "Calendar",
            "isDefault": true, "own": true, "mailbox": "", "origin": "default", "readOnly": false,
            "canCreate": true, "accessRole": "owner", "rights": all},
        {"sourceId": source(&own(1)), "calendarId": own(1), "name": "Team", "isDefault": false,
            "own": true, "mailbox": "", "origin": "folder", "readOnly": false, "canCreate": true,
            "accessRole": "owner", "rights": all},
        {"sourceId": source(&own(2)), "calendarId": own(2), "name": "Sub", "isDefault": false,
            "own": true, "mailbox": "", "origin": "folder", "readOnly": false, "canCreate": true,
            "accessRole": "owner", "rights": all},
    ]);
    assert_eq!(&answer["calendars"], &expected);
    // Every source id but the default calendar's is the account's and a digest, and no two are alike.
    let ids: Vec<&str> = calendars
        .iter()
        .map(|c| c["sourceId"].as_str().unwrap())
        .collect();
    assert!(
        ids[1..]
            .iter()
            .all(|id| id.len() == "exchange:exchange:ada@example.org:".len() + 64)
    );
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        3
    );
    // No server id beyond the references, no server text, no secret.
    let text = answer.to_string();
    for secret in [
        "calendar-folder",
        &folder_id(1),
        &folder_id(10),
        PASSWORD,
        LOGIN,
        "IPF.",
    ] {
        assert!(!text.contains(secret), "{secret}");
    }
    // The same calendars the next time, by the same ids.
    let again = rpc("calendars", json!({"accountId": ACCOUNT}))
        .await
        .unwrap();
    assert_eq!(again["calendars"], answer["calendars"]);
    assert!(!shared.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn a_calendar_another_mailbox_shares_is_added_by_its_address_and_one_that_is_not_is_refused_with_one_code()
 {
    if isolated() {
        return;
    }
    let (_w, _shared) = mailbox_world(Vec::new()).await;
    let ask = |address: &str| json!({"accountId": ACCOUNT, "mailbox": address});
    let added = rpc("calendarShared", ask("Carol@Example.org"))
        .await
        .unwrap();
    assert_eq!(
        (&added["provider"], &added["accountId"]),
        (&json!("exchange"), &json!(ACCOUNT))
    );
    let calendar = &added["calendar"];
    assert_eq!(calendar["calendarId"], theirs(11, CAROL).as_str());
    assert_eq!(
        (&calendar["origin"], &calendar["mailbox"]),
        (&json!("address"), &json!(CAROL))
    );
    assert_eq!(
        (&calendar["readOnly"], &calendar["accessRole"]),
        (&json!(false), &json!("writer"))
    );
    // Read only is still shared, and named the same way.
    let bob = rpc("calendarShared", ask(BOB)).await.unwrap();
    let read = json!({"read": true, "create": false, "modify": false, "delete": false});
    assert_eq!(
        (&bob["calendar"]["readOnly"], &bob["calendar"]["rights"]),
        (&json!(true), &read)
    );
    let alias = rpc("calendarShared", ask("ada.alias@example.org")).await;
    assert_eq!(alias.err(), Some("exchange_calendar_own_mailbox"));
    for address in ["nobody@example.org", "dave@example.org"] {
        let refused = rpc("calendarShared", ask(address)).await;
        assert_eq!(
            refused.err(),
            Some("exchange_calendar_not_shared"),
            "{address}"
        );
    }
}

#[tokio::test]
async fn the_new_methods_and_the_calendar_member_refuse_what_they_do_not_take_before_any_lookup() {
    // No world: a request that got as far as the account would say the mailbox is not there.
    let id = cal_id(1);
    let key = "DwAAABYAAAB0001";
    let timed = json!({"title": "x", "allDay": false, "startMs": 1_790_000_000_000i64, "endMs": 1_790_001_800_000i64});
    let mut cases = vec![
        (
            "calendars",
            json!({"accountId": ACCOUNT, "unexpected": true}),
        ),
        (
            "calendars",
            json!({"accountId": ACCOUNT, "requestToken": ""}),
        ),
        ("calendars", json!({"accountId": "imap:ada@example.org"})),
        ("calendarShared", json!({"accountId": ACCOUNT})),
        (
            "calendarShared",
            json!({"accountId": ACCOUNT, "mailbox": 5}),
        ),
        (
            "calendarShared",
            json!({"accountId": ACCOUNT, "mailbox": "bob"}),
        ),
        (
            "calendarShared",
            json!({"accountId": ACCOUNT, "mailbox": "Bob <bob@example.org>"}),
        ),
        (
            "calendarShared",
            json!({"accountId": ACCOUNT, "mailbox": " bob@example.org"}),
        ),
        (
            "calendarShared",
            json!({"accountId": ACCOUNT, "mailbox": "bob@example.org, carol@example.org"}),
        ),
        (
            "calendarShared",
            json!({"accountId": ACCOUNT, "mailbox": "ADA@example.org"}),
        ),
        (
            "calendarShared",
            json!({"accountId": ACCOUNT, "mailbox": BOB, "calendar": own(1)}),
        ),
    ];
    let named = [
        ("calendarEvents", october(None)),
        ("calendarEvent", json!({"accountId": ACCOUNT, "id": id})),
        (
            "calendarCreate",
            merge(&json!({"accountId": ACCOUNT}), timed.clone()),
        ),
        (
            "calendarUpdate",
            json!({"accountId": ACCOUNT, "id": id, "changeKey": key, "title": "x"}),
        ),
        (
            "calendarDelete",
            json!({"accountId": ACCOUNT, "id": id, "changeKey": key}),
        ),
        (
            "calendarRespond",
            json!({"accountId": ACCOUNT, "id": id, "changeKey": key, "response": "accept", "send": true}),
        ),
        (
            "meetingRemove",
            json!({"accountId": ACCOUNT, "id": id, "changeKey": key}),
        ),
    ];
    for (method, params) in named {
        for bad in [
            json!(""),
            json!(5),
            json!(own(1).to_uppercase()),
            json!(format!("{}:Bob@example.org", own(1))),
            json!(format!("{}:ada@example.org", own(1))),
            json!(format!("{}:", own(1))),
            json!("not-a-reference"),
        ] {
            let mut params = params.clone();
            params["calendar"] = bad;
            cases.push((method, params));
        }
    }
    for (method, params) in cases {
        let answer = rpc(method, params.clone()).await;
        assert_eq!(answer.err(), Some("invalid_params"), "{method} {params}");
    }
}

#[tokio::test]
async fn what_reaches_people_and_every_event_of_a_series_are_locked_outside_the_default_calendar_before_any_lookup()
 {
    let (id, key) = (cal_id(1), "DwAAABYAAAB0001");
    let timed = json!({"title": "x", "allDay": false, "startMs": 1_790_000_000_000i64, "endMs": 1_790_001_800_000i64});
    let with = |base: Value, extra: Value| {
        let mut map = base.as_object().unwrap().clone();
        map.extend(extra.as_object().unwrap().clone());
        map.extend(timed.as_object().unwrap().clone());
        Value::Object(map)
    };
    for calendar in [own(1), theirs(11, CAROL)] {
        let target =
            json!({"accountId": ACCOUNT, "id": id, "changeKey": key, "calendar": calendar});
        let cases = [
            (
                "meetingCreate",
                with(
                    json!({"accountId": ACCOUNT, "calendar": calendar}),
                    json!({"requiredAttendees": [BOB], "sendInvitations": true}),
                ),
            ),
            (
                "meetingUpdate",
                merge(&target, json!({"title": "x", "sendUpdates": true})),
            ),
            (
                "meetingCancel",
                merge(&target, json!({"sendCancellations": true})),
            ),
            ("meetingRemove", target.clone()),
            (
                "calendarRespond",
                merge(&target, json!({"response": "accept", "send": true})),
            ),
            (
                "calendarUpdate",
                merge(
                    &target,
                    json!({"title": "x", "scope": "series", "startClock": "10:15", "durationMinutes": 30}),
                ),
            ),
            ("calendarDelete", merge(&target, json!({"scope": "series"}))),
        ];
        for (method, params) in cases {
            let answer = rpc(method, params.clone()).await;
            assert_eq!(answer.err(), LOCKED, "{method} {params}");
        }
        // Nothing is deleted in another mailbox's calendar, one event or all of them.
        if calendar.contains(':') {
            for scope in [json!(null), json!("occurrence")] {
                let mut params = target.clone();
                if !scope.is_null() {
                    params["scope"] = scope;
                }
                let answer = rpc("calendarDelete", params.clone()).await;
                assert_eq!(answer.err(), LOCKED, "{params}");
            }
        }
        // The word that people are mailed is still judged first.
        let unconfirmed = with(
            json!({"accountId": ACCOUNT, "calendar": calendar}),
            json!({"requiredAttendees": [BOB]}),
        );
        let answer = rpc("meetingCreate", unconfirmed).await;
        assert_eq!(answer.err(), Some("invalid_params"));
    }
}

fn merge(base: &Value, extra: Value) -> Value {
    let mut map = base.as_object().unwrap().clone();
    map.extend(extra.as_object().unwrap().clone());
    Value::Object(map)
}

#[tokio::test]
async fn each_calendar_is_read_by_its_reference_and_locked_by_its_own_rules_with_what_is_private_masked()
 {
    if isolated() {
        return;
    }
    let mut private = at(5, "Salary review", 11).with("<t:Sensitivity>Private</t:Sensitivity>");
    private.location = "Clinic on Example Street".into();
    // Bob lets the user read his calendar and change none of it; an item that names no rights grants none.
    let mut bobs = at(3, "Bob's", 10);
    bobs.rights = Some((false, false));
    let mut weekly =
        at(7, "Carol's weekly", 11).with("<t:CalendarItemType>Occurrence</t:CalendarItemType>");
    weekly.unsaid = true;
    let items = vec![
        Cal::new(1, "Mine", "2026-10-05T09:00:00Z", "2026-10-05T10:00:00Z"),
        at(2, "Team's", 1),
        bobs,
        at(4, "Carol's", 11),
        private,
        at(6, "Carol's meeting", 11).with(INVITED),
        weekly,
        Cal {
            answer: Some("Decline"),
            ..at(8, "Carol's declined", 11).with(INVITED)
        },
    ];
    let (_w, shared) = mailbox_world(items).await;
    let titles = |answer: &Value| {
        let events = answer["events"].as_array().unwrap();
        let said = events
            .iter()
            .map(|e| format!("{} {}", e["title"], e["lock"]));
        said.collect::<Vec<_>>()
    };
    let mine = rpc("calendarEvents", october(None)).await.unwrap();
    assert_eq!(titles(&mine), [r#""Mine" """#]);
    let team = rpc("calendarEvents", october(Some(own(1)))).await.unwrap();
    assert_eq!(titles(&team), [r#""Team's" """#]);
    let bob = rpc("calendarEvents", october(Some(theirs(10, BOB))))
        .await
        .unwrap();
    assert_eq!(
        titles(&bob),
        [r#""Bob's" "calendar""#],
        "a calendar the user may only read"
    );
    let carol = rpc("calendarEvents", october(Some(theirs(11, CAROL))))
        .await
        .unwrap();
    assert_eq!(
        titles(&carol),
        [
            r#""Carol's" """#,
            r#""Private" "private""#,
            r#""Carol's meeting" "meeting""#,
            r#""Carol's weekly" "calendar""#,
            r#""Carol's declined" "meeting""#,
        ]
    );
    // Masked before the answer leaves, as in the default calendar.
    let text = carol.to_string();
    assert!(!text.contains("Salary") && !text.contains("Clinic"));
    // A calendar the user may not read, or that is gone, is an error and not an empty month.
    shared.lock().unwrap().folders[5].rights = Some([false, false, false, false]);
    let denied = rpc("calendarEvents", october(Some(theirs(10, BOB)))).await;
    assert_eq!(denied.err(), Some("exchange_access_denied"));
    let gone = rpc("calendarEvents", october(Some(own(99)))).await;
    assert_eq!(gone.err(), Some("exchange_folder_unavailable"));
    // The detail of an event there is the item's own: no answer, no removal, no series, its own lock.
    let detail = |n: u16, calendar: String| json!({"accountId": ACCOUNT, "id": cal_id(n), "calendar": calendar});
    let meeting = rpc("calendarEvent", detail(6, theirs(11, CAROL)))
        .await
        .unwrap();
    let said =
        ["canRespond", "canRemove", "canRemoveSeries", "editable"].map(|k| meeting[k].clone());
    assert_eq!(json!(said), json!([false, false, false, false]));
    assert_eq!(
        (&meeting["lock"], &meeting["series"]),
        (&json!("meeting"), &Value::Null)
    );
    // A meeting declined there is not removed from here either: removals are the default calendar's.
    let declined = rpc("calendarEvent", detail(8, theirs(11, CAROL)))
        .await
        .unwrap();
    let said = ["canRespond", "canRemove", "editable"].map(|k| declined[k].clone());
    assert_eq!(json!(said), json!([false, false, false]));
    let weekly = rpc("calendarEvent", detail(7, theirs(11, CAROL)))
        .await
        .unwrap();
    assert_eq!(
        (&weekly["series"], &weekly["editable"]),
        (&Value::Null, &json!(false))
    );
    assert_eq!(
        weekly["lock"], "calendar",
        "no rights named for the item, none granted"
    );
    let hidden = rpc("calendarEvent", detail(5, theirs(11, CAROL)))
        .await
        .unwrap();
    assert_eq!(
        (&hidden["title"], &hidden["location"], &hidden["lock"]),
        (&json!("Private"), &json!(""), &json!("private"))
    );
    // Read for a calendar it is not in, an event is locked.
    let elsewhere = rpc("calendarEvent", detail(2, theirs(11, CAROL)))
        .await
        .unwrap();
    assert_eq!(
        (&elsewhere["editable"], &elsewhere["lock"]),
        (&json!(false), &json!("unknown"))
    );
    let inbox = shared
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|body| body.contains("IPM.Schedule.Meeting.Canceled"));
    assert!(
        !inbox,
        "the Inbox says nothing of another calendar's meetings"
    );
}

#[tokio::test]
async fn an_appointment_is_made_changed_and_deleted_in_the_calendar_named_and_nowhere_else() {
    if isolated() {
        return;
    }
    let mut writable = at(1, "Carol's", 11);
    writable.rights = Some((true, true));
    let (_w, shared) = mailbox_world(vec![writable]).await;
    let new = |calendar: String| {
        json!({"accountId": ACCOUNT, "title": "Lunch", "allDay": false,
        "startMs": ms("2026-10-06T11:00:00Z"), "endMs": ms("2026-10-06T12:00:00Z"), "calendar": calendar})
    };
    let made = rpc("calendarCreate", new(own(1))).await.unwrap();
    let team = rpc("calendarEvents", october(Some(own(1)))).await.unwrap();
    assert_eq!(team["events"][0]["id"], made["id"]);
    let mine = rpc("calendarEvents", october(None)).await.unwrap();
    assert!(mine["events"].as_array().unwrap().is_empty());
    let refused = rpc("calendarCreate", new(theirs(10, BOB))).await;
    assert_eq!(refused.err(), LOCKED, "a calendar the user may only read");
    // An item of Carol's, by the rights the server gives it.
    let carol = theirs(11, CAROL);
    let change = json!({"accountId": ACCOUNT, "id": cal_id(1), "changeKey": "CK1v1", "title": "Renamed", "calendar": carol});
    let renamed = rpc("calendarUpdate", change).await.unwrap();
    assert_eq!(renamed["changeKey"], "CK1v2");
    // Named without its calendar it is not the default calendar's to change.
    let unnamed =
        json!({"accountId": ACCOUNT, "id": cal_id(1), "changeKey": "CK1v2", "title": "x"});
    assert_eq!(rpc("calendarUpdate", unnamed).await.err(), LOCKED);
    // Deleting in another mailbox is not offered: where the item would go is not documented.
    let delete =
        json!({"accountId": ACCOUNT, "id": cal_id(1), "changeKey": "CK1v2", "calendar": carol});
    assert_eq!(rpc("calendarDelete", delete).await.err(), LOCKED);
    // In the owner's own other calendar it is.
    let delete = json!({"accountId": ACCOUNT, "id": made["id"], "changeKey": made["changeKey"], "calendar": own(1)});
    assert_eq!(
        rpc("calendarDelete", delete).await.unwrap(),
        json!({"deleted": true})
    );
    let store = shared.lock().unwrap();
    let deletes = store
        .requests
        .iter()
        .filter(|b| b.contains("<m:DeleteItem"))
        .count();
    assert_eq!(deletes, 1, "nothing was deleted in Carol's calendar");
    let creates: Vec<String> = store
        .requests
        .iter()
        .filter(|b| b.contains("CreateItem"))
        .cloned()
        .collect();
    assert_eq!(creates.len(), 1, "nothing was made where it was refused");
    let saved = operation(&creates[0]);
    let folder = saved.at(&["SavedItemFolderId", "FolderId"]).unwrap();
    assert_eq!(folder.attr("Id"), Some(folder_id(1).as_str()));
}
