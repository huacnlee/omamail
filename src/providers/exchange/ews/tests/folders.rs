//! Calendars beyond the default one, against the scripted calendar of `calendar`: discovery, another
//! mailbox's calendar opened by its address, a range of a calendar named by its folder, and what may be
//! written where.

use super::super::{Calendar, Client, Discovered, Lock, Origin, Rights, Scope};
use super::calendar::{
    CALENDAR_FOLDER, Cal, DEFAULT, Folder, Shared, appointment, cal_id, calendar, edit, folder_id,
    october, operation, refused, secs, timed,
};
use super::detail::INVITED;
use super::fake::{Fake, Out, Soap};

const BOB: &str = "bob@example.org";
const CAROL: &str = "carol@example.org";
const LOCKED: &str = "exchange_calendar_locked";
const NOT_SHARED: &str = "exchange_calendar_not_shared";
const READ: [bool; 4] = [true, false, false, false];
const ALL: [bool; 4] = [true; 4];

/// A mailbox with two calendar folders of its own, one in Deleted Items, a birthday folder and a notes
/// folder; and the calendars Bob (to read), Carol (to write) and Dave (a folder that is no calendar)
/// share with it, and the owner's own default calendar reached by an alias of theirs.
pub fn mailbox(store: &Shared) {
    let mut store = store.lock().unwrap();
    let birthdays = Folder {
        class: "IPF.Appointment.Birthday".into(),
        ..Folder::own(3, "Birthdays")
    };
    let notes = Folder {
        class: "IPF.StickyNote".into(),
        ..Folder::own(4, "Notes")
    };
    let removed = Folder {
        deleted: true,
        ..Folder::own(5, "Old team")
    };
    let not_calendar = Folder {
        class: "IPF.Note".into(),
        ..Folder::shared(12, "dave@example.org", ALL)
    };
    let alias = Folder {
        id: CALENDAR_FOLDER.into(),
        ..Folder::shared(13, "ada.alias@example.org", ALL)
    };
    store.folders = vec![
        Folder::own(1, "Team"),
        Folder::own(2, "Sub"),
        birthdays,
        notes,
        removed,
        Folder::shared(10, BOB, READ),
        Folder::shared(11, CAROL, ALL),
        not_calendar,
        alias,
    ];
}

async fn client_of(
    items: Vec<Cal>,
    wrap: impl Fn(&Soap) -> Option<Out> + Send + Sync + 'static,
) -> (Fake, Client, Shared) {
    let (fake, client, store) = calendar(items, wrap).await;
    mailbox(&store);
    (fake, client, store)
}

/// The operations the server was asked for, the folder lookup aside.
fn ops(store: &Shared) -> Vec<String> {
    let store = store.lock().unwrap();
    let names = store.requests.iter().map(|body| operation(body).name);
    names.collect()
}

fn names(found: &Discovered) -> Vec<String> {
    let said = found.calendars.iter().map(|each| {
        let whose = each.mailbox.as_deref().unwrap_or("own");
        format!("{} {whose} {}", each.folder.name, each.origin.word())
    });
    said.collect()
}

fn folder(n: u16) -> Calendar {
    Calendar::Folder {
        id: folder_id(n),
        mailbox: None,
    }
}

fn shared(n: u16, mailbox: &str) -> Calendar {
    Calendar::Folder {
        id: folder_id(n),
        mailbox: Some(mailbox.to_owned()),
    }
}

/// Where each `FindFolder` started.
fn roots(store: &Shared) -> Vec<String> {
    let requests = store.lock().unwrap().requests.clone();
    let finds = requests.iter().map(|body| operation(body));
    finds
        .filter(|op| op.name == "FindFolder")
        .map(|op| {
            let at = op.at(&["ParentFolderIds", "DistinguishedFolderId"]);
            at.unwrap().attr("Id").unwrap().to_owned()
        })
        .collect()
}

