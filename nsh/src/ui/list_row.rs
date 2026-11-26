//! A message row: sender, time, subject, snippet, and an unread dot.
//! Its texts are bindings, so a recycled cell follows its row.

use nsh_base::theme;
use nsh_core::prelude::*;

use super::theme::{MESSAGE_ROW, motion, unread};

/// What a row shows, read through bindings.
pub struct ListRowProps<S, T, U, B, P, Q>
where
    S: Fn() -> SharedString + 'static,
    T: Fn() -> SharedString + 'static,
    U: Fn() -> SharedString + 'static,
    B: Fn() -> SharedString + 'static,
    P: Fn() -> bool + Copy + 'static,
    Q: Fn() -> bool + Copy + 'static,
{
    pub sender: S,
    pub time: T,
    pub subject: U,
    pub snippet: B,
    pub unread: P,
    pub selected: Q,
}

pub fn list_row<S, T, U, B, P, Q>(
    props: ListRowProps<S, T, U, B, P, Q>,
    on_press: impl Fn() + 'static,
) -> impl IntoElement
where
    S: Fn() -> SharedString + 'static,
    T: Fn() -> SharedString + 'static,
    U: Fn() -> SharedString + 'static,
    B: Fn() -> SharedString + 'static,
    P: Fn() -> bool + Copy + 'static,
    Q: Fn() -> bool + Copy + 'static,
{
    let is_unread = props.unread;
    nsh_base::button()
        .on_press(on_press)
        .selected(props.selected)
        .min_h(px(MESSAGE_ROW))
        .px_4()
        .py_3()
        .gap_1()
        .hover(|s| s.bg(move || theme().accent))
        .active(|s| s.opacity(motion::PRESSED_OPACITY))
        .selected_style(|s| s.bg(move || theme().accent))
        .focus_visible(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_2()
                .child(
                    view()
                        .size(px(8.0))
                        .rounded_full()
                        .bg(unread)
                        .style_when(move || !is_unread(), |s| s.opacity(0.0)),
                )
                .child(
                    text(props.sender)
                        .flex_1()
                        .min_w(px(0.0))
                        .number_of_lines(1)
                        .text_sm()
                        .style_with(move |s| {
                            s.font_weight(if is_unread() {
                                FontWeight::SEMIBOLD
                            } else {
                                FontWeight::NORMAL
                            })
                        }),
                )
                .child(
                    text(props.time)
                        .text_xs()
                        .text_color(move || theme().muted_foreground)
                        .flex_shrink_0(),
                ),
        )
        .child(
            view()
                .pl(px(16.0))
                .gap(px(2.0))
                .child(text(props.subject).text_sm().number_of_lines(1))
                .child(
                    text(props.snippet)
                        .text_xs()
                        .number_of_lines(2)
                        .text_color(move || theme().muted_foreground),
                ),
        )
}
