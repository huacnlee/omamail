use super::*;
use crate::providers::exchange::ews::decode::envelope;
use crate::providers::exchange::ews::tests::fake;

const TIMES: &str = "<t:Start>2026-10-05T07:00:00Z</t:Start><t:End>2026-10-05T07:30:00Z</t:End>";

/// An invitation as the owner's copy has it; `inner` comes first and overrides it.
const INVITED: &str = concat!(
    "<t:IsMeeting>true</t:IsMeeting><t:MyResponseType>NoResponseReceived</t:MyResponseType>",
    "<t:CalendarItemType>Single</t:CalendarItemType><t:AppointmentState>3</t:AppointmentState>",
    "<t:IsOrganizer>false</t:IsOrganizer><t:UID>u-1</t:UID>",
    "<t:ResponseObjects><t:AcceptItem/><t:DeclineItem/></t:ResponseObjects>",
);

fn read(inner: &str) -> Result<Option<EventDetail>, Rej> {
    let item = format!(
        r#"<m:Items><t:CalendarItem><t:ItemId Id="AAMk" ChangeKey="Dw+/="/>{TIMES}{inner}{INVITED}</t:CalendarItem></m:Items>"#
    );
    let body = fake::response("GetItem", &[fake::ok("GetItem", &item)]);
    detail(&envelope(body.as_bytes()).unwrap().body)
}

fn one(inner: &str) -> EventDetail {
    read(inner).unwrap().unwrap()
}

fn mailbox(name: &str, address: &str) -> String {
    format!(
        "<t:Mailbox><t:Name>{name}</t:Name><t:EmailAddress>{address}</t:EmailAddress></t:Mailbox>"
    )
}

#[test]
fn a_detail_reads_the_people_their_answers_the_link_and_what_decides_an_answer() {
    let attendee = |who: String, answer: &str| {
        format!("<t:Attendee>{who}<t:ResponseType>{answer}</t:ResponseType></t:Attendee>")
    };
    let found = one(&format!(
        concat!(
            "<t:Subject>Planning</t:Subject><t:Organizer>{}</t:Organizer>",
            "<t:RequiredAttendees>{}{}</t:RequiredAttendees><t:OptionalAttendees>{}</t:OptionalAttendees>",
            "<t:Resources>{}</t:Resources>",
            "<t:JoinOnlineMeetingUrl> https://meet.example.org/j/1?p=x </t:JoinOnlineMeetingUrl>",
            "<t:ReminderIsSet>true</t:ReminderIsSet><t:ReminderMinutesBeforeStart>10</t:ReminderMinutesBeforeStart>",
        ),
        mailbox("Bob", "bob@example.org"),
        attendee(mailbox("Ada", "ada@example.org"), "NoResponseReceived"),
        attendee(mailbox("", "cy@example.org"), "Maybe"),
        attendee(
            mailbox("Dee", "/o=Example/cn=Dee").replace(
                "</t:Mailbox>",
                "<t:RoutingType>EX</t:RoutingType></t:Mailbox>"
            ),
            "Accept"
        ),
        attendee(mailbox("Room 4", "room4@example.org"), "Organizer"),
    ));
    let who = found
        .organizer
        .as_ref()
        .map(|who| (who.name.as_str(), who.address.as_str()));
    assert_eq!(who, Some(("Bob", "bob@example.org")));
    let people: Vec<String> = found
        .attendees
        .iter()
        .map(|a| format!("{} {} {} {}", a.who.name, a.who.address, a.kind, a.response))
        .collect();
    // A word that is not Microsoft's is unknown; an X.500 name is a name and no address.
    let expected = [
        "Ada ada@example.org required none",
        " cy@example.org required unknown",
        "Dee  optional accept",
        "Room 4 room4@example.org resource organizer",
    ];
    assert_eq!(people, expected);
    assert_eq!(found.join_url, "https://meet.example.org/j/1?p=x");
    assert_eq!(found.item.reminder_minutes, Some(10));
    let facts = (
        found.is_organizer,
        found.state,
        found.can_accept,
        found.cancellation,
    );
    assert_eq!(facts, (Some(false), Some(3), Some(true), Cancelled::No));
    assert!(found.invitation());
    // What is not a calendar item is no detail; a refusal is the server's code.
    let message = r#"<m:Items><t:Message><t:ItemId Id="AAMk"/></t:Message></m:Items>"#;
    let body = fake::response("GetItem", &[fake::ok("GetItem", message)]);
    assert_eq!(detail(&envelope(body.as_bytes()).unwrap().body), Ok(None));
    let body = fake::response(
        "GetItem",
        &[fake::message("GetItem", "Error", "ErrorItemNotFound", "")],
    );
    let refused = detail(&envelope(body.as_bytes()).unwrap().body);
    assert_eq!(
        refused.map_err(|rej| rej.code),
        Err("exchange_message_not_found")
    );
}

