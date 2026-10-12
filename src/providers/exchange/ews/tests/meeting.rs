//! Meetings with other people against the scripted calendar of `calendar`: whom each request mails,
//! what is refused before anything is sent, and what a failure proves.

use super::super::xml::Node;
use super::super::{Appointment, Client, Edit, MeetingEdit, Reminder, Scope, When};
use super::calendar::{Cal, Shared, cal_id, calendar, ews, october, operation, refused, secs};
use super::detail::INVITED;
use super::fake::{Out, Soap};
use crate::providers::exchange::guests::Guests;

const OWNER: &str = "ada@example.org";
const LOCKED: Option<&str> = Some("exchange_calendar_locked");

fn person(address: &str) -> String {
    format!(
        "<t:Attendee><t:Mailbox><t:EmailAddress>{address}</t:EmailAddress></t:Mailbox></t:Attendee>"
    )
}

/// A meeting the owner, Ada, sent to Bob and (optionally) Cy, the server listing Ada on it too.
fn mine(n: u16) -> Cal {
    october(n, 5).with(&format!(
        concat!(
            "<t:IsMeeting>true</t:IsMeeting><t:AppointmentState>1</t:AppointmentState>",
            "<t:IsOrganizer>true</t:IsOrganizer><t:ResponseObjects><t:CancelCalendarItem/></t:ResponseObjects>",
            "<t:RequiredAttendees>{}{}</t:RequiredAttendees><t:OptionalAttendees>{}</t:OptionalAttendees>"
        ),
        person("Ada@example.org"),
        person("bob@example.org"),
        person("cy@example.org")
    ))
}

fn who(list: &[&str]) -> Vec<String> {
    list.iter().map(|a| (*a).to_owned()).collect()
}

fn edit(title: Option<&str>, required: Option<&[&str]>, optional: Option<&[&str]>) -> MeetingEdit {
    MeetingEdit {
        edit: Edit {
            title: title.map(str::to_owned),
            location: None,
            reminder: Reminder::Keep,
            when: None,
        },
        required: required.map(who),
        optional: optional.map(who),
    }
}

fn lunch() -> Appointment {
    Appointment {
        recurrence: None,
        title: "Lunch".into(),
        location: "Canteen".into(),
        notes: None,
        reminder: None,
        when: When::Timed {
            start_ms: secs("2026-10-05T11:00:00Z") * 1000,
            end_ms: secs("2026-10-05T12:00:00Z") * 1000,
        },
    }
}

/// The last request that was not a read.
fn written(store: &Shared) -> Node {
    let store = store.lock().unwrap();
    let mut writes = store.requests.iter().map(|body| operation(body));
    let reads = ["GetFolder", "GetItem", "FindItem"];
    writes
        .rfind(|op| !reads.contains(&op.name.as_str()))
        .unwrap()
}

fn listed(node: &Node, list: &str) -> Vec<String> {
    node.child(list).map_or_else(Vec::new, |list| {
        let people = list.children("Attendee").into_iter();
        people
            .map(|a| a.text_at(&["Mailbox", "EmailAddress"]).unwrap().to_owned())
            .collect()
    })
}

fn writes(fake: &super::fake::Fake) -> usize {
    ["CreateItem", "UpdateItem", "DeleteItem"]
        .iter()
        .map(|op| fake.log.count(op))
        .sum()
}

