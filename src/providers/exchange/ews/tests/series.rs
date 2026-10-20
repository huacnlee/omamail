//! Repeating events against the scripted calendar of `calendar`: one event or all of them written
//! through a scope and never without one, a series answered through its master, and a series its
//! organizer cancelled taken off the calendar in one call with nobody mailed.

use chrono::NaiveTime;

use super::super::xml::Node;
use super::super::{Answer, Attendee, Client, Edit, Lock, MeetingEdit, Reminder, Scope, When};
use super::calendar::{Cal, Shared, cal_id, calendar, ews, operation, refused, secs};
use super::detail::INVITED;
use super::fake::{Fake, Out, Soap, ok, response};

const VIENNA: &str = "W. Europe Standard Time";
const OWNER: &str = "ada@example.org";
const UID: &str = "uid-1@example.org";
const ONE: Option<Scope> = Some(Scope::Occurrence);
const ALL: Option<Scope> = Some(Scope::Series);
const INVALID: Option<&str> = Some("invalid_params");
const LOCKED: Option<&str> = Some("exchange_calendar_locked");
const CONFLICT: Option<&str> = Some("exchange_calendar_conflict");
const NOT_REMOVABLE: Option<&str> = Some("exchange_calendar_not_removable");

/// The start of the `i`th Monday of a weekly series from 2026-10-05, 09:00 UTC.
pub fn monday(i: u16) -> String {
    let at = secs("2026-10-05T09:00:00Z") + i64::from(i) * 7 * 86_400;
    let at = chrono::DateTime::from_timestamp(at, 0).unwrap();
    at.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// A weekly series: master 1, with its rule and zone, and `count` events from 2, `extra` on each.
pub fn weekly(count: u16, extra: &str) -> Vec<Cal> {
    let member = |n: u16, kind: &str, i: u16| {
        let (start, end) = (monday(i), monday(i).replace("T09", "T10"));
        let kind = format!(
            "<t:CalendarItemType>{kind}</t:CalendarItemType><t:IsRecurring>true</t:IsRecurring>"
        );
        // Where an event sits in its series; the master sits nowhere.
        let place = match n {
            1 => extra.to_owned(),
            _ => format!("<t:RecurrenceId>{start}</t:RecurrenceId>{extra}"),
        };
        let cal = Cal::new(n, "Backup", &start, &end).with(&kind).with(&place);
        let (uid, series) = (Some(1), Some(1));
        Cal { uid, series, ..cal }
    };
    let rule = concat!(
        "<t:Recurrence><t:WeeklyRecurrence><t:Interval>1</t:Interval>",
        "<t:DaysOfWeek>Monday</t:DaysOfWeek></t:WeeklyRecurrence><t:NumberedRecurrence>",
        "<t:StartDate>2026-10-05</t:StartDate><t:NumberOfOccurrences>3</t:NumberOfOccurrences>",
        r#"</t:NumberedRecurrence></t:Recurrence><t:StartTimeZone Id="W. Europe Standard Time"/>"#
    );
    let mut items = vec![member(1, "RecurringMaster", 0).with(rule)];
    items.extend((0..count).map(|i| member(i + 2, "Occurrence", i)));
    items
}

/// A change of the title of item `n` (and its time, if given), on a computer in Vienna: the id answered.
async fn change(
    client: &mut Client,
    n: u16,
    key: &str,
    when: Option<When>,
    scope: Option<Scope>,
) -> Result<String, &'static str> {
    let edit = Edit {
        title: Some("Moved".into()),
        location: None,
        reminder: Reminder::Keep,
        when,
    };
    let id = cal_id(n);
    let done = client.change_appointment(&id, key, &edit, VIENNA, scope);
    Ok(done.await?.id)
}

fn people(required: Option<&str>) -> MeetingEdit {
    let edit = Edit {
        title: Some("Renamed".into()),
        location: None,
        reminder: Reminder::Keep,
        when: None,
    };
    let required = required.map(|who| vec![who.to_owned()]);
    MeetingEdit {
        edit,
        required,
        optional: None,
    }
}

