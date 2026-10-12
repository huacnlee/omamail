use super::*;
use crate::providers::exchange::ews::decode::envelope;
use crate::providers::exchange::ews::tests::fake;

fn decoded(kind: &str, inner: &str) -> Node {
    let body = fake::response(kind, &[fake::ok(kind, inner)]);
    envelope(body.as_bytes()).unwrap().body
}

fn view(items: &str, attrs: &str) -> Result<CalendarPage, Rej> {
    let root = format!("<m:RootFolder{attrs}><t:Items>{items}</t:Items></m:RootFolder>");
    calendar_view(&decoded("FindItem", &root))
}

const TIMES: &str = "<t:Start>2026-10-05T07:00:00Z</t:Start><t:End>2026-10-05T07:30:00Z</t:End>";

fn one(inner: &str) -> CalendarItem {
    let item = format!(
        r#"<t:CalendarItem><t:ItemId Id="AAMk" ChangeKey="Dw+/="/>{TIMES}{inner}</t:CalendarItem>"#
    );
    view(&item, "").unwrap().items.pop().unwrap()
}

#[test]
fn an_item_is_read_from_the_elements_the_shape_asks_for() {
    let item = one(concat!(
        "<t:Subject>Standup </t:Subject><t:Location>Room 4</t:Location><t:UID> u-1 </t:UID>",
        "<t:Organizer><t:Mailbox><t:Name>Ada</t:Name></t:Mailbox></t:Organizer>",
        "<t:IsAllDayEvent>true</t:IsAllDayEvent><t:IsMeeting>1</t:IsMeeting><t:IsRecurring>yes</t:IsRecurring>",
        "<t:StartWallClock>2026-10-05T09:00:00Z</t:StartWallClock>",
        "<t:EndWallClock>2026-10-05T09:30:00.5+02:00</t:EndWallClock>",
        "<t:ReminderIsSet>true</t:ReminderIsSet><t:ReminderMinutesBeforeStart>15</t:ReminderMinutesBeforeStart>",
        "<t:LegacyFreeBusyStatus>OOF</t:LegacyFreeBusyStatus><t:MyResponseType>Accept</t:MyResponseType>",
        "<t:CalendarItemType>Occurrence</t:CalendarItemType>"
    ));
    let texts = [
        &item.id,
        &item.change_key,
        &item.uid,
        &item.subject,
        &item.location,
        &item.organizer,
    ];
    assert_eq!(texts, ["AAMk", "Dw+/=", "u-1", "Standup ", "Room 4", "Ada"]);
    assert_eq!(
        (item.start_ms, item.end_ms),
        (1_791_183_600_000, 1_791_185_400_000)
    );
    // A wall clock is the event's own clock: a zone on it is dropped, not applied.
    let wall = |text| NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f").ok();
    let walls = (wall("2026-10-05T09:00:00"), wall("2026-10-05T09:30:00.5"));
    assert_eq!((item.start_wall, item.end_wall), walls);
    let flags = [
        item.all_day,
        item.meeting,
        item.recurring,
        item.cancelled,
        item.private,
    ];
    assert_eq!(
        flags,
        [true, true, false, false, false],
        "a flag is true or 1"
    );
    let words = (item.busy, item.response, item.kind, item.reminder_minutes);
    assert_eq!(words, ("oof", "accept", "occurrence", Some(15)));
}