#[tokio::test]
async fn a_meeting_is_made_with_its_people_invited_once_and_nobody_is_no_meeting() {
    let (fake, mut client, store) = calendar(Vec::new(), |_| None).await;
    let guests = Guests {
        required: who(&["bob@example.org"]),
        optional: who(&["cy@example.org"]),
    };
    let made = client
        .create_meeting(&lunch(), &guests, "UTC")
        .await
        .unwrap();
    assert_eq!((made.id, made.change_key), (cal_id(1), "CK1v1".to_owned()));
    let create = written(&store);
    let invitations = create.attr("SendMeetingInvitations");
    assert_eq!(invitations, Some("SendToAllAndSaveCopy"));
    let item = create.at(&["Items", "CalendarItem"]).unwrap();
    let people = (
        listed(item, "RequiredAttendees"),
        listed(item, "OptionalAttendees"),
    );
    assert_eq!(people, (guests.required.clone(), guests.optional.clone()));
    let nobody = client
        .create_meeting(&lunch(), &Guests::default(), "UTC")
        .await;
    assert_eq!(nobody.err(), Some("invalid_params"));
    assert_eq!(fake.log.count("CreateItem"), 1);
    // An answer that was lost may have come after everybody was mailed: unconfirmed, sent once.
    let lost = |soap: &Soap| (soap.op == "CreateItem").then_some(Out::Drop);
    let (fake, mut client, _) = calendar(Vec::new(), lost).await;
    let made = client.create_meeting(&lunch(), &guests, "UTC").await;
    assert_eq!(made.err(), Some("exchange_calendar_unconfirmed"));
    assert_eq!(fake.log.count("CreateItem"), 1);
}

/// A change of the meeting at `key`, what it wrote, and the key it left.
async fn change(
    client: &mut Client,
    store: &Shared,
    key: &str,
    wanted: MeetingEdit,
) -> Result<(bool, String, Node), &'static str> {
    let done = client
        .change_meeting(&cal_id(1), key, &wanted, OWNER, "UTC", None, None)
        .await?;
    Ok((done.sent, done.written.change_key, written(store)))
}

#[tokio::test]
async fn a_change_tells_everybody_and_writes_a_list_only_whole_only_when_it_changes() {
    let (fake, mut client, store) = calendar(vec![mine(1)], |_| None).await;
    let fields = |update: &Node| -> Vec<String> {
        let updates = update
            .at(&["ItemChanges", "ItemChange", "Updates"])
            .unwrap();
        let uri = |set: &Node| {
            format!(
                "{} {}",
                set.name,
                set.child("FieldURI").unwrap().attr("FieldURI").unwrap()
            )
        };
        updates.children.iter().map(uri).collect()
    };
    // A title alone: the people are left as they are, and told.
    let (sent, key, update) = change(
        &mut client,
        &store,
        "CK1v1",
        edit(Some("Lunch, moved"), None, None),
    )
    .await
    .unwrap();
    assert!(sent && key == "CK1v2");
    let told = update.attr("SendMeetingInvitationsOrCancellations");
    assert_eq!(
        (told, update.attr("ConflictResolution")),
        (Some("SendToAllAndSaveCopy"), Some("NeverOverwrite"))
    );
    assert_eq!(fields(&update), ["SetItemField item:Subject"]);
    // The same people in another case: nothing to send.
    let same = edit(None, Some(&["BOB@example.org"]), Some(&["cy@example.org"]));
    let (sent, key, _) = change(&mut client, &store, "CK1v2", same).await.unwrap();
    assert!(!sent && key == "CK1v2");
    assert_eq!(fake.log.count("UpdateItem"), 1);
    // One list changes: it is written whole, the owner the server listed carried over.
    let added = edit(
        None,
        Some(&["bob@example.org", "dee@example.org"]),
        Some(&["cy@example.org"]),
    );
    let (_, key, update) = change(&mut client, &store, "CK1v2", added).await.unwrap();
    assert_eq!(fields(&update), ["SetItemField calendar:RequiredAttendees"]);
    let set = update
        .at(&[
            "ItemChanges",
            "ItemChange",
            "Updates",
            "SetItemField",
            "CalendarItem",
        ])
        .unwrap();
    assert_eq!(
        listed(set, "RequiredAttendees"),
        who(&["bob@example.org", "dee@example.org", OWNER])
    );
    // A list emptied is deleted; whoever was on it is told by the server.
    let (_, _, update) = change(&mut client, &store, &key, edit(None, None, Some(&[])))
        .await
        .unwrap();
    assert_eq!(
        fields(&update),
        ["DeleteItemField calendar:OptionalAttendees"]
    );
    // The owner's own reminder alone tells nobody, as Outlook's does not.
    let mut own = edit(None, None, None);
    own.edit.reminder = Reminder::Minutes(15);
    let (sent, _, update) = change(&mut client, &store, "CK1v4", own).await.unwrap();
    assert!(!sent, "nobody was told");
    let quiet = update.attr("SendMeetingInvitationsOrCancellations");
    assert_eq!(quiet, Some("SendToNone"));
    let set = [
        "SetItemField item:ReminderIsSet",
        "SetItemField item:ReminderMinutesBeforeStart",
    ];
    assert_eq!(fields(&update), set);
    // The owner is nobody to invite, and nobody left is a cancellation, not a change: refused unsent.
    let before = fake.log.count("UpdateItem");
    for wanted in [
        edit(None, Some(&[OWNER]), None),
        edit(None, Some(&[]), Some(&[])),
    ] {
        let refused = client
            .change_meeting(&cal_id(1), "CK1v4", &wanted, OWNER, "UTC", None, None)
            .await;
        assert_eq!(refused.err(), Some("invalid_params"));
    }
    let alone = october(2, 5).with(&format!(
        "<t:IsMeeting>true</t:IsMeeting><t:RequiredAttendees>{}</t:RequiredAttendees>",
        person("bob@example.org")
    ));
    store.lock().unwrap().items.push(alone);
    let emptied = client
        .change_meeting(
            &cal_id(2),
            "CK2v1",
            &edit(None, Some(&[]), None),
            OWNER,
            "UTC",
            None,
            None,
        )
        .await;
    assert_eq!(emptied.err(), Some("invalid_params"));
    assert_eq!(fake.log.count("UpdateItem"), before);
}

