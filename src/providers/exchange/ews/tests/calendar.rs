//! The calendar operations against a scripted calendar that keeps its items, pages a view by start
//! the way the server does and writes what it is asked to, refusing a stale version.

use std::sync::{Arc, Mutex};

use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, NaiveDateTime, SecondsFormat};
use quick_xml::escape::escape;

use super::super::client::calendar::CalendarEvents;
use super::super::{Appointment, Choice, Client, Edit, When, xml};
use super::conn::client;
use super::fake::{self, Fake, Offer, Out, Soap, message, ok, response};
use crate::providers::exchange::ids;

/// One item of the scripted calendar; times in Unix seconds.
#[derive(Clone, Default)]
pub struct Cal {
    pub n: u16,
    pub subject: String,
    pub location: String,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    /// The wall clocks the server gives: midnight of the days, for an all-day item.
    pub walls: Option<(String, String)>,
    /// Elements of the item ahead of the defaults, which they override (`Sensitivity`, ...).
    pub extra: String,
    /// People on it, which only a `GetItem` lists.
    pub attendees: usize,
    pub reminder: Option<u32>,
    pub version: u32,
}

pub fn secs(text: &str) -> i64 {
    DateTime::parse_from_rfc3339(text).unwrap().timestamp()
}

fn ews(n: u16) -> String {
    let mut bytes = [9u8; 40];
    bytes[..2].copy_from_slice(&n.to_be_bytes());
    STANDARD.encode(bytes)
}

/// The Omamail id of item `n`.
pub fn cal_id(n: u16) -> String {
    ids::encode(&ews(n)).unwrap()
}

impl Cal {
    pub fn new(n: u16, subject: &str, start: &str, end: &str) -> Cal {
        let (start, end) = (secs(start), secs(end));
        let (subject, version) = (subject.to_owned(), 1);
        Cal {
            n,
            subject,
            start,
            end,
            version,
            ..Cal::default()
        }
    }

    /// A day as a server in some zone keeps it: midnight there as instants, and the days as walls.
    pub fn day(n: u16, subject: &str, start: &str, end: &str, days: (&str, &str)) -> Cal {
        let walls = Some((
            format!("{}T00:00:00", days.0),
            format!("{}T00:00:00", days.1),
        ));
        Cal {
            all_day: true,
            walls,
            ..Cal::new(n, subject, start, end)
        }
    }

    pub fn with(self, extra: &str) -> Cal {
        Cal {
            extra: self.extra + extra,
            ..self
        }
    }

    pub fn key(&self) -> String {
        format!("CK{}v{}", self.n, self.version)
    }

    fn xml(&self, optional: bool, people: bool) -> String {
        let at = |secs| {
            DateTime::from_timestamp(secs, 0)
                .unwrap()
                .to_rfc3339_opts(SecondsFormat::Secs, true)
        };
        let mut out = format!(
            concat!(
                r#"<t:CalendarItem><t:ItemId Id="{}" ChangeKey="{}"/>{}<t:Subject>{}</t:Subject>"#,
                "<t:Location>{}</t:Location><t:Start>{}</t:Start><t:End>{}</t:End>",
                "<t:IsAllDayEvent>{}</t:IsAllDayEvent><t:CalendarItemType>Single</t:CalendarItemType>",
                "<t:MyResponseType>Organizer</t:MyResponseType><t:UID>uid-{}@example.org</t:UID>",
                "<t:Organizer><t:Mailbox><t:Name>Ada Example</t:Name></t:Mailbox></t:Organizer>"
            ),
            ews(self.n),
            self.key(),
            self.extra,
            escape(&self.subject),
            escape(&self.location),
            at(self.start),
            at(self.end),
            self.all_day,
            self.n
        );
        if let (true, Some((start, end))) = (optional, &self.walls) {
            out += &format!(
                "<t:StartWallClock>{start}</t:StartWallClock><t:EndWallClock>{end}</t:EndWallClock>"
            );
        }
        if let (true, Some(minutes)) = (optional, self.reminder) {
            out += &format!(
                "<t:ReminderIsSet>true</t:ReminderIsSet><t:ReminderMinutesBeforeStart>{minutes}</t:ReminderMinutesBeforeStart>"
            );
        }
        if people {
            // The default calendar's, unless `extra` named another folder ahead of it.
            out += r#"<t:ParentFolderId Id="calendar-folder"/>"#;
        }
        if people && self.attendees > 0 {
            let one = "<t:Attendee><t:Mailbox><t:EmailAddress>guest@example.org</t:EmailAddress></t:Mailbox></t:Attendee>";
            out += &format!(
                "<t:RequiredAttendees>{}</t:RequiredAttendees>",
                one.repeat(self.attendees)
            );
        }
        out + "</t:CalendarItem>"
    }
}

