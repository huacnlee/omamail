use super::*;
use crate::providers::exchange::ews::xml::{self, Node};

const VIENNA: &str = "W. Europe Standard Time";

/// The operation of a request, and the zone its header names.
fn parsed(request: &str) -> (Node, Option<String>) {
    let mut root = xml::parse(request.as_bytes()).expect("a request is well-formed XML");
    let zone = root.at(&["Header", "TimeZoneContext", "TimeZoneDefinition"]);
    assert!(
        zone.is_none_or(|zone| zone.children.is_empty()),
        "a bare id"
    );
    let zone = zone.and_then(|zone| zone.attr("Id").map(str::to_owned));
    let body = root.children.iter().position(|child| child.name == "Body");
    (
        root.children.swap_remove(body.unwrap()).children.remove(0),
        zone,
    )
}

fn names(node: &Node) -> Vec<&str> {
    node.children
        .iter()
        .map(|child| child.name.as_str())
        .collect()
}

fn ms(text: &str) -> i64 {
    DateTime::parse_from_rfc3339(text)
        .unwrap()
        .timestamp_millis()
}

fn timed(start: &str, end: &str) -> When {
    When::Timed {
        start_ms: ms(start),
        end_ms: ms(end),
    }
}

fn days(first: &str, after: &str) -> When {
    let day = |text: &str| text.parse().unwrap();
    When::AllDay {
        first: day(first),
        after: day(after),
    }
}

fn plain(title: &str, when: When) -> Appointment {
    let (title, location) = (title.into(), String::new());
    Appointment {
        title,
        location,
        notes: None,
        when,
    }
}

const HOUR: (&str, &str) = ("2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z");

#[test]
fn a_view_asks_the_calendar_folder_for_a_range_in_utc_and_the_optional_shape_only_when_asked() {
    let (start, end) = (
        ms("2026-10-01T00:00:00.500Z"),
        ms("2026-11-01T00:00:00.001Z"),
    );
    let (find, zone) = parsed(&calendar_view(start, end, 100, true).unwrap());
    assert_eq!(zone, None);
    // Whole seconds, and a range never shrinks.
    let view = find.child("CalendarView").unwrap();
    let attrs = ["StartDate", "EndDate", "MaxEntriesReturned"].map(|name| view.attr(name));
    let expected = ["2026-10-01T00:00:00Z", "2026-11-01T00:00:01Z", "100"];
    assert_eq!(attrs, expected.map(Some));
    let folder = find
        .at(&["ParentFolderIds", "DistinguishedFolderId"])
        .unwrap();
    assert_eq!(folder.attr("Id"), Some("calendar"));
    let shape = find.at(&["ItemShape", "AdditionalProperties"]).unwrap();
    let uris: Vec<&str> = shape
        .children
        .iter()
        .filter_map(|f| f.attr("FieldURI"))
        .collect();
    assert_eq!(
        uris.len(),
        (VIEW.to_owned() + " " + OPTIONAL)
            .split_whitespace()
            .count()
    );
    assert!(
        !uris
            .iter()
            .any(|uri| uri.contains("Body") || uri.contains("Preview"))
    );
    assert!(!uris.iter().any(|uri| uri.contains("Attendees")));
    let plain = calendar_view(0, 1000, 1, false).unwrap();
    assert!(OPTIONAL.split_whitespace().all(|uri| !plain.contains(uri)));
    let refused = [
        (-1, 1000, 1),
        (1000, 999, 1),
        (0, MAX_CURSOR_MS + 1, 1),
        (0, 1, 0),
        (0, 1, 101),
    ];
    for (start, end, max) in refused {
        assert_eq!(
            calendar_view(start, end, max, true),
            Err(INVALID),
            "{start} {end} {max}"
        );
    }
}

