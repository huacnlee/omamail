//! An event's detail, answers to invitations and reminders, against the scripted calendar of
//! `calendar`: what is read, what is refused before anything is sent, and what an answer proves.

use super::super::{Answer, Appointment, Cancelled, Client, Edit, Reminder, When};
use super::calendar::{Cal, cal_id, calendar, ews, october, operation, refused, secs};
use super::fake::{Out, Soap, ok, response};

const NOT_INVITATION: Option<&str> = Some("exchange_calendar_not_invitation");

/// What makes an item an invitation from Bob to the owner, Ada: ahead of the defaults it overrides.
pub const INVITED: &str = concat!(
    "<t:IsMeeting>true</t:IsMeeting><t:MyResponseType>NoResponseReceived</t:MyResponseType>",
    "<t:AppointmentState>3</t:AppointmentState><t:IsOrganizer>false</t:IsOrganizer>",
    "<t:ResponseObjects><t:AcceptItem/><t:TentativelyAcceptItem/><t:DeclineItem/></t:ResponseObjects>",
    r#"<t:Body BodyType="HTML">&lt;p&gt;Agenda&lt;/p&gt;</t:Body>"#,
    "<t:Organizer><t:Mailbox><t:Name>Bob</t:Name><t:EmailAddress>bob@example.org</t:EmailAddress></t:Mailbox></t:Organizer>",
    "<t:RequiredAttendees><t:Attendee><t:Mailbox><t:EmailAddress>ada@example.org</t:EmailAddress></t:Mailbox></t:Attendee></t:RequiredAttendees>",
);

/// Item `n` answered at `key`: what became of a removal, or the code it failed with.
async fn answer(
    client: &mut Client,
    n: u16,
    key: &str,
    reply: Answer,
    send: bool,
    remove: bool,
) -> Result<Option<bool>, &'static str> {
    let done = client.respond(&cal_id(n), key, reply, send, remove).await?;
    Ok(done.removed)
}

fn invitation(n: u16) -> Cal {
    october(n, 5).with(INVITED)
}

/// The operations the server was asked for, the folder lookup aside.
fn ops(store: &super::calendar::Shared) -> Vec<String> {
    let store = store.lock().unwrap();
    store
        .requests
        .iter()
        .map(|body| operation(body).name)
        .collect()
}

#[tokio::test]
async fn an_invitation_is_read_whole_and_answered_on_a_fresh_read_naming_the_version_drawn() {
    let (_fake, mut client, store) = calendar(vec![invitation(1)], |_| None).await;
    let found = client.event_detail(&cal_id(1)).await.unwrap();
    assert!(found.invitation() && found.cancellation == Cancelled::No);
    assert_eq!(found.notes, "Agenda", "an HTML body is not believed");
    let who = found.organizer.as_ref().map(|who| who.address.as_str());
    assert_eq!(who, Some("bob@example.org"));
    assert_eq!(found.attendees[0].who.address, "ada@example.org");
    let done = client
        .respond(&cal_id(1), "CK1v1", Answer::Accept, true, false)
        .await
        .unwrap();
    // The server re-created the item; the answer names it.
    let named = (done.written.id, done.written.change_key, done.removed);
    assert_eq!(named, (cal_id(2), "CK2v1".to_owned(), None));
    let read = ["GetFolder", "GetItem", "FindItem"];
    assert_eq!(
        ops(&store),
        [&read[..], &read[..], &["CreateItem"]].concat()
    );
    let saved = client
        .respond(&cal_id(2), "CK2v1", Answer::Tentative, false, false)
        .await;
    assert!(saved.is_ok());
    let store = store.lock().unwrap();
    let answers: Vec<String> = store
        .requests
        .iter()
        .map(|body| operation(body))
        .filter(|op| op.name == "CreateItem")
        .map(|op| {
            // The response object names the item and its version, and nothing else is written.
            let items = op.child("Items").unwrap();
            let reply = &items.children[0];
            let id = reply.child("ReferenceItemId").unwrap();
            assert_eq!((items.children.len(), reply.children.len()), (1, 1));
            let attrs: Vec<String> = op.attrs.iter().map(|(k, v)| format!("{k}={v}")).collect();
            let key = id.attr("ChangeKey").unwrap();
            format!("{} {} {key}", attrs.join(" "), reply.name)
        })
        .collect();
    assert_eq!(
        answers,
        [
            "MessageDisposition=SendAndSaveCopy AcceptItem CK1v1",
            "MessageDisposition=SaveOnly TentativelyAcceptItem CK2v1"
        ]
    );
}

