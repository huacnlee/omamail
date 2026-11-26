//! Buttons: a text button in three variants and an icon-only button.

use nsh_base::theme;
use nsh_core::prelude::*;

use super::{
    icon::{Icon, icon},
    theme::{CONTROL_HEIGHT, motion, radius},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonVariant {
    /// The one main action of a surface.
    Primary,
    /// Other actions.
    Secondary,
    /// Toolbar actions: no fill until hovered.
    Ghost,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonSize {
    Small,
    Regular,
}

/// A button labelled `label`.
pub fn button(
    label: impl Into<SharedString>,
    variant: ButtonVariant,
    size: ButtonSize,
    on_press: impl Fn() + 'static,
) -> impl IntoElement {
    let label: SharedString = label.into();
    let height = match size {
        ButtonSize::Small => 24.0,
        ButtonSize::Regular => CONTROL_HEIGHT,
    };
    let base = nsh_base::button()
        .on_press(on_press)
        .h(px(height))
        .px_3()
        .flex_row()
        .items_center()
        .justify_center()
        .rounded(radius)
        .focus_visible(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
        .disabled_style(|s| s.opacity(0.5))
        .active(|s| s.opacity(motion::PRESSED_OPACITY));
    let styled = match variant {
        ButtonVariant::Primary => base
            .bg(move || theme().primary)
            .text_color(move || theme().primary_foreground)
            .hover(|s| s.bg(move || theme().primary.opacity(0.9))),
        ButtonVariant::Secondary => base
            .bg(move || theme().secondary)
            .text_color(move || theme().secondary_foreground)
            .hover(|s| s.bg(move || theme().accent)),
        ButtonVariant::Ghost => base
            .text_color(move || theme().foreground)
            .hover(|s| s.bg(move || theme().accent)),
    };
    styled.child(text(label).text_sm().font_weight(FontWeight::MEDIUM))
}

/// An icon-only toolbar button; `label` is what screen readers and
/// tests know it by.
pub fn icon_button(
    which: Icon,
    label: &'static str,
    on_press: impl Fn() + 'static,
) -> impl IntoElement {
    nsh_base::button()
        .on_press(on_press)
        .accessibility_label(label)
        .size(px(CONTROL_HEIGHT))
        .items_center()
        .justify_center()
        .rounded(radius)
        .text_color(move || theme().muted_foreground)
        .hover(|s| {
            s.bg(move || theme().accent)
                .text_color(move || theme().accent_foreground)
        })
        .active(|s| s.opacity(motion::PRESSED_OPACITY))
        .focus_visible(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
        .child(icon(which, 16.0))
}
