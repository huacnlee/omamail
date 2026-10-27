use super::*;
use crate::providers::exchange::ews::xml::{self, Node};
use chrono::Weekday;

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
        recurrence: None,
        title,
        location,
        notes: None,
        reminder: None,
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
        reminder: Reminder::Minutes(15),
        when: Some(item.when),
        ..Change::default()
    };
    let requests = [
        calendar_view(0, 1000, 1, true).unwrap(),
        get_appointment("AAMk"),
        create_appointment(&item, VIENNA).unwrap(),
        update_appointment("AAMk", "K", &change, VIENNA).unwrap(),
        delete_appointment("AAMk", "K").unwrap(),
        event_detail("AAMk", true),
        find_cancellations(),
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
            recurrence: None,
            title,
            location,
            notes,
            reminder: None,
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

/// The `FieldURI`s a request's shape asks for.
fn uris(node: &Node) -> Vec<String> {
    let shape = node.at(&["ItemShape", "AdditionalProperties"]).unwrap();
    let uri = |f: &Node| f.attr("FieldURI").unwrap().to_owned();
    shape.children.iter().map(uri).collect()
}

#[test]
fn a_reminder_is_written_only_when_it_is_named_and_never_past_four_weeks() {
    let item = Appointment {
        reminder: Some(15),
        ..plain("Dentist", timed(HOUR.0, HOUR.1))
    };
    let (create, _) = parsed(&create_appointment(&item, VIENNA).unwrap());
    let made = create.at(&["Items", "CalendarItem"]).unwrap();
    let order = "Subject ReminderIsSet ReminderMinutesBeforeStart Start End IsAllDayEvent LegacyFreeBusyStatus";
    assert_eq!(names(made).join(" "), order);
    let set = ["ReminderIsSet", "ReminderMinutesBeforeStart"]
        .map(|n| made.child(n).unwrap().text.clone());
    assert_eq!(set, ["true", "15"]);
    let sets = |reminder| {
        let change = Change {
            reminder,
            ..Change::default()
        };
        let (update, _) = parsed(&update_appointment("A", "K", &change, VIENNA).unwrap());
        let updates = update
            .at(&["ItemChanges", "ItemChange", "Updates"])
            .unwrap();
        let one = |set: &Node| {
            let value = &set.child("CalendarItem").unwrap().children[0];
            format!(
                "{}={}",
                set.child("FieldURI").unwrap().attr("FieldURI").unwrap(),
                value.text
            )
        };
        updates
            .children
            .iter()
            .map(one)
            .collect::<Vec<_>>()
            .join(" ")
    };
    assert_eq!(sets(Reminder::Off), "item:ReminderIsSet=false");
    let expected = "item:ReminderIsSet=true item:ReminderMinutesBeforeStart=40320";
    assert_eq!(sets(Reminder::Minutes(40_320)), expected);
    let late = Appointment {
        reminder: Some(40_321),
        ..item
    };
    assert_eq!(create_appointment(&late, VIENNA), Err(INVALID));
    let change = Change {
        reminder: Reminder::Minutes(40_321),
        ..Change::default()
    };
    assert_eq!(update_appointment("A", "K", &change, VIENNA), Err(INVALID));
}

#[test]
fn the_detail_read_asks_for_the_body_as_text_and_the_2013_properties_only_when_asked() {
    let (get, zone) = parsed(&event_detail("AAMk+/=", true));
    assert_eq!((get.name.as_str(), zone), ("GetItem", None));
    let shape = get.child("ItemShape").unwrap();
    assert_eq!(
        names(shape).join(" "),
        "BaseShape BodyType AdditionalProperties"
    );
    assert_eq!(shape.child("BodyType").unwrap().text, "Text");
    let asked = uris(&get);
    for uri in [
        "item:Body",
        "item:ResponseObjects",
        "calendar:AppointmentState",
        "calendar:MyResponseType",
        "calendar:UID",
        "calendar:Resources",
        "calendar:IsOrganizer",
        "calendar:JoinOnlineMeetingUrl",
    ] {
        assert!(asked.iter().any(|found| found == uri), "{uri}");
    }
    let id = get.at(&["ItemIds", "ItemId"]).unwrap();
    assert_eq!(id.attrs, [("Id".to_owned(), "AAMk+/=".to_owned())]);
    let (plain, _) = parsed(&event_detail("AAMk", false));
    assert_eq!(uris(&plain).len(), asked.len() - 3);
    assert!(
        uris(&plain)
            .iter()
            .any(|uri| uri == "calendar:OriginalStart"),
        "where an event sits"
    );
    assert!(
        !uris(&plain)
            .iter()
            .any(|uri| uri.contains("Organizer") && uri != "calendar:Organizer")
    );
}

#[test]
fn an_answer_names_the_item_and_its_version_and_is_sent_to_the_organizer_or_saved_and_nothing_else()
{
    for (answer, element) in [
        (Answer::Accept, "AcceptItem"),
        (Answer::Tentative, "TentativelyAcceptItem"),
        (Answer::Decline, "DeclineItem"),
    ] {
        for (send, disposition) in [(true, "SendAndSaveCopy"), (false, "SaveOnly")] {
            let (create, zone) = parsed(&respond("AAMk+/=", "Dw+/=", answer, send).unwrap());
            assert_eq!(zone, None);
            let only = ("MessageDisposition".to_owned(), disposition.to_owned());
            assert_eq!(
                create.attrs,
                [only],
                "no SendMeetingInvitations, no SendOnly"
            );
            let items = create.child("Items").unwrap();
            assert_eq!(
                (names(&create), names(items)),
                (vec!["Items"], vec![element])
            );
            let reply = &items.children[0];
            assert_eq!(names(reply), ["ReferenceItemId"], "no body, no recipient");
            let reference = &reply.children[0];
            let attrs = [("Id", "AAMk+/="), ("ChangeKey", "Dw+/=")]
                .map(|(k, v)| (k.to_owned(), v.to_owned()));
            assert_eq!(reference.attrs, attrs);
        }
    }
    for key in ["", "a b", "a\"b"] {
        assert_eq!(
            respond("AAMk", key, Answer::Accept, true),
            Err(INVALID),
            "{key:?}"
        );
    }
    assert_eq!(
        (
            Answer::parse("tentative"),
            Answer::parse("maybe"),
            Answer::Decline.word()
        ),
        (Some(Answer::Tentative), None, "decline")
    );
}

#[test]
fn the_cancellations_are_the_inboxs_of_their_class_newest_first() {
    let (find, _) = parsed(&find_cancellations());
    let order = "ItemShape IndexedPageItemView Restriction SortOrder ParentFolderIds";
    assert_eq!(names(&find).join(" "), order);
    let class = find.at(&["Restriction", "IsEqualTo"]).unwrap();
    let field = class.child("FieldURI").unwrap().attr("FieldURI");
    let value = class
        .at(&["FieldURIOrConstant", "Constant"])
        .unwrap()
        .attr("Value");
    assert_eq!(
        (field, value),
        (
            Some("item:ItemClass"),
            Some("IPM.Schedule.Meeting.Canceled")
        )
    );
    let sort = find.at(&["SortOrder", "FieldOrder"]).unwrap();
    assert_eq!(sort.attr("Order"), Some("Descending"));
    let folder = find
        .at(&["ParentFolderIds", "DistinguishedFolderId"])
        .unwrap();
    assert_eq!(folder.attr("Id"), Some("inbox"));
    let asked = uris(&find).join(" ");
    let expected = "item:DateTimeReceived calendar:UID calendar:RecurrenceId meeting:AssociatedCalendarItemId meeting:IsOutOfDate";
    assert_eq!(asked, expected);
}

fn who(list: &[&str]) -> Vec<String> {
    list.iter().map(|a| (*a).to_owned()).collect()
}

/// The addresses of one attendee list, in order.
fn listed(node: &Node, list: &str) -> Vec<String> {
    node.child(list).map_or_else(Vec::new, |list| {
        let people = list.children("Attendee").into_iter();
        let address = |a: &Node| a.text_at(&["Mailbox", "EmailAddress"]).unwrap().to_owned();
        people.map(address).collect()
    })
}

#[test]
fn a_new_meeting_mails_its_people_with_a_copy_kept_and_nobody_is_no_meeting() {
    let guests = Guests {
        required: who(&["ada@example.org", "bob@example.org"]),
        optional: who(&["cy@example.org"]),
    };
    let lunch = Appointment {
        location: "Canteen".into(),
        ..plain("Lunch", timed(HOUR.0, HOUR.1))
    };
    let (create, zone) = parsed(&create_meeting(&lunch, &guests, VIENNA).unwrap());
    assert_eq!(zone, None, "instants need no zone");
    let only = (
        "SendMeetingInvitations".to_owned(),
        "SendToAllAndSaveCopy".to_owned(),
    );
    assert_eq!(
        create.attrs,
        [only],
        "no MessageDisposition: that is for messages"
    );
    let item = create.at(&["Items", "CalendarItem"]).unwrap();
    let order = names(item);
    let tail = &order[order.len() - 3..];
    assert_eq!(tail, ["Location", "RequiredAttendees", "OptionalAttendees"]);
    assert_eq!(listed(item, "RequiredAttendees"), guests.required);
    assert_eq!(listed(item, "OptionalAttendees"), guests.optional);
    // Only optional people: no required list, and still a meeting.
    let quiet = Guests {
        required: Vec::new(),
        optional: who(&["cy@example.org"]),
    };
    let (create, _) = parsed(&create_meeting(&lunch, &quiet, VIENNA).unwrap());
    let item = create.at(&["Items", "CalendarItem"]).unwrap();
    assert!(item.child("RequiredAttendees").is_none());
    // Nobody, or anybody who is not an address, is refused here too.
    for required in [
        &[][..],
        &["Ada <ada@example.org>"],
        &["ada@example.org", "ADA@example.org"],
    ] {
        let guests = Guests {
            required: who(required),
            optional: Vec::new(),
        };
        assert_eq!(
            create_meeting(&lunch, &guests, VIENNA),
            Err(INVALID),
            "{required:?}"
        );
    }
    // The appointment's own create still invites nobody.
    let (plain, _) = parsed(&create_appointment(&lunch, VIENNA).unwrap());
    assert_eq!(plain.attr("SendMeetingInvitations"), Some("SendToNone"));
}

#[test]
fn a_meeting_update_tells_everybody_never_overwrites_and_writes_a_list_whole_or_empties_it() {
    let required = who(&["ada@example.org", "dee@example.org"]);
    let change = Change {
        title: Some("Lunch, moved"),
        required: Some(&required),
        optional: Some(&[]),
        ..Change::default()
    };
    let (update, _) = parsed(&update_meeting("AAMk", "K", &change, VIENNA).unwrap());
    let attrs = [
        ("MessageDisposition", "SaveOnly"),
        ("ConflictResolution", "NeverOverwrite"),
        (
            "SendMeetingInvitationsOrCancellations",
            "SendToAllAndSaveCopy",
        ),
    ];
    assert_eq!(
        update.attrs,
        attrs.map(|(k, v)| (k.to_owned(), v.to_owned()))
    );
    let updates = update
        .at(&["ItemChanges", "ItemChange", "Updates"])
        .unwrap();
    assert_eq!(
        names(updates),
        ["SetItemField", "SetItemField", "DeleteItemField"]
    );
    let uri = |at: usize| {
        let field = updates.children[at].child("FieldURI").unwrap();
        field.attr("FieldURI").unwrap().to_owned()
    };
    let lists = [uri(1), uri(2)];
    assert_eq!(
        lists,
        ["calendar:RequiredAttendees", "calendar:OptionalAttendees"]
    );
    let set = updates.children[1].child("CalendarItem").unwrap();
    assert_eq!(listed(set, "RequiredAttendees"), required);
    // A meeting left with nobody, a person who is not an address, and an empty change are refused.
    let nobody = Change {
        required: Some(&[]),
        optional: Some(&[]),
        ..Change::default()
    };
    let named = who(&["Ada <ada@example.org>"]);
    let unnamed = Change {
        required: Some(&named),
        ..Change::default()
    };
    for change in [nobody, unnamed, Change::default()] {
        assert_eq!(update_meeting("AAMk", "K", &change, VIENNA), Err(INVALID));
    }
    // The owner's own reminder alone tells nobody; with anything else, everybody is told.
    let mut own = Change {
        reminder: Reminder::Minutes(15),
        ..Change::default()
    };
    let (quiet, _) = parsed(&update_meeting("AAMk", "K", &own, VIENNA).unwrap());
    let sending = quiet.attr("SendMeetingInvitationsOrCancellations");
    assert_eq!(sending, Some("SendToNone"));
    own.title = Some("Lunch");
    let (told, _) = parsed(&update_meeting("AAMk", "K", &own, VIENNA).unwrap());
    let sending = told.attr("SendMeetingInvitationsOrCancellations");
    assert_eq!(sending, Some("SendToAllAndSaveCopy"));
    // An appointment's update names nobody: a request that did would be a meeting.
    let people = Change {
        title: Some("x"),
        optional: Some(&required),
        ..Change::default()
    };
    assert_eq!(
        update_appointment("AAMk", "K", &people, VIENNA),
        Err(INVALID)
    );
}

#[test]
fn a_cancellation_is_sent_to_everybody_and_a_removal_is_saved_and_sent_to_nobody() {
    let (cancel, _) = parsed(&cancel_meeting("AAMk", "K", Some("Sorry,\r\nnext week")).unwrap());
    let only = (
        "MessageDisposition".to_owned(),
        "SendAndSaveCopy".to_owned(),
    );
    assert_eq!(cancel.attrs, [only]);
    let item = cancel.at(&["Items", "CancelCalendarItem"]).unwrap();
    assert_eq!(names(item), ["ReferenceItemId", "NewBodyContent"]);
    let reference = &item.children[0];
    assert_eq!(
        (reference.attr("Id"), reference.attr("ChangeKey")),
        (Some("AAMk"), Some("K"))
    );
    let note = &item.children[1];
    assert_eq!(
        (note.attr("BodyType"), note.text.as_str()),
        (Some("Text"), "Sorry,\r\nnext week")
    );
    let (bare, _) = parsed(&cancel_meeting("AAMk", "K", None).unwrap());
    assert_eq!(
        names(bare.at(&["Items", "CancelCalendarItem"]).unwrap()),
        ["ReferenceItemId"]
    );
    let long = "x".repeat(MAX_CANCEL_NOTE_BYTES + 1);
    for (key, note) in [
        ("", None),
        ("a b", None),
        ("K", Some(&long[..])),
        ("K", Some("a\u{7}b")),
        ("K", Some(" ")),
    ] {
        assert_eq!(
            cancel_meeting("AAMk", key, note),
            Err(INVALID),
            "{key:?} {note:?}"
        );
    }
    assert!(cancel_meeting("AAMk", "K", Some(&long[1..])).is_ok());
    let (remove, _) = parsed(&remove_cancellation("AAMk", "K").unwrap());
    let only = ("MessageDisposition".to_owned(), "SaveOnly".to_owned());
    assert_eq!(remove.attrs, [only]);
    let item = remove.at(&["Items", "RemoveItem"]).unwrap();
    assert_eq!(names(item), ["ReferenceItemId"], "no body, no recipient");
    assert_eq!(remove_cancellation("AAMk", ""), Err(INVALID));
}

fn weekly(first: &str, interval: u32, end: End) -> Recurrence {
    let start: NaiveDate = first.parse().unwrap();
    let pattern = Pattern::Weekly(interval, vec![start.weekday()]);
    Recurrence {
        pattern,
        end,
        start,
    }
}

fn series(when: When, rule: Recurrence) -> Appointment {
    Appointment {
        recurrence: Some(rule),
        ..plain("Backup", when)
    }
}

/// What follows the people (or the place) in a new item: the rule and the zones, as written.
fn tail(request: &str) -> &str {
    let at = request.find("<t:Recurrence>").expect("a rule");
    &request[at..request.find("</t:CalendarItem>").unwrap()]
}

const ZONES: &str = r#"<t:StartTimeZone Id="W. Europe Standard Time"/><t:EndTimeZone Id="W. Europe Standard Time"/>"#;

#[test]
fn a_series_is_utc_instants_a_rule_and_the_zone_it_recurs_in_named_twice() {
    // 03:00 in Vienna, a week before the clocks change: the instants stay UTC, the zone says the wall.
    let when = timed("2026-10-19T01:00:00Z", "2026-10-19T02:00:00Z");
    let backup = series(when, weekly("2026-10-19", 1, End::Count(3)));
    let request = create_appointment(&backup, VIENNA).unwrap();
    let (create, zone) = parsed(&request);
    assert_eq!(zone.as_deref(), Some(VIENNA));
    assert_eq!(create.attr("SendMeetingInvitations"), Some("SendToNone"));
    assert!(request.contains("<t:Start>2026-10-19T01:00:00Z</t:Start>"));
    let rule = concat!(
        "<t:Recurrence><t:WeeklyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Monday</t:DaysOfWeek>",
        "</t:WeeklyRecurrence><t:NumberedRecurrence><t:StartDate>2026-10-19</t:StartDate>",
        "<t:NumberOfOccurrences>3</t:NumberOfOccurrences></t:NumberedRecurrence></t:Recurrence>"
    );
    assert_eq!(tail(&request), format!("{rule}{ZONES}"));
    // A meeting that repeats carries its people before the rule, and is still sent to them.
    let guests = Guests {
        required: who(&["bob@example.org"]),
        optional: Vec::new(),
    };
    let request = create_meeting(&backup, &guests, VIENNA).unwrap();
    assert!(request.contains("</t:RequiredAttendees><t:Recurrence>"));
    assert!(request.contains(r#"SendMeetingInvitations="SendToAllAndSaveCopy""#));
    // Whole days are days in the zone of the series; a single event names no zone and no rule.
    let days = series(
        days("2026-10-19", "2026-10-20"),
        weekly("2026-10-19", 1, End::Never),
    );
    let (create, zone) = parsed(&create_appointment(&days, VIENNA).unwrap());
    let start = create
        .at(&["Items", "CalendarItem"])
        .unwrap()
        .text_at(&["Start"]);
    assert_eq!(
        (zone.as_deref(), start),
        (Some(VIENNA), Some("2026-10-19T00:00:00"))
    );
    let single = create_appointment(&plain("Once", when), VIENNA).unwrap();
    assert!(!single.contains("TimeZone") && !single.contains("Recurrence"));
}

#[test]
fn every_pattern_and_end_is_written_in_the_order_of_its_page() {
    use Weekday::{Thu, Tue};
    let first: NaiveDate = "2026-10-29".parse().unwrap();
    let cases = [
        (
            Pattern::Daily(3),
            End::Never,
            "<t:DailyRecurrence><t:Interval>3</t:Interval>",
        ),
        (
            Pattern::Weekly(2, vec![Tue, Thu]),
            End::Count(4),
            concat!(
                "<t:WeeklyRecurrence><t:Interval>2</t:Interval><t:DaysOfWeek>Tuesday Thursday</t:DaysOfWeek>",
                "<t:FirstDayOfWeek>Monday</t:FirstDayOfWeek>"
            ),
        ),
        (
            Pattern::Monthly(1, 29),
            End::Never,
            "<t:AbsoluteMonthlyRecurrence><t:Interval>1</t:Interval><t:DayOfMonth>29</t:DayOfMonth>",
        ),
        (
            Pattern::MonthlyBy(1, Thu, 4),
            End::Never,
            concat!(
                "<t:RelativeMonthlyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Thursday</t:DaysOfWeek>",
                "<t:DayOfWeekIndex>Last</t:DayOfWeekIndex>"
            ),
        ),
        (
            Pattern::Yearly(10, 29),
            End::Never,
            "<t:AbsoluteYearlyRecurrence><t:DayOfMonth>29</t:DayOfMonth><t:Month>October</t:Month>",
        ),
        (
            Pattern::YearlyBy(10, Thu, 4),
            End::Until("2027-03-04".parse().unwrap()),
            concat!(
                "<t:RelativeYearlyRecurrence><t:DaysOfWeek>Thursday</t:DaysOfWeek>",
                "<t:DayOfWeekIndex>Last</t:DayOfWeekIndex><t:Month>October</t:Month>"
            ),
        ),
    ];
    let when = timed("2026-10-29T08:00:00Z", "2026-10-29T09:00:00Z");
    for (pattern, end, written) in cases {
        let rule = Recurrence {
            pattern,
            end,
            start: first,
        };
        let request = create_appointment(&series(when, rule), VIENNA).unwrap();
        assert!(
            tail(&request).starts_with(&format!("<t:Recurrence>{written}</")),
            "{written}"
        );
        let range = match end {
            End::Never => {
                "<t:NoEndRecurrence><t:StartDate>2026-10-29</t:StartDate></t:NoEndRecurrence>"
            }
            End::Count(_) => {
                "<t:NumberedRecurrence><t:StartDate>2026-10-29</t:StartDate><t:NumberOfOccurrences>4</t:NumberOfOccurrences></t:NumberedRecurrence>"
            }
            End::Until(_) => {
                "<t:EndDateRecurrence><t:StartDate>2026-10-29</t:StartDate><t:EndDate>2027-03-04</t:EndDate></t:EndDateRecurrence>"
            }
        };
        assert!(
            tail(&request).ends_with(&format!("{range}</t:Recurrence>{ZONES}")),
            "{range}"
        );
    }
    // FirstDayOfWeek only where it decides which days go together.
    let every = series(when, weekly("2026-10-29", 1, End::Never));
    assert!(
        !create_appointment(&every, VIENNA)
            .unwrap()
            .contains("FirstDayOfWeek")
    );
}

#[test]
fn a_series_that_cannot_be_kept_or_said_is_refused_before_anything_is_written() {
    let when = timed("2026-10-19T01:00:00Z", "2026-10-19T02:00:00Z");
    let on = |pattern| Recurrence {
        pattern,
        ..weekly("2026-10-19", 1, End::Never)
    };
    for (when, rule, zone) in [
        // Not on its first day (no zone puts this instant on Wednesday), or not on its rule.
        (when, weekly("2026-10-21", 1, End::Never), VIENNA),
        (when, on(Pattern::Weekly(1, vec![Weekday::Tue])), VIENNA),
        // Longer than a day for a daily rule; past the bounds; made in a zone the server is not told.
        (
            timed("2026-10-19T01:00:00Z", "2026-10-20T01:01:00Z"),
            on(Pattern::Daily(1)),
            VIENNA,
        ),
        (when, weekly("2026-10-19", 100, End::Never), VIENNA),
        (when, weekly("2026-10-19", 1, End::Count(1000)), VIENNA),
        (when, weekly("2026-10-19", 1, End::Never), "Vienna\"/>"),
        (
            days("2026-10-20", "2026-10-21"),
            weekly("2026-10-19", 1, End::Never),
            VIENNA,
        ),
    ] {
        assert_eq!(create_appointment(&series(when, rule), zone), Err(INVALID));
    }
}

#[test]
fn every_events_time_of_day_is_a_clock_time_in_the_series_own_zone_and_never_an_instant() {
    let start = NaiveTime::from_hms_opt(10, 15, 0).unwrap();
    let ten = When::Clock { start, minutes: 45 };
    let on_day = Some(ten.on("2026-10-05".parse().unwrap()));
    let change = Change {
        when: on_day,
        ..Change::default()
    };
    let request = update_appointment("A", "CK", &change, VIENNA).unwrap();
    let (update, zone) = parsed(&request);
    let quiet = update.attr("SendMeetingInvitationsOrCancellations");
    assert_eq!((zone.as_deref(), quiet), (Some(VIENNA), Some("SendToNone")));
    let written = concat!(
        r#"<t:StartTimeZone Id="W. Europe Standard Time"/></t:CalendarItem></t:SetItemField>"#,
        r#"<t:SetItemField><t:FieldURI FieldURI="calendar:EndTimeZone"/><t:CalendarItem>"#,
        r#"<t:EndTimeZone Id="W. Europe Standard Time"/></t:CalendarItem></t:SetItemField>"#,
        r#"<t:SetItemField><t:FieldURI FieldURI="calendar:Start"/><t:CalendarItem>"#,
        "<t:Start>2026-10-05T10:15:00</t:Start></t:CalendarItem></t:SetItemField>",
        r#"<t:SetItemField><t:FieldURI FieldURI="calendar:End"/><t:CalendarItem>"#,
        "<t:End>2026-10-05T11:00:00</t:End>"
    );
    assert!(request.contains(written) && !request.contains("IsAllDayEvent"));
    // A time of day not yet put on a day is no time at all.
    let unplaced = Change {
        when: Some(ten),
        ..Change::default()
    };
    assert_eq!(
        update_appointment("A", "CK", &unplaced, VIENNA),
        Err(INVALID)
    );
    // The master is read through one of its events, with its rule and its zone.
    let read = master_detail("EV", true);
    assert!(
        read.contains(r#"<m:ItemIds><t:RecurringMasterItemId OccurrenceId="EV"/></m:ItemIds>"#)
    );
    assert!(read.contains("calendar:Recurrence") && read.contains("calendar:StartTimeZone"));
}
