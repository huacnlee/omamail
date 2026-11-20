//! Read-only address books on an IMAP mailbox's own server (CardDAV, RFC
//! 6352), found the way calendar discovery finds calendars there: RFC 6764
//! on the IMAP host, signed in as the mailbox. The password goes only to
//! HTTPS on that host; every card is reduced to names and addresses through
//! the same checks as the local book, and the result is kept as a private
//! snapshot so suggestions survive being offline. Nothing is written to the
//! server.
use quick_xml::{Reader, events::Event};
use reqwest::Url;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Read, time::Duration};

use super::{Book, json_book, sorted, vcard};
use crate::calendar::discovery::{self, Mailbox};

const BOOK_LIMIT: usize = 16 * 1024 * 1024;
const TOTAL_LIMIT: usize = 32 * 1024 * 1024;
const SNAPSHOT_LIMIT: usize = 16 * 1024 * 1024;
const MAX_BOOKS: usize = 64;
const MAX_NAME: usize = 256;
const DEADLINE: Duration = Duration::from_secs(45);
// 2: the snapshot names the server it was read from.
const SNAPSHOT_VERSION: u64 = 2;

const HOME: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:carddav\"><d:prop><c:addressbook-home-set/></d:prop></d:propfind>";
const BOOKS: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>";
// RFC 6352 §10.3 makes the filter mandatory; an empty one matches every card
// (§10.5), and strict servers refuse a query without it.
const QUERY: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><c:addressbook-query xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:carddav\"><d:prop><c:address-data/></d:prop><c:filter/></c:addressbook-query>";

/// Discovery shares the calendar's DAV code and so its reasons; the contacts
/// method answers in its own namespace.
fn reason(error: &'static str) -> &'static str {
    match error {
        "calendar_auth_refused" => "contacts_auth_refused",
        "calendar_timeout" => "contacts_timeout",
        "calendar_network_failed" => "contacts_network_failed",
        "calendar_response_too_large" => "contacts_response_too_large",
        "calendar_origin_refused" => "contacts_origin_refused",
        "calendar_provider_unsupported" => "contacts_provider_unsupported",
        "calendar_invalid_response" | "calendar_too_many_redirects" => "contacts_invalid_response",
        "calendar_not_found" | "calendar_request_failed" => "contacts_not_found",
        error if error.starts_with("contacts_") => error,
        _ => "contacts_unavailable",
    }
}

fn book_name(raw: &str, url: &Url) -> String {
    let name: String = raw.trim().chars().filter(|c| !c.is_control()).collect();
    if !name.is_empty() && name.len() <= MAX_NAME {
        return name;
    }
    // A book without a usable name is named after the last part of its path.
    url.path_segments()
        .and_then(|segments| segments.filter(|s| !s.is_empty()).next_back())
        .map(|segment| {
            let decoded: Vec<u8> = segment.bytes().collect();
            String::from_utf8_lossy(&percent_decode(&decoded))
                .chars()
                .filter(|c| !c.is_control())
                .take(64)
                .collect::<String>()
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Address book".to_owned())
}

fn percent_decode(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let decoded = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| std::str::from_utf8(&bytes[i + 1..i + 3]).ok())
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match decoded {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    out
}

/// Every `address-data` text of an addressbook-query answer.
fn cards(xml: &str) -> Result<Vec<String>, &'static str> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut inside = false;
    let mut current = String::new();
    let mut cards = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event))
                if discovery::local_name(event.name().as_ref()) == b"address-data" =>
            {
                inside = true;
                current.clear();
            }
            Ok(Event::Text(event)) if inside => {
                current.push_str(&event.decode().map_err(|_| "contacts_invalid_response")?);
            }
            Ok(Event::CData(event)) if inside => {
                current.push_str(&event.decode().map_err(|_| "contacts_invalid_response")?);
            }
            Ok(Event::GeneralRef(event)) if inside => {
                discovery::append_reference(&mut current, &event)
                    .map_err(|_| "contacts_invalid_response")?;
            }
            Ok(Event::End(event))
                if inside && discovery::local_name(event.name().as_ref()) == b"address-data" =>
            {
                inside = false;
                if !current.trim().is_empty() {
                    cards.push(std::mem::take(&mut current));
                }
            }
            Ok(Event::Eof) if !inside => return Ok(cards),
            Ok(Event::Eof) | Err(_) => return Err("contacts_invalid_response"),
            _ => {}
        }
    }
}

