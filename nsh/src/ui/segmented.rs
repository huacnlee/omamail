//! A segmented control: one of a few options, as a row of buttons.

use nsh_base::theme;
use nsh_core::prelude::*;

use super::theme::{motion, radius};

/// `options` with `selected` the current one; `on_select` gets the index.
pub fn segmented(
    options: &'static [&'static str],
    selected: Signal<usize>,
    on_select: impl Fn(usize) + Copy + 'static,
) -> impl IntoElement {
    let mut row = view()
        .flex_row()
        .p(px(2.0))
        .gap(px(2.0))
        .rounded(move || radius())
        .bg(move || theme().muted)
        .role(AccessibilityRole::Radiogroup);
    for (index, label) in options.iter().enumerate() {
        row = row.child(
            nsh_base::button()
                .on_press(move || on_select(index))
                .selected(move || selected.get() == index)
                .accessibility_label(*label)
                .h(px(22.0))
                .px_3()
                .items_center()
                .justify_center()
                .rounded(move || radius())
                .text_color(move || theme().muted_foreground)
                .hover(|s| s.text_color(move || theme().foreground))
                .active(|s| s.opacity(motion::PRESSED_OPACITY))
                .selected_style(|s| {
                    s.bg(move || theme().background)
                        .text_color(move || theme().foreground)
                        .shadow_sm()
                })
                .focus_visible(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
                .child(text(*label).text_xs().font_weight(FontWeight::MEDIUM)),
        );
    }
    row
}
