//! A search field.

use nsh_base::{input, theme};
use nsh_core::prelude::*;

use super::{
    icon::{Icon, icon},
    theme::{CONTROL_HEIGHT, radius},
};

/// A search input showing `value`, reporting edits and Enter.
pub fn search_input(
    placeholder: &'static str,
    value: Signal<String>,
    on_submit: impl Fn(String) + 'static,
) -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .gap_2()
        .h(px(CONTROL_HEIGHT))
        .px_2()
        .rounded(radius)
        .bg(move || theme().muted)
        .text_color(move || theme().muted_foreground)
        .focus_within(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
        .child(icon(Icon::Search, 14.0))
        .child(
            input()
                .flex_1()
                .text_sm()
                .text_color(move || theme().foreground)
                .placeholder(placeholder)
                .value(move || value.get())
                .on_change(move |next: &str| value.set(next.to_owned()))
                .on_submit(move |text: &str| on_submit(text.to_owned())),
        )
}