#[test]
fn a_new_appointment_is_instants_or_days_in_the_calendar_folder_and_invites_nobody() {
    let item = Appointment {
        location: "Room 4".into(),
        notes: Some("Bring\tthe plans\r\n".into()),
        ..plain("Dentist", timed("2026-10-05T01:00:00.900Z", HOUR.1))
    };
    let (create, zone) = parsed(&create_appointment(&item, VIENNA).unwrap());
    assert_eq!(zone, None, "an instant with its Z needs no zone");
    let only = ("SendMeetingInvitations".to_owned(), "SendToNone".to_owned());
    assert_eq!(
        create.attrs,
        [only],
        "no MessageDisposition, which is for messages"
    );
    let folder = create.at(&["SavedItemFolderId", "DistinguishedFolderId"]);
    assert_eq!(folder.unwrap().attr("Id"), Some("calendar"));
    let made = create.at(&["Items", "CalendarItem"]).unwrap();
    // The order the schema keeps a calendar item's elements in.
    let order = "Subject Body ReminderIsSet Start End IsAllDayEvent LegacyFreeBusyStatus Location";
    assert_eq!(names(made).join(" "), order);
    let text = |made: &Node, name| made.child(name).unwrap().text.clone();
    let values = [
        "Start",
        "End",
        "ReminderIsSet",
        "LegacyFreeBusyStatus",
        "Body",
    ]
    .map(|n| text(made, n));
    let expected = [HOUR.0, HOUR.1, "false", "Busy", "Bring\tthe plans\r\n"];
    assert_eq!(values, expected, "whole seconds; notes kept as they are");
    // A day is its days with no zone on them, and the owner's zone in the header.
    let day = plain("Off", days("2026-10-25", "2026-10-26"));
    let (create, zone) = parsed(&create_appointment(&day, VIENNA).unwrap());
    assert_eq!(zone.as_deref(), Some(VIENNA));
    let made = create.at(&["Items", "CalendarItem"]).unwrap();
    let values = ["Start", "End", "IsAllDayEvent", "LegacyFreeBusyStatus"].map(|n| text(made, n));
    assert_eq!(
        values,
        ["2026-10-25T00:00:00", "2026-10-26T00:00:00", "true", "Free"]
    );
    assert_eq!(
        names(made).len(),
        6,
        "no place, no notes: no element for either"
    );
    // A day needs a zone that can be written; a time ignores it.
    assert_eq!(create_appointment(&day, "a\"b"), Err(INVALID));
    assert!(create_appointment(&plain("x", timed(HOUR.0, HOUR.1)), "a\"b").is_ok());
}