#[tokio::test]
async fn nothing_the_owner_does_not_organise_whole_is_changed_or_cancelled() {
    let room = format!("<t:Resources>{}</t:Resources>", person("room@example.org"));
    let nameless = "<t:RequiredAttendees><t:Attendee><t:Mailbox><t:Name>Dee</t:Name></t:Mailbox></t:Attendee></t:RequiredAttendees>";
    // The owner alone: nobody else to tell, so no meeting the owner organises with guests.
    let alone = format!(
        "<t:RequiredAttendees>{}</t:RequiredAttendees><t:OptionalAttendees/>",
        person(OWNER)
    );
    let vetoes = [
        "<t:AppointmentState>3</t:AppointmentState>",
        "<t:IsOrganizer>false</t:IsOrganizer>",
        "<t:ResponseObjects><t:AcceptItem/></t:ResponseObjects>",
        "<t:IsCancelled>true</t:IsCancelled>",
        "<t:Sensitivity>Private</t:Sensitivity>",
        "<t:CalendarItemType>Occurrence</t:CalendarItemType>",
        "<t:RequiredAttendees/><t:OptionalAttendees/>",
        r#"<t:ParentFolderId Id="elsewhere"/>"#,
        &room,
        // Somebody whose address the server did not give: a change mails them and the question could
        // not name them.
        nameless,
        &alone,
    ];
    let mut items: Vec<Cal> = (1..)
        .zip(vetoes)
        .map(|(n, veto)| Cal {
            extra: veto.to_owned() + &mine(n).extra,
            ..mine(n)
        })
        .collect();
    items.push(october(20, 5).with(INVITED));
    items.push(october(21, 5));
    items.push(mine(30));
    let (fake, mut client, _) = calendar(items, |_| None).await;
    for n in (1..=11).chain([20, 21]) {
        let key = format!("CK{n}v1");
        let changed = client
            .change_meeting(
                &cal_id(n),
                &key,
                &edit(Some("x"), None, None),
                OWNER,
                "UTC",
                None,
                None,
            )
            .await;
        let cancelled = client
            .cancel_meeting(&cal_id(n), &key, None, OWNER, None, None)
            .await;
        assert_eq!((changed.err(), cancelled.err()), (LOCKED, LOCKED), "{n}");
    }
    // Another version is a conflict, never retried with the fresh one.
    let stale = client
        .change_meeting(
            &cal_id(30),
            "CK30v0",
            &edit(Some("x"), None, None),
            OWNER,
            "UTC",
            None,
            None,
        )
        .await;
    let cancelled = client
        .cancel_meeting(&cal_id(30), "CK30v0", None, OWNER, None, None)
        .await;
    let conflict = Some("exchange_calendar_conflict");
    assert_eq!((stale.err(), cancelled.err()), (conflict, conflict));
    assert_eq!(writes(&fake), 0);
}

