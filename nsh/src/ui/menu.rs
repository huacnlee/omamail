//! A menu on a trigger: the app's popup look over `nsh_base::menu`.

use nsh_base::{menu_item, theme};
use nsh_core::prelude::*;

use super::theme::radius;

/// One command of a menu.
pub struct MenuEntry {
    pub label: &'static str,
    pub on_select: Box<dyn Fn()>,
}

/// A menu opening from `trigger`.
pub fn menu(trigger: impl IntoElement, entries: Vec<MenuEntry>) -> impl IntoElement {
    let mut menu = nsh_base::menu()
        .offset(px(4.0))
        .popup_style(|s| {
            s.p_1()
                .min_w(px(180.0))
                .rounded(radius)
                .bg(move || theme().popover)
                .border_1()
                .border_color(move || theme().border)
                .shadow_md()
        })
        .trigger(trigger);
    for entry in entries {
        let on_select = entry.on_select;
        menu = menu.child(
            menu_item()
                .on_select(on_select)
                .px_2()
                .py(px(6.0))
                .rounded(radius)
                .text_color(move || theme().popover_foreground)
                .hover(|s| s.bg(move || theme().accent))
                .child(text(entry.label).text_sm()),
        );
    }
    menu
}