/// The last request that was not a read.
fn written(store: &Shared) -> Node {
    let store = store.lock().unwrap();
    let ops = store.requests.iter().map(|body| operation(body));
    let reads = ["GetFolder", "GetItem", "FindItem"];
    let mut writes = ops.filter(|op| !reads.contains(&op.name.as_str()));
    writes.next_back().unwrap()
}

fn writes(fake: &Fake) -> usize {
    let ops = ["CreateItem", "UpdateItem", "DeleteItem"];
    ops.iter().map(|op| fake.log.count(op)).sum()
}

/// The `Id` the last write names, and the attribute that says whom it mails.
fn named(store: &Shared, mails: &str) -> (String, Option<String>) {
    let write = written(store);
    let id = write.at(&["ItemChanges", "ItemChange", "ItemId"]);
    let id = id.or(write.at(&["ItemIds", "ItemId"]));
    let id = id.or_else(|| {
        write
            .child("Items")?
            .children
            .first()?
            .child("ReferenceItemId")
    });
    let id = id.unwrap().attr("Id").unwrap().to_owned();
    (id, write.attr(mails).map(str::to_owned))
}

fn sent(id: u16, mails: &str) -> (String, Option<String>) {
    (ews(id), Some(mails.to_owned()))
}

fn left(store: &Shared) -> Vec<u16> {
    let store = store.lock().unwrap();
    store.items.iter().map(|cal| cal.n).collect()
}

