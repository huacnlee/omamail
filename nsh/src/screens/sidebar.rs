//! Accounts and the system mailboxes, with the inbox's unread count.

use nsh_core::prelude::*;
use nsh_omarchy::{self as om, IconName, tokens};

use crate::store::{MailStore, Mailbox};

fn mailbox_icon(mailbox: Mailbox) -> Option<IconName> {
    Some(match mailbox {
        Mailbox::Inbox => IconName::Inbox,
        Mailbox::Unread => IconName::Eye,
        Mailbox::Starred => IconName::Star,
        Mailbox::Sent => IconName::Upload,
        Mailbox::Drafts => IconName::Pencil,
        Mailbox::Archive => IconName::Folder,
        Mailbox::Spam => IconName::TriangleAlert,
        Mailbox::Trash => IconName::Trash,
    })
}

pub fn sidebar(store: MailStore) -> impl IntoElement {
    let account = move || {
        store
            .accounts()
            .first()
            .map(|a| {
                if a.email.is_empty() {
                    a.label.clone()
                } else {
                    a.email.clone()
                }
            })
            .unwrap_or_default()
    };
    let mut section = om::sidebar_section(account);
    for mailbox in Mailbox::ALL {
        let mut item = om::sidebar_item(mailbox.id(), mailbox.label());
        if let Some(glyph) = mailbox_icon(mailbox) {
            item = item.icon(glyph);
        }
        if mailbox == Mailbox::Inbox {
            item = item.suffix(when(
                move || store.inbox_unread() > 0,
                move || {
                    text(move || SharedString::from(store.inbox_unread().to_string()))
                        .font_family(tokens::font_mono())
                        .text_size(px(tokens::TEXT_SM))
                        .text_color(tokens::secondary)
                },
            ));
        }
        section = section.child(item);
    }
    om::sidebar()
        .value(move || SharedString::from(store.mailbox().id()))
        .on_change(move |id: &SharedString| {
            if let Some(mailbox) = Mailbox::ALL.into_iter().find(|m| m.id() == id.as_ref()) {
                store.select_mailbox(mailbox);
            }
        })
        .accessibility_label("Mailboxes")
        .child(section)
}