/// The address books in a home, as `(url, name)`.
fn books(xml: &str, home: &Url, mailbox: &Mailbox) -> Result<Vec<(Url, String)>, &'static str> {
    let mut found = Vec::new();
    for collection in discovery::dav_collections(xml)? {
        if !collection.is_addressbook {
            continue;
        }
        let url = mailbox.resolve(home, &collection.href)?;
        if found.iter().any(|(seen, _): &(Url, String)| seen == &url) {
            continue;
        }
        if found.len() >= MAX_BOOKS {
            return Err("contacts_too_many_books");
        }
        let name = book_name(&collection.name, &url);
        found.push((url, name));
    }
    Ok(found)
}

async fn fetch_with(
    client: &reqwest::Client,
    account: &str,
    mailbox: &Mailbox,
    password: &str,
) -> Result<Value, &'static str> {
    let resolve = |base: &Url, raw: &str| mailbox.resolve(base, raw);
    let home = discovery::mailbox_home(
        client,
        mailbox,
        password,
        "carddav",
        HOME,
        b"addressbook-home-set",
    )
    .await?;
    let (home, xml) = discovery::dav_request(
        client,
        "PROPFIND",
        home,
        &mailbox.username,
        password,
        "1",
        BOOKS,
        BOOK_LIMIT,
        &resolve,
    )
    .await?;
    let mut everyone = Book::new();
    let mut listed = Vec::new();
    let mut total = 0;
    for (url, name) in books(&xml, &home, mailbox)? {
        let (_, answer) = discovery::dav_request(
            client,
            "REPORT",
            url,
            &mailbox.username,
            password,
            "1",
            QUERY,
            BOOK_LIMIT,
            &resolve,
        )
        .await?;
        total += answer.len();
        if total > TOTAL_LIMIT {
            return Err("contacts_response_too_large");
        }
        let mut book = Book::new();
        for card in cards(&answer)? {
            vcard(&mut book, &card);
        }
        listed.push(json!({"name":name,"contacts":book.len()}));
        let rows = sorted(book);
        json_book(&mut everyone, &rows);
    }
    Ok(json!({
        "accountId":account,
        "books":listed,
        "contacts":sorted(everyone),
    }))
}

fn account(params: &Value) -> Result<(String, String), &'static str> {
    let fields = params.as_object().ok_or("invalid_params")?;
    let consent = fields.contains_key("server");
    if fields.len() != 2 + usize::from(consent)
        || fields
            .keys()
            .any(|k| k != "accountId" && k != "operation" && k != "server")
        || (consent && fields.get("operation").and_then(Value::as_str) != Some("refresh"))
        || (consent && server_param(params).is_none())
    {
        return Err("invalid_params");
    }
    let account = fields
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|id| {
            id.starts_with("imap:")
                && id.contains('@')
                && id.len() <= 1024
                && !id.chars().any(|c| c.is_control() || c.is_whitespace())
        })
        .ok_or("invalid_params")?;
    let operation = fields
        .get("operation")
        .and_then(Value::as_str)
        .filter(|op| matches!(*op, "read" | "refresh" | "forget"))
        .ok_or("invalid_params")?;
    Ok((account.to_owned(), operation.to_owned()))
}

/// The `server` a Find request names: the host the person was shown.
fn server_param(params: &Value) -> Option<&str> {
    params["server"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 253 && !s.chars().any(|c| c.is_control()))
}

