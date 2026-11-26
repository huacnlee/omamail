//! The selected mailbox's messages, virtualized.

use nsh_core::prelude::*;
use nsh_omarchy::{self as om, IconName, tokens};

use crate::{
    store::{MailStore, Summary},
    ui::{BAR_HEIGHT, MESSAGE_ROW},
};

fn row(store: MailStore, at: Position) -> impl IntoElement {
    let row = computed(move || store.message(at.index()));
    let field = move |f: fn(&Summary) -> SharedString| {
        move || row.with(|m| m.as_ref().map(f).unwrap_or_default())
    };
    let id = move || row.with(|m| m.as_ref().map(|m| m.id.clone()));
    let unread = move || row.with(|m| m.as_ref().is_some_and(|m| m.unread));
    // Unread rows read brighter; read ones settle back to the body color.
    let strong = move || {
        if unread() {
            tokens::bright()
        } else {
            tokens::foreground()
        }
    };
    let line = |content: Box<dyn Fn() -> SharedString>| {
        text(move || content()).number_of_lines(1).flex_1()
    };
    om::list_item()
        .selected(move || id().is_some() && store.selected() == id())
        .on_press(move || {
            if let Some(id) = id() {
                store.open(id);
            }
        })
        .accessibility_label(field(|m| m.subject.clone()))
        .child(
            view()
                .h(px(MESSAGE_ROW))
                .w_full()
                .justify_center()
                .gap(px(2.0))
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .gap(px(tokens::SPACE_2))
                        .child(
                            // The unread marker: the accent, square as Omarchy draws it.
                            view().w(px(6.0)).h(px(6.0)).child(when(unread, || {
                                view().size_full().bg(move || tokens::accent())
                            })),
                        )
                        .child(
                            line(Box::new(field(|m| m.sender.clone())))
                                .text_size(px(tokens::TEXT_MD))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(strong),
                        )
                        .child(
                            text(field(|m| m.time.clone()))
                                .font_family(tokens::font_mono())
                                .text_size(px(tokens::TEXT_SM))
                                .text_color(move || tokens::secondary()),
                        ),
                )
                .child(
                    line(Box::new(field(|m| m.subject.clone())))
                        .pl(px(6.0 + tokens::SPACE_2))
                        .text_size(px(tokens::TEXT_MD))
                        .text_color(strong),
                )
                .child(
                    line(Box::new(field(|m| m.snippet.clone())))
                        .pl(px(6.0 + tokens::SPACE_2))
                        .text_size(px(tokens::TEXT_SM))
                        .text_color(move || tokens::secondary()),
                ),
        )
}

pub fn message_list(store: MailStore) -> impl IntoElement {
    let target = element_ref();
    let list = om::list(move || store.message_count(), move |at| row(store, at))
        .keys(move || {
            store
                .message_ids()
                .into_iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
        })
        .estimated_item_size(px(MESSAGE_ROW))
        .empty(
            view().p(px(tokens::SPACE_6)).child(
                om::empty_state(move || {
                    SharedString::from(if store.loading() {
                        "Loading…"
                    } else {
                        "No messages"
                    })
                })
                .icon(IconName::Inbox),
            ),
        )
        .element_ref(&target)
        .flex_1();
    view()
        .flex_1()
        .bg(move || tokens::background())
        .child(
            view()
                .flex_row()
                .items_center()
                .h(px(BAR_HEIGHT))
                .pl(px(tokens::SPACE_3))
                .pr(px(tokens::SPACE_1))
                .gap(px(tokens::SPACE_2))
                .border_b_1()
                .border_color(move || tokens::border())
                .child(
                    text(move || store.mailbox().label())
                        .flex_1()
                        .text_size(px(tokens::TEXT_MD))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(move || tokens::bright()),
                )
                .child(
                    text(move || SharedString::from(store.message_count().to_string()))
                        .font_family(tokens::font_mono())
                        .text_size(px(tokens::TEXT_SM))
                        .text_color(move || tokens::secondary()),
                )
                .child(
                    om::icon_button(IconName::Download, "Refresh")
                        .ghost()
                        .small()
                        .on_press(move || store.load()),
                ),
        )
        .child(
            view().flex_1().relative().child(list).child(
                om::scrollbar(target)
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .right_0(),
            ),
        )
}
