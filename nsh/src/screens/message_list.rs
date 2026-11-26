//! The selected mailbox's messages, virtualized.

use nsh_base::theme;
use nsh_core::prelude::*;

use crate::{
    store::MailStore,
    ui::{Icon, ListRowProps, icon_button, list_row, theme::MESSAGE_ROW},
};

pub fn message_list(store: MailStore) -> impl IntoElement {
    let list = virtual_list(
        move || store.message_count(),
        move |at| {
            let row = computed(move || store.message(at.index()));
            let field = move |f: fn(&crate::store::Summary) -> SharedString| {
                move || row.with(|m| m.as_ref().map(f).unwrap_or_default())
            };
            let id = move || row.with(|m| m.as_ref().map(|m| m.id.clone()));
            list_row(
                ListRowProps {
                    sender: field(|m| m.sender.clone()),
                    time: field(|m| m.time.clone()),
                    subject: field(|m| m.subject.clone()),
                    snippet: field(|m| m.snippet.clone()),
                    unread: move || row.with(|m| m.as_ref().is_some_and(|m| m.unread)),
                    selected: move || id().is_some() && store.selected() == id(),
                },
                move || {
                    if let Some(id) = id() {
                        store.open(id);
                    }
                },
            )
        },
    )
    .keys(move || {
        store
            .message_ids()
            .into_iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
    })
    .estimated_item_size(px(MESSAGE_ROW))
    .separator(|| view().h(px(1.0)).mx_4().bg(move || theme().border))
    .empty(
        view().p_6().items_center().child(
            text(move || {
                if store.loading() {
                    "Loading…"
                } else {
                    "No messages"
                }
            })
            .text_sm()
            .text_color(move || theme().muted_foreground),
        ),
    )
    .flex_1();
    view()
        .flex_1()
        .bg(move || theme().background)
        .child(
            view()
                .flex_row()
                .items_center()
                .h(px(44.0))
                .px_4()
                .gap_2()
                .border_b_1()
                .border_color(move || theme().border)
                .child(
                    text(move || store.mailbox().label())
                        .flex_1()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD),
                )
                .child(icon_button(Icon::Refresh, "Refresh", move || store.load())),
        )
        .child(list)
}
