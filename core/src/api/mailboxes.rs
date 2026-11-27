//! The system mailboxes every account lists (`mail.list` `mailbox`).

use serde::Serialize;

/// A system mailbox: its id for [`ListQuery`](super::ListQuery) and its title.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Mailbox {
    pub id: &'static str,
    pub title: &'static str,
}

/// The mailboxes in the order the sidebar shows them.
pub const SYSTEM: [Mailbox; 8] = [
    Mailbox {
        id: "inbox",
        title: "Inbox",
    },
    Mailbox {
        id: "unread",
        title: "Unread",
    },
    Mailbox {
        id: "starred",
        title: "Starred",
    },
    Mailbox {
        id: "sent",
        title: "Sent",
    },
    Mailbox {
        id: "drafts",
        title: "Drafts",
    },
    Mailbox {
        id: "archive",
        title: "Archive",
    },
    Mailbox {
        id: "spam",
        title: "Spam",
    },
    Mailbox {
        id: "trash",
        title: "Trash",
    },
];

#[cfg(test)]
mod tests {
    #[test]
    fn ids_are_the_ones_mail_list_takes() {
        for mailbox in super::SYSTEM {
            assert!(
                crate::mail::Mailbox::try_from(mailbox.id).is_ok(),
                "{}",
                mailbox.id
            );
        }
    }
}