#[test]
fn what_nobody_could_classify_gets_the_cautious_default() {
    let bare = one("");
    let words = (bare.busy, bare.response, bare.kind, bare.private);
    assert_eq!(words, ("busy", "unknown", "unknown", false));
    assert_eq!((bare.start_wall, bare.reminder_minutes), (None, None));
    let sensitivities = [
        "Normal",
        "Personal",
        "Private",
        "Confidential",
        "Secret",
        "",
    ];
    let private =
        sensitivities.map(|s| one(&format!("<t:Sensitivity>{s}</t:Sensitivity>")).private);
    assert_eq!(private, [false, false, true, true, true, true]);
    for wall in [
        "2026-10-05",
        "1969-12-31T23:00:00",
        "2026-10-05T09:00:00 x",
        "2026-13-05T09:00:00",
    ] {
        let item = one(&format!("<t:StartWallClock>{wall}</t:StartWallClock>"));
        assert_eq!(item.start_wall, None, "{wall}");
    }
    let set = "<t:ReminderIsSet>true</t:ReminderIsSet>";
    for minutes in ["40321", "-5"] {
        let reminder =
            format!("{set}<t:ReminderMinutesBeforeStart>{minutes}</t:ReminderMinutesBeforeStart>");
        assert_eq!(one(&reminder).reminder_minutes, None, "{minutes}");
    }
    let unset = "<t:ReminderMinutesBeforeStart>15</t:ReminderMinutesBeforeStart>";
    assert_eq!(one(unset).reminder_minutes, None);
    // Bounded, and a uid too long to be one is dropped, not cut into another.
    let long = format!(
        "<t:Subject>{}</t:Subject><t:UID>{}</t:UID>",
        "é".repeat(600),
        "u".repeat(513)
    );
    let long = one(&long);
    assert_eq!((long.subject.len(), long.uid.as_str()), (1000, ""));
    // A change key a write could not send back is no key.
    let item =
        format!(r#"<t:CalendarItem><t:ItemId Id="A" ChangeKey="a b"/>{TIMES}</t:CalendarItem>"#);
    assert_eq!(view(&item, "").unwrap().items[0].change_key, "");
}

#[test]
fn only_drawable_calendar_items_are_listed_and_an_item_without_an_id_is_damage() {
    let item = |n, times: &str| {
        format!(r#"<t:CalendarItem><t:ItemId Id="A{n}"/>{times}</t:CalendarItem>"#)
    };
    let items = [
        item(1, TIMES),
        item(2, "<t:Start>2026-10-05T07:00:00Z</t:Start>"),
        item(
            3,
            "<t:Start>soon</t:Start><t:End>2026-10-05T07:30:00Z</t:End>",
        ),
        item(
            4,
            "<t:Start>1969-12-31T23:00:00Z</t:Start><t:End>1970-01-01T01:00:00Z</t:End>",
        ),
        format!(r#"<t:Message><t:ItemId Id="M"/>{TIMES}</t:Message>"#),
    ];
    let page = view(&items.concat(), r#" IncludesLastItemInRange="false""#).unwrap();
    assert_eq!(
        (page.items.len(), page.elements, page.includes_last),
        (1, 5, Some(false))
    );
    assert_eq!(view(&items[0], "").unwrap().includes_last, None);
    assert!(view(&format!("<t:CalendarItem>{TIMES}</t:CalendarItem>"), "").is_err());
    assert!(view(&items[0], r#" IncludesLastItemInRange="maybe""#).is_err());
    assert!(view(&items[0].repeat(1001), "").is_err());
}

#[test]
fn a_plain_appointment_of_ones_own_is_the_only_unlocked_item() {
    let base = CalendarItem {
        kind: "single",
        response: "organizer",
        ..CalendarItem::default()
    };
    let with = |change: fn(&mut CalendarItem)| {
        let mut item = base.clone();
        change(&mut item);
        item.lock()
    };
    assert_eq!(
        (base.lock(), with(|item| item.response = "unknown")),
        (None, None)
    );
    for (change, lock) in [
        (
            (|item| (item.cancelled, item.meeting) = (true, true)) as fn(&mut CalendarItem),
            Lock::Cancelled,
        ),
        (|item| item.kind = "occurrence", Lock::Recurring),
        (|item| item.kind = "master", Lock::Recurring),
        (|item| item.recurring = true, Lock::Recurring),
        (|item| item.kind = "unknown", Lock::Unknown),
        (|item| item.meeting = true, Lock::Meeting),
        (|item| item.attendees = 1, Lock::Meeting),
        (|item| item.response = "accept", Lock::Foreign),
        (|item| item.response = "none", Lock::Foreign),
        (|item| item.private = true, Lock::Private),
    ] {
        assert_eq!(with(change), Some(lock));
    }
}

#[test]
fn a_read_for_a_write_counts_the_people_and_a_write_answers_its_id_and_key() {
    let get =
        |items: &str| appointment(&decoded("GetItem", &format!("<m:Items>{items}</m:Items>")));
    let people = "<t:Attendee/><t:Attendee/>";
    let lists = format!(
        "<t:RequiredAttendees>{people}</t:RequiredAttendees><t:Resources>{people}</t:Resources>"
    );
    let item = format!(r#"<t:CalendarItem><t:ItemId Id="A"/>{TIMES}{lists}</t:CalendarItem>"#);
    assert_eq!(get(&item).unwrap().unwrap().attendees, 4);
    assert_eq!(
        get(r#"<t:Message><t:ItemId Id="A"/></t:Message>"#).unwrap(),
        None
    );
    let missing = fake::response(
        "GetItem",
        &[fake::message("GetItem", "Error", "ErrorItemNotFound", "")],
    );
    let missing = appointment(&envelope(missing.as_bytes()).unwrap().body);
    assert_eq!(
        missing.err().map(|rej| rej.code),
        Some("exchange_message_not_found")
    );
    let made = |inner: &str| {
        written(&decoded("CreateItem", inner), "CreateItem")
            .unwrap()
            .unwrap()
    };
    let echoed = r#"<m:Items><t:CalendarItem><t:ItemId Id="AAMk" ChangeKey="K1"/></t:CalendarItem></m:Items>"#;
    assert_eq!(made(echoed), ("AAMk".to_owned(), "K1".to_owned()));
    // A server that echoes nothing still did what it was asked.
    assert_eq!(made(""), (String::new(), String::new()));
}
