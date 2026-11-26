//! Accounts and the system mailboxes, with the inbox's unread count.

use nsh_base::theme;
use nsh_core::prelude::*;

use crate::{
    store::{MailStore, Mailbox},
    ui::{Icon, sidebar_item},
};

fn mailbox_icon(mailbox: Mailbox) -> Icon {
    match mailbox {
        Mailbox::Inbox => Icon::Inbox,
        Mailbox::Unread => Icon::Unread,
        Mailbox::Starred => Icon::Star,
        Mailbox::Sent => Icon::Send,
        Mailbox::Drafts => Icon::Draft,
        Mailbox::Archive => Icon::Archive,
        Mailbox::Spam => Icon::Spam,
        Mailbox::Trash => Icon::Trash,
    }
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
    let mut items = view().gap(px(2.0)).role(AccessibilityRole::List);
    for mailbox in Mailbox::ALL {
        items = items.child(sidebar_item(
            mailbox_icon(mailbox),
            mailbox.label(),
            move || store.mailbox() == mailbox,
            move || {
                if mailbox == Mailbox::Inbox {
                    store.inbox_unread()
                } else {
                    0
                }
            },
            move || store.select_mailbox(mailbox),
        ));
    }
    view()
        .flex_1()
        .px_2()
        .py_3()
        .gap_3()
        .bg(move || theme().sidebar)
        .text_color(move || theme().sidebar_foreground)
        .child(
            text(account)
                .px_2()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .number_of_lines(1)
                .text_color(move || theme().muted_foreground),
        )
        .child(items)
}
