//! The open message: its header and the backend's reading-mode HTML in a
//! `TextView`. Links open in the system browser.

use nsh_base::{TextViewLinkPressEvent, text_view, theme};
use nsh_core::prelude::*;

use crate::{
    store::{MailStore, Reader},
    ui::theme::READER_MAX_WIDTH,
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
        .bg(move || theme().background)
        .child(when(
            move || !ready(),
            move || {
                view().flex_1().items_center().justify_center().child(
                    text(placeholder)
                        .text_sm()
                        .text_color(move || theme().muted_foreground),
                )
            },
        ))
        .child(when(ready, move || {
            scroll().flex_1().child(
                view()
                    .w_full()
                    .max_w(px(READER_MAX_WIDTH))
                    .self_center()
                    .px_8()
                    .py_6()
                    .gap_4()
                    .child(
                        text(subject)
                            .text_xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .selectable(true),
                    )
                    .child(
                        text(sender)
                            .text_sm()
                            .text_color(move || theme().muted_foreground),
                    )
                    .child(view().h(px(1.0)).bg(move || theme().border))
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
                            .gap_3()
                            .text_size(px(15.0))
                            .line_height(px(23.0))
                            .text_color(move || theme().foreground),
                    ),
            )
        }))
}