#[tokio::test]
async fn a_cancellation_tells_everybody_once_in_the_organizers_words() {
    let (fake, mut client, store) = calendar(vec![mine(1)], |_| None).await;
    let told = client
        .cancel_meeting(&cal_id(1), "CK1v1", Some("Sorry"), OWNER, None, None)
        .await;
    assert_eq!(told, Ok(2), "the owner is not among those told");
    let create = written(&store);
    assert_eq!(create.attr("MessageDisposition"), Some("SendAndSaveCopy"));
    let cancel = create.at(&["Items", "CancelCalendarItem"]).unwrap();
    let reference = cancel.child("ReferenceItemId").unwrap();
    let named = (reference.attr("Id"), reference.attr("ChangeKey"));
    assert_eq!(named, (Some(ews(1).as_str()), Some("CK1v1")));
    assert_eq!(cancel.text_at(&["NewBodyContent"]), Some("Sorry"));
    assert!(store.lock().unwrap().items.is_empty());
    assert_eq!(fake.log.count("CreateItem"), 1);
    // Lost, or answered with a code that proves nothing: the people may have been told.
    for out in [|| Out::Drop, || refused("CreateItem", "ErrorSomethingNew")] {
        let (fake, mut client, _) = calendar(vec![mine(1)], move |soap: &Soap| {
            (soap.op == "CreateItem").then(out)
        })
        .await;
        let told = client
            .cancel_meeting(&cal_id(1), "CK1v1", None, OWNER, None, None)
            .await;
        assert_eq!(told.err(), Some("exchange_calendar_unconfirmed"));
        assert_eq!(fake.log.count("CreateItem"), 1);
    }
}