#[tokio::test]
async fn one_event_or_all_of_a_plain_series_is_written_through_a_scope_and_nobody_is_mailed() {
    let (fake, mut client, store) = calendar(weekly(3, ""), |_| None).await;
    let (from, to) = (secs("2026-10-01T00:00:00Z"), secs("2026-11-01T00:00:00Z"));
    let found = client.calendar_events(from * 1000, to * 1000, 100).await;
    let found = found.unwrap().items;
    let listed: Vec<_> = found.iter().map(|i| (i.kind, i.screen_lock())).collect();
    assert_eq!(
        listed,
        [("occurrence", None); 3],
        "the events, never the master"
    );
    let detail = client.event_detail(&cal_id(3)).await.unwrap();
    let series = detail.series.unwrap();
    let said = (series.key.as_str(), series.repeat.text.as_str());
    assert_eq!(said, ("CK1v1", "Every week on Monday, 3 times"));
    assert!(series.lock(OWNER).is_none() && !series.can_respond);
    // Named with no scope, or the master as one event: nothing is written.
    let none = change(&mut client, 3, "CK1v1", None, None).await;
    let master = change(&mut client, 1, "CK1v1", None, ONE).await;
    assert_eq!(
        (none.err(), master.err(), writes(&fake)),
        (LOCKED, CONFLICT, 0)
    );
    // One event by its own id, which becomes an exception; every version of the series moves on.
    let one = change(&mut client, 3, "CK1v1", None, ONE).await;
    let quiet = "SendMeetingInvitationsOrCancellations";
    assert_eq!(
        (one, named(&store, quiet)),
        (Ok(cal_id(3)), sent(3, "SendToNone"))
    );
    assert!(store.lock().unwrap().items[2].extra.contains(">Exception<"));
    let stale = change(&mut client, 4, "CK1v1", None, ALL).await;
    assert_eq!((stale.err(), writes(&fake)), (CONFLICT, 1));
    // All of it through the master; its time of day a clock time on its first day, in its zone.
    let start = NaiveTime::from_hms_opt(10, 15, 0).unwrap();
    let ten = Some(When::Clock { start, minutes: 45 });
    let one = change(&mut client, 4, "CK1v2", ten, ONE).await;
    assert_eq!((one.err(), writes(&fake)), (INVALID, 1));
    // Typed on a computer in another zone, it would be another time on the series' wall; and an event
    // longer than the week between two is no time of day for a weekly series.
    let edit = |when| Edit {
        title: None,
        location: None,
        reminder: Reminder::Keep,
        when,
    };
    let four = cal_id(4);
    let (ten_edit, long_edit) = (
        edit(ten),
        edit(Some(When::Clock {
            start,
            minutes: 7 * 24 * 60 + 1,
        })),
    );
    let london = client.change_appointment(&four, "CK1v2", &ten_edit, "GMT Standard Time", ALL);
    let london = london.await.err();
    let long = client
        .change_appointment(&four, "CK1v2", &long_edit, VIENNA, ALL)
        .await;
    let zone_differs = Some("exchange_calendar_zone_differs");
    assert_eq!(
        (london, long.err(), writes(&fake)),
        (zone_differs, INVALID, 1)
    );
    let all = change(&mut client, 4, "CK1v2", ten, ALL).await;
    assert_eq!(
        (all, named(&store, quiet)),
        (Ok(cal_id(1)), sent(1, "SendToNone"))
    );
    let body = store.lock().unwrap().requests.last().unwrap().clone();
    let zone = format!(r#"<t:TimeZoneDefinition Id="{VIENNA}"/>"#);
    assert!(
        body.contains(&zone),
        "the series' zone, which is the computer's"
    );
    assert!(body.contains("<t:Start>2026-10-05T10:15:00</t:Start>"));
    assert!(!body.contains("IsAllDayEvent"));
    // Deleted: one event alone, then all of it through the master; nobody told either time.
    let quiet = "SendMeetingCancellations";
    let gone = client.delete_appointment(&cal_id(4), "CK1v3", ONE).await;
    assert_eq!(
        (gone, named(&store, quiet)),
        (Ok(()), sent(4, "SendToNone"))
    );
    assert_eq!(left(&store), [1, 2, 3]);
    let gone = client.delete_appointment(&cal_id(2), "CK1v4", ALL).await;
    assert_eq!(
        (gone, named(&store, quiet)),
        (Ok(()), sent(1, "SendToNone"))
    );
    assert!(left(&store).is_empty());
    // A master that says no zone has no time of day to change from here.
    let mut items = weekly(1, "");
    items[0].extra = items[0].extra.replace("StartTimeZone", "Unnamed");
    let (fake, mut client, _) = calendar(items, |_| None).await;
    let unknown = change(&mut client, 2, "CK1v1", ten, ALL).await;
    assert_eq!((unknown.err(), writes(&fake)), (LOCKED, 0));
}

pub fn attendee(address: &str) -> String {
    format!(
        "<t:Attendee><t:Mailbox><t:EmailAddress>{address}</t:EmailAddress></t:Mailbox></t:Attendee>"
    )
}

/// A series of meetings the owner organises, with these people on it.
pub fn organised(people: &[&str]) -> String {
    let people: String = people.iter().map(|who| attendee(who)).collect();
    format!(
        concat!(
            "<t:IsMeeting>true</t:IsMeeting><t:AppointmentState>1</t:AppointmentState>",
            "<t:IsOrganizer>true</t:IsOrganizer><t:ResponseObjects><t:CancelCalendarItem/>",
            "</t:ResponseObjects><t:RequiredAttendees>{}</t:RequiredAttendees>"
        ),
        people
    )
}

/// Makes an event of a series an exception, with `own` (its own lists) ahead of the series'.
pub fn exception(cal: &mut Cal, own: &str) {
    cal.extra = format!("{own}{}", cal.extra.replace(">Occurrence<", ">Exception<"));
}

#[tokio::test]
async fn a_repeating_meeting_tells_exactly_the_people_its_question_named_one_event_or_all() {
    // Bob and Cy are on the series; event 3 is an exception an hour later, with the same people.
    let mut items = weekly(3, &organised(&["bob@example.org", "cy@example.org"]));
    exception(&mut items[2], "");
    (items[2].start, items[2].end) = (items[2].start + 3600, items[2].end + 3600);
    let (fake, mut client, store) = calendar(items, |_| None).await;
    let detail = client.event_detail(&cal_id(3)).await.unwrap();
    let series = detail.series.as_ref().unwrap();
    let address = |list: &[Attendee]| {
        list.iter()
            .map(|a| a.who.address.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        address(&series.master.attendees),
        ["bob@example.org", "cy@example.org"]
    );
    assert_eq!(series.exceptions.as_ref().map(Vec::len), Some(1));
    assert!(series.lock(OWNER).is_none() && !series.can_respond);
    assert!(detail.screen_lock(OWNER).is_none());
    // The people of one event are the series', and the plain calls do not stand in for a meeting.
    let cy = people(Some("cy@example.org"));
    let three = cal_id(3);
    let both = ["bob@example.org".to_owned(), "cy@example.org".to_owned()];
    let one = client.change_meeting(&three, "CK1v1", &cy, OWNER, VIENNA, ONE, None);
    let one = one.await.err();
    let nobody = people(None);
    let named_for_one = client.change_meeting(
        &three,
        "CK1v1",
        &nobody,
        OWNER,
        VIENNA,
        ONE,
        Some(&both[..1]),
    );
    let named_for_one = named_for_one.await.err();
    let plain = change(&mut client, 3, "CK1v1", None, ALL).await;
    assert_eq!(
        (one, named_for_one, plain.err(), writes(&fake)),
        (INVALID, INVALID, LOCKED, 0)
    );
    // All of it tells the master's people, so a question that named only the event's is refused, and so
    // is one that named nobody.
    let renamed = people(None);
    for told in [Some(&both[..1]), None] {
        let all = client.change_meeting(&three, "CK1v1", &renamed, OWNER, VIENNA, ALL, told);
        let all = all.await.err();
        let cancel = client
            .cancel_meeting(&three, "CK1v1", None, OWNER, ALL, told)
            .await
            .err();
        let refused = if told.is_some() { CONFLICT } else { INVALID };
        assert_eq!((all, cancel, writes(&fake)), (refused, refused, 0));
    }
    let all = client.change_meeting(&three, "CK1v1", &renamed, OWNER, VIENNA, ALL, Some(&both));
    assert!(all.await.unwrap().sent);
    let told = "SendMeetingInvitationsOrCancellations";
    assert_eq!(named(&store, told), sent(1, "SendToAllAndSaveCopy"));
    // The owner's own reminder of all of it alone tells nobody.
    let mut reminder = people(None);
    (reminder.edit.title, reminder.edit.reminder) = (None, Reminder::Minutes(15));
    let quiet = client.change_meeting(&three, "CK1v2", &reminder, OWNER, VIENNA, ALL, Some(&both));
    assert!(!quiet.await.unwrap().sent);
    assert_eq!(named(&store, told), sent(1, "SendToNone"));
    // One event cancelled alone tells its own people, then all of it through the master tells the
    // master's.
    let told = "MessageDisposition";
    let one = client
        .cancel_meeting(&three, "CK1v3", None, OWNER, ONE, None)
        .await;
    assert_eq!(
        (one, named(&store, told)),
        (Ok(2), sent(3, "SendAndSaveCopy"))
    );
    assert_eq!(left(&store), [1, 2, 4]);
    let four = cal_id(4);
    let all = client
        .cancel_meeting(&four, "CK1v4", None, OWNER, ALL, Some(&both))
        .await;
    assert_eq!(
        (all, named(&store, told)),
        (Ok(2), sent(1, "SendAndSaveCopy"))
    );
    assert!(left(&store).is_empty());
    // Somebody else's series is answered, never changed or cancelled.
    let (fake, mut client, _) = calendar(weekly(2, INVITED), |_| None).await;
    let ada = ["ada@example.org".to_owned()];
    let theirs = client
        .cancel_meeting(&three, "CK1v1", None, OWNER, ALL, Some(&ada))
        .await;
    assert_eq!((theirs.err(), writes(&fake)), (LOCKED, 0));
}

/// All of the series of meetings event 2 belongs to changed and cancelled, telling Bob, and what the
/// detail of event 2 says of changing all of it.
async fn all_of_it(
    client: &mut Client,
) -> (Option<&'static str>, Option<&'static str>, Option<Lock>) {
    let (bob, two, renamed) = (["bob@example.org".to_owned()], cal_id(2), people(None));
    let change = client.change_meeting(&two, "CK1v1", &renamed, OWNER, VIENNA, ALL, Some(&bob));
    let change = change.await.err();
    let series = client.event_detail(&two).await.unwrap().series.unwrap();
    let cancel = client.cancel_meeting(&two, &series.key, None, OWNER, ALL, Some(&bob));
    (change, cancel.await.err(), series.lock(OWNER))
}

#[tokio::test]
async fn a_series_with_an_event_of_its_own_guests_is_changed_and_cancelled_one_event_at_a_time() {
    let series = || weekly(3, &organised(&["bob@example.org"]));
    let locked = (LOCKED, LOCKED, Some(Lock::ExceptionGuests));
    // Dan was added to event 3 alone: all of it is neither changed nor cancelled, nobody is told.
    let mut items = series();
    let dan = format!(
        "<t:RequiredAttendees>{}{}</t:RequiredAttendees>",
        attendee("bob@example.org"),
        attendee("dan@example.org")
    );
    exception(&mut items[2], &dan);
    let (fake, client, _) = calendar(items, |_| None).await;
    let (mut client, two) = (client, cal_id(2));
    let (change, cancel, lock) = all_of_it(&mut client).await;
    assert_eq!(((change, cancel, lock), writes(&fake)), (locked, 0));
    // One event is still changed by itself.
    let renamed = people(None);
    let one = client.change_meeting(&two, "CK1v1", &renamed, OWNER, VIENNA, ONE, None);
    assert!(one.await.unwrap().sent);
    // The same people, in another case, with the owner and a room besides: all of it goes.
    let mut items = series();
    let same = format!(
        "<t:RequiredAttendees>{}{}</t:RequiredAttendees><t:Resources>{}</t:Resources>",
        attendee("BOB@example.org"),
        attendee(OWNER),
        attendee("room@example.org")
    );
    exception(&mut items[2], &same);
    let (_fake, mut client, _) = calendar(items, |_| None).await;
    let (change, cancel, lock) = all_of_it(&mut client).await;
    assert_eq!((change, cancel, lock), (None, None, None));
    // Fifty exceptions are read in one request; one more is not read at all, and locks.
    for (count, lock) in [(50, None), (51, Some(Lock::ExceptionGuests))] {
        let mut items = weekly(count + 1, &organised(&["bob@example.org"]));
        items
            .iter_mut()
            .skip(1)
            .take(usize::from(count))
            .for_each(|cal| exception(cal, ""));
        let (_fake, mut client, store) = calendar(items, |_| None).await;
        let detail = client.event_detail(&cal_id(2)).await.unwrap();
        assert_eq!(
            detail.series.unwrap().lock(OWNER),
            lock,
            "{count} exceptions"
        );
        let requests = &store.lock().unwrap().requests;
        let all = |body: &&String| body.matches("<t:ItemId Id=").count() == usize::from(count);
        let reads = requests.iter().filter(all).count();
        assert_eq!(
            reads,
            usize::from(count == 50),
            "{count} exceptions read at once"
        );
    }
    // An exception that cannot be read, or an answer that is not one per exception, is not guessed at.
    for refusal in [true, false] {
        let mut items = series();
        exception(&mut items[2], "");
        let fails = move |soap: &Soap| {
            let id = format!(r#"<t:ItemId Id="{}"/>"#, ews(3));
            let read = soap.op == "GetItem" && soap.body.contains(&id);
            read.then(|| match refusal {
                true => refused("GetItem", "ErrorInternalServerError"),
                false => Out::Xml(response("GetItem", &[])),
            })
        };
        let (fake, mut client, _) = calendar(items, fails).await;
        let (change, cancel, lock) = all_of_it(&mut client).await;
        assert_eq!(((change, cancel, lock), writes(&fake)), (locked, 0));
    }
}

#[tokio::test]
async fn a_series_is_answered_through_its_master_unless_its_organizer_cancelled_all_of_it() {
    let (_fake, mut client, store) = calendar(weekly(3, INVITED), |_| None).await;
    // One event cancelled leaves the rest to answer.
    let one_event = (UID.to_owned(), Some(monday(1)));
    store.lock().unwrap().cancelled.push(one_event);
    let detail = client.event_detail(&cal_id(2)).await.unwrap();
    let series = detail.series.unwrap();
    assert!(series.can_respond && series.lock(OWNER).is_some() && series.removal.is_none());
    let (two, three) = (cal_id(2), cal_id(3));
    let accept = client.respond(&two, "CK1v1", Answer::Accept, true, false, true);
    assert!(accept.await.is_ok());
    let accept = written(&store);
    let reference = accept
        .at(&["Items", "AcceptItem", "ReferenceItemId"])
        .unwrap();
    let id = (reference.attr("Id"), reference.attr("ChangeKey"));
    assert_eq!(id, (Some(ews(1).as_str()), Some("CK1v1")));
    assert_eq!(accept.attr("MessageDisposition"), Some("SendAndSaveCopy"));
    // Declined whole and asked to be removed: one answer, and a look that nothing is left.
    let (fake, mut client, store) = calendar(weekly(3, INVITED), |_| None).await;
    let decline = client.respond(&three, "CK1v1", Answer::Decline, true, true, true);
    assert_eq!(decline.await.unwrap().removed, Some(true));
    let counts = (fake.log.count("CreateItem"), fake.log.count("DeleteItem"));
    assert_eq!((counts, left(&store)), ((1, 0), vec![]));
    // A server that keeps the declined series: its master, under the id the answer gave it, is
    // deleted, nobody told, whatever became of the first event.
    let (fake, mut client, store) = calendar(weekly(3, INVITED), |_| None).await;
    store.lock().unwrap().keeps_declined = true;
    store.lock().unwrap().items.retain(|cal| cal.n != 2);
    let decline = client.respond(&three, "CK1v1", Answer::Decline, true, true, true);
    assert_eq!(decline.await.unwrap().removed, Some(true));
    let deleted = named(&store, "SendMeetingCancellations");
    assert_eq!(
        (deleted, fake.log.count("DeleteItem")),
        (sent(5, "SendToNone"), 1)
    );
    // A declined master of another meeting under that id is not this one's: kept, and not said off.
    let mut items = weekly(3, INVITED);
    let other = Cal {
        n: 9,
        uid: Some(9),
        series: Some(9),
        answer: Some("Decline"),
        ..weekly(0, INVITED).remove(0)
    };
    items.push(other);
    let elsewhere = |soap: &Soap| match soap.op.as_str() {
        "CreateItem" if soap.body.contains("<t:DeclineItem>") => {
            let id = format!(r#"<t:ItemId Id="{}" ChangeKey="CK9v1"/>"#, ews(9));
            let items = format!("<m:Items><t:CalendarItem>{id}</t:CalendarItem></m:Items>");
            Some(Out::Xml(response(
                "CreateItem",
                &[ok("CreateItem", &items)],
            )))
        }
        "GetItem" if soap.body.contains(&format!(r#"<t:ItemId Id="{}""#, ews(1))) => {
            Some(refused("GetItem", "ErrorItemNotFound"))
        }
        _ => None,
    };
    let (fake, mut client, store) = calendar(items, elsewhere).await;
    let decline = client.respond(&three, "CK1v1", Answer::Decline, true, true, true);
    assert_eq!(decline.await.unwrap().removed, Some(false));
    assert_eq!(
        (fake.log.count("DeleteItem"), left(&store).contains(&9)),
        (0, true)
    );
    // A read that fails after the answer says nothing is off the calendar, whatever else is found.
    let failing = |soap: &Soap| {
        let master =
            soap.op == "GetItem" && soap.body.contains(&format!(r#"<t:ItemId Id="{}""#, ews(1)));
        master.then(|| refused("GetItem", "ErrorInternalServerError"))
    };
    let (fake, mut client, _) = calendar(weekly(3, INVITED), failing).await;
    let decline = client.respond(&three, "CK1v1", Answer::Decline, true, true, true);
    assert_eq!(
        (decline.await.unwrap().removed, fake.log.count("DeleteItem")),
        (Some(false), 0)
    );
    // Cancelled as a whole, it is answered by nobody.
    let (fake, mut client, store) = calendar(weekly(3, INVITED), |_| None).await;
    store.lock().unwrap().cancelled.push((UID.into(), None));
    let late = client.respond(&two, "CK1v1", Answer::Accept, true, false, true);
    let refused = Some("exchange_calendar_not_invitation");
    assert_eq!((late.await.err(), writes(&fake)), (refused, 0));
}

/// An invited weekly series of `count` events and the cancellations of `events` in the Inbox (by
/// index; `None` for one of the whole series).
async fn cancelled(
    count: u16,
    events: &[Option<u16>],
    wrap: impl Fn(&Soap) -> Option<Out> + Send + Sync + 'static,
) -> (Fake, Client, Shared) {
    let (fake, client, store) = calendar(weekly(count, INVITED), wrap).await;
    let messages = events.iter().map(|at| (UID.to_owned(), at.map(monday)));
    store.lock().unwrap().cancelled.extend(messages);
    (fake, client, store)
}

/// The `RemoveItem`s that were saved, not sent.
fn removals(store: &Shared) -> usize {
    let store = store.lock().unwrap();
    let ops = store.requests.iter().map(|body| operation(body));
    let saved = |op: &Node| op.attr("MessageDisposition") == Some("SaveOnly");
    let removal = |op: &Node| op.at(&["Items", "RemoveItem"]).is_some() && saved(op);
    ops.filter(removal).count()
}

#[tokio::test]
async fn a_cancelled_series_is_taken_off_in_one_call_and_only_what_its_organizer_cancelled() {
    // Cancelled as a whole: the detail says so, and its one cancellation takes all of it.
    let (fake, mut client, store) = cancelled(3, &[None], |_| None).await;
    let detail = client.event_detail(&cal_id(3)).await.unwrap();
    let said = (detail.removal(), detail.series.unwrap().removal);
    assert_eq!(said, (Some("cancelled"), Some(0)));
    let done = client.remove_series(&cal_id(3), "CK1v1").await.unwrap();
    assert_eq!((done.count, done.more, removals(&store)), (1, false, 1));
    assert!(left(&store).is_empty());
    assert_eq!(
        fake.log.count("DeleteItem") + fake.log.count("UpdateItem"),
        0
    );
    // Two events cancelled one by one: both go, the rest stays, and the master is never deleted.
    let (fake, mut client, store) = cancelled(3, &[Some(0), Some(1)], |_| None).await;
    let done = client.remove_series(&cal_id(4), "CK1v1").await.unwrap();
    assert_eq!(
        (done.count, done.more, left(&store)),
        (2, false, vec![1, 4])
    );
    assert_eq!(fake.log.count("DeleteItem"), 0);
    // Cancelled whole and event by event: the whole series' cancellation goes first, and alone.
    let (_fake, mut client, store) = cancelled(3, &[Some(0), None], |_| None).await;
    let done = client.remove_series(&cal_id(3), "CK1v1").await.unwrap();
    assert_eq!((done.count, removals(&store), left(&store)), (1, 1, vec![]));
    // One cancelled event is that event's removal; nobody cancelled it; a stale version: nothing.
    let none: &[Option<u16>] = &[];
    let cases = [
        (&[Some(1)][..], "CK1v1", NOT_REMOVABLE),
        (none, "CK1v1", NOT_REMOVABLE),
        (&[None][..], "CK1v0", CONFLICT),
    ];
    for (events, key, code) in cases {
        let (fake, mut client, _) = cancelled(3, events, |_| None).await;
        assert_eq!(client.remove_series(&cal_id(3), key).await.err(), code);
        assert_eq!(writes(&fake), 0);
    }
    // Another series' cancellation is not this one's.
    let (fake, mut client, store) = calendar(weekly(2, INVITED), |_| None).await;
    let other = ("uid-9@example.org".to_owned(), None);
    store.lock().unwrap().cancelled.push(other);
    let other = client.remove_series(&cal_id(2), "CK1v1").await;
    assert_eq!((other.err(), writes(&fake)), (NOT_REMOVABLE, 0));
    // One event removed alone stays alone, even when all of the series was cancelled.
    let (_fake, mut client, store) = cancelled(3, &[None], |_| None).await;
    let none = client.remove_meeting(&cal_id(3), "CK1v1", None).await;
    assert_eq!(
        none.err(),
        LOCKED,
        "an event of a series is removed through its scope"
    );
    let one = client.remove_meeting(&cal_id(3), "CK1v1", ONE).await;
    assert_eq!(
        (one, removals(&store), left(&store)),
        (Ok("cancelled"), 0, vec![1, 2, 4])
    );
}

#[tokio::test]
async fn a_refused_cancellation_deletes_nothing_instead_and_a_long_series_says_more_are_left() {
    // A server that will not process it: the refusal is said, and nothing is deleted instead.
    let refuses = |soap: &Soap| {
        let removal = soap.body.contains("<t:RemoveItem>");
        removal.then(|| refused("CreateItem", "ErrorInternalServerError"))
    };
    let (fake, mut client, store) = cancelled(3, &[None], refuses).await;
    let done = client.remove_series(&cal_id(2), "CK1v1").await;
    let unconfirmed = Some("exchange_calendar_unconfirmed");
    assert_eq!((done.err(), fake.log.count("DeleteItem")), (unconfirmed, 0));
    assert_eq!(left(&store), [1, 2, 3, 4]);
    // One the server says is out of date cancels nothing.
    let (fake, mut client, store) = cancelled(3, &[None], |_| None).await;
    store.lock().unwrap().stale = vec![UID.into()];
    let done = client.remove_series(&cal_id(2), "CK1v1").await;
    assert_eq!((done.err(), writes(&fake)), (NOT_REMOVABLE, 0));
    // A master the server leaves behind after the whole cancellation is read again and deleted at its
    // new version, nobody told; one it leaves as the owner's own is not, and that is said as left.
    let (fake, mut client, store) = cancelled(3, &[None], |_| None).await;
    store.lock().unwrap().keeps_master = Some(String::new());
    let done = client.remove_series(&cal_id(2), "CK1v1").await.unwrap();
    let delete = written(&store);
    let key = delete.at(&["ItemIds", "ItemId"]).unwrap().attr("ChangeKey");
    assert_eq!((done.count, done.left, key), (2, false, Some("CK1v2")));
    assert_eq!(
        named(&store, "SendMeetingCancellations"),
        sent(1, "SendToNone")
    );
    assert!(left(&store).is_empty() && fake.log.count("DeleteItem") == 1);
    let mine = "<t:MyResponseType>Organizer</t:MyResponseType><t:IsOrganizer>true</t:IsOrganizer>";
    let (fake, mut client, store) = cancelled(3, &[None], |_| None).await;
    store.lock().unwrap().keeps_master = Some(mine.into());
    let done = client.remove_series(&cal_id(2), "CK1v1").await.unwrap();
    let said = (
        done.count,
        done.more,
        done.left,
        fake.log.count("DeleteItem"),
    );
    assert_eq!((said, left(&store)), ((1, false, true, 0), vec![1]));
    // Once something was taken off, a failure after it is said with the count, never instead of it.
    let lost = |soap: &Soap| {
        let master = soap.op == "GetItem" && soap.body.contains(r#"<t:ItemId Id="AAEJ"#);
        master.then(|| refused("GetItem", "ErrorInternalServerError"))
    };
    let (_fake, mut client, store) = cancelled(3, &[None], lost).await;
    store.lock().unwrap().keeps_master = Some(String::new());
    let done = client.remove_series(&cal_id(2), "CK1v1").await.unwrap();
    assert_eq!((done.count, done.left), (1, true));
    let second = |soap: &Soap| {
        let removal = soap.body.contains("<t:RemoveItem>") && soap.body.contains(&ews(901));
        removal.then(|| refused("CreateItem", "ErrorInternalServerError"))
    };
    let (_fake, mut client, store) = cancelled(3, &[Some(0), Some(1)], second).await;
    let done = client.remove_series(&cal_id(4), "CK1v1").await.unwrap();
    assert_eq!(
        (done.count, done.more, left(&store)),
        (1, true, vec![1, 3, 4])
    );
    // A master the server itself flags cancelled needs no look in the Inbox.
    let mut items = weekly(2, INVITED);
    items[0].extra = format!("<t:IsCancelled>true</t:IsCancelled>{}", items[0].extra);
    let (fake, mut client, _) = calendar(items, |_| None).await;
    let done = client.remove_series(&cal_id(2), "CK1v1").await;
    assert_eq!(done.map(|done| done.count), Ok(1));
    let counts = (fake.log.count("FindItem"), fake.log.count("DeleteItem"));
    assert_eq!(counts, (0, 1));
    // Fifty-two events cancelled one by one: fifty in this call, and it says more are left.
    let all: Vec<Option<u16>> = (0..52).map(Some).collect();
    let (_fake, mut client, store) = cancelled(52, &all, |_| None).await;
    let done = client.remove_series(&cal_id(2), "CK1v1").await.unwrap();
    assert_eq!((done.count, done.more, removals(&store)), (50, true, 50));
}