#[test]
fn an_update_names_its_version_sets_only_what_changes_and_never_overwrites_or_mails() {
    let fields = |change: &Change| {
        let request = update_appointment("AAMk+/=", "Dw+/=", change, VIENNA).unwrap();
        let (update, zone) = parsed(&request);
        let attrs: Vec<String> = update
            .attrs
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        let options = "MessageDisposition=SaveOnly ConflictResolution=NeverOverwrite";
        let expected = format!("{options} SendMeetingInvitationsOrCancellations=SendToNone");
        assert_eq!(attrs.join(" "), expected);
        let id = update.at(&["ItemChanges", "ItemChange", "ItemId"]).unwrap();
        assert_eq!(
            (id.attr("Id"), id.attr("ChangeKey")),
            (Some("AAMk+/="), Some("Dw+/="))
        );
        let updates = update
            .at(&["ItemChanges", "ItemChange", "Updates"])
            .unwrap();
        let uri = |set: &Node| {
            set.child("FieldURI")
                .unwrap()
                .attr("FieldURI")
                .unwrap()
                .to_owned()
        };
        (
            updates
                .children
                .iter()
                .map(uri)
                .collect::<Vec<_>>()
                .join(" "),
            zone,
        )
    };
    let title = Change {
        title: Some("New"),
        ..Change::default()
    };
    assert_eq!(fields(&title), ("item:Subject".into(), None));
    let moved = Change {
        location: Some(""),
        when: Some(timed(HOUR.0, HOUR.1)),
        ..Change::default()
    };
    let times = "calendar:IsAllDayEvent calendar:Start calendar:End";
    assert_eq!(fields(&moved), (format!("calendar:Location {times}"), None));
    let to_day = Change {
        when: Some(days("2026-10-25", "2026-10-26")),
        ..Change::default()
    };
    let zones = "calendar:IsAllDayEvent calendar:StartTimeZone calendar:EndTimeZone";
    let expected = format!("{zones} calendar:Start calendar:End");
    assert_eq!(fields(&to_day), (expected, Some(VIENNA.to_owned())));
    let request = update_appointment("A", "K", &to_day, VIENNA).unwrap();
    assert!(request.contains(r#"<t:StartTimeZone Id="W. Europe Standard Time"/>"#));
    let long = "k".repeat(201);
    for key in ["", "a b", "a\"b", long.as_str()] {
        assert_eq!(
            update_appointment("A", key, &title, VIENNA),
            Err(INVALID),
            "{key:?}"
        );
        assert_eq!(delete_appointment("A", key), Err(INVALID), "{key:?}");
    }
    assert_eq!(
        update_appointment("A", "K", &Change::default(), VIENNA),
        Err(INVALID)
    );
}

#[test]
fn no_request_can_mail_anybody_or_name_a_person_whatever_it_is_given() {
    let tricky = "Room\" SendMeetingInvitations=\"SendToAllAndSaveCopy <t:Attendee>";
    let item = Appointment {
        location: tricky.into(),
        notes: Some(tricky.into()),
        ..plain(tricky, days("2026-10-25", "2026-10-26"))
    };
    let change = Change {
        title: Some(tricky),
        location: Some(tricky),
        when: Some(item.when),
    };
    let requests = [
        calendar_view(0, 1000, 1, true).unwrap(),
        get_appointment("AAMk"),
        create_appointment(&item, VIENNA).unwrap(),
        update_appointment("AAMk", "K", &change, VIENNA).unwrap(),
        delete_appointment("AAMk", "K").unwrap(),
    ];
    let allowed = [
        "SendToNone",
        "SaveOnly",
        "NeverOverwrite",
        "MoveToDeletedItems",
        "Shallow",
    ];
    for request in &requests {
        let (operation, _) = parsed(request);
        // What happens to people is the operation's to say: nothing, in every request there is.
        for (name, value) in &operation.attrs {
            assert!(allowed.contains(&value.as_str()), "{name}={value}");
        }
        let mut stack = vec![&operation];
        while let Some(node) = stack.pop() {
            assert!(!node.name.contains("Attendee"), "{request}");
            stack.extend(node.children.iter());
        }
    }
    let (delete, _) = parsed(&requests[4]);
    assert_eq!(delete.attr("DeleteType"), Some("MoveToDeletedItems"));
    let id = delete.at(&["ItemIds", "ItemId"]).unwrap();
    assert_eq!(id.attr("ChangeKey"), Some("K"));
    // The read before a write is the one request that asks for the attendee lists, and it asks for
    // the folder the item is in, which must be the default calendar's.
    assert!(requests[1].contains("calendar:RequiredAttendees"));
    assert!(requests[1].contains(r#"FieldURI="item:ParentFolderId""#));
    let folder = get_calendar_folder();
    assert!(folder.contains(r#"<t:DistinguishedFolderId Id="calendar"/>"#));
    assert!(!requests[1].contains("item:Body"));
}

#[test]
fn nothing_is_repaired_a_field_or_a_time_that_cannot_be_written_is_a_refusal() {
    let when = timed(HOUR.0, HOUR.1);
    let (title, place, notes) = ("x".repeat(1001), "x".repeat(501), "x".repeat(32 * 1024 + 1));
    for (title, location, notes) in [
        ("", "", None),
        ("   ", "", None),
        ("a\nb", "", None),
        ("a\u{FFFE}", "", None),
        (title.as_str(), "", None),
        ("ok", "a\tb", None),
        ("ok", place.as_str(), None),
        ("ok", "", Some("a\u{0}b")),
        ("ok", "", Some(notes.as_str())),
    ] {
        let (title, location, notes) = (title.into(), location.into(), notes.map(str::to_owned));
        let item = Appointment {
            title,
            location,
            notes,
            when,
        };
        assert_eq!(create_appointment(&item, VIENNA), Err(INVALID), "{item:?}");
    }
    let before_1970 = When::Timed {
        start_ms: -1000,
        end_ms: 1000,
    };
    for when in [
        timed("2026-10-05T02:00:00Z", "2026-10-05T02:00:00.999Z"),
        timed(HOUR.1, HOUR.0),
        timed("2026-10-05T00:00:00Z", "2027-10-07T00:00:00Z"),
        before_1970,
        days("2026-10-05", "2026-10-05"),
        days("1969-12-31", "1970-01-01"),
        days("2026-01-01", "2027-01-03"),
    ] {
        assert_eq!(
            create_appointment(&plain("x", when), VIENNA),
            Err(INVALID),
            "{when:?}"
        );
    }
    // Escaped, so no text can become markup.
    let (create, _) = parsed(&create_appointment(&plain("<b>&\"'", when), VIENNA).unwrap());
    let subject = create.at(&["Items", "CalendarItem", "Subject"]).unwrap();
    assert_eq!(subject.text, "<b>&\"'");
}
