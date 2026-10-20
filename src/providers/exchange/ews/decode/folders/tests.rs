use super::*;
use crate::providers::exchange::ews::decode::envelope;
use crate::providers::exchange::ews::tests::fake::{message, ok, response};

const ID: &str = "AAMkADAwATM0MDAAMS0zYgAuAAADDHL9rDpqAAA=";

fn body(kind: &str, messages: &[String]) -> Node {
    envelope(response(kind, messages).as_bytes()).unwrap().body
}

fn rights(read: bool, create: bool, modify: bool, delete: bool) -> String {
    format!(
        "<t:EffectiveRights><t:CreateContents>{create}</t:CreateContents><t:Delete>{delete}</t:Delete><t:Modify>{modify}</t:Modify><t:Read>{read}</t:Read></t:EffectiveRights>"
    )
}

fn folder(id: &str, inner: &str) -> String {
    format!(
        r#"<t:CalendarFolder><t:FolderId Id="{id}" ChangeKey="AgAA"/>{inner}</t:CalendarFolder>"#
    )
}

fn got(inner: &str) -> Result<CalendarFolder, Rej> {
    let folders = format!("<m:Folders>{inner}</m:Folders>");
    let found = calendar_folders(&body("GetFolder", &[ok("GetFolder", &folders)]), 1);
    found.and_then(|mut list| list.pop().unwrap())
}

#[test]
fn a_folder_is_its_id_its_name_its_class_and_the_rights_the_server_names() {
    let inner = format!(
        "<t:DisplayName> Team </t:DisplayName><t:FolderClass>IPF.Appointment</t:FolderClass>{}",
        rights(true, true, false, true)
    );
    let found = got(&folder(ID, &inner)).unwrap();
    assert_eq!((found.id.as_str(), found.name.as_str()), (ID, "Team"));
    assert_eq!(found.class, "IPF.Appointment");
    let said = Rights {
        read: true,
        create: true,
        modify: false,
        delete: true,
    };
    assert_eq!(found.rights, Some(said));
}

#[test]
fn no_rights_element_is_no_rights_and_a_right_it_does_not_name_as_true_is_not_granted() {
    assert_eq!(got(&folder(ID, "")).unwrap().rights, None);
    let half = "<t:EffectiveRights><t:Read>1</t:Read><t:Modify>yes</t:Modify><t:Delete/></t:EffectiveRights>";
    let found = got(&folder(ID, half)).unwrap().rights.unwrap();
    assert_eq!(
        found,
        Rights {
            read: true,
            ..Rights::default()
        }
    );
    // An item's rights are read the same way.
    let item = xml_node(&format!(
        "<t:CalendarItem>{}</t:CalendarItem>",
        rights(false, false, true, false)
    ));
    assert_eq!(
        effective_rights(&item),
        Some(Rights {
            modify: true,
            ..Rights::default()
        })
    );
}

fn xml_node(text: &str) -> Node {
    let wrapped = format!(r#"<x xmlns:t="urn:t">{text}</x>"#);
    let mut root = crate::providers::exchange::ews::xml::parse(wrapped.as_bytes()).unwrap();
    root.children.remove(0)
}

#[test]
fn a_name_is_cleaned_of_control_and_invisible_characters_and_bounded() {
    let name = |text: &str| {
        let inner = format!("<t:DisplayName>{text}</t:DisplayName>");
        got(&folder(ID, &inner)).unwrap().name
    };
    assert_eq!(name("Te&#x202E;am&#x200B;&#9;"), "Team");
    let invisible = "&#xAD;&#x61C;&#x2060;&#x2061;&#x2062;&#x2063;&#x2064;&#xFEFF;";
    assert_eq!(name(&format!("Te{invisible}am")), "Team");
    assert_eq!(name("  "), "Calendar");
    assert_eq!(name("&#x2066;&#x2069;"), "Calendar");
    let long = name(&"é".repeat(150));
    assert!(long.len() <= MAX_FOLDER_NAME_BYTES && long.chars().all(|c| c == 'é'));
    let class = got(&folder(
        ID,
        &format!("<t:FolderClass>{}</t:FolderClass>", "X".repeat(300)),
    ));
    assert_eq!(class.unwrap().class.len(), 64);
}

#[test]
fn a_folder_without_a_usable_id_is_a_damaged_answer_and_a_refused_one_its_own_error() {
    assert_eq!(got("<t:CalendarFolder/>"), Err(Rej::INVALID));
    assert_eq!(got(&folder(" ", "")), Err(Rej::INVALID));
    assert_eq!(got(&folder(&"A".repeat(513), "")), Err(Rej::INVALID));
    let refused = message("GetFolder", "Error", "ErrorAccessDenied", "");
    let found = calendar_folders(&body("GetFolder", &[refused]), 1).unwrap();
    assert_eq!(
        found[0].as_ref().err().map(|rej| rej.code),
        Some("exchange_access_denied")
    );
    // One answer for another number of folders than were asked about is damaged.
    let one = ok(
        "GetFolder",
        &format!("<m:Folders>{}</m:Folders>", folder(ID, "")),
    );
    assert!(calendar_folders(&body("GetFolder", &[one]), 2).is_err());
}

fn page(folders: &str, attributes: &str) -> Result<FoldersPage, Rej> {
    let root = format!("<m:RootFolder{attributes}><t:Folders>{folders}</t:Folders></m:RootFolder>");
    folders_page(&body("FindFolder", &[ok("FindFolder", &root)]))
}

#[test]
fn a_page_of_folders_says_whether_it_is_the_last_and_counts_what_it_left_out() {
    let two = folder(ID, "<t:DisplayName>A</t:DisplayName>") + "<t:CalendarFolder/>";
    let found = page(&two, r#" IncludesLastItemInRange="false""#).unwrap();
    let names: Vec<&str> = found.folders.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        (names, found.elements, found.includes_last),
        (vec!["A"], 2, Some(false))
    );
    assert_eq!(page("", "").unwrap().includes_last, None);
    assert_eq!(
        page("", r#" IncludesLastItemInRange="maybe""#),
        Err(Rej::INVALID)
    );
    // More folders than a page asks for is a damaged answer.
    assert_eq!(page(&folder(ID, "").repeat(101), ""), Err(Rej::INVALID));
    assert_eq!(page(&folder(ID, "").repeat(100), "").unwrap().elements, 100);
}