#[tokio::test]
async fn discovery_lists_the_default_calendar_then_the_mailboxs_own_calendar_folders() {
    let (_fake, mut client, store) = client_of(Vec::new(), |_| None).await;
    let found = client.discover_calendars().await.unwrap();
    // Not a birthday or notes folder, not one in Deleted Items, and nobody else's.
    assert_eq!(
        names(&found),
        ["Calendar own default", "Team own folder", "Sub own folder"]
    );
    assert!(!found.truncated);
    assert_eq!((found.steps.folders, found.steps.folders_code), (2, None));
    let rights: Vec<Option<Rights>> = found.calendars.iter().map(|c| c.folder.rights).collect();
    assert_eq!(
        rights,
        [Some(Rights::ALL); 3],
        "the owner's default whatever it named"
    );
    assert_eq!(found.calendars[0].folder.id, CALENDAR_FOLDER);
    // The default calendar, one deep search from the root (which reaches below the default calendar),
    // and the same below Deleted Items; nothing in the Inbox, and nobody impersonated.
    assert_eq!(ops(&store), ["GetFolder", "FindFolder", "FindFolder"]);
    assert_eq!(roots(&store), ["msgfolderroot", "deleteditems"]);
    let requests = store.lock().unwrap().requests.clone();
    assert!(requests.iter().all(|body| !body.contains("Impersonation")));
}

#[tokio::test]
async fn a_server_that_refuses_the_class_restriction_is_asked_again_and_the_class_is_compared_exactly()
 {
    let (fake, mut client, store) = client_of(Vec::new(), |_| None).await;
    store.lock().unwrap().refuse_restriction = true;
    // A class in another case is no calendar's, nor is one that begins with it.
    store.lock().unwrap().folders.push(Folder {
        class: "ipf.appointment".into(),
        ..Folder::own(6, "Lower")
    });
    let found = client.discover_calendars().await.unwrap();
    let own: Vec<&str> = found.calendars[1..]
        .iter()
        .map(|c| c.folder.name.as_str())
        .collect();
    assert_eq!(own, ["Team", "Sub"]);
    // Each search asked twice: restricted, refused, and then without the restriction.
    assert_eq!(fake.log.count("FindFolder"), 4);
}

#[tokio::test]
async fn more_folders_than_a_discovery_lists_are_cut_and_said() {
    let (_fake, mut client, store) = client_of(Vec::new(), |_| None).await;
    store.lock().unwrap().folders = (1..=120)
        .map(|n| Folder::own(n, &format!("F{n}")))
        .collect();
    let found = client.discover_calendars().await.unwrap();
    assert_eq!(
        found.calendars.len(),
        100,
        "the default calendar and 99 more"
    );
    assert!(found.truncated);
    // A server that refuses the restriction is read at most five pages deep.
    let (_fake, mut client, store) = client_of(Vec::new(), |_| None).await;
    {
        let mut store = store.lock().unwrap();
        store.refuse_restriction = true;
        store.folders = (1..=600)
            .map(|n| Folder {
                class: "IPF.Note".into(),
                ..Folder::own(n, "Mail")
            })
            .collect();
    }
    let found = client.discover_calendars().await.unwrap();
    assert!(found.truncated && found.calendars.len() == 1);
    let pages = ops(&store).iter().filter(|op| *op == "FindFolder").count();
    assert_eq!(
        pages,
        1 + 5 + 1 + 1,
        "five pages below the root, one in Deleted Items"
    );
}