/// The scripted calendar.
#[derive(Default)]
pub struct Store {
    pub items: Vec<Cal>,
    /// A view that asks for the wall clocks is a server error.
    pub refuse_walls: bool,
    /// Every request but the folder lookup, as sent.
    pub requests: Vec<String>,
}

pub type Shared = Arc<Mutex<Store>>;

pub fn store(items: Vec<Cal>) -> Shared {
    Arc::new(Mutex::new(Store {
        items,
        ..Store::default()
    }))
}

/// The operation element of a request.
pub fn operation(body: &str) -> xml::Node {
    let mut tree = xml::parse(body.as_bytes()).unwrap();
    let at = tree.children.iter().position(|c| c.name == "Body").unwrap();
    tree.children.swap_remove(at).children.remove(0)
}

fn refused(kind: &str, code: &str) -> Out {
    Out::Xml(response(kind, &[message(kind, "Error", code, "")]))
}

fn written(kind: &str, cal: &Cal) -> Out {
    let id = format!(
        r#"<t:ItemId Id="{}" ChangeKey="{}"/>"#,
        ews(cal.n),
        cal.key()
    );
    let items = format!("<m:Items><t:CalendarItem>{id}</t:CalendarItem></m:Items>");
    Out::Xml(response(kind, &[ok(kind, &items)]))
}

/// `Start` or `End` as written: an instant, or a day's midnight in the request's zone (an hour east
/// of UTC for any zone but UTC, which is all the fake needs to know of zones).
fn written_time(text: &str, zone: Option<&str>) -> i64 {
    DateTime::parse_from_rfc3339(text).map_or_else(
        |_| {
            let local = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S").unwrap();
            local.and_utc().timestamp()
                - if zone.is_some_and(|z| z != "UTC") {
                    3600
                } else {
                    0
                }
        },
        |date| date.timestamp(),
    )
}

