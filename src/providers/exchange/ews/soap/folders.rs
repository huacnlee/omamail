//! The requests that find and open calendar folders, and the folder element every calendar request
//! names. Written from Microsoft's GetFolder, FindFolder, FolderShape, FolderClass, EffectiveRights,
//! DistinguishedFolderId, FolderId, Mailbox and Restriction pages, from "Delegate
//! access and EWS in Exchange" and "Access a calendar as a delegate by using EWS", and from
//! [MS-OXOCAL] for the class of a calendar folder.
//!
//! - **A calendar is named three ways** (`Where`): the signed-in mailbox's own `calendar` folder by its
//!   distinguished name, as every call named it before there was a choice; the `calendar` folder of
//!   another mailbox by its primary address, the same element with a `Mailbox` child ("explicit
//!   access": it "specifies the mailbox for the delegate to access"); and any folder by the `FolderId`
//!   an earlier answer gave ("implicit access": "the context is hidden in the identifiers", so the other
//!   mailbox's address is not sent again). Nothing is impersonated: no header names a user.
//! - **An address and an id are checked, never repaired**: an address is `ids::mailbox`'s shape, an id
//!   one a reference could be made of (`ids::encode`).
//! - **`GetFolder` asks for what a calendar list needs**: `folder:DisplayName`, `folder:FolderClass` and
//!   `folder:EffectiveRights` ("supported in the GetFolder, GetItem, FindFolder ... responses").
//! - **`FindFolder` is deep** ("search in all child folders of the identified parent folder"), from the
//!   root of the message folders (`msgfolderroot`) or from Deleted Items (`deleteditems`, whose
//!   calendars the caller leaves out), a page of at most `MAX_FOLDERS`, with a restriction "used to
//!   filter folders": the folder class equal to `IPF.Appointment`, the container class [MS-OXOCAL]
//!   gives a calendar folder. The restriction can be left out for a server that refuses it; the caller then compares
//!   the class itself.

use super::{envelope, esc, field};
use crate::providers::exchange::ids;

const INVALID: &str = "invalid_params";
/// The most folders one `FindFolder` page asks for, and believes an answer holds.
pub const MAX_FOLDERS: usize = 100;
/// The furthest a page of folders may start.
const MAX_OFFSET: usize = 10_000;

/// The class Microsoft gives a calendar folder (`FolderClass`; [MS-OXOCAL], `PidTagContainerClass`).
pub const CALENDAR_CLASS: &str = "IPF.Appointment";

/// Which calendar a call is for. `Default` is the signed-in mailbox's own `calendar` folder, what every
/// call meant before there was a choice; `Folder` is a calendar folder by the server's id, of the
/// signed-in mailbox (`mailbox` none) or of another one, whose primary address it carries for the
/// decisions this client makes (an id of another mailbox's folder "uniquely identif[ies] itself as
/// belonging to the mailbox owner", so the address is never sent with it).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Calendar {
    #[default]
    Default,
    Folder {
        /// `FolderId/@Id` as the server gave it.
        id: String,
        mailbox: Option<String>,
    },
}

impl Calendar {
    pub fn is_default(&self) -> bool {
        matches!(self, Calendar::Default)
    }

    /// Whether the folder is in a mailbox that is not the signed-in one.
    pub fn is_shared(&self) -> bool {
        matches!(
            self,
            Calendar::Folder {
                mailbox: Some(_),
                ..
            }
        )
    }

    /// How a request names this calendar's folder.
    pub fn place(&self) -> Where<'_> {
        match self {
            Calendar::Default => Where::Default,
            Calendar::Folder { id, .. } => Where::Id(id),
        }
    }
}

/// Where a calendar folder is, as a request names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Where<'a> {
    /// The signed-in mailbox's own `calendar` folder.
    Default,
    /// The `calendar` folder of another mailbox, by its primary address.
    Mailbox(&'a str),
    /// Any folder, by the server's id.
    Id(&'a str),
}

/// Where a `FindFolder` starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Under {
    MessageRoot,
    DeletedItems,
}

/// The folder element for `at`; refused when it could not be written safely.
pub fn folder_element(at: Where) -> Result<String, &'static str> {
    Ok(match at {
        Where::Default => r#"<t:DistinguishedFolderId Id="calendar"/>"#.to_owned(),
        Where::Mailbox(address) => {
            ids::mailbox(address)?;
            format!(
                r#"<t:DistinguishedFolderId Id="calendar"><t:Mailbox><t:EmailAddress>{}</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId>"#,
                esc(address)
            )
        }
        Where::Id(id) => {
            ids::encode(id).map_err(|_| INVALID)?;
            format!(r#"<t:FolderId Id="{}"/>"#, esc(id))
        }
    })
}

fn folder_shape() -> String {
    let fields: String = [
        "folder:DisplayName",
        "folder:FolderClass",
        "folder:EffectiveRights",
    ]
    .map(field)
    .concat();
    format!(
        "<m:FolderShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>{fields}</t:AdditionalProperties></m:FolderShape>"
    )
}

/// `GetFolder` of one calendar folder for its name, its class and the signed-in user's rights there.
pub fn get_calendar_folder_rights(at: Where) -> Result<String, &'static str> {
    Ok(envelope(&format!(
        "<m:GetFolder>{}<m:FolderIds>{}</m:FolderIds></m:GetFolder>",
        folder_shape(),
        folder_element(at)?
    )))
}

/// `FindFolder`, deep, below `under`: one page of at most `max` folders (1 to `MAX_FOLDERS`) from
/// `offset`, and with `restricted` the calendar folders alone.
pub fn find_calendar_folders(
    under: Under,
    restricted: bool,
    offset: usize,
    max: usize,
) -> Result<String, &'static str> {
    if !(1..=MAX_FOLDERS).contains(&max) || offset > MAX_OFFSET {
        return Err(INVALID);
    }
    let parent = match under {
        Under::MessageRoot => "msgfolderroot",
        Under::DeletedItems => "deleteditems",
    };
    let restriction = if restricted {
        format!(
            r#"<m:Restriction><t:IsEqualTo>{}<t:FieldURIOrConstant><t:Constant Value="{CALENDAR_CLASS}"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>"#,
            field("folder:FolderClass")
        )
    } else {
        String::new()
    };
    Ok(envelope(&format!(
        concat!(
            r#"<m:FindFolder Traversal="Deep">{}"#,
            r#"<m:IndexedPageFolderView MaxEntriesReturned="{}" Offset="{}" BasePoint="Beginning"/>{}"#,
            r#"<m:ParentFolderIds><t:DistinguishedFolderId Id="{}"/></m:ParentFolderIds></m:FindFolder>"#
        ),
        folder_shape(),
        max,
        offset,
        restriction,
        parent
    )))
}

#[cfg(test)]
mod tests;
