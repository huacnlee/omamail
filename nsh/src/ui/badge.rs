//! A count beside a label (unread mail).

use nsh_base::theme;
use nsh_core::prelude::*;

/// `count`, hidden at zero.
pub fn badge(count: impl Fn() -> usize + Copy + 'static) -> impl IntoElement {
    when(
        move || count() > 0,
        move || {
            text(move || count().to_string())
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(move || theme().muted_foreground)
                .flex_shrink_0()
        },
    )
}
