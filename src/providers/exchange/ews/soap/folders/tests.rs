use super::*;
use crate::providers::exchange::ews::soap::calendar::{
    Appointment, When, calendar_view_in, create_appointment_in, create_meeting,
};
use crate::providers::exchange::ews::xml::{self, Node};
use crate::providers::exchange::guests::Guests;

/// The operation element of a request, which must be well-formed XML with no impersonation header.
fn operation(request: &str) -> Node {
    assert!(!request.contains("Impersonation"), "nobody is impersonated");
    let mut root = xml::parse(request.as_bytes()).expect("a request is well-formed XML");
    let body = root.children.iter().position(|child| child.name == "Body");
    root.children.swap_remove(body.unwrap()).children.remove(0)
}

fn uris(node: &Node) -> Vec<String> {
    let mut found = Vec::new();
    fn walk(node: &Node, found: &mut Vec<String>) {
        if let Some(uri) = node.attr("FieldURI") {
            found.push(uri.to_owned());
        }
        node.children.iter().for_each(|child| walk(child, found));
    }
    walk(node, &mut found);
    found
}

const ID: &str = "AAMkADAwATM0MDAAMS0zYgAuAAADDHL9rDpqAAA=";

#[test]
fn a_calendar_is_named_by_its_distinguished_name_by_the_mailbox_it_belongs_to_or_by_its_id() {
    let element = |at| xml::parse(folder_element(at).unwrap().as_bytes()).unwrap();
    let own = element(Where::Default);
    assert_eq!(
        (own.name.as_str(), own.attr("Id")),
        ("DistinguishedFolderId", Some("calendar"))
    );
    assert!(own.children.is_empty());
    let theirs = element(Where::Mailbox("bob@example.org"));
    assert_eq!(theirs.attr("Id"), Some("calendar"));
    assert_eq!(
        theirs.text_at(&["Mailbox", "EmailAddress"]),
        Some("bob@example.org")
    );
    let by_id = element(Where::Id(ID));
    assert_eq!(
        (by_id.name.as_str(), by_id.attr("Id")),
        ("FolderId", Some(ID))
    );
    // The calendar of a call says where it is.
    assert_eq!(Calendar::Default.place(), Where::Default);
    let folder = Calendar::Folder {
        id: ID.into(),
        mailbox: Some("bob@example.org".into()),
    };
    assert_eq!(
        folder.place(),
        Where::Id(ID),
        "the id carries its mailbox; the address is not sent"
    );
    assert!(folder.is_shared() && !folder.is_default());
    let own = Calendar::Folder {
        id: ID.into(),
        mailbox: None,
    };
    assert!(!own.is_shared() && !own.is_default());
}

#[test]
fn an_address_or_an_id_that_could_break_the_request_is_refused_and_never_repaired() {
    for address in [
        "Bob@example.org",
        "bob",
        "Bob <bob@example.org>",
        "bob@example.org\"/><x",
        "a b@example.org",
        "bob@example",
        "",
    ] {
        assert_eq!(
            folder_element(Where::Mailbox(address)),
            Err(INVALID),
            "{address}"
        );
        let found = get_calendar_folder_rights(Where::Mailbox(address));
        assert_eq!(found, Err(INVALID), "{address}");
    }
    for id in ["", "a\"><x", "AAAA", "not base64!", &"A".repeat(400)] {
        assert_eq!(folder_element(Where::Id(id)), Err(INVALID), "{id}");
        let view = calendar_view_in(0, 1000, 1, true, Where::Id(id));
        assert_eq!(view, Err(INVALID), "{id}");
    }
}

#[test]
fn a_get_folder_asks_for_the_name_the_class_and_the_rights_of_one_folder() {
    let op = operation(&get_calendar_folder_rights(Where::Mailbox("bob@example.org")).unwrap());
    assert_eq!(op.name, "GetFolder");
    let shape = op.child("FolderShape").unwrap();
    assert_eq!(shape.text_at(&["BaseShape"]), Some("IdOnly"));
    assert_eq!(
        uris(shape),
        [
            "folder:DisplayName",
            "folder:FolderClass",
            "folder:EffectiveRights"
        ]
    );
    assert_eq!(op.child("FolderIds").unwrap().children.len(), 1);
}