#[tokio::test]
async fn a_cancelled_or_declined_meeting_leaves_the_calendar_and_nobody_is_mailed() {
    let invited = |n: u16, extra: &str| october(n, 5).with(extra).with(INVITED);
    let items = vec![
        invited(1, ""),
        invited(2, "<t:IsCancelled>true</t:IsCancelled>"),
        invited(3, "<t:MyResponseType>Decline</t:MyResponseType>"),
        invited(4, ""),
        mine(5),
    ];
    let (fake, mut client, store) = calendar(items, |_| None).await;
    store.lock().unwrap().cancelled = vec![("uid-1@example.org".into(), None)];
    // A single meeting named as one event of a series is not what the screen drew: nothing done.
    let one = client
        .remove_meeting(&cal_id(1), "CK1v1", Some(Scope::Occurrence))
        .await;
    let writes =
        |fake: &super::fake::Fake| fake.log.count("CreateItem") + fake.log.count("DeleteItem");
    assert_eq!(
        (one.err(), writes(&fake)),
        (Some("exchange_calendar_conflict"), 0)
    );
    // Another version is a conflict, with nothing done.
    let stale = client.remove_meeting(&cal_id(1), "CK1v0", None).await;
    assert_eq!(stale.err(), Some("exchange_calendar_conflict"));
    // The cancellation is processed: a RemoveItem of the message, saved and sent to nobody.
    assert_eq!(
        client.remove_meeting(&cal_id(1), "CK1v1", None).await,
        Ok("cancelled")
    );
    let create = written(&store);
    assert_eq!(create.attr("MessageDisposition"), Some("SaveOnly"));
    let reference = create
        .at(&["Items", "RemoveItem", "ReferenceItemId"])
        .unwrap();
    assert_eq!(reference.attr("Id"), Some(ews(900).as_str()));
    // Flagged by the server, or declined: moved to Deleted Items with nobody told.
    for (n, why) in [(2, "cancelled"), (3, "declined")] {
        assert_eq!(
            client
                .remove_meeting(&cal_id(n), &format!("CK{n}v1"), None)
                .await,
            Ok(why)
        );
        let delete = written(&store);
        let attrs = (
            delete.attr("SendMeetingCancellations"),
            delete.attr("DeleteType"),
        );
        assert_eq!(attrs, (Some("SendToNone"), Some("MoveToDeletedItems")));
    }
    // An invitation nobody cancelled or declined, and the owner's own meeting, stay.
    for n in [4, 5] {
        let kept = client
            .remove_meeting(&cal_id(n), &format!("CK{n}v1"), None)
            .await;
        assert_eq!(kept.err(), Some("exchange_calendar_not_removable"), "{n}");
    }
    assert_eq!(
        (fake.log.count("CreateItem"), fake.log.count("DeleteItem")),
        (1, 2)
    );
    assert_eq!(fake.log.count("UpdateItem"), 0);
    // A RemoveItem that fails is said, and the meeting is never deleted instead: refused with a code
    // nobody has a name for, or lost, it is unconfirmed; refused by name, it is that refusal.
    type Case = (fn() -> Out, Result<&'static str, &'static str>, usize);
    let cases: [Case; 3] = [
        (
            || refused("CreateItem", "ErrorSomethingNew"),
            Err("exchange_calendar_unconfirmed"),
            0,
        ),
        (|| Out::Drop, Err("exchange_calendar_unconfirmed"), 0),
        (
            || refused("CreateItem", "ErrorAccessDenied"),
            Err("exchange_access_denied"),
            0,
        ),
    ];
    for (out, expected, deletes) in cases {
        let answer = move |soap: &Soap| (soap.op == "CreateItem").then(out);
        let (fake, mut client, store) = calendar(vec![invited(1, "")], answer).await;
        store.lock().unwrap().cancelled = vec![("uid-1@example.org".into(), None)];
        assert_eq!(
            client.remove_meeting(&cal_id(1), "CK1v1", None).await,
            expected
        );
        assert_eq!(
            (fake.log.count("CreateItem"), fake.log.count("DeleteItem")),
            (1, deletes)
        );
    }
    // Outside the default calendar nothing is removed from here.
    let elsewhere = invited(
        1,
        r#"<t:ParentFolderId Id="elsewhere"/><t:IsCancelled>true</t:IsCancelled>"#,
    );
    let (fake, mut client, _) = calendar(vec![elsewhere], |_| None).await;
    assert_eq!(
        client.remove_meeting(&cal_id(1), "CK1v1", None).await.err(),
        LOCKED
    );
    assert_eq!(writes(&fake), 0);
    // A cancellation of one event of the meeting, and an item that does not say where it sits: a
    // doubt, which removes nothing.
    let (fake, mut client, store) = calendar(vec![invited(1, "")], |_| None).await;
    let one_event = (
        "uid-1@example.org".into(),
        Some("2026-10-05T09:00:00Z".into()),
    );
    store.lock().unwrap().cancelled = vec![one_event];
    let doubt = client.remove_meeting(&cal_id(1), "CK1v1", None).await;
    assert_eq!(doubt.err(), Some("exchange_calendar_not_removable"));
    // A cancellation the server says is out of date (the organizer took the owner off and put them
    // back): the meeting goes on, and nothing is removed.
    let stale = ("uid-1@example.org".into(), None);
    {
        let mut held = store.lock().unwrap();
        (held.cancelled, held.stale) = (vec![stale], vec!["uid-1@example.org".into()]);
    }
    let live = client.remove_meeting(&cal_id(1), "CK1v1", None).await;
    assert_eq!(live.err(), Some("exchange_calendar_not_removable"));
    assert_eq!(writes(&fake), 0);
}