/// `contacts.dav {accountId, operation, server?}`. `read` answers the saved
/// snapshot without touching the network (`{enabled:false}` when there is
/// none, or when the mailbox's server is no longer the one it was read from,
/// in which case it is deleted); `refresh` reads the server and saves what it
/// found, or answers the saved snapshot with `cached` and the `error` when the
/// server cannot be read; `forget` removes the snapshot. A mailbox has
/// address books in suggestions exactly while it has a snapshot.
///
/// The person's consent names a server. `refresh` with `server` is the Find
/// button: it goes ahead only if that is still the mailbox's server. Without
/// it, a refresh is the background one and goes ahead only for a snapshot
/// read from the mailbox's current server, and it does not bring back a
/// snapshot that was forgotten while it ran.
// Snapshot reads, writes and deletions are plain file operations made from
// concurrent backend requests, so a check such as "is the snapshot still
// there?" and the write that depends on it share this lock; it is never held
// across the network read.
static SNAPSHOTS: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn snapshots() -> Result<std::sync::MutexGuard<'static, ()>, &'static str> {
    SNAPSHOTS.lock().map_err(|_| "contacts_cache_unavailable")
}

pub async fn call(params: &Value) -> Result<Value, &'static str> {
    call_with(params, crate::calendar::client()?).await
}

/// `call` with the HTTP client given, so a test can point the mailbox's
/// server at a local TLS peer.
async fn call_with(params: &Value, client: &reqwest::Client) -> Result<Value, &'static str> {
    let (account, operation) = account(params)?;
    let root = crate::platform::dirs::AppDirs::discover()?.cache;
    let current = discovery::mailbox(&account).ok();
    let server = current
        .as_ref()
        .and_then(|mailbox| mailbox.origin.host_str().map(str::to_owned));
    match operation.as_str() {
        "read" => {
            let _snapshots = snapshots()?;
            read_bound(&root, &account, server.as_deref())
        }
        "forget" => {
            let _snapshots = snapshots()?;
            forget(&root, &account)?;
            Ok(json!({"enabled":false}))
        }
        _ => {
            let consent = server_param(params);
            {
                let _snapshots = snapshots()?;
                may_refresh(&root, &account, consent, server.as_deref())?;
            }
            let mailbox = current.ok_or("contacts_provider_unsupported")?;
            let fetched = tokio::time::timeout(DEADLINE, async {
                let password = crate::auth::password("imap", &account).await?;
                fetch_with(client, &account, &mailbox, &password).await
            })
            .await
            .map_err(|_| "contacts_timeout")
            .and_then(|result| result.map_err(reason));
            let _snapshots = snapshots()?;
            refreshed_from(
                &root,
                &account,
                server.as_deref().unwrap_or_default(),
                consent.is_some(),
                fetched,
                now(),
            )
        }
    }
}

/// The saved snapshot, only while the mailbox's server is the one it was read
/// from. A changed server took no part in the consent, so its books go.
fn read_bound(
    root: &std::path::Path,
    account: &str,
    current: Option<&str>,
) -> Result<Value, &'static str> {
    match read(root, account)? {
        Some(saved) if current.is_some() && saved["server"].as_str() == current => Ok(saved),
        Some(_) => {
            forget(root, account)?;
            Ok(json!({"enabled":false,"error":"contacts_server_changed"}))
        }
        None => Ok(json!({"enabled":false})),
    }
}

/// Whether a refresh may sign in to the mailbox's server: the Find button
/// names that server, a background refresh needs a snapshot read from it.
/// Refused before any network or keyring access.
fn may_refresh(
    root: &std::path::Path,
    account: &str,
    consent: Option<&str>,
    current: Option<&str>,
) -> Result<(), &'static str> {
    let Some(current) = current else {
        return Err("contacts_provider_unsupported");
    };
    // Books read from another server were agreed to for that server, not
    // this one: they go, and so does the request, Find included. A Refresh
    // pressed on a row still showing the old books names no new host, so the
    // row has to ask again, naming the new one, before anything is sent.
    let saved = read(root, account)?;
    if let Some(saved) = &saved
        && saved["server"].as_str() != Some(current)
    {
        forget(root, account)?;
        return Err("contacts_server_changed");
    }
    match consent {
        Some(named) if named.eq_ignore_ascii_case(current) => Ok(()),
        Some(_) => Err("contacts_server_changed"),
        None if saved.is_some() => Ok(()),
        None => Err("contacts_server_changed"),
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
fn refreshed(
    root: &std::path::Path,
    account: &str,
    fetched: Result<Value, &'static str>,
    at: u64,
) -> Result<Value, &'static str> {
    refreshed_from(root, account, "mail.example.test", true, fetched, at)
}