/// The calendar's answers. The folder lookup is answered by whoever wraps this.
pub fn script(store: Shared) -> impl Fn(&Soap) -> Out + Send + Sync + 'static {
    move |soap| {
        let mut store = store.lock().unwrap();
        store.requests.push(soap.body.clone());
        let request = operation(&soap.body);
        let root = xml::parse(soap.body.as_bytes()).unwrap();
        let zone = root.at(&["Header", "TimeZoneContext", "TimeZoneDefinition"]);
        let zone = zone.and_then(|node| node.attr("Id"));
        let asked = request.at(&["ItemIds", "ItemId"]).or(request.at(&[
            "ItemChanges",
            "ItemChange",
            "ItemId",
        ]));
        let at = asked.and_then(|id| {
            store
                .items
                .iter()
                .position(|cal| Some(ews(cal.n).as_str()) == id.attr("Id"))
        });
        let key = asked.and_then(|id| id.attr("ChangeKey"));
        match soap.op.as_str() {
            "GetFolder" => {
                let folder = r#"<m:Folders><t:CalendarFolder><t:FolderId Id="calendar-folder"/></t:CalendarFolder></m:Folders>"#;
                Out::Xml(response("GetFolder", &[ok("GetFolder", folder)]))
            }
            "FindItem" => {
                let optional = soap.body.contains("StartWallClock");
                if optional && store.refuse_walls {
                    return refused("FindItem", "ErrorInvalidPropertyRequest");
                }
                let view = request.child("CalendarView").unwrap();
                let (from, to) = (
                    secs(view.attr("StartDate").unwrap()),
                    secs(view.attr("EndDate").unwrap()),
                );
                let max: usize = view.attr("MaxEntriesReturned").unwrap().parse().unwrap();
                let mut found: Vec<&Cal> = store
                    .items
                    .iter()
                    .filter(|c| c.end >= from && c.start < to)
                    .collect();
                found.sort_by_key(|cal| (cal.start, cal.n));
                let page: Vec<String> = found
                    .iter()
                    .take(max)
                    .map(|cal| cal.xml(optional, false))
                    .collect();
                Out::Xml(fake::find(&page, found.len() <= max, found.len()))
            }
            "GetItem" => match at {
                Some(at) => {
                    let item = format!("<m:Items>{}</m:Items>", store.items[at].xml(false, true));
                    Out::Xml(response("GetItem", &[ok("GetItem", &item)]))
                }
                None => refused("GetItem", "ErrorItemNotFound"),
            },
            "CreateItem" => {
                let item = request.at(&["Items", "CalendarItem"]).unwrap();
                let text = |name: &str| item.text_at(&[name]).unwrap_or("").to_owned();
                let n = store.items.iter().map(|cal| cal.n).max().unwrap_or(0) + 1;
                let all_day = text("IsAllDayEvent") == "true";
                let cal = Cal {
                    n,
                    subject: text("Subject"),
                    location: text("Location"),
                    start: written_time(&text("Start"), zone),
                    end: written_time(&text("End"), zone),
                    all_day,
                    walls: all_day.then(|| (text("Start"), text("End"))),
                    version: 1,
                    ..Cal::default()
                };
                let answer = written("CreateItem", &cal);
                store.items.push(cal);
                answer
            }
            "UpdateItem" | "DeleteItem" if at.is_none() => refused(&soap.op, "ErrorItemNotFound"),
            "UpdateItem" | "DeleteItem" if key != Some(store.items[at.unwrap()].key().as_str()) => {
                refused(&soap.op, "ErrorIrresolvableConflict")
            }
            "UpdateItem" => {
                let cal = &mut store.items[at.unwrap()];
                let updates = request
                    .at(&["ItemChanges", "ItemChange", "Updates"])
                    .unwrap();
                for set in updates.children("SetItemField") {
                    let value = set.child("CalendarItem").unwrap().children[0].text.clone();
                    match set.child("FieldURI").unwrap().attr("FieldURI").unwrap() {
                        "item:Subject" => cal.subject = value,
                        "calendar:Location" => cal.location = value,
                        "calendar:IsAllDayEvent" => cal.all_day = value == "true",
                        "calendar:Start" => cal.start = written_time(&value, zone),
                        "calendar:End" => cal.end = written_time(&value, zone),
                        _ => {}
                    }
                }
                cal.version += 1;
                written("UpdateItem", cal)
            }
            "DeleteItem" => {
                store.items.remove(at.unwrap());
                Out::Xml(fake::done("DeleteItem", 1))
            }
            _ => Out::Drop,
        }
    }
}

/// A client of a scripted calendar, and its store; `wrap` may answer a request itself.
async fn calendar(
    items: Vec<Cal>,
    wrap: impl Fn(&Soap) -> Option<Out> + Send + Sync + 'static,
) -> (Fake, Client, Shared) {
    let shared = store(items);
    let answer = script(shared.clone());
    let fake = Fake::start(Offer::Basic, move |soap| match soap.op.as_str() {
        "GetFolder" if !soap.body.contains(r#"Id="calendar""#) => Out::Xml(fake::folders()),
        _ => wrap(soap).unwrap_or_else(|| answer(soap)),
    })
    .await;
    let client = client(&fake, Choice::Basic, fake::PASSWORD);
    (fake, client, shared)
}

fn october(n: u16, day: u32) -> Cal {
    let at = |minute| format!("2026-10-{day:02}T09:{minute}:00Z");
    Cal::new(n, &format!("Event {n}"), &at("00"), &at("30"))
}

const FROM: &str = "2026-10-01T00:00:00Z";
const TO: &str = "2026-11-01T00:00:00Z";

async fn whole_october(client: &mut Client, page: usize) -> Result<CalendarEvents, &'static str> {
    client
        .calendar_events(secs(FROM) * 1000, secs(TO) * 1000, page)
        .await
}