#[test]
fn a_folder_search_is_deep_paged_restricted_to_the_calendar_class_and_from_the_place_named() {
    for (under, parent) in [
        (Under::MessageRoot, "msgfolderroot"),
        (Under::DeletedItems, "deleteditems"),
    ] {
        let op = operation(&find_calendar_folders(under, true, 200, 100).unwrap());
        assert_eq!(
            (op.name.as_str(), op.attr("Traversal")),
            ("FindFolder", Some("Deep"))
        );
        let view = op.child("IndexedPageFolderView").unwrap();
        let attrs = ["MaxEntriesReturned", "Offset", "BasePoint"].map(|name| view.attr(name));
        assert_eq!(attrs, [Some("100"), Some("200"), Some("Beginning")]);
        let equal = op.at(&["Restriction", "IsEqualTo"]).unwrap();
        assert_eq!(uris(equal), ["folder:FolderClass"]);
        let constant = equal.at(&["FieldURIOrConstant", "Constant"]).unwrap();
        assert_eq!(constant.attr("Value"), Some("IPF.Appointment"));
        let from = op
            .at(&["ParentFolderIds", "DistinguishedFolderId"])
            .unwrap();
        assert_eq!(from.attr("Id"), Some(parent));
        assert_eq!(
            uris(op.child("FolderShape").unwrap()),
            [
                "folder:DisplayName",
                "folder:FolderClass",
                "folder:EffectiveRights"
            ]
        );
    }
    let open = operation(&find_calendar_folders(Under::MessageRoot, false, 0, 1).unwrap());
    assert!(
        open.child("Restriction").is_none(),
        "for a server that refuses it"
    );
    for (offset, max) in [(0, 0), (0, 101), (10_001, 10)] {
        let refused = find_calendar_folders(Under::DeletedItems, true, offset, max);
        assert_eq!(refused, Err(INVALID), "{offset} {max}");
    }
}

fn lunch() -> Appointment {
    Appointment {
        title: "Lunch".into(),
        location: String::new(),
        notes: None,
        reminder: None,
        when: When::Timed {
            start_ms: 1_790_000_000_000,
            end_ms: 1_790_003_600_000,
        },
        recurrence: None,
    }
}

#[test]
fn a_view_and_an_appointment_name_the_folder_and_a_meeting_is_only_ever_made_in_the_default_one() {
    // A view of another calendar asks each item's rights; the default calendar's asks none.
    let default = calendar_view_in(0, 1000, 1, true, Where::Default).unwrap();
    assert!(!default.contains("EffectiveRights"));
    let view = operation(&calendar_view_in(0, 1000, 1, true, Where::Id(ID)).unwrap());
    assert!(uris(&view).contains(&"item:EffectiveRights".to_owned()));
    let parent = view.child("ParentFolderIds").unwrap();
    assert_eq!(parent.children.len(), 1);
    let named = &parent.children[0];
    assert_eq!(
        (named.name.as_str(), named.attr("Id")),
        ("FolderId", Some(ID))
    );
    let made = operation(&create_appointment_in(&lunch(), "UTC", Where::Id(ID)).unwrap());
    assert_eq!(made.attr("SendMeetingInvitations"), Some("SendToNone"));
    let saved = &made.child("SavedItemFolderId").unwrap().children;
    assert_eq!(saved.len(), 1);
    assert_eq!(
        (saved[0].name.as_str(), saved[0].attr("Id")),
        ("FolderId", Some(ID))
    );
    let bad = create_appointment_in(&lunch(), "UTC", Where::Id("a\""));
    assert_eq!(bad, Err(INVALID));
    let guests = Guests {
        required: vec!["bob@example.org".into()],
        optional: Vec::new(),
    };
    let meeting = operation(&create_meeting(&lunch(), &guests, "UTC").unwrap());
    let saved = meeting
        .at(&["SavedItemFolderId", "DistinguishedFolderId"])
        .unwrap();
    assert!(saved.attr("Id") == Some("calendar") && saved.children.is_empty());
}