fn refreshed_from(
    root: &std::path::Path,
    account: &str,
    server: &str,
    consent: bool,
    fetched: Result<Value, &'static str>,
    at: u64,
) -> Result<Value, &'static str> {
    // "Stop using" while a background refresh was out: its answer must not
    // bring the books back.
    if !consent && read(root, account)?.is_none() {
        return Ok(json!({"enabled":false}));
    }
    match fetched {
        Ok(mut value) => {
            value["fetchedAt"] = json!(at);
            value["server"] = json!(server);
            write(root, account, &value)?;
            value["enabled"] = json!(true);
            value["cached"] = json!(false);
            Ok(value)
        }
        Err(error) => match read(root, account)? {
            Some(mut saved) => {
                saved["error"] = json!(error);
                Ok(saved)
            }
            None => Err(error),
        },
    }
}

fn snapshot_name(account: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(account.to_lowercase().as_bytes());
    format!("{:x}.json", digest.finalize())
}

fn read(root: &std::path::Path, account: &str) -> Result<Option<Value>, &'static str> {
    let Some(dir) = crate::cache::directories_readonly(root, &["omamail", "address-books"])
        .map_err(|_| "contacts_cache_unavailable")?
    else {
        return Ok(None);
    };
    let Some(mut file) = crate::cache::regular_readonly(&dir, &snapshot_name(account))
        .map_err(|_| "contacts_cache_unavailable")?
    else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    (&mut file)
        .take(SNAPSHOT_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "contacts_cache_unavailable")?;
    if bytes.len() > SNAPSHOT_LIMIT {
        return Ok(None);
    }
    let Ok(raw) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(None);
    };
    if raw["version"].as_u64() != Some(SNAPSHOT_VERSION) || raw["accountId"] != account {
        return Ok(None);
    }
    // The snapshot is ours, but it is read back through the same checks as
    // everything else that becomes a suggestion.
    let mut book = Book::new();
    json_book(&mut book, &raw["contacts"]);
    let books: Vec<Value> = raw["books"]
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_BOOKS)
        .filter_map(|b| {
            let name = b["name"].as_str()?;
            (!name.is_empty() && name.len() <= MAX_NAME && !name.chars().any(char::is_control))
                .then(|| json!({"name":name,"contacts":b["contacts"].as_u64().unwrap_or(0)}))
        })
        .collect();
    Ok(Some(json!({
        "accountId":account,
        "server":raw["server"].as_str().unwrap_or_default(),
        "enabled":true,
        "cached":true,
        "fetchedAt":raw["fetchedAt"].as_u64().unwrap_or(0),
        "books":books,
        "contacts":sorted(book),
    })))
}

fn write(root: &std::path::Path, account: &str, value: &Value) -> Result<(), &'static str> {
    let snapshot = json!({
        "version":SNAPSHOT_VERSION,
        "accountId":account,
        "server":value["server"],
        "fetchedAt":value["fetchedAt"],
        "books":value["books"],
        "contacts":value["contacts"],
    });
    let bytes = serde_json::to_vec(&snapshot).map_err(|_| "contacts_cache_unavailable")?;
    if bytes.len() > SNAPSHOT_LIMIT {
        return Err("contacts_response_too_large");
    }
    let dir = crate::cache::directories(root, &["omamail", "address-books"], true)
        .ok()
        .flatten()
        .ok_or("contacts_cache_unavailable")?;
    crate::platform::private_fs::atomic_replace(&dir, &snapshot_name(account), &bytes)
        .map_err(|_| "contacts_cache_unavailable")?;
    crate::platform::private_fs::sync_dir(&dir).map_err(|_| "contacts_cache_unavailable")
}

fn forget(root: &std::path::Path, account: &str) -> Result<(), &'static str> {
    let Some(dir) = crate::cache::directories(root, &["omamail", "address-books"], false)
        .map_err(|_| "contacts_cache_unavailable")?
    else {
        return Ok(());
    };
    crate::platform::private_fs::remove_owned(&dir, &snapshot_name(account))
        .map_err(|_| "contacts_cache_unavailable")?;
    crate::platform::private_fs::sync_dir(&dir).map_err(|_| "contacts_cache_unavailable")
}

#[cfg(test)]
#[path = "dav_tests.rs"]
mod tests;