#[tokio::test]
async fn a_failed_search_fails_the_folder_step_and_says_its_code() {
    // The root search, and the search of Deleted Items, without which a deleted calendar could not be
    // told from one in use: either failing lists no folder and says why.
    for root in ["msgfolderroot", "deleteditems"] {
        let fail = move |soap: &Soap| {
            let named = soap.op == "FindFolder" && soap.body.contains(&format!(r#"Id="{root}""#));
            named.then(|| refused("FindFolder", "ErrorAccessDenied"))
        };
        let (_fake, mut client, _) = client_of(Vec::new(), fail).await;
        let found = client.discover_calendars().await.unwrap();
        let code = found.steps.folders_code;
        assert_eq!(code, Some("exchange_access_denied"), "{root}");
        assert_eq!(names(&found), ["Calendar own default"], "{root}");
    }
}

#[tokio::test]
async fn a_mailbox_without_a_calendar_is_no_discovery_and_a_refused_login_ends_it() {
    let none = |soap: &Soap| {
        let default = soap.op == "GetFolder" && !soap.body.contains("Mailbox");
        default.then(|| refused("GetFolder", "ErrorFolderNotFound"))
    };
    let (_fake, mut client, _) = client_of(Vec::new(), none).await;
    let found = client.discover_calendars().await;
    assert_eq!(found.err(), Some("exchange_folder_unavailable"));
    for root in ["msgfolderroot", "deleteditems"] {
        let refuse = move |soap: &Soap| {
            let named = soap.op == "FindFolder" && soap.body.contains(&format!(r#"Id="{root}""#));
            named.then(|| Out::Status(401, Vec::new()))
        };
        let (_fake, mut client, _) = client_of(Vec::new(), refuse).await;
        let found = client.discover_calendars().await;
        assert_eq!(found.err(), Some("exchange_unauthorized"), "{root}");
        assert!(client.rejected(), "{root}");
    }
}

#[tokio::test]
async fn another_mailboxs_calendar_is_opened_by_its_address_and_every_way_of_not_being_shared_is_one_code()
 {
    let (fake, mut client, store) = client_of(Vec::new(), |_| None).await;
    let found = client.open_shared_calendar(CAROL).await.unwrap();
    assert_eq!(
        (found.origin, found.mailbox.as_deref()),
        (Origin::Address, Some(CAROL))
    );
    assert_eq!(found.folder.id, folder_id(11));
    // Read only is still shared.
    assert!(client.open_shared_calendar(BOB).await.is_ok());
    // No right to read, no right named, a folder that is no calendar, no such mailbox: not shared.
    {
        let mut store = store.lock().unwrap();
        let folders = &mut store.folders;
        folders.push(Folder::shared(
            14,
            "erin@example.org",
            [false, true, true, true],
        ));
        folders.push(Folder {
            rights: None,
            ..Folder::shared(15, "frank@example.org", ALL)
        });
    }
    let refused_here = [
        "erin@example.org",
        "frank@example.org",
        "dave@example.org",
        "nobody@example.org",
    ];
    for address in refused_here {
        let opened = client.open_shared_calendar(address).await;
        assert_eq!(opened.err(), Some(NOT_SHARED), "{address}");
    }
    // An alias of the owner's opens the owner's own default calendar, which is no other calendar.
    let alias = client.open_shared_calendar("ada.alias@example.org").await;
    assert_eq!(alias.err(), Some("exchange_calendar_own_mailbox"));
    // Whatever the server calls the refusal.
    for code in [
        "ErrorAccessDenied",
        "ErrorFolderNotFound",
        "ErrorItemNotFound",
        "ErrorNonExistentMailbox",
    ] {
        let refuse = move |soap: &Soap| {
            (soap.op == "GetFolder" && soap.body.contains("Mailbox"))
                .then(|| refused("GetFolder", code))
        };
        let (_fake, mut client, _) = client_of(Vec::new(), refuse).await;
        let opened = client.open_shared_calendar(CAROL).await;
        assert_eq!(opened.err(), Some(NOT_SHARED), "{code}");
    }
    // A refusal that is not about sharing keeps its own code.
    let busy = |soap: &Soap| {
        (soap.op == "GetFolder" && soap.body.contains("Mailbox"))
            .then(|| refused("GetFolder", "ErrorInternalServerError"))
    };
    let (_fake, mut client, _) = client_of(Vec::new(), busy).await;
    let opened = client.open_shared_calendar(CAROL).await;
    assert_eq!(opened.err(), Some("exchange_server_error"));
    // An address that could not be named is refused before the connection is touched.
    let before = fake
        .log
        .connections
        .load(std::sync::atomic::Ordering::SeqCst);
    let asked = ops(&store).len();
    for bad in [
        "Carol@example.org",
        "carol",
        "Carol <carol@example.org>",
        "a b@example.org",
        "carol@example.org\"/>",
    ] {
        let opened = client.open_shared_calendar(bad).await;
        assert_eq!(opened.err(), Some("invalid_params"), "{bad}");
    }
    assert_eq!(ops(&store).len(), asked);
    let after = fake
        .log
        .connections
        .load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(after, before);
}

const FROM: &str = "2026-10-01T00:00:00Z";
const TO: &str = "2026-11-01T00:00:00Z";

async fn titles(client: &mut Client, calendar: &Calendar) -> Result<Vec<String>, &'static str> {
    let (from, to) = (secs(FROM) * 1000, secs(TO) * 1000);
    let found = client.calendar_events(from, to, 100, calendar).await?;
    Ok(found.items.into_iter().map(|item| item.subject).collect())
}

fn titled(n: u16, title: &str, folder: u16) -> Cal {
    let cal = Cal {
        subject: title.into(),
        ..october(n, 5)
    };
    cal.within(&folder_id(folder))
}

#[tokio::test]
async fn a_calendar_is_read_by_its_folder_after_the_server_says_the_user_may_read_it() {
    let items = vec![
        Cal {
            subject: "Mine".into(),
            ..october(1, 5)
        },
        titled(2, "Team's", 1),
        titled(3, "Bob's", 10),
    ];
    let (fake, mut client, store) = client_of(items, |_| None).await;
    assert_eq!(titles(&mut client, DEFAULT).await.unwrap(), ["Mine"]);
    assert_eq!(titles(&mut client, &folder(1)).await.unwrap(), ["Team's"]);
    // The default calendar as it always was: a view, no folder read and no rights asked; another by
    // its id after its rights, each item with its own.
    let requests = store.lock().unwrap().requests.clone();
    assert_eq!(operation(&requests[0]).name, "FindItem");
    assert!(!requests[0].contains("EffectiveRights"));
    let view = operation(&requests[2]);
    let named = view
        .at(&["ParentFolderIds", "FolderId"])
        .unwrap()
        .attr("Id");
    assert_eq!(
        (operation(&requests[1]).name.as_str(), named),
        ("GetFolder", Some(folder_id(1).as_str()))
    );
    assert!(requests[1].contains("folder:EffectiveRights"));
    assert!(requests[2].contains("item:EffectiveRights"));
    // A calendar the user may not read is not read, and one that is gone or no calendar is
    // unavailable, not empty.
    store.lock().unwrap().folders[5].rights = Some([false, true, true, true]);
    let views = fake.log.count("FindItem");
    let bob = shared(10, BOB);
    let denied = Some("exchange_access_denied");
    assert_eq!(titles(&mut client, &bob).await.err(), denied);
    store.lock().unwrap().folders[5].rights = None;
    assert_eq!(titles(&mut client, &bob).await.err(), denied);
    for gone in [folder(99), folder(4), folder(3)] {
        assert_eq!(
            titles(&mut client, &gone).await.err(),
            Some("exchange_folder_unavailable"),
            "{gone:?}"
        );
    }
    assert_eq!(
        fake.log.count("FindItem"),
        views,
        "nothing was read from them"
    );
    // An id that could not be written is refused before the connection is used.
    let bad = Calendar::Folder {
        id: "a\"><x".into(),
        mailbox: None,
    };
    let asked = ops(&store).len();
    assert_eq!(
        titles(&mut client, &bad).await.err(),
        Some("invalid_params")
    );
    assert_eq!(ops(&store).len(), asked);
}

#[tokio::test]
async fn each_item_of_another_calendar_is_locked_by_its_own_rights_not_the_folders() {
    // An Editor's share (every item may be changed), an Author's (only the user's own), a Reviewer's
    // (none), and an item the server said nothing of.
    let mut items = vec![
        titled(1, "Editor may", 11),
        titled(2, "Author's own", 10),
        titled(3, "Somebody else's", 10),
        titled(4, "Said nothing", 10),
    ];
    items[2].rights = Some((false, false));
    items[3].unsaid = true;
    let (_fake, mut client, store) = client_of(items, |_| None).await;
    // The folders say no Modify for Bob's calendar and every right for Carol's: the items decide.
    store.lock().unwrap().folders[5].rights = Some([true, true, false, false]);
    let (from, to) = (secs(FROM) * 1000, secs(TO) * 1000);
    let mut locks = Vec::new();
    for calendar in [shared(11, CAROL), shared(10, BOB)] {
        let found = client
            .calendar_events(from, to, 100, &calendar)
            .await
            .unwrap();
        assert!(found.other);
        for item in found.items {
            let lock = item.other_lock(item.rights.unwrap_or_default());
            locks.push((item.subject, lock));
        }
    }
    let calendar = Some(Lock::Calendar);
    assert_eq!(
        locks,
        [
            ("Editor may".into(), None),
            ("Author's own".into(), None),
            ("Somebody else's".into(), calendar),
            ("Said nothing".into(), calendar),
        ]
    );
}

#[tokio::test]
async fn an_appointment_is_made_only_where_the_user_may_read_and_make_things() {
    let (fake, mut client, store) = client_of(Vec::new(), |_| None).await;
    let lunch = appointment(
        "Lunch",
        timed("2026-10-06T11:00:00Z", "2026-10-06T12:00:00Z"),
    );
    let made = client
        .create_appointment(&lunch, "UTC", &shared(11, CAROL))
        .await
        .unwrap();
    assert!(!made.id.is_empty());
    assert_eq!(
        titles(&mut client, &shared(11, CAROL)).await.unwrap(),
        ["Lunch"]
    );
    assert_eq!(
        titles(&mut client, DEFAULT).await.unwrap(),
        Vec::<String>::new()
    );
    let requests = store.lock().unwrap().requests.clone();
    let create = requests.iter().find(|body| body.contains("CreateItem"));
    let create = operation(create.unwrap());
    assert_eq!(create.attr("SendMeetingInvitations"), Some("SendToNone"));
    let saved = &create.child("SavedItemFolderId").unwrap().children;
    assert_eq!(saved.len(), 1);
    assert_eq!(
        (saved[0].name.as_str(), saved[0].attr("Id")),
        ("FolderId", Some(folder_id(11).as_str()))
    );
    // Read only, no right named, a folder that is gone or no calendar: nothing is made.
    let creates = fake.log.count("CreateItem");
    store.lock().unwrap().folders[0].rights = None;
    for (calendar, code) in [
        (shared(10, BOB), LOCKED),
        (folder(1), LOCKED),
        (folder(99), "exchange_folder_unavailable"),
        (folder(4), "exchange_folder_unavailable"),
    ] {
        let made = client.create_appointment(&lunch, "UTC", &calendar).await;
        assert_eq!(made.err(), Some(code));
    }
    assert_eq!(fake.log.count("CreateItem"), creates, "nothing was sent");
}

/// Item `n` changed at `key`: what the write answered.
async fn change(
    client: &mut Client,
    n: u16,
    key: &str,
    scope: Option<Scope>,
    calendar: &Calendar,
) -> Result<(), &'static str> {
    let (id, wanted) = (cal_id(n), edit("Changed", None));
    let done = client.change_appointment(&id, key, &wanted, "UTC", scope, calendar);
    done.await.map(|_| ())
}

async fn delete(
    client: &mut Client,
    n: u16,
    key: &str,
    scope: Option<Scope>,
    calendar: &Calendar,
) -> Result<(), &'static str> {
    client
        .delete_appointment(&cal_id(n), key, scope, calendar)
        .await
}

#[tokio::test]
async fn an_item_of_another_mailbox_is_changed_only_by_its_own_rights_and_never_deleted() {
    let rights = [
        Some((true, true)),
        Some((false, false)),
        Some((false, true)),
    ];
    let mut items: Vec<Cal> = (1..=3)
        .zip(rights)
        .map(|(n, rights)| Cal {
            rights,
            ..titled(n, "Theirs", 11)
        })
        .collect();
    items.push(Cal {
        unsaid: true,
        ..titled(4, "Theirs", 11)
    });
    let (fake, mut client, store) = client_of(items, |_| None).await;
    let carol = shared(11, CAROL);
    let key = |n: u16| format!("CK{n}v1");
    assert!(change(&mut client, 1, &key(1), None, &carol).await.is_ok());
    for n in [2, 3, 4] {
        let changed = change(&mut client, n, &key(n), None, &carol).await;
        assert_eq!(changed.err(), Some(LOCKED), "{n}");
    }
    assert_eq!(fake.log.count("UpdateItem"), 1);
    // Nothing is deleted in another mailbox, whatever the item's rights, and nothing is asked.
    let asked = ops(&store).len();
    for n in [1, 3] {
        let deleted = delete(&mut client, n, &key(n), None, &carol).await;
        assert_eq!(deleted.err(), Some(LOCKED), "{n}");
    }
    let done = (ops(&store).len(), fake.log.count("DeleteItem"));
    assert_eq!(done, (asked, 0));
    // Every read of an item there asked for its rights.
    let requests = store.lock().unwrap().requests.clone();
    let reads: Vec<&String> = requests
        .iter()
        .filter(|body| operation(body).name == "GetItem")
        .collect();
    assert!(
        reads.len() == 4
            && reads
                .iter()
                .all(|body| body.contains("item:EffectiveRights"))
    );
}

#[tokio::test]
async fn in_the_owners_own_other_calendar_an_item_is_changed_and_deleted_by_its_own_rights() {
    let mut items = vec![
        titled(1, "Team's", 1),
        october(2, 5),
        titled(3, "Change only", 1),
        titled(4, "Delete only", 1),
    ];
    items[2].rights = Some((true, false));
    items[3].rights = Some((false, true));
    let (fake, mut client, store) = client_of(items, |_| None).await;
    assert!(
        change(&mut client, 1, "CK1v1", None, &folder(1))
            .await
            .is_ok()
    );
    let requests = store.lock().unwrap().requests.clone();
    let reads: Vec<&String> = requests
        .iter()
        .filter(|body| operation(body).name == "GetItem")
        .collect();
    assert!(reads.len() == 1 && reads[0].contains("item:EffectiveRights"));
    // Deleting needs the right to delete, and changing the right to modify.
    let deleted = delete(&mut client, 3, "CK3v1", None, &folder(1)).await;
    assert_eq!(deleted.err(), Some(LOCKED));
    let changed = change(&mut client, 4, "CK4v1", None, &folder(1)).await;
    assert_eq!(changed.err(), Some(LOCKED));
    assert!(
        delete(&mut client, 4, "CK4v1", None, &folder(1))
            .await
            .is_ok()
    );
    // An item named with a calendar it is not in is not written: the default's in a folder, nor the
    // folder's in another folder or in the default calendar.
    for (n, calendar) in [(2, folder(1)), (1, folder(2)), (1, Calendar::Default)] {
        let key = if n == 1 { "CK1v2" } else { "CK2v1" };
        let changed = change(&mut client, n, key, None, &calendar).await;
        assert_eq!(changed.err(), Some(LOCKED), "{n}");
        let deleted = delete(&mut client, n, key, None, &calendar).await;
        assert_eq!(deleted.err(), Some(LOCKED), "{n}");
    }
    assert_eq!(fake.log.count("UpdateItem"), 1);
    assert_eq!(fake.log.count("DeleteItem"), 1);
}

#[tokio::test]
async fn outside_the_default_calendar_a_series_is_written_one_event_at_a_time() {
    let event = Cal {
        extra: "<t:CalendarItemType>Occurrence</t:CalendarItemType>".into(),
        ..titled(1, "Weekly", 1)
    };
    let (_fake, mut client, store) = client_of(vec![event], |_| None).await;
    let all = Some(Scope::Series);
    for calendar in [folder(1), shared(11, CAROL)] {
        let changed = change(&mut client, 1, "CK1v1", all, &calendar).await;
        assert_eq!(changed.err(), Some(LOCKED));
        let deleted = delete(&mut client, 1, "CK1v1", all, &calendar).await;
        assert_eq!(deleted.err(), Some(LOCKED));
    }
    assert!(ops(&store).is_empty(), "nothing was asked");
    // One event of it is written as one event.
    let one = Some(Scope::Occurrence);
    assert!(
        change(&mut client, 1, "CK1v1", one, &folder(1))
            .await
            .is_ok()
    );
}

fn invitation_in(n: u16, folder: u16) -> Cal {
    october(n, 5).with(INVITED).within(&folder_id(folder))
}

#[tokio::test]
async fn the_detail_of_an_item_of_another_calendar_reads_the_item_alone_with_its_rights_there() {
    let theirs = Cal {
        rights: Some((true, false)),
        ..invitation_in(1, 10)
    };
    let weekly = Cal {
        extra: "<t:CalendarItemType>Occurrence</t:CalendarItemType>".into(),
        ..titled(2, "Weekly", 10)
    };
    let mine = october(3, 5).with(INVITED);
    let (_fake, mut client, store) = client_of(vec![theirs, weekly, mine], |_| None).await;
    let bob = shared(10, BOB);
    let found = client.event_detail(&cal_id(1), &bob).await.unwrap();
    assert!(!found.elsewhere && found.incoming());
    let modify = Rights {
        read: true,
        modify: true,
        ..Rights::default()
    };
    assert_eq!(found.item.rights, Some(modify));
    // A meeting there is locked whoever organises it, and nothing of a series is read.
    assert_eq!(found.other_lock(), Some(Lock::Meeting));
    let found = client.event_detail(&cal_id(2), &bob).await.unwrap();
    assert!(found.series.is_none() && found.other_lock().is_none());
    assert_eq!(
        ops(&store),
        ["GetFolder", "GetItem", "GetFolder", "GetItem"],
        "not the Inbox, not a master"
    );
    let requests = store.lock().unwrap().requests.clone();
    assert!(requests[1].contains("item:EffectiveRights"));
    assert!(requests[3].contains("item:EffectiveRights"));
    // Read for a calendar it is not in, it is elsewhere and locked; a folder of the owner's own asks
    // the item's rights too.
    let found = client.event_detail(&cal_id(2), &folder(1)).await.unwrap();
    assert!(found.elsewhere && found.other_lock() == Some(Lock::Unknown));
    let last = store.lock().unwrap().requests.last().cloned().unwrap();
    assert!(last.contains("item:EffectiveRights"));
    // The owner's own invitation in the default calendar is read as ever: no rights, the Inbox looked at.
    let before = ops(&store).len();
    let mine = client.event_detail(&cal_id(3), DEFAULT).await.unwrap();
    assert!(mine.invitation());
    let requests = store.lock().unwrap().requests.clone();
    let after = &requests[before..];
    assert!(
        after
            .iter()
            .all(|body| !body.contains("item:EffectiveRights"))
    );
    assert!(
        after
            .iter()
            .any(|body| body.contains("IPM.Schedule.Meeting.Canceled"))
    );
}

#[tokio::test]
async fn an_id_the_server_no_longer_knows_is_a_folder_that_is_gone_whatever_it_calls_the_refusal() {
    for code in [
        "ErrorItemNotFound",
        "ErrorInvalidId",
        "ErrorInvalidIdMalformed",
        "ErrorFolderNotFound",
    ] {
        let refuse = move |soap: &Soap| {
            let by_id = soap.op == "GetFolder" && soap.body.contains("<t:FolderId");
            by_id.then(|| refused("GetFolder", code))
        };
        let (fake, mut client, _) = client_of(Vec::new(), refuse).await;
        assert_eq!(
            titles(&mut client, &folder(1)).await.err(),
            Some("exchange_folder_unavailable"),
            "{code}"
        );
        let lunch = appointment(
            "Lunch",
            timed("2026-10-06T11:00:00Z", "2026-10-06T12:00:00Z"),
        );
        let made = client.create_appointment(&lunch, "UTC", &folder(1)).await;
        assert_eq!(made.err(), Some("exchange_folder_unavailable"), "{code}");
        assert_eq!(fake.log.count("FindItem") + fake.log.count("CreateItem"), 0);
    }
}
