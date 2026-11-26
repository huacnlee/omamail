//! Omamail's NSH client: the mail UI over the `omamail serve` backend.
//!
//! `backend` speaks the backend's protocol, `store` holds the mail state,
//! `ui` holds layout constants (components come from `nsh-omarchy`), and `screens` the three columns.

pub mod backend;
pub mod reader_html;
mod screens;
pub mod store;
pub mod ui;

use std::rc::Rc;

use nsh_core::element::desktop::window as app_window;
use nsh_core::prelude::*;
use nsh_omarchy::{self as om, tokens};

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

/// The title bar and the three columns over `backend`.
pub fn mail_window(backend: Rc<dyn Backend>) -> impl IntoElement {
    om::init();
    let store = MailStore::new(backend);
    store.start();
    let connected = move || store.connection() == Connection::Ready;
    view()
        .flex_1()
        .bg(tokens::background)
        .text_color(tokens::foreground)
        .child(om::title_bar().title("Omamail"))
        .child(when(
            move || !connected(),
            move || {
                let message = move || match store.connection() {
                    Connection::Failed(error) => {
                        SharedString::from(format!("Cannot reach the mail backend ({error})"))
                    }
                    _ => "Connecting…".into(),
                };
                view()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .child(om::empty_state(message))
            },
        ))
        .child(when(connected, move || {
            view()
                .flex_1()
                .flex_row()
                .min_h(px(0.0))
                .child(screens::sidebar(store))
                .child(
                    om::resizable_panel_group()
                        .flex_1()
                        .child(
                            om::resizable_panel()
                                .size(ui::LIST_WIDTH)
                                .min_size(260.0)
                                .child(screens::message_list(store)),
                        )
                        .child(
                            om::resizable_panel()
                                .min_size(320.0)
                                .child(screens::reader(store)),
                        ),
                )
        }))
}

fn failed(message: SharedString) -> impl IntoElement {
    view()
        .flex_1()
        .items_center()
        .justify_center()
        .bg(tokens::background)
        .child(om::empty_state(SharedString::from(format!(
            "Cannot start the mail backend ({message})"
        ))))
}
