//! The calendars a mailbox can reach: its own default one and its other calendar folders, found; a
//! calendar another mailbox shares, opened by that mailbox's address; and the folder a calendar call
//! names, as the server spells it now, with what the signed-in user may do there.
//!
//! No Autodiscover, no DNS, no address book: every request goes to the server the owner typed, and what
//! is asked is what Microsoft documents (`soap::folders`).
//!
//! **Discovery** (`discover_calendars`) is two steps, of which only the first must succeed:
//!
//! 1. `GetFolder` of the default `calendar` folder, with its name and rights (a mailbox with none is
//!    `exchange_folder_unavailable`). The owner may do everything there whatever the server leaves out.
//! 2. `FindFolder`, deep, from the root of the message folders (a deep traversal searches "all child
//!    folders of the identified parent folder", the default calendar's included, so no second search
//!    starts there), for the folders of class `IPF.Appointment`; and the same search below Deleted
//!    Items, whose calendars are not listed. A server that refuses the class restriction is asked again
//!    without it, for up to `MAX_PAGES` pages, and the class of each folder is compared exactly, so
//!    `IPF.Appointment.Birthday` is no calendar. The default calendar is listed once.
//!
//! Step 2 is a thing discovery can do without: a failure of it is said with its code (`Steps`), and so is
//! a list cut short (`truncated`), so that a caller keeps what an earlier discovery found rather than
//! taking an incomplete answer for the whole. A refused login ends the call.
//!
//! **A calendar of another mailbox is opened by the address of that mailbox** (`open_shared_calendar`).
//! Microsoft documents no request that lists what others have shared with the signed-in user: the
//! shortcuts Outlook keeps for them are folder-associated messages ([MS-OXOCFG]) that `FindItem`'s
//! documented traversals do not reach. The folder is read before anything is saved, and every way of not
//! being shared (access denied, no such mailbox, no such folder, no right to read, not a calendar) is one
//! code, `exchange_calendar_not_shared`; an address that opens the owner's own default calendar (an alias
//! of theirs) is `exchange_calendar_own_mailbox`, so it is not drawn twice.
//!
//! **What may be done in a calendar is asked of the server whenever it decides something** (`home`): a
//! folder that is not exactly a calendar is no calendar, and the folder's `EffectiveRights` decide
//! whether it is read and whether something is made in it. A server that names none grants none, except
//! in the default calendar, which is the owner's.

use super::super::decode::calendar as view;
use super::super::decode::folders::{self as answer, CalendarFolder, Rights};
use super::super::decode::{self, Rej};
use super::super::soap::calendar as soap;
use super::super::soap::folders::{self as request, CALENDAR_CLASS, Calendar, Under, Where};
use super::calendar::SERVER;
use super::{Client, UNAUTHORIZED, whole};

pub const NOT_SHARED: &str = "exchange_calendar_not_shared";
/// The address opened the owner's own default calendar: an alias of theirs.
pub const OWN_MAILBOX: &str = "exchange_calendar_own_mailbox";
/// Most calendars one discovery lists, the default one included.
pub const MAX_CALENDARS: usize = 100;
/// Most pages of folders read from a server that refuses the class restriction.
const MAX_PAGES: usize = 5;

/// Where a calendar was found, in the words the answer uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Default,
    Folder,
    Address,
}

impl Origin {
    pub const fn word(self) -> &'static str {
        match self {
            Origin::Default => "default",
            Origin::Folder => "folder",
            Origin::Address => "address",
        }
    }
}

/// One calendar a mailbox can reach; `mailbox` is the primary address of another mailbox, `None` for
/// the signed-in one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub folder: CalendarFolder,
    pub mailbox: Option<String>,
    pub origin: Origin,
}

/// What the folder step did: how many calendars it found, and its code if it failed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Steps {
    pub folders: usize,
    pub folders_code: Option<&'static str>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Discovered {
    /// The default calendar first, then the mailbox's other folders.
    pub calendars: Vec<Found>,
    /// Calendars were left out: more than `MAX_CALENDARS`, or pages the server had and were not read.
    pub truncated: bool,
    pub steps: Steps,
}

/// The folder a call names as the server spells it now, and what the signed-in user may do there.
pub struct Home {
    pub id: String,
    pub rights: Rights,
}

