use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;

const MAX_BATCH_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch<'a> {
    site: &'a str,
    #[serde(borrow)]
    events: Vec<Event<'a>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Event<'a> {
    name: &'a str,
    url: &'a str,
    #[serde(rename = "ts")]
    _timestamp: u32,
    user_id: &'a str,
    app_version: &'a str,
    ua: &'a str,
}

pub(super) fn approved_batch(body: &str) -> bool {
    if body.len() > MAX_BATCH_BYTES {
        return false;
    }
    let Ok(batch) = serde_json::from_str::<Batch<'_>>(body) else {
        return false;
    };
    batch.site == "omamail"
        && (1..=50).contains(&batch.events.len())
        && batch.events.iter().all(approved_event)
}

fn approved_event(event: &Event<'_>) -> bool {
    static ID: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z")
            .expect("installation UUID pattern")
    });
    static VERSION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\A[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?\z")
            .expect("app version pattern")
    });
    static SYSTEM: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\A \((?:Linux|(?:macOS|Windows NT)(?: [0-9]+(?:\.[0-9]+)*)?)\)\z")
            .expect("desktop system pattern")
    });
    event.name == "screen_view"
        && matches!(
            event.url,
            "/mail" | "/message" | "/compose" | "/calendar" | "/settings" | "/accounts"
        )
        && ID.is_match(event.user_id)
        && event.app_version.len() <= 64
        && VERSION.is_match(event.app_version)
        && event.ua.len() <= 128
        && event
            .ua
            .strip_prefix("Omamail/")
            .and_then(|ua| ua.strip_prefix(event.app_version))
            .is_some_and(|system| SYSTEM.is_match(system))
}
