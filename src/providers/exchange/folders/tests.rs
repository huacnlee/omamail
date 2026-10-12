use super::*;
use crate::providers::exchange::ews::tests::calendar::folder_id;
use crate::providers::exchange::ews::{CalendarFolder, Found};

const ACCOUNT: &str = "exchange:ada@example.org";
const OWNER: &str = "ada@example.org";

fn own() -> String {
    ids::encode(&folder_id(1)).unwrap()
}

fn member(value: Value) -> Map<String, Value> {
    json!({"calendar": value}).as_object().unwrap().clone()
}

#[test]
fn a_reference_is_the_folder_spelled_as_a_message_id_and_for_another_mailbox_its_address() {
    let mine = reference(&folder_id(1), None).unwrap();
    assert_eq!(mine, own());
    let theirs = reference(&folder_id(1), Some("bob@example.org")).unwrap();
    assert_eq!(theirs, format!("{}:bob@example.org", own()));
    assert!(
        reference("not base64!", None).is_none(),
        "no reference is made of what the codec refuses"
    );
    // Each parses back to the folder it names.
    let folder = |mailbox: Option<&str>| Calendar::Folder {
        id: folder_id(1),
        mailbox: mailbox.map(str::to_owned),
    };
    assert_eq!(parse(&mine, OWNER), Ok(folder(None)));
    assert_eq!(parse(&theirs, OWNER), Ok(folder(Some("bob@example.org"))));
}

#[test]
fn only_the_one_spelling_of_a_reference_is_one() {
    let id = own();
    for bad in [
        String::new(),
        ":".into(),
        id.to_uppercase(),
        format!("{id}="),
        format!("{id}:"),
        format!(":{OWNER}"),
        format!("{id}:Bob@example.org"),
        format!("{id}:bob@example.org:carol@example.org"),
        format!("{id}:Bob <bob@example.org>"),
        format!("{id}:bob@example.org "),
        format!("{id} "),
        // The mailbox's own address is not another mailbox, in any case.
        format!("{id}:{OWNER}"),
        "a".repeat(600),
    ] {
        assert_eq!(parse(&bad, OWNER), Err(INVALID), "{bad:?}");
    }
}

#[test]
fn the_calendar_member_is_absent_or_null_for_the_default_and_otherwise_a_reference_string() {
    assert_eq!(calendar(&Map::new(), ACCOUNT), Ok(Calendar::Default));
    assert_eq!(
        calendar(&member(Value::Null), ACCOUNT),
        Ok(Calendar::Default)
    );
    assert!(matches!(
        calendar(&member(json!(own())), ACCOUNT),
        Ok(Calendar::Folder { mailbox: None, .. })
    ));
    for bad in [
        json!(""),
        json!(5),
        json!(true),
        json!([own()]),
        json!({"id": own()}),
    ] {
        assert_eq!(
            calendar(&member(bad.clone()), ACCOUNT),
            Err(INVALID),
            "{bad}"
        );
    }
}

#[test]
fn a_call_only_the_default_calendar_takes_part_in_is_locked_for_any_other_and_refuses_a_malformed_one()
 {
    assert_eq!(default_only(&Map::new(), ACCOUNT), Ok(()));
    assert_eq!(default_only(&member(Value::Null), ACCOUNT), Ok(()));
    assert_eq!(default_only(&member(json!(own())), ACCOUNT), Err(LOCKED));
    let theirs = format!("{}:bob@example.org", own());
    assert_eq!(default_only(&member(json!(theirs)), ACCOUNT), Err(LOCKED));
    assert_eq!(default_only(&member(json!("nope")), ACCOUNT), Err(INVALID));
}

#[test]
fn a_source_id_is_the_accounts_for_the_default_calendar_and_a_stable_digest_for_any_other() {
    assert_eq!(
        source_id(ACCOUNT, None),
        "exchange:exchange:ada@example.org"
    );
    let team = source_id(ACCOUNT, Some(&own()));
    assert!(team.starts_with("exchange:exchange:ada@example.org:"));
    let digest = team.rsplit(':').next().unwrap();
    assert!(digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(
        team,
        source_id(ACCOUNT, Some(&own())),
        "the same from one discovery to the next"
    );
    // And from one release to the next: a saved file keeps a calendar by it. SHA-256 of
    // "exchange", NUL, the account, NUL and the reference, worked out apart from this code.
    let digest = "90babb4f252a2121fdc96a7c69c4cc7d539dc0a72fbcbfe32e61c911249f2fd6";
    assert_eq!(team, format!("exchange:exchange:ada@example.org:{digest}"));
    let theirs = format!("{}:bob@example.org", own());
    assert_ne!(team, source_id(ACCOUNT, Some(&theirs)));
    assert_ne!(team, source_id("exchange:bob@example.org", Some(&own())));
}

fn found(rights: Option<Rights>, mailbox: Option<&str>, origin: Origin) -> Found {
    Found {
        folder: CalendarFolder {
            id: folder_id(1),
            name: "Calendar".into(),
            class: "IPF.Appointment".into(),
            rights,
        },
        mailbox: mailbox.map(str::to_owned),
        origin,
    }
}

#[test]
fn an_entry_says_what_the_user_may_do_in_the_calendar_as_the_server_said_it() {
    let read = Some(Rights {
        read: true,
        ..Rights::default()
    });
    let all = Some(Rights::ALL);
    let cases = [
        (found(all, None, Origin::Default), true, "owner", ""),
        (found(all, None, Origin::Folder), true, "owner", "own"),
        (
            found(all, Some("bob@example.org"), Origin::Address),
            true,
            "writer",
            "theirs",
        ),
        (
            found(read, Some("bob@example.org"), Origin::Address),
            false,
            "reader",
            "theirs",
        ),
        (found(None, None, Origin::Folder), false, "reader", "own"),
    ];
    for (found, writable, role, reference) in cases {
        let said = entry(ACCOUNT, &found).unwrap();
        assert_eq!(said["readOnly"], !writable);
        assert_eq!(said["canCreate"], writable);
        assert_eq!(said["accessRole"], role);
        let expected = match reference {
            "" => String::new(),
            "own" => own(),
            _ => format!("{}:bob@example.org", own()),
        };
        assert_eq!(said["calendarId"], expected.as_str());
        assert_eq!(said["isDefault"], reference.is_empty());
        assert_eq!(said["origin"], found.origin.word());
    }
    // A folder no reference can be made of is not listed.
    let mut odd = found(all, None, Origin::Folder);
    odd.folder.id = "calendar-folder".into();
    assert!(entry(ACCOUNT, &odd).is_none());
    // The default calendar needs none.
    odd.origin = Origin::Default;
    assert_eq!(entry(ACCOUNT, &odd).unwrap()["calendarId"], "");
}