#[tokio::test]
async fn a_range_is_paged_by_moving_its_start_and_every_item_comes_once_in_order() {
    // A long event still running where the next answer starts comes again, first.
    let mut items: Vec<Cal> = (1..=7).map(|n| october(n, 2 + u32::from(n))).collect();
    items.push(Cal::new(
        20,
        "Trip",
        "2026-10-02T00:00:00Z",
        "2026-10-20T00:00:00Z",
    ));
    let (fake, mut client, store) = calendar(items, |_| None).await;
    let found = client
        .calendar_events(secs(FROM) * 1000, secs(TO) * 1000 + 1, 3)
        .await
        .unwrap();
    assert!(!found.truncated);
    let starts: Vec<i64> = found.items.iter().map(|item| item.start_ms).collect();
    assert!(starts.len() == 8 && starts.is_sorted());
    let requests = store.lock().unwrap().requests.clone();
    assert!(requests.len() > 2 && requests.len() == fake.log.count("FindItem"));
    // The range in UTC whole seconds and never shrinking; the next starts at the latest start seen.
    let view = |at: usize| {
        operation(&requests[at])
            .child("CalendarView")
            .unwrap()
            .attrs
            .clone()
    };
    assert!(view(0).contains(&("EndDate".into(), "2026-11-01T00:00:01Z".into())));
    assert!(view(1).contains(&("StartDate".into(), "2026-10-04T09:00:00Z".into())));
}

