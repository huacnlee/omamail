//! Calendar folders as `GetFolder` and `FindFolder` describe them, and what the signed-in user may do in
//! a folder or to an item (`EffectiveRights`). Written from Microsoft's GetFolder, FindFolder,
//! CalendarFolder, FolderClass and EffectiveRights pages. Beyond the rules of the other decoders:
//!
//! - **A folder is its id, a name, a class and the rights, and nothing else.** A name is cleaned of
//!   control characters and of the invisible ones that reorder or hide text, trimmed and cut on a
//!   character boundary ("Calendar" when nothing is left); the class is cut and believed only by a
//!   comparison of the whole of it; an id that a reference could not be made of is the caller's to
//!   leave out (`ids::encode`).
//! - **Rights are what `EffectiveRights` names, where it is**: the folder's, or an item's ("the same
//!   information that is provided in the PR_ACCESS MAPI property"). No element is no rights at all
//!   (`None`), and a right it does not name, or names as anything but true, is not granted.
//! - **A page is bounded**: an answer with more folders than a page asks for is damaged.

use super::calendar::cap;
use super::{Rej, check, each, id_attr, messages};
use crate::providers::exchange::ews::soap::folders::MAX_FOLDERS;
use crate::providers::exchange::ews::xml::Node;

/// A folder name as it is shown: long enough for any name a person gives a calendar.
pub const MAX_FOLDER_NAME_BYTES: usize = 200;
const MAX_CLASS_BYTES: usize = 64;
/// More than any folder id the server writes, and short enough to compare cheaply.
const MAX_FOLDER_ID_BYTES: usize = 512;
const UNNAMED: &str = "Calendar";

/// What the signed-in user may do in a folder or to an item.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rights {
    pub read: bool,
    /// `CreateContents`: items may be made in the folder.
    pub create: bool,
    pub modify: bool,
    pub delete: bool,
}

impl Rights {
    /// What the owner of a mailbox may do in it.
    pub const ALL: Rights = Rights {
        read: true,
        create: true,
        modify: true,
        delete: true,
    };
}

/// A calendar folder: `FolderId/@Id` as sent, its name, its class and the signed-in user's rights there
/// (`None` when the server gave none, which is none).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CalendarFolder {
    pub id: String,
    pub name: String,
    pub class: String,
    pub rights: Option<Rights>,
}

fn is_true(text: &str) -> bool {
    matches!(text.trim(), "true" | "1")
}

/// What the `EffectiveRights` child of `node` says, `None` when there is none.
pub fn effective_rights(node: &Node) -> Option<Rights> {
    let rights = node.child("EffectiveRights")?;
    let has = |name: &str| rights.text_at(&[name]).is_some_and(is_true);
    Some(Rights {
        read: has("Read"),
        create: has("CreateContents"),
        modify: has("Modify"),
        delete: has("Delete"),
    })
}

/// Control characters and the invisible ones that reorder, join or hide text (the soft hyphen, the
/// Arabic letter mark, the zero-width and joining characters, the directional marks, embeddings and
/// isolates, the word joiner and invisible operators, the byte order mark): none belongs in a name.
fn hidden(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{00AD}' | '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

fn clean_name(text: &str) -> String {
    let cleaned: String = text.chars().filter(|c| !hidden(*c)).collect();
    let name = cap(cleaned.trim(), MAX_FOLDER_NAME_BYTES);
    match name.trim() {
        "" => UNNAMED.to_owned(),
        name => name.to_owned(),
    }
}

/// One folder element, whatever the server calls it; `None` without a usable id.
fn folder(node: &Node) -> Option<CalendarFolder> {
    let id = id_attr(node.child("FolderId"), "Id").filter(|id| id.len() <= MAX_FOLDER_ID_BYTES)?;
    Some(CalendarFolder {
        id,
        name: clean_name(node.text_at(&["DisplayName"]).unwrap_or("")),
        class: cap(
            node.text_at(&["FolderClass"]).unwrap_or(""),
            MAX_CLASS_BYTES,
        ),
        rights: effective_rights(node),
    })
}

/// A `GetFolderResponse` for `expected` folders, one result each: a folder the server refused is its
/// own error, one with no usable id is a damaged answer.
pub fn calendar_folders(
    body: &Node,
    expected: usize,
) -> Result<Vec<Result<CalendarFolder, Rej>>, Rej> {
    each(
        body,
        "GetFolderResponse",
        "GetFolderResponseMessage",
        expected,
        |message| {
            let found = message
                .child("Folders")
                .and_then(|list| list.children.first());
            found.and_then(folder).ok_or(Rej::INVALID)
        },
    )
}

/// One page of a `FindFolder`: the folders with a usable id, whether the server said it was the last,
/// and how many elements it sent (those left out included).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FoldersPage {
    pub folders: Vec<CalendarFolder>,
    pub includes_last: Option<bool>,
    pub elements: usize,
}

pub fn folders_page(body: &Node) -> Result<FoldersPage, Rej> {
    let [message] = messages(body, "FindFolderResponse", "FindFolderResponseMessage", 1)?[..]
    else {
        return Err(Rej::INVALID);
    };
    check(message)?;
    let root = message.child("RootFolder").ok_or(Rej::INVALID)?;
    let elements = root
        .child("Folders")
        .map_or(&[][..], |list| &list.children[..]);
    if elements.len() > MAX_FOLDERS {
        return Err(Rej::INVALID);
    }
    let includes_last = match root.attr("IncludesLastItemInRange").map(str::trim) {
        None => None,
        Some("true") => Some(true),
        Some("false") => Some(false),
        Some(_) => return Err(Rej::INVALID),
    };
    Ok(FoldersPage {
        folders: elements.iter().filter_map(folder).collect(),
        includes_last,
        elements: elements.len(),
    })
}

#[cfg(test)]
mod tests;
