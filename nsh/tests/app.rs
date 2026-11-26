//! The mail window over the sample backend: handshake, inbox, reader.

use nsh_core::{
    Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;
use omamail_nsh::{Mail, MailProps};

fn start() -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(1200.0), px(780.0)),
        ..EngineConfig::new(Root::new::<Mail>(|| MailProps { fake: true }))
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    Headless::start(config).expect("the engine starts")
}

#[test]
fn the_handshake_leads_to_the_inbox() -> Result<(), String> {
    let mut app = start();
    app.wait_for("text:Design review notes")?;
    app.wait_for("text:ada@example.org")?;
    assert!(app.shows("[omamail] CI passed on main"));
    assert!(app.shows("No message selected"));
    Ok(())
}

#[test]
fn selecting_a_message_shows_its_body() -> Result<(), String> {
    let mut app = start();
    app.wait_for("text:Design review notes")?;
    app.press("text:Design review notes")?;
    app.wait_for("id:reader-body")?;
    app.wait_for("text:/Keep the/")?;
    Ok(())
}

#[test]
fn another_mailbox_lists_its_own_messages() -> Result<(), String> {
    let mut app = start();
    app.wait_for("text:周五的发布安排")?;
    app.press("id:Unread")?;
    app.wait_for("text:Design review notes")?;
    app.wait_for_gone("text:周五的发布安排", std::time::Duration::from_secs(5))?;
    Ok(())
}