#[tokio::test]
async fn a_read_that_cannot_be_completed_says_it_is_truncated_and_never_looks_whole() {
    // As many items as an answer holds, all running where the next would start: no progress.
    let workshop = |n| {
        Cal::new(
            n,
            "Workshop",
            "2026-10-02T09:00:00Z",
            "2026-10-02T17:00:00Z",
        )
    };
    let (_fake, mut client, _) = calendar((1..=4).map(workshop).collect(), |_| None).await;
    let found = whole_october(&mut client, 3).await.unwrap();
    assert_eq!((found.truncated, found.items.len()), (true, 3));
    // More answers than a read may ask for: each answer of two repeats the one still at its start.
    let days = (1..=20).map(|n| october(n, 1 + u32::from(n)));
    let (fake, mut client, _) = calendar(days.collect(), |_| None).await;
    let found = whole_october(&mut client, 2).await.unwrap();
    assert_eq!(
        (
            found.truncated,
            found.items.len(),
            fake.log.count("FindItem")
        ),
        (true, 13, 12)
    );
    // More items than a read returns.
    let tick = |n: u16| {
        let start = secs("2026-10-02T00:00:00Z") + i64::from(n) * 60;
        Cal {
            start,
            end: start + 30,
            ..Cal::new(n, "Tick", FROM, FROM)
        }
    };
    let (_fake, mut client, _) = calendar((0..1100).map(tick).collect(), |_| None).await;
    let found = whole_october(&mut client, 100).await.unwrap();
    assert_eq!((found.truncated, found.items.len()), (true, 1000));
    // An answer that does not say whether it is the last is the last when it is short.
    let quiet = |soap: &Soap| {
        let page = fake::find(&[october(1, 3).xml(true, false)], true, 1);
        (soap.op == "FindItem")
            .then(|| Out::Xml(page.replace(r#" IncludesLastItemInRange="true""#, "")))
    };
    let (_fake, mut client, _) = calendar(Vec::new(), quiet).await;
    assert!(!whole_october(&mut client, 3).await.unwrap().truncated);
}

#[tokio::test]
async fn a_server_that_refuses_the_wall_clocks_is_asked_once_without_them() {
    let days = ("2026-10-05", "2026-10-06");
    let mut day = Cal::day(
        1,
        "Holiday",
        "2026-10-04T22:00:00Z",
        "2026-10-05T22:00:00Z",
        days,
    );
    day.reminder = Some(15);
    let (fake, mut client, store) = calendar(vec![day], |_| None).await;
    let found = whole_october(&mut client, 100).await.unwrap();
    assert!(found.items[0].start_wall.is_some() && found.items[0].reminder_minutes == Some(15));
    store.lock().unwrap().refuse_walls = true;
    let found = whole_october(&mut client, 100).await.unwrap();
    assert_eq!(
        (found.items[0].start_wall, found.items[0].reminder_minutes),
        (None, None)
    );
    assert_eq!(fake.log.count("FindItem"), 3);
    // Only a first answer is asked again: a server error later fails the read.
    let later = move |soap: &Soap| {
        let second = soap.op == "FindItem" && soap.body.contains("2026-10-03T09");
        second.then(|| refused("FindItem", "ErrorInternalServerError"))
    };
    let (_fake, mut client, _) = calendar(
        (1..=4).map(|n| october(n, 2 + u32::from(n))).collect(),
        later,
    )
    .await;
    assert_eq!(
        whole_october(&mut client, 1).await.err(),
        Some("exchange_server_error")
    );
}

fn timed(start: &str, end: &str) -> When {
    When::Timed {
        start_ms: secs(start) * 1000,
        end_ms: secs(end) * 1000,
    }
}

fn appointment(title: &str, when: When) -> Appointment {
    Appointment {
        title: title.into(),
        location: "Room 4".into(),
        notes: None,
        when,
    }
}

fn edit(title: &str, when: Option<When>) -> Edit {
    Edit {
        title: Some(title.into()),
        location: Some("Room 4".into()),
        when,
    }
}

#[tokio::test]
async fn an_appointment_is_made_changed_by_what_differs_and_deleted_and_nobody_is_mailed() {
    let (fake, mut client, store) = calendar(Vec::new(), |_| None).await;
    let zone = "W. Europe Standard Time";
    let dentist = Appointment {
        notes: Some("Bring the card\r\nand the form".into()),
        ..appointment(
            "Dentist",
            timed("2026-10-05T07:00:00Z", "2026-10-05T07:30:00Z"),
        )
    };
    let made = client.create_appointment(&dentist, zone).await.unwrap();
    assert_eq!(made.change_key, "CK1v1");
    let other = client.create_appointment(&dentist, zone).await.unwrap();
    // An unchanged form sends nothing; a title sends the title alone.
    let same = client
        .change_appointment(&made.id, "CK1v1", &edit("Dentist", None), zone)
        .await;
    assert_eq!(same.unwrap().change_key, "CK1v1");
    assert_eq!(fake.log.count("UpdateItem"), 0);
    let renamed = client
        .change_appointment(&made.id, "CK1v1", &edit("Renamed", None), zone)
        .await;
    assert_eq!(renamed.unwrap().change_key, "CK1v2");
    let later = Some(timed("2026-10-05T08:00:00Z", "2026-10-05T08:30:00Z"));
    client
        .change_appointment(&made.id, "CK1v2", &edit("Renamed", later), zone)
        .await
        .unwrap();
    client.delete_appointment(&other.id, "CK2v1").await.unwrap();
    let store = store.lock().unwrap();
    let left: Vec<(&str, i64)> = store
        .items
        .iter()
        .map(|cal| (cal.subject.as_str(), cal.start))
        .collect();
    assert_eq!(left, [("Renamed", secs("2026-10-05T08:00:00Z"))]);
    let sent = &store.requests;
    let ops: Vec<String> = sent.iter().map(|body| operation(body).name).collect();
    // The read before a change is the default calendar's id, then the item.
    let read = "GetFolder GetItem";
    let writes = format!("{read} UpdateItem {read} UpdateItem {read} DeleteItem");
    assert_eq!(
        ops.join(" "),
        format!("CreateItem CreateItem {read} {writes}")
    );
    assert!(
        sent[0].contains("&#13;\nand the form"),
        "a line break survives the server's parser"
    );
    let updates = operation(&sent[6]);
    let updates = updates
        .at(&["ItemChanges", "ItemChange", "Updates"])
        .unwrap();
    assert_eq!(updates.children.len(), 1, "the title alone");
    for body in sent.iter().filter(|body| body.contains("Item ")) {
        for word in [
            "SendToAll",
            "SendOnly",
            "SendAndSave",
            "HardDelete",
            "Always",
            "Attendee",
        ] {
            assert!(!body.contains(word), "{word} in {body}");
        }
    }
}

#[tokio::test]
async fn a_version_other_than_the_one_drawn_is_a_conflict_and_nothing_is_written_or_retried() {
    let conflict = Some("exchange_calendar_conflict");
    let (fake, mut client, _) = calendar(vec![october(1, 5)], |_| None).await;
    // Changed since the screen was drawn: refused on the read, before anything is written.
    let stale = client
        .change_appointment(&cal_id(1), "CK1v0", &edit("New", None), "UTC")
        .await;
    assert_eq!(stale.err(), conflict);
    assert_eq!(
        client.delete_appointment(&cal_id(1), "CK1v0").await.err(),
        conflict
    );
    assert_eq!(
        fake.log.count("UpdateItem") + fake.log.count("DeleteItem"),
        0
    );
    // Changed between the read and the write: the server's refusal, said once and never retried.
    let race = |soap: &Soap| {
        (soap.op == "UpdateItem").then(|| refused("UpdateItem", "ErrorIrresolvableConflict"))
    };
    let (fake, mut client, _) = calendar(vec![october(1, 5)], race).await;
    let lost = client
        .change_appointment(&cal_id(1), "CK1v1", &edit("New", None), "UTC")
        .await;
    assert_eq!(lost.err(), conflict);
    assert_eq!(
        (fake.log.count("GetItem"), fake.log.count("UpdateItem")),
        (1, 1)
    );
}

#[tokio::test]
async fn nothing_but_a_plain_appointment_of_ones_own_is_written() {
    let mut people = october(1, 5);
    people.attendees = 1;
    let mut locked = vec![people];
    for (n, extra) in (2..).zip([
        "<t:IsMeeting>true</t:IsMeeting>",
        "<t:CalendarItemType>Occurrence</t:CalendarItemType>",
        "<t:IsRecurring>true</t:IsRecurring>",
        "<t:IsCancelled>true</t:IsCancelled>",
        "<t:MyResponseType>Accept</t:MyResponseType>",
        "<t:Sensitivity>Private</t:Sensitivity>",
        "<t:CalendarItemType>Something</t:CalendarItemType>",
        // A plain appointment the login reaches in a folder that is not the default calendar.
        r#"<t:ParentFolderId Id="elsewhere"/>"#,
    ]) {
        locked.push(october(n, 5).with(extra));
    }
    let message = |soap: &Soap| {
        let item = format!(
            r#"<m:Items><t:Message><t:ItemId Id="{}" ChangeKey="CK99v1"/></t:Message></m:Items>"#,
            ews(99)
        );
        (soap.op == "GetItem" && soap.body.contains(&ews(99)))
            .then(|| Out::Xml(response("GetItem", &[ok("GetItem", &item)])))
    };
    let (fake, mut client, _) = calendar(locked, message).await;
    for n in (1..=9).chain([99]) {
        let key = format!("CK{n}v1");
        let changed = client
            .change_appointment(&cal_id(n), &key, &edit("x", None), "UTC")
            .await;
        assert_eq!(changed.err(), Some("exchange_calendar_locked"), "{n}");
        let deleted = client.delete_appointment(&cal_id(n), &key).await;
        assert_eq!(deleted.err(), Some("exchange_calendar_locked"), "{n}");
    }
    assert_eq!(
        fake.log.count("UpdateItem") + fake.log.count("DeleteItem"),
        0
    );
}

#[tokio::test]
async fn a_failed_write_says_what_it_proves_and_is_never_sent_twice() {
    let unknown = "exchange_calendar_unconfirmed";
    let cases: [(fn() -> Out, &str); 8] = [
        (|| Out::Drop, unknown),
        (|| Out::Torn, unknown),
        // A gateway can answer a status for a request its backend went on to run.
        (|| Out::Status(503, Vec::new()), unknown),
        (|| Out::Status(302, Vec::new()), unknown),
        (|| refused("UpdateItem", "ErrorSomethingNew"), unknown),
        (
            || refused("UpdateItem", "ErrorItemNotFound"),
            "exchange_message_not_found",
        ),
        (
            || refused("UpdateItem", "ErrorAccessDenied"),
            "exchange_access_denied",
        ),
        (
            || Out::Xml(fake::fault("ErrorServerBusy")),
            "exchange_throttled",
        ),
    ];
    for (answer, code) in cases {
        let (fake, mut client, _) = calendar(vec![october(1, 5)], move |soap| {
            (soap.op == "UpdateItem").then(answer)
        })
        .await;
        let changed = client
            .change_appointment(&cal_id(1), "CK1v1", &edit("New", None), "UTC")
            .await;
        assert_eq!(changed.err(), Some(code));
        assert_eq!(fake.log.count("UpdateItem"), 1, "{code}");
    }
    let dentist = appointment(
        "Dentist",
        timed("2026-10-05T07:00:00Z", "2026-10-05T07:30:00Z"),
    );
    let (fake, mut client, _) = calendar(Vec::new(), |soap| {
        (soap.op == "CreateItem").then_some(Out::Drop)
    })
    .await;
    assert_eq!(
        client.create_appointment(&dentist, "UTC").await.err(),
        Some(unknown)
    );
    assert_eq!(fake.log.count("CreateItem"), 1);
    // A refused password: the folder lookup finds it, and the appointment is never written.
    let mut wrong = super::conn::client(&fake, Choice::Basic, "wrong");
    assert_eq!(
        wrong.create_appointment(&dentist, "UTC").await.err(),
        Some("exchange_unauthorized")
    );
    assert_eq!(fake.log.count("CreateItem"), 1);
}

#[tokio::test]
async fn a_drag_writes_the_time_alone_and_an_id_the_codec_refuses_is_no_failure() {
    // An empty subject the screen draws as a placeholder, and a place it could not write back.
    let mut bare = Cal::new(1, "", "2026-10-05T09:00:00Z", "2026-10-05T09:30:00Z");
    bare.location = "Room\t4".into();
    let (fake, mut client, store) = calendar(vec![bare], |_| None).await;
    let moved = Edit {
        title: None,
        location: None,
        when: Some(timed("2026-10-05T10:00:00Z", "2026-10-05T10:30:00Z")),
    };
    client
        .change_appointment(&cal_id(1), "CK1v1", &moved, "UTC")
        .await
        .unwrap();
    let cal = store.lock().unwrap().items[0].clone();
    let kept = (cal.subject.as_str(), cal.location.as_str(), cal.start);
    assert_eq!(kept, ("", "Room\t4", secs("2026-10-05T10:00:00Z")));
    let request = store.lock().unwrap().requests.last().unwrap().clone();
    assert!(!request.contains("item:Subject") && !request.contains("calendar:Location"));
    // Nothing named and nothing to send: the read alone answers.
    let nothing = Edit {
        title: None,
        location: None,
        when: None,
    };
    let same = client
        .change_appointment(&cal_id(1), "CK1v2", &nothing, "UTC")
        .await;
    assert_eq!(same.unwrap().change_key, "CK1v2");
    assert_eq!(fake.log.count("UpdateItem"), 1);
    // A write the server confirmed with an id the codec refuses is answered like one with none.
    let odd = |soap: &Soap| {
        let id = r#"<m:Items><t:CalendarItem><t:ItemId Id="AAAA" ChangeKey="K"/></t:CalendarItem></m:Items>"#;
        let kind = soap.op.clone();
        ["CreateItem", "UpdateItem"]
            .contains(&kind.as_str())
            .then(|| Out::Xml(response(&kind, &[ok(&kind, id)])))
    };
    let (_fake, mut client, _) = calendar(vec![october(1, 5)], odd).await;
    let made = client
        .create_appointment(&appointment("x", timed(FROM, TO)), "UTC")
        .await
        .expect("confirmed, never a failure");
    assert_eq!((made.id.as_str(), made.change_key.as_str()), ("", "K"));
    let changed = client
        .change_appointment(&cal_id(1), "CK1v1", &edit("New", None), "UTC")
        .await;
    assert_eq!(changed.unwrap().id, cal_id(1));
}
