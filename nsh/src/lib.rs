//! Omamail's NSH client: the mail UI over the `omamail serve` backend.
//!
//! `backend` speaks the backend's protocol, `store` holds the mail state,
//! `ui` is the styled component layer and `screens` the three columns.

pub mod backend;
pub mod reader_html;
mod screens;
pub mod store;
pub mod ui;

use std::rc::Rc;

use nsh_base::{nav_page, nav_stack, split_view, theme};
use nsh_core::element::desktop::window as app_window;
use nsh_core::prelude::*;

use crate::{
    backend::{Backend, FakeBackend},
    store::{Connection, MailStore},
};

#[native_module("omamail/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
    registry.register::<Mail>();
}

/// The app's root: the mail window over `omamail serve`, or over the
/// sample backend with `OMAMAIL_NSH_BACKEND=fake`.
#[component]
pub fn App() -> impl IntoElement {
    let content = move || match backend::connect_default() {
        Ok(backend) => mail_window(backend).into_element(),
        Err(error) => failed(error.message.into()).into_element(),
    };
    app_window().id("main").title("Omamail").content(content)
}

/// The props of [`Mail`].
#[derive(Clone, PartialEq, Props)]
pub struct MailProps {
    /// Use the sample backend (tests).
    pub fake: bool,
}

/// The mail window's content on a chosen backend: what tests mount.
#[component]
pub fn Mail(props: MailProps) -> impl IntoElement {
    if props.fake {
        mail_window(Rc::new(FakeBackend::sample())).into_element()
    } else {
        match backend::connect_default() {
            Ok(backend) => mail_window(backend).into_element(),
            Err(error) => failed(error.message.into()).into_element(),
        }
    }
}

/// The three columns over `backend`.
pub fn mail_window(backend: Rc<dyn Backend>) -> impl IntoElement {
    let store = MailStore::new(backend);
    store.start();
    let connected = move || store.connection() == Connection::Ready;
    view()
        .flex_1()
        .bg(move || theme().background)
        .text_color(move || theme().foreground)
        .child(when(
            move || !connected(),
            move || {
                let message = move || match store.connection() {
                    Connection::Failed(error) => {
                        SharedString::from(format!("Cannot reach the mail backend ({error})"))
                    }
                    _ => "Connecting…".into(),
                };
                view().flex_1().items_center().justify_center().child(
                    text(message)
                        .text_sm()
                        .text_color(move || theme().muted_foreground),
                )
            },
        ))
        .child(when(connected, move || {
            split_view()
                .flex_1()
                .sidebar(
                    nav_stack().child(nav_page().title("Mailboxes").child(screens::sidebar(store))),
                )
                .content(
                    nav_stack().child(
                        nav_page()
                            .title("Messages")
                            .child(screens::message_list(store)),
                    ),
                )
                .detail(
                    nav_stack().child(nav_page().title("Message").child(screens::reader(store))),
                )
        }))
}

fn failed(message: SharedString) -> impl IntoElement {
    view()
        .flex_1()
        .items_center()
        .justify_center()
        .bg(move || theme().background)
        .child(
            text(SharedString::from(format!(
                "Cannot start the mail backend ({message})"
            )))
            .text_sm()
            .text_color(move || theme().muted_foreground),
        )
}