#[tokio::test]
async fn nothing_is_answered_that_is_not_an_invitation_or_not_the_version_drawn() {
    let vetoes = [
        "<t:IsOrganizer>true</t:IsOrganizer>",
        "<t:AppointmentState>1</t:AppointmentState>",
        "<t:ResponseObjects><t:DeclineItem/></t:ResponseObjects>",
        "<t:IsCancelled>true</t:IsCancelled>",
        "<t:Sensitivity>Private</t:Sensitivity>",
        "<t:CalendarItemType>RecurringMaster</t:CalendarItemType>",
        "<t:MyResponseType>Unknown</t:MyResponseType>",
        "<t:MyResponseType>Organizer</t:MyResponseType>",
        "<t:IsMeeting>false</t:IsMeeting>",
    ];
    let mut items = vec![october(1, 5)];
    for (n, veto) in (2..).zip(vetoes) {
        items.push(october(n, 5).with(veto).with(INVITED));
    }
    items.push(invitation(20));
    // One whose version the server does not say.
    let keyless = |soap: &Soap| {
        let item = invitation(30)
            .xml(true, true)
            .replace(r#" ChangeKey="CK30v1""#, "");
        let answer = response(
            "GetItem",
            &[ok("GetItem", &format!("<m:Items>{item}</m:Items>"))],
        );
        (soap.op == "GetItem" && soap.body.contains(&ews(30))).then_some(Out::Xml(answer))
    };
    let (fake, mut client, _) = calendar(items, keyless).await;
    for n in 1..=10 {
        let key = format!("CK{n}v1");
        let tried = answer(&mut client, n, &key, Answer::Accept, true, false);
        assert_eq!(tried.await.err(), NOT_INVITATION, "{n}");
    }
    let stale = answer(&mut client, 20, "CK20v0", Answer::Accept, true, false);
    assert_eq!(stale.await.err(), Some("exchange_calendar_conflict"));
    let unknown = answer(&mut client, 30, "CK30v1", Answer::Accept, true, false);
    assert_eq!(unknown.await.err(), Some("exchange_invalid_response"));
    assert_eq!(fake.log.count("CreateItem"), 0);
    // An invitation the login reaches outside the default calendar is not answered from here.
    let elsewhere = october(40, 5)
        .with(r#"<t:ParentFolderId Id="elsewhere"/>"#)
        .with(INVITED);
    let (fake, mut client, _) = calendar(vec![elsewhere], |_| None).await;
    let found = client.event_detail(&cal_id(40)).await.unwrap();
    assert!(found.elsewhere && found.incoming() && !found.invitation());
    let outside = answer(&mut client, 40, "CK40v1", Answer::Accept, true, false);
    assert_eq!(outside.await.err(), Some("exchange_calendar_locked"));
    assert_eq!(fake.log.count("CreateItem"), 0);
}

#[tokio::test]
async fn a_meeting_its_organizer_cancelled_is_never_answered() {
    let (fake, mut client, store) = calendar(vec![invitation(1), invitation(2)], |_| None).await;
    store.lock().unwrap().cancelled = vec![("uid-1@example.org".into(), None)];
    let found = client.event_detail(&cal_id(1)).await.unwrap();
    assert!(found.cancellation == Cancelled::Yes && !found.invitation());
    let refused_answer = answer(&mut client, 1, "CK1v1", Answer::Accept, true, false);
    assert_eq!(refused_answer.await.err(), NOT_INVITATION);
    assert_eq!(fake.log.count("CreateItem"), 0);
    // Another meeting's cancellation is not this one's.
    let other = answer(&mut client, 2, "CK2v1", Answer::Accept, true, false);
    assert!(other.await.is_ok());
    // One the server says is out of date (the organizer took the owner off and put them back) cancels
    // nothing: the meeting is shown as it is and answered.
    store.lock().unwrap().stale = vec!["uid-1@example.org".into()];
    let found = client.event_detail(&cal_id(1)).await.unwrap();
    assert!(found.cancellation == Cancelled::No && found.invitation());
    let live = answer(&mut client, 1, "CK1v1", Answer::Accept, true, false);
    assert!(live.await.is_ok());
    store.lock().unwrap().stale.clear();
    // One cancelled event of a series is that event alone.
    let event = |n: u16, day: u32| {
        Cal {
        uid: Some(7),
        ..october(n, day)
            .with(&format!(
                "<t:CalendarItemType>Occurrence</t:CalendarItemType><t:RecurrenceId>2026-10-{day:02}T09:00:00Z</t:RecurrenceId>"
            ))
            .with(INVITED)
    }
    };
    // An event that does not say where it sits is not answered while one of its meeting is cancelled,
    // and neither is an item of the meeting at the cancelled place whatever the server calls it.
    let unplaced = Cal {
        uid: Some(7),
        ..october(3, 19)
            .with("<t:CalendarItemType>Occurrence</t:CalendarItemType>")
            .with(INVITED)
    };
    let single = Cal {
        uid: Some(7),
        ..october(4, 12)
            .with("<t:OriginalStart>2026-10-12T09:00:00Z</t:OriginalStart>")
            .with(INVITED)
    };
    let events = vec![event(1, 5), event(2, 12), unplaced, single];
    let (fake, mut client, store) = calendar(events, |_| None).await;
    let named = (
        "uid-7@example.org".into(),
        Some("2026-10-12T09:00:00Z".into()),
    );
    store.lock().unwrap().cancelled = vec![named];
    let mut said = Vec::new();
    for n in 1..=4 {
        said.push(client.event_detail(&cal_id(n)).await.unwrap().cancellation);
    }
    let (yes, no, unplaced) = (Cancelled::Yes, Cancelled::No, Cancelled::Unplaced);
    assert_eq!(said, [no, yes, unplaced, yes], "a doubt is said as one");
    let cancelled = answer(&mut client, 2, "CK2v1", Answer::Accept, true, false);
    assert_eq!(cancelled.await.err(), NOT_INVITATION);
    let doubtful = answer(&mut client, 3, "CK3v1", Answer::Accept, true, false);
    assert_eq!(doubtful.await.err(), NOT_INVITATION);
    let at_the_place = answer(&mut client, 4, "CK4v1", Answer::Accept, true, false);
    assert_eq!(at_the_place.await.err(), NOT_INVITATION);
    assert_eq!(fake.log.count("CreateItem"), 0);
    let kept = answer(&mut client, 1, "CK1v1", Answer::Accept, true, false);
    assert!(kept.await.is_ok());
    // An Inbox that cannot be read: the detail goes without, an answer is not sent.
    let blind = |soap: &Soap| {
        let inbox = soap.op == "FindItem" && soap.body.contains("Canceled");
        inbox.then(|| refused("FindItem", "ErrorAccessDenied"))
    };
    let (fake, mut client, _) = calendar(vec![invitation(1)], blind).await;
    let found = client.event_detail(&cal_id(1)).await.unwrap();
    assert_eq!(found.cancellation, Cancelled::No);
    let tried = answer(&mut client, 1, "CK1v1", Answer::Accept, true, false);
    assert_eq!(tried.await.err(), Some("exchange_access_denied"));
    assert_eq!(fake.log.count("CreateItem"), 0);
}

#[tokio::test]
async fn a_sent_decline_can_take_the_meeting_off_the_calendar_and_that_never_fails_the_answer() {
    // The server took it off: nothing to delete.
    let (fake, mut client, _) = calendar(vec![invitation(1)], |_| None).await;
    let done = answer(&mut client, 1, "CK1v1", Answer::Decline, true, true);
    assert_eq!(done.await.unwrap(), Some(true));
    assert_eq!(fake.log.count("DeleteItem"), 0);
    // The server left it, declined: deleted into Deleted Items, nobody told.
    let (fake, mut client, store) = calendar(vec![invitation(1)], |_| None).await;
    store.lock().unwrap().keeps_declined = true;
    let done = answer(&mut client, 1, "CK1v1", Answer::Decline, true, true);
    assert_eq!(done.await.unwrap(), Some(true));
    let delete = {
        let store = store.lock().unwrap();
        assert!(store.items.is_empty());
        operation(store.requests.last().unwrap())
    };
    assert_eq!(delete.attr("SendMeetingCancellations"), Some("SendToNone"));
    assert_eq!(delete.attr("DeleteType"), Some("MoveToDeletedItems"));
    assert_eq!(fake.log.count("DeleteItem"), 1);
    // A delete the server refuses is said, and the decline still stands.
    let (_fake, mut client, store) = calendar(vec![invitation(1)], |soap: &Soap| {
        (soap.op == "DeleteItem").then(|| refused("DeleteItem", "ErrorAccessDenied"))
    })
    .await;
    store.lock().unwrap().keeps_declined = true;
    let done = answer(&mut client, 1, "CK1v1", Answer::Decline, true, true);
    assert_eq!(done.await.unwrap(), Some(false));
    // A meeting the server still shows undeclined is not the owner's to delete.
    let unrecorded = |soap: &Soap| {
        let empty = response("CreateItem", &[ok("CreateItem", "<m:Items/>")]);
        (soap.op == "CreateItem").then_some(Out::Xml(empty))
    };
    let (fake, mut client, _) = calendar(vec![invitation(1)], unrecorded).await;
    let done = answer(&mut client, 1, "CK1v1", Answer::Decline, true, true);
    assert_eq!(done.await.unwrap(), Some(false));
    assert_eq!(fake.log.count("DeleteItem"), 0);
    // Only a sent decline of a single meeting: one event of a series is left where it is.
    let one = october(2, 5)
        .with("<t:CalendarItemType>Occurrence</t:CalendarItemType>")
        .with(INVITED);
    let (fake, mut client, store) = calendar(vec![one], |_| None).await;
    let series = answer(&mut client, 2, "CK2v1", Answer::Decline, true, true);
    assert_eq!(series.await.err(), Some("exchange_calendar_locked"));
    for (reply, send) in [(Answer::Accept, true), (Answer::Decline, false)] {
        let tried = answer(&mut client, 2, "CK2v1", reply, send, true);
        assert_eq!(tried.await.err(), Some("invalid_params"));
    }
    assert_eq!(fake.log.count("CreateItem"), 0);
    assert_eq!(
        ops(&store),
        ["GetFolder", "GetItem", "FindItem"],
        "refused before a read"
    );
}

#[tokio::test]
async fn a_failed_answer_says_what_it_proves_and_is_never_sent_twice() {
    let unknown = "exchange_calendar_unconfirmed";
    type Case = (fn() -> Out, &'static str);
    let cases: [Case; 4] = [
        (|| Out::Drop, unknown),
        (|| Out::Status(503, Vec::new()), unknown),
        (|| refused("CreateItem", "ErrorSomethingNew"), unknown),
        (
            || refused("CreateItem", "ErrorItemNotFound"),
            "exchange_message_not_found",
        ),
    ];
    for (out, code) in cases {
        let (fake, mut client, _) = calendar(vec![invitation(1)], move |soap: &Soap| {
            (soap.op == "CreateItem").then(out)
        })
        .await;
        let sent = answer(&mut client, 1, "CK1v1", Answer::Accept, true, false);
        assert_eq!(sent.await.err(), Some(code));
        assert_eq!(fake.log.count("CreateItem"), 1, "{code}");
    }
}

#[tokio::test]
async fn a_server_that_refuses_the_2013_properties_is_asked_once_without_them() {
    let old = |soap: &Soap| {
        let newer = soap.op == "GetItem" && soap.body.contains("calendar:IsOrganizer");
        newer.then(|| refused("GetItem", "ErrorInvalidPropertyRequest"))
    };
    let (fake, mut client, store) = calendar(vec![invitation(1)], old).await;
    let found = client.event_detail(&cal_id(1)).await.unwrap();
    // Read so, it is still the invitation it was, but no answer is offered that would always fail.
    assert!(found.reduced && found.incoming() && !found.invitation());
    assert_eq!(fake.log.count("GetItem"), 2);
    let second = store.lock().unwrap().requests[1].clone();
    assert!(!second.contains("JoinOnlineMeetingUrl") && second.contains("item:Body"));
    // An answer never takes the reduced read: it fails with the first read's code, sending nothing.
    let refused_answer = answer(&mut client, 1, "CK1v1", Answer::Accept, true, false);
    assert_eq!(refused_answer.await.err(), Some("exchange_server_error"));
    assert_eq!(
        (fake.log.count("GetItem"), fake.log.count("CreateItem")),
        (3, 0)
    );
    // A message is no event: there is nothing to show.
    let message = |soap: &Soap| {
        let item = format!(
            r#"<m:Items><t:Message><t:ItemId Id="{}"/></t:Message></m:Items>"#,
            ews(9)
        );
        (soap.op == "GetItem").then(|| Out::Xml(response("GetItem", &[ok("GetItem", &item)])))
    };
    let (_fake, mut client, _) = calendar(Vec::new(), message).await;
    let found = client.event_detail(&cal_id(9)).await;
    assert_eq!(found.err(), Some("exchange_message_not_found"));
}

#[tokio::test]
async fn a_reminder_is_written_when_it_is_asked_for_and_only_when_it_changes() {
    let (fake, mut client, store) = calendar(Vec::new(), |_| None).await;
    let when = When::Timed {
        start_ms: secs("2026-10-05T07:00:00Z") * 1000,
        end_ms: secs("2026-10-05T07:30:00Z") * 1000,
    };
    let item = Appointment {
        title: "Dentist".into(),
        location: String::new(),
        notes: None,
        reminder: Some(15),
        when,
    };
    let made = client.create_appointment(&item, "UTC").await.unwrap();
    assert_eq!(store.lock().unwrap().items[0].reminder, Some(15));
    let mut key = made.change_key;
    let mut fields = Vec::new();
    for reminder in [
        Reminder::Minutes(15),
        Reminder::Minutes(30),
        Reminder::Keep,
        Reminder::Off,
        Reminder::Off,
    ] {
        let edit = Edit {
            title: None,
            location: None,
            reminder,
            when: None,
        };
        key = client
            .change_appointment(&made.id, &key, &edit, "UTC")
            .await
            .unwrap()
            .change_key;
        let store = store.lock().unwrap();
        let last = operation(store.requests.last().unwrap());
        let sets = last
            .at(&["ItemChanges", "ItemChange", "Updates"])
            .map(|updates| {
                let uri = |set: &super::super::xml::Node| {
                    set.child("FieldURI")
                        .unwrap()
                        .attr("FieldURI")
                        .unwrap()
                        .to_owned()
                };
                updates
                    .children
                    .iter()
                    .map(uri)
                    .collect::<Vec<_>>()
                    .join(" ")
            });
        fields.push(sets.unwrap_or_default());
    }
    assert_eq!(
        fields,
        [
            "",
            "item:ReminderIsSet item:ReminderMinutesBeforeStart",
            "",
            "item:ReminderIsSet",
            ""
        ]
    );
    assert_eq!(fake.log.count("UpdateItem"), 2);
    assert_eq!(store.lock().unwrap().items[0].reminder, None);
}