/// A folder of the signed-in mailbox that is not there, or an id that no longer names one.
fn folder_code(code: &'static str) -> &'static str {
    match code {
        decode::NOT_FOUND => decode::FOLDER,
        code => code,
    }
}

/// Every way another mailbox's calendar is not shared with the signed-in user: refused, no such
/// mailbox, no such folder.
fn shared_code(code: &'static str) -> &'static str {
    match code {
        decode::DENIED | decode::FOLDER | decode::NOT_FOUND => NOT_SHARED,
        code => code,
    }
}

/// Whether a folder is a calendar: its class is exactly the calendar's.
fn is_calendar(folder: &CalendarFolder) -> bool {
    folder.class == CALENDAR_CLASS
}

impl Client {
    /// One folder as the server describes it, with the signed-in user's rights there; a refusal is said
    /// by `failed`.
    async fn calendar_folder(
        &mut self,
        at: Where<'_>,
        failed: fn(&'static str) -> &'static str,
    ) -> Result<CalendarFolder, &'static str> {
        let asked = request::get_calendar_folder_rights(at)?;
        let mut found = self
            .call(&asked, true, |node| {
                whole(answer::calendar_folders(node, 1)?)
            })
            .await?;
        found
            .pop()
            .unwrap_or(Err(Rej::INVALID))
            .map_err(|rej| failed(rej.code))
    }

    /// The default calendar's id as the server spells it now.
    async fn default_calendar_id(&mut self) -> Result<String, &'static str> {
        let asked = soap::get_calendar_folder();
        self.call(&asked, true, view::folder_id).await
    }

    /// The folder `calendar` names, read now: the default one by its distinguished name, with every right
    /// (it is the owner's), and any other by its id, with the rights the server gives there. A folder
    /// that is not a calendar is unavailable as one.
    pub(super) async fn home(&mut self, calendar: &Calendar) -> Result<Home, &'static str> {
        match calendar {
            Calendar::Default => Ok(Home {
                id: self.default_calendar_id().await?,
                rights: Rights::ALL,
            }),
            Calendar::Folder { id, .. } => {
                let folder = self.calendar_folder(Where::Id(id), folder_code).await?;
                if !is_calendar(&folder) {
                    return Err(decode::FOLDER);
                }
                Ok(Home {
                    id: folder.id,
                    rights: folder.rights.unwrap_or_default(),
                })
            }
        }
    }

    /// The calendars of the signed-in mailbox, as far as documented requests find them.
    pub async fn discover_calendars(&mut self) -> Result<Discovered, &'static str> {
        let mut found = Discovered::default();
        let mut default = self.calendar_folder(Where::Default, folder_code).await?;
        default.rights = Some(default.rights.unwrap_or(Rights::ALL));
        let default_id = default.id.clone();
        found.calendars.push(Found {
            folder: default,
            mailbox: None,
            origin: Origin::Default,
        });
        match self.own_folders(&default_id).await {
            Ok((folders, truncated)) => {
                found.steps.folders = folders.len();
                found.truncated |= truncated;
                found
                    .calendars
                    .extend(folders.into_iter().map(|folder| Found {
                        folder,
                        mailbox: None,
                        origin: Origin::Folder,
                    }));
            }
            Err(UNAUTHORIZED) => return Err(UNAUTHORIZED),
            Err(code) => found.steps.folders_code = Some(code),
        }
        Ok(found)
    }

    /// The default `calendar` of the mailbox `address` names, if it is shared with the signed-in user:
    /// one the server opens, says may be read and calls a calendar, and that is not the owner's own
    /// default calendar reached by an alias. Read before anything is saved.
    pub async fn open_shared_calendar(&mut self, address: &str) -> Result<Found, &'static str> {
        // Judged before the connection is touched.
        request::folder_element(Where::Mailbox(address))?;
        let folder = self
            .calendar_folder(Where::Mailbox(address), shared_code)
            .await?;
        let readable = folder.rights.is_some_and(|rights| rights.read);
        if !readable || !is_calendar(&folder) {
            return Err(NOT_SHARED);
        }
        if folder.id == self.default_calendar_id().await? {
            return Err(OWN_MAILBOX);
        }
        Ok(Found {
            folder,
            mailbox: Some(address.to_owned()),
            origin: Origin::Address,
        })
    }

    /// The signed-in mailbox's calendar folders other than the default one, outside Deleted Items, and
    /// whether more were left than were listed. Either search failing fails the step: without the
    /// second, a calendar in Deleted Items could not be told from one in use.
    async fn own_folders(
        &mut self,
        default_id: &str,
    ) -> Result<(Vec<CalendarFolder>, bool), &'static str> {
        let (found, mut truncated) = self.calendar_folders(Under::MessageRoot).await?;
        let (deleted, deleted_more) = self.calendar_folders(Under::DeletedItems).await?;
        truncated |= deleted_more;
        let mut folders: Vec<CalendarFolder> = Vec::new();
        for folder in found {
            let known = folder.id == default_id
                || deleted.iter().any(|gone| gone.id == folder.id)
                || folders.iter().any(|f| f.id == folder.id);
            if known {
                continue;
            }
            // The default calendar takes one of the places.
            if folders.len() + 1 < MAX_CALENDARS {
                folders.push(folder);
            } else {
                truncated = true;
            }
        }
        Ok((folders, truncated))
    }

    /// The calendar folders below `under`, and whether the server said there were more than it gave:
    /// asked with the class restriction, and once more without it from a server that refuses that.
    async fn calendar_folders(
        &mut self,
        under: Under,
    ) -> Result<(Vec<CalendarFolder>, bool), &'static str> {
        let max = request::MAX_FOLDERS;
        let calendars = |page: Vec<CalendarFolder>| page.into_iter().filter(is_calendar);
        let restricted = request::find_calendar_folders(under, true, 0, max)?;
        match self.call(&restricted, true, answer::folders_page).await {
            Ok(page) => {
                let more = !page.includes_last.unwrap_or(page.elements < max);
                Ok((calendars(page.folders).collect(), more))
            }
            Err(SERVER) => {
                let mut folders = Vec::new();
                for at in 0..MAX_PAGES {
                    let asked = request::find_calendar_folders(under, false, at * max, max)?;
                    let page = self.call(&asked, true, answer::folders_page).await?;
                    folders.extend(calendars(page.folders));
                    if page.includes_last.unwrap_or(page.elements < max) {
                        return Ok((folders, false));
                    }
                }
                Ok((folders, true))
            }
            Err(code) => Err(code),
        }
    }
}
