//! A mailbox in the sidebar: icon, label, unread count.

use nsh_base::theme;
use nsh_core::prelude::*;

use super::{
    badge::badge,
    icon::{Icon, icon},
    theme::{SIDEBAR_ROW, motion, radius},
};

pub fn sidebar_item(
    which: Icon,
    label: &'static str,
    selected: impl Fn() -> bool + Copy + 'static,
    unread: impl Fn() -> usize + Copy + 'static,
    on_press: impl Fn() + 'static,
) -> impl IntoElement {
    nsh_base::button()
        .on_press(on_press)
        .selected(selected)
        .test_id(label)
        .accessibility_label(label)
        .h(px(SIDEBAR_ROW))
        .px_2()
        .gap_2()
        .flex_row()
        .items_center()
        .rounded(radius)
        .text_color(move || theme().sidebar_foreground)
        .hover(|s| s.bg(move || theme().sidebar_accent))
        .active(|s| s.opacity(motion::PRESSED_OPACITY))
        .selected_style(|s| {
            s.bg(move || theme().sidebar_accent)
                .text_color(move || theme().sidebar_accent_foreground)
        })
        .focus_visible(|s| {
            s.outline(px(2.0))
                .outline_color(move || theme().sidebar_ring)
        })
        .child(icon(which, 16.0))
        .child(text(label).text_sm().flex_1().number_of_lines(1))
        .child(badge(unread))
}
