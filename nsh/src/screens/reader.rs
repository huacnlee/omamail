//! The open message: its header and the backend's reading-mode HTML in a
//! `TextView`. Links open in the system browser.

use nsh_base::{TextViewLinkPressEvent, text_view};
use nsh_core::prelude::*;
use nsh_omarchy::{self as om, IconName, tokens};

use crate::{
    store::{MailStore, Reader},
    ui::READER_MAX_WIDTH,
};

pub fn reader(store: MailStore) -> impl IntoElement {
    let state = computed(move || store.reader());
    let html = move || match state.get() {
        Reader::Ready { html, .. } => Some(html),
        _ => None,
    };
    let placeholder = move || match state.get() {
        Reader::Empty => "No message selected".into(),
        Reader::Loading => "Loading…".into(),
        Reader::Failed(error) => {
            SharedString::from(format!("Could not open this message ({error})"))
        }
        Reader::Ready { .. } => SharedString::default(),
    };
    let ready = move || matches!(state.get(), Reader::Ready { .. });
    let subject = move || match state.get() {
        Reader::Ready { subject, .. } => subject,
        _ => SharedString::default(),
    };
    let sender = move || match state.get() {
        Reader::Ready { sender, .. } => sender,
        _ => SharedString::default(),
    };
    view()
        .flex_1()
        .bg(tokens::background)
        .child(when(
            move || !ready(),
            move || {
                view()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .child(om::empty_state(placeholder).icon(IconName::Inbox))
            },
        ))
        .child(when(ready, move || {
            scroll().flex_1().child(
                view()
                    .w_full()
                    .max_w(px(READER_MAX_WIDTH))
                    .self_center()
                    .px(px(tokens::SPACE_6))
                    .py(px(tokens::SPACE_4))
                    .gap(px(tokens::SPACE_3))
                    .child(
                        text(subject)
                            .text_size(px(tokens::TEXT_XL))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(tokens::bright)
                            .selectable(true),
                    )
                    .child(
                        text(sender)
                            .font_family(tokens::font_mono())
                            .text_size(px(tokens::TEXT_SM))
                            .text_color(tokens::secondary),
                    )
                    .child(view().h(px(1.0)).bg(tokens::divider))
                    .child(
                        text_view()
                            .html(html)
                            .selectable(true)
                            .on_link_press(|event: &TextViewLinkPressEvent| {
                                // In-document anchors stay in the reader.
                                if !event.url.starts_with('#') {
                                    drop(open_url(event.url.to_string()));
                                }
                            })
                            .test_id("reader-body")
                            .gap(px(tokens::SPACE_3))
                            .text_size(px(tokens::TEXT_LG))
                            .line_height(px(22.0))
                            .text_color(tokens::foreground),
                    ),
            )
        }))
}