#[test]
fn only_an_https_link_with_no_user_name_is_a_link() {
    let long = format!("https://example.org/{}", "a".repeat(2048));
    for refused in [
        "http://meet.example.org/j/1",
        "https://ada:secret@meet.example.org/j/1",
        "https://meet.example.org/a b",
        "https://meet.example.org/\u{e9}",
        "https:///j/1",
        "javascript:alert(1)",
        long.as_str(),
    ] {
        let found = one(&format!(
            "<t:JoinOnlineMeetingUrl>{refused}</t:JoinOnlineMeetingUrl>"
        ));
        assert_eq!(found.join_url, "", "{refused}");
    }
}

#[test]
fn the_notes_are_plain_text_whatever_the_server_sends_and_say_when_they_are_cut() {
    let body = |kind: &str, text: &str, more: &str| {
        let text = quick_xml::escape::escape(text);
        one(&format!(
            r#"<t:Body BodyType="{kind}"{more}>{text}</t:Body>"#
        ))
    };
    let html = concat!(
        "<html><head><style>p { color: red }</style><script>alert('x')</script></head>",
        "<body><!-- note --><p>Agenda &amp; notes</p><div>Room&nbsp;4 &#x2192; &lt;b&gt;</div>",
        "<br>Line\u{1}<p></p><p></p><p>end &unknown; &#99999999;</p></body></html>"
    );
    let found = body("HTML", html, "");
    assert_eq!(
        found.notes,
        "Agenda & notes\n\nRoom 4 \u{2192} <b>\n\nLine\n\nend &unknown; &#99999999;"
    );
    assert!(!found.notes_cut);
    // Text as text, its line ends made one, and cut on a character boundary with a word that says so.
    let found = body("Text", "one\r\ntwo\rthree\u{7}", "");
    assert_eq!(found.notes, "one\ntwo\nthree");
    let long = "\u{e9}".repeat(9000);
    let found = body("Text", &long, "");
    assert!(found.notes_cut && found.notes.len() <= 16 * 1024 && found.notes.ends_with('\u{e9}'));
    assert!(body("Text", "short", r#" IsTruncated="true""#).notes_cut);
    // A tag that never ends takes the rest with it, and costs only text.
    assert_eq!(body("HTML", "kept <a href='x", "").notes, "kept");
}

#[test]
fn the_people_are_bounded_and_the_rest_said_to_be_cut() {
    let one_of =
        |name: &str, address: &str| format!("<t:Attendee>{}</t:Attendee>", mailbox(name, address));
    let many: String = (0..250)
        .map(|n| one_of("", &format!("p{n}@example.org")))
        .collect();
    let long = format!("{}@example.org", "a".repeat(320));
    let found = one(&format!(
        "<t:OptionalAttendees>{}</t:OptionalAttendees><t:RequiredAttendees>{many}</t:RequiredAttendees>",
        one_of(&"N".repeat(400), &long),
    ));
    assert_eq!((found.attendees.len(), found.attendees_cut), (200, true));
    let last = found.attendees.last().unwrap();
    assert_eq!(last.who.address, "p199@example.org", "required first");
    let few = one(&format!(
        "<t:RequiredAttendees>{}</t:RequiredAttendees>",
        one_of(&"N".repeat(400), &long)
    ));
    // An address cut short would be somebody else's: over its bound it is dropped, a name is cut.
    let who = &few.attendees[0].who;
    let shown = (who.name.len(), who.address.as_str(), few.attendees_cut);
    assert_eq!(shown, (320, "", false));
}

#[test]
fn an_invitation_is_one_only_when_every_signal_agrees() {
    assert!(one("").invitation());
    for (veto, still_received) in [
        ("<t:IsOrganizer>true</t:IsOrganizer>", false),
        ("<t:AppointmentState>1</t:AppointmentState>", false),
        ("<t:IsMeeting>false</t:IsMeeting>", false),
        ("<t:Sensitivity>Confidential</t:Sensitivity>", false),
        ("<t:MyResponseType>Organizer</t:MyResponseType>", false),
        ("<t:MyResponseType>Unknown</t:MyResponseType>", false),
        (
            "<t:CalendarItemType>RecurringMaster</t:CalendarItemType>",
            false,
        ),
        ("<t:CalendarItemType>Something</t:CalendarItemType>", false),
        ("<t:IsCancelled>true</t:IsCancelled>", true),
        (
            "<t:ResponseObjects><t:DeclineItem/></t:ResponseObjects>",
            true,
        ),
    ] {
        let found = one(veto);
        assert!(!found.invitation(), "{veto}");
        assert_eq!(found.incoming(), still_received, "{veto}");
    }
    // A signal the server does not give is no veto; an answer already given may be changed.
    for inner in [
        "<t:IsOrganizer>maybe</t:IsOrganizer><t:AppointmentState>x</t:AppointmentState>",
        "<t:MyResponseType>Decline</t:MyResponseType><t:CalendarItemType>Occurrence</t:CalendarItemType>",
    ] {
        assert!(one(inner).invitation(), "{inner}");
    }
    for (cancellation, reduced) in [
        (Cancelled::Yes, false),
        (Cancelled::Unplaced, false),
        (Cancelled::No, true),
    ] {
        let waiting = EventDetail {
            cancellation,
            reduced,
            ..one("")
        };
        assert!(
            waiting.incoming() && !waiting.invitation(),
            "{cancellation:?} {reduced}"
        );
    }
}

#[test]
fn a_cancellation_is_for_the_meeting_of_its_uid_or_else_the_item_it_names() {
    let found = |items: &str| {
        let root = format!(r#"<m:RootFolder><t:Items>{items}</t:Items></m:RootFolder>"#);
        let body = fake::response("FindItem", &[fake::ok("FindItem", &root)]);
        cancellations(&envelope(body.as_bytes()).unwrap().body)
    };
    let listed = found(&format!(
        concat!(
            r#"<t:MeetingCancellation><t:ItemId Id="M1"/><t:UID> u-1 </t:UID></t:MeetingCancellation>"#,
            r#"<t:Message><t:ItemId Id="M2"/><t:UID>u-2</t:UID></t:Message>"#,
            r#"<t:MeetingCancellation><t:ItemId Id="M3"/><t:UID>{}</t:UID>"#,
            r#"<t:AssociatedCalendarItemId Id="AAMk"/></t:MeetingCancellation>"#,
            r#"<t:MeetingCancellation><t:ItemId Id="M4"/><t:UID>u-4</t:UID>"#,
            "<t:RecurrenceId>2026-10-05T07:00:00Z</t:RecurrenceId></t:MeetingCancellation>",
            r#"<t:MeetingCancellation><t:ItemId Id="M5"/><t:UID>u-1</t:UID>"#,
            "<t:IsOutOfDate>true</t:IsOutOfDate></t:MeetingCancellation>"
        ),
        "u".repeat(513)
    ))
    .unwrap();
    let shown: Vec<(&str, &str, Option<i64>)> = listed
        .iter()
        .map(|c| (c.uid.as_str(), c.associated.as_str(), c.occurrence))
        .collect();
    let at = 1_791_183_600_000;
    let expected = [
        ("u-1", "", None),
        ("", "AAMk", None),
        ("u-4", "", Some(at)),
        ("u-1", "", None),
    ];
    assert_eq!(shown, expected, "a uid too long is none");
    let dated: Vec<bool> = listed.iter().map(|c| c.out_of_date).collect();
    assert_eq!(dated, [false, false, false, true]);
    let item = |uid: &str, id: &str, kind: &'static str, position: Option<i64>| EventDetail {
        item: CalendarItem {
            uid: uid.into(),
            id: id.into(),
            kind,
            ..CalendarItem::default()
        },
        position,
        ..EventDetail::default()
    };
    let (yes, no, unplaced) = (Cancelled::Yes, Cancelled::No, Cancelled::Unplaced);
    let by_uid = &listed[0];
    assert_eq!(by_uid.is_for(&item("u-1", "x", "occurrence", Some(5))), yes);
    assert_eq!(by_uid.is_for(&item("u-9", "x", "single", None)), no);
    let by_item = &listed[1];
    assert_eq!(by_item.is_for(&item("", "AAMk", "single", None)), yes);
    assert_eq!(by_item.is_for(&item("", "BBMk", "single", None)), no);
    // One event of a series is the item at that place, whatever its kind; one that does not say where
    // it sits may be it, and is said to be in doubt.
    let event = &listed[2];
    assert_eq!(event.is_for(&item("u-4", "x", "exception", Some(at))), yes);
    assert_eq!(event.is_for(&item("u-4", "x", "single", Some(at))), yes);
    assert_eq!(
        event.is_for(&item("u-4", "x", "occurrence", Some(at + 1))),
        no
    );
    let doubt = event.is_for(&item("u-4", "x", "occurrence", None));
    assert_eq!(doubt, unplaced, "a place not said is a doubt");
    // One the server says is out of date cancels nothing, though its uid is the meeting's.
    let old = listed[3].is_for(&item("u-1", "x", "single", None));
    assert_eq!(old, no, "a newer message of the meeting came after it");
    // Two different uids are two meetings, whatever the message names as its own.
    let both = Cancellation {
        uid: "u-1".into(),
        associated: "AAMk".into(),
        occurrence: None,
        out_of_date: false,
    };
    assert_eq!(both.is_for(&item("u-2", "AAMk", "single", None)), no);
    assert_eq!(
        found(&"<t:Message/>".repeat(1001)).err(),
        Some(Rej::INVALID)
    );
    // Where an event of a series sits: its RecurrenceId, else its OriginalStart.
    let position = |inner: &str| one(inner).position;
    let original = "<t:OriginalStart>2026-10-05T07:00:00Z</t:OriginalStart>";
    assert_eq!(position(original), Some(at));
    let both = format!("<t:RecurrenceId>2026-10-06T07:00:00Z</t:RecurrenceId>{original}");
    assert_eq!(position(&both), Some(at + 86_400_000));
}
