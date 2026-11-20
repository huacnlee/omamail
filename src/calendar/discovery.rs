//! Account-owned calendar discovery. Authentication material never leaves
//! Rust; the UI receives only bounded calendar names, identifiers and access.

use quick_xml::{
    Reader,
    escape::resolve_xml_entity,
    events::{BytesRef, Event},
};
use reqwest::{Method, Response, StatusCode, Url, header::LOCATION};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const DISCOVERY_LIMIT: usize = 4 * 1024 * 1024;
const MAX_CALENDARS: usize = 256;

#[cfg(test)]
#[path = "discovery_runtime_tests.rs"]
mod runtime_tests;

fn account_id(params: &Value) -> Result<&str, &'static str> {
    let fields = params.as_object().ok_or("invalid_params")?;
    if fields.len() != 1 || fields.keys().any(|key| key != "accountId") {
        return Err("invalid_params");
    }
    fields
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|value| {
            (value.starts_with("outlook:")
                || value.starts_with("imap:")
                || value.starts_with("m365:"))
                && value.len() <= 1024
                && !value.chars().any(|c| c.is_control() || c.is_whitespace())
        })
        .ok_or("invalid_params")
}

fn bounded_text(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.len() <= 8192)
        .filter(|text| !text.chars().any(char::is_control))
        .map(str::to_owned)
}

fn source_id(provider: &str, account: &str, remote: &str, is_default: bool) -> String {
    if matches!(provider, "microsoft" | "google") && is_default {
        return format!("{provider}:{account}");
    }
    let mut digest = Sha256::new();
    digest.update(provider.as_bytes());
    digest.update([0]);
    digest.update(account.as_bytes());
    digest.update([0]);
    digest.update(remote.as_bytes());
    format!("{provider}:{account}:{:x}", digest.finalize())
}

pub(super) async fn response_body(response: Response) -> Result<String, &'static str> {
    bounded_body(response, DISCOVERY_LIMIT).await
}

async fn bounded_body(mut response: Response, limit: usize) -> Result<String, &'static str> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("calendar_response_too_large");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "calendar_network_failed")?
    {
        if chunk.len() > limit - bytes.len() {
            return Err("calendar_response_too_large");
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "calendar_invalid_response")
}

async fn microsoft(account: &str) -> Result<Value, &'static str> {
    // A Microsoft 365 mailbox keeps its Graph token under its own sign-in (one code for mail and
    // calendar); an Outlook one asks its Graph resource of the Outlook refresh token.
    let token = crate::auth::graph_token(account).await?;
    microsoft_with_client(super::client()?, account, &token).await
}

pub async fn google(account: &str, token: &str) -> Result<Value, &'static str> {
    if account.is_empty()
        || account.contains(':')
        || !account.contains('@')
        || account.len() > 1024
        || account.chars().any(char::is_whitespace)
        || account.chars().any(char::is_control)
    {
        return Err("invalid_params");
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(27),
        google_pages(account, token),
    )
    .await
    .map_err(|_| "calendar_timeout")?
}

fn google_calendar(account: &str, value: &Value) -> Result<Value, &'static str> {
    let id = bounded_text(value, "id").ok_or("calendar_invalid_response")?;
    if value["id"].as_str() != Some(id.as_str()) || matches!(id.as_str(), "." | "..") {
        return Err("calendar_invalid_response");
    }
    let primary = value["primary"] == true;
    let role = bounded_text(value, "accessRole").unwrap_or_default();
    let name = bounded_text(value, "summaryOverride")
        .or_else(|| bounded_text(value, "summary"))
        .unwrap_or_else(|| id.clone());
    Ok(json!({
        "sourceId":source_id("google", account, &id, primary),
        "calendarId":id,"name":name,"isDefault":primary,
        "readOnly":!matches!(role.as_str(), "owner" | "writer"),
        "accessRole":role,"timeZone":bounded_text(value, "timeZone").unwrap_or_default(),
        "selected":value["selected"] == true,"hidden":value["hidden"] == true,
        "defaultReminders":value["defaultReminders"].as_array().cloned().unwrap_or_default(),
        "canCreateMeet":value["conferenceProperties"]["allowedConferenceSolutionTypes"]
            .as_array().is_some_and(|types| types.iter().any(|kind| kind == "hangoutsMeet"))
    }))
}

async fn google_pages(account: &str, token: &str) -> Result<Value, &'static str> {
    let origin =
        Url::parse("https://www.googleapis.com/calendar/v3/users/me/calendarList").unwrap();
    let mut page_token = String::new();
    let mut calendars = Vec::new();
    let mut bytes = 0;
    let mut seen = std::collections::HashSet::new();
    for _ in 0..100 {
        let mut url = origin.clone();
        url.query_pairs_mut()
            .extend_pairs([("showHidden", "true"), ("maxResults", "250")]);
        if !page_token.is_empty() {
            url.query_pairs_mut().append_pair("pageToken", &page_token);
        }
        let response = super::client()?
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| "calendar_network_failed")?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err("calendar_auth_refused");
        }
        if !response.status().is_success() {
            return Err("calendar_request_failed");
        }
        let body = response_body(response).await?;
        bytes += body.len();
        if bytes > DISCOVERY_LIMIT {
            return Err("calendar_response_too_large");
        }
        let payload: Value =
            serde_json::from_str(&body).map_err(|_| "calendar_invalid_response")?;
        for value in payload["items"]
            .as_array()
            .ok_or("calendar_invalid_response")?
        {
            if value["deleted"] == true {
                continue;
            }
            let item = google_calendar(account, value)?;
            if seen.insert(item["calendarId"].as_str().unwrap().to_owned()) {
                calendars.push(item);
            }
            if calendars.len() > MAX_CALENDARS {
                return Err("calendar_too_many_calendars");
            }
        }
        match bounded_text(&payload, "nextPageToken") {
            Some(next) if next != page_token => page_token = next,
            None if payload.get("nextPageToken").is_none() => {
                return Ok(json!({"provider":"google","accountId":account,"calendars":calendars}));
            }
            _ => return Err("calendar_invalid_response"),
        }
    }
    Err("calendar_too_many_pages")
}

async fn microsoft_with_client(
    client: &reqwest::Client,
    account: &str,
    token: &str,
) -> Result<Value, &'static str> {
    let origin = Url::parse("https://graph.microsoft.com/v1.0/me/calendars")
        .map_err(|_| "calendar_network_failed")?;
    let mut next = origin.clone();
    next.query_pairs_mut().extend_pairs([
        (
            "$select",
            "id,name,color,hexColor,canEdit,isDefaultCalendar",
        ),
        ("$top", "100"),
    ]);
    let mut calendars = Vec::new();
    for _ in 0..100 {
        let response = client
            .get(next.clone())
            .bearer_auth(token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| "calendar_network_failed")?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err("calendar_auth_refused");
        }
        if !response.status().is_success() {
            return Err("calendar_request_failed");
        }
        let payload: Value = serde_json::from_str(&response_body(response).await?)
            .map_err(|_| "calendar_invalid_response")?;
        let values = payload["value"]
            .as_array()
            .ok_or("calendar_invalid_response")?;
        for value in values {
            let Some(calendar_id) = bounded_text(value, "id") else {
                continue;
            };
            if calendars.len() >= MAX_CALENDARS {
                return Err("calendar_too_many_calendars");
            }
            let is_default = value["isDefaultCalendar"] == true;
            let name = bounded_text(value, "name").unwrap_or_else(|| "Microsoft Calendar".into());
            calendars.push(json!({
                "sourceId": source_id("microsoft", account, &calendar_id, is_default),
                "calendarId": calendar_id,
                "name": name,
                "readOnly": value["canEdit"] != true,
                "isDefault": is_default
            }));
        }
        let Some(raw) = payload["@odata.nextLink"]
            .as_str()
            .filter(|value| !value.is_empty())
        else {
            return Ok(json!({"provider":"microsoft","accountId":account,"calendars":calendars}));
        };
        if raw.len() > 8192 || raw.chars().any(char::is_control) {
            return Err("calendar_invalid_response");
        }
        let candidate = Url::parse(raw).map_err(|_| "calendar_invalid_response")?;
        if candidate.origin() != origin.origin() || candidate.path() != origin.path() {
            return Err("calendar_origin_refused");
        }
        next = candidate;
    }
    Err("calendar_too_many_pages")
}

fn icloud_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("caldav.icloud.com") {
        return true;
    }
    let lower = host.to_ascii_lowercase();
    let Some(partition) = lower
        .strip_prefix('p')
        .and_then(|value| value.strip_suffix("-caldav.icloud.com"))
    else {
        return false;
    };
    !partition.is_empty() && partition.bytes().all(|byte| byte.is_ascii_digit())
}

pub(super) fn icloud_url(raw: &str) -> Result<Url, &'static str> {
    if raw.is_empty() || raw.len() > 8192 || raw.chars().any(char::is_control) || raw.contains('\\')
    {
        return Err("calendar_invalid_url");
    }
    let url = Url::parse(raw).map_err(|_| "calendar_invalid_url")?;
    if url.scheme() != "https"
        || url.port().is_some_and(|port| port != 443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !url.host_str().is_some_and(icloud_host)
    {
        return Err("calendar_origin_refused");
    }
    Ok(url)
}

fn resolve_icloud(base: &Url, raw: &str) -> Result<Url, &'static str> {
    if raw.is_empty() || raw.len() > 8192 || raw.chars().any(char::is_control) || raw.contains('\\')
    {
        return Err("calendar_invalid_response");
    }
    let url = base.join(raw).map_err(|_| "calendar_invalid_response")?;
    icloud_url(url.as_str()).map_err(|_| "calendar_origin_refused")
}

fn icloud_mailbox(settings: &Value) -> bool {
    let host = settings["imap"]["imapHost"].as_str().unwrap_or("").trim();
    let email = settings["email"].as_str().unwrap_or("").trim();
    let domain = email.rsplit_once('@').map(|(_, value)| value).unwrap_or("");
    host.eq_ignore_ascii_case("imap.mail.me.com")
        || ["icloud.com", "me.com", "mac.com"]
            .iter()
            .any(|value| domain.eq_ignore_ascii_case(value))
}

fn mailbox_username(settings: &Value) -> Result<String, &'static str> {
    let email = settings["email"].as_str().unwrap_or("").trim();
    let username = settings["imap"]["username"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(email);
    if username.is_empty()
        || username.len() > 1024
        || username
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("calendar_invalid_input");
    }
    Ok(username.to_owned())
}

pub(super) fn icloud_username(account: &str) -> Result<String, &'static str> {
    if !account.starts_with("imap:") {
        return Err("calendar_provider_unsupported");
    }
    let settings = crate::auth::settings("imap", account)?;
    if !icloud_mailbox(&settings) {
        return Err("calendar_provider_unsupported");
    }
    mailbox_username(&settings)
}

/// An IMAP mailbox's own server, reached for DAV the way RFC 6764 describes:
/// HTTPS on the IMAP host, default port. The mailbox password goes to this
/// origin and nowhere else; every address a server names, redirects
/// included, is checked against it before the password goes with a request.
/// A server whose calendars or address books live on another host is not
/// followed there; it can still be connected by hand with its own password.
pub(crate) struct Mailbox {
    pub(crate) origin: Url,
    pub(crate) username: String,
}

fn mailbox_origin(host: &str) -> Result<Url, &'static str> {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty()
        || host.len() > 253
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
        || host.split('.').any(str::is_empty)
    {
        return Err("calendar_provider_unsupported");
    }
    // A loopback name or an address literal is a local bridge or a bare
    // address (Proton Bridge serves IMAP on 127.0.0.1), not a server that can
    // also hold calendars under its own HTTPS name.
    if host == "localhost" || host.ends_with(".localhost") {
        return Err("calendar_provider_unsupported");
    }
    let url =
        Url::parse(&format!("https://{host}/")).map_err(|_| "calendar_provider_unsupported")?;
    if url.host_str() != Some(host.as_str())
        || url.port().is_some()
        || host.parse::<std::net::IpAddr>().is_ok()
    {
        return Err("calendar_provider_unsupported");
    }
    Ok(url)
}

/// The DAV origin and sign-in name of a generic IMAP mailbox. iCloud keeps
/// its own discovery, on Apple's hosts rather than the IMAP host.
pub(crate) fn mailbox(account: &str) -> Result<Mailbox, &'static str> {
    if !account.starts_with("imap:") {
        return Err("calendar_provider_unsupported");
    }
    let settings = crate::auth::settings_readonly("imap", account)?;
    if icloud_mailbox(&settings) {
        return Err("calendar_provider_unsupported");
    }
    Ok(Mailbox {
        origin: mailbox_origin(settings["imap"]["imapHost"].as_str().unwrap_or(""))?,
        username: mailbox_username(&settings)?,
    })
}

impl Mailbox {
    /// Whether the mailbox password may accompany a request to `url`.
    pub(crate) fn check(&self, url: &Url) -> Result<(), &'static str> {
        if url.scheme() != "https"
            || url.host_str() != self.origin.host_str()
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("calendar_origin_refused");
        }
        Ok(())
    }

    /// An href or redirect the server sent, resolved against `base` and kept
    /// on the mailbox's origin.
    pub(crate) fn resolve(&self, base: &Url, raw: &str) -> Result<Url, &'static str> {
        if raw.is_empty()
            || raw.len() > 8192
            || raw.chars().any(char::is_control)
            || raw.contains('\\')
        {
            return Err("calendar_invalid_response");
        }
        let url = base.join(raw).map_err(|_| "calendar_invalid_response")?;
        self.check(&url)?;
        Ok(url)
    }
}

async fn dav_propfind(
    url: Url,
    username: &str,
    password: &str,
    depth: &str,
    body: &'static str,
) -> Result<(Url, String), &'static str> {
    dav_propfind_with_client(super::client()?, url, username, password, depth, body).await
}

async fn dav_propfind_with_client(
    client: &reqwest::Client,
    url: Url,
    username: &str,
    password: &str,
    depth: &str,
    body: &'static str,
) -> Result<(Url, String), &'static str> {
    dav_request(
        client,
        "PROPFIND",
        url,
        username,
        password,
        depth,
        body,
        DISCOVERY_LIMIT,
        &resolve_icloud,
    )
    .await
}

/// One PROPFIND or REPORT with Basic credentials. Redirects are followed by
/// hand, at most four, and only to an address `resolve` accepts; the same
/// method, credentials and body go with the next request.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn dav_request(
    client: &reqwest::Client,
    method: &str,
    mut url: Url,
    username: &str,
    password: &str,
    depth: &str,
    body: &'static str,
    limit: usize,
    resolve: &(dyn Fn(&Url, &str) -> Result<Url, &'static str> + Sync),
) -> Result<(Url, String), &'static str> {
    let method = Method::from_bytes(method.as_bytes()).map_err(|_| "calendar_invalid_operation")?;
    for _ in 0..4 {
        let response = client
            .request(method.clone(), url.clone())
            .basic_auth(username, Some(password))
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(body)
            .send()
            .await
            .map_err(|_| "calendar_network_failed")?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("calendar_invalid_response")?;
            url = resolve(&url, location)?;
            continue;
        }
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err("calendar_auth_refused");
        }
        if response.status() != StatusCode::MULTI_STATUS && !response.status().is_success() {
            return Err("calendar_request_failed");
        }
        return Ok((url, bounded_body(response, limit).await?));
    }
    Err("calendar_too_many_redirects")
}

pub(crate) fn local_name(raw: &[u8]) -> &[u8] {
    raw.rsplit(|byte| *byte == b':').next().unwrap_or(raw)
}

pub(crate) fn append_reference(
    target: &mut String,
    reference: &BytesRef<'_>,
) -> Result<(), &'static str> {
    if let Some(value) = reference
        .resolve_char_ref()
        .map_err(|_| "calendar_invalid_response")?
    {
        target.push(value);
        return Ok(());
    }
    let name = reference
        .decode()
        .map_err(|_| "calendar_invalid_response")?;
    target.push_str(resolve_xml_entity(&name).ok_or("calendar_invalid_response")?);
    Ok(())
}

fn nested_href(xml: &str, container: &[u8]) -> Result<String, &'static str> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut text = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                stack.push(local_name(event.name().as_ref()).to_vec());
                if stack.last().is_some_and(|name| name.as_slice() == b"href") {
                    text.clear();
                }
            }
            Ok(Event::Text(event))
                if stack.last().is_some_and(|name| name.as_slice() == b"href") =>
            {
                text.push_str(&event.decode().map_err(|_| "calendar_invalid_response")?);
            }
            Ok(Event::CData(event))
                if stack.last().is_some_and(|name| name.as_slice() == b"href") =>
            {
                text.push_str(&event.decode().map_err(|_| "calendar_invalid_response")?);
            }
            Ok(Event::GeneralRef(event))
                if stack.last().is_some_and(|name| name.as_slice() == b"href") =>
            {
                append_reference(&mut text, &event)?;
            }
            Ok(Event::End(event)) => {
                let qualified = event.name();
                let name = local_name(qualified.as_ref());
                if name == b"href"
                    && stack.iter().any(|entry| entry.as_slice() == container)
                    && !text.trim().is_empty()
                {
                    return Ok(text.trim().to_owned());
                }
                stack.pop();
            }
            Ok(Event::Eof) => return Err("calendar_invalid_response"),
            Err(_) => return Err("calendar_invalid_response"),
            _ => {}
        }
    }
}

/// One collection of a Depth 1 PROPFIND answer, as the server described it.
#[derive(Default)]
pub(crate) struct DavCollection {
    pub(crate) href: String,
    pub(crate) name: String,
    pub(crate) is_addressbook: bool,
    is_calendar: bool,
    saw_component: bool,
    supports_events: bool,
    writable: bool,
}

fn attribute_name(
    event: &quick_xml::events::BytesStart<'_>,
    reader: &Reader<&[u8]>,
) -> Option<String> {
    for attribute in event.attributes().with_checks(false).flatten() {
        if local_name(attribute.key.as_ref()) != b"name" {
            continue;
        }
        return attribute
            .decode_and_unescape_value(reader.decoder())
            .ok()
            .map(|value| value.into_owned());
    }
    None
}

pub(crate) fn dav_collections(xml: &str) -> Result<Vec<DavCollection>, &'static str> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut current: Option<DavCollection> = None;
    let mut capture = Vec::<u8>::new();
    let mut captured = String::new();
    let mut collections = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let name = local_name(event.name().as_ref()).to_vec();
                if name == b"response" {
                    current = Some(DavCollection::default());
                }
                if let Some(value) = current.as_mut() {
                    match name.as_slice() {
                        b"calendar" => value.is_calendar = true,
                        b"addressbook" => value.is_addressbook = true,
                        // RFC 3744 §3.12: `all` aggregates every privilege,
                        // so a server may report it instead of `write`.
                        b"write" | b"write-content" | b"all" => value.writable = true,
                        b"comp" => {
                            value.saw_component = true;
                            if attribute_name(&event, &reader)
                                .is_some_and(|item| item.eq_ignore_ascii_case("VEVENT"))
                            {
                                value.supports_events = true;
                            }
                        }
                        b"href" | b"displayname" => {
                            capture = name;
                            captured.clear();
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Empty(event)) => {
                if let Some(value) = current.as_mut() {
                    match local_name(event.name().as_ref()) {
                        b"calendar" => value.is_calendar = true,
                        b"addressbook" => value.is_addressbook = true,
                        b"write" | b"write-content" | b"all" => value.writable = true,
                        b"comp" => {
                            value.saw_component = true;
                            if attribute_name(&event, &reader)
                                .is_some_and(|item| item.eq_ignore_ascii_case("VEVENT"))
                            {
                                value.supports_events = true;
                            }
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Text(event)) if !capture.is_empty() => {
                captured.push_str(&event.decode().map_err(|_| "calendar_invalid_response")?);
            }
            Ok(Event::CData(event)) if !capture.is_empty() => {
                captured.push_str(&event.decode().map_err(|_| "calendar_invalid_response")?);
            }
            Ok(Event::GeneralRef(event)) if !capture.is_empty() => {
                append_reference(&mut captured, &event)?;
            }
            Ok(Event::End(event)) => {
                let qualified = event.name();
                let name = local_name(qualified.as_ref());
                if name == capture.as_slice() {
                    if let Some(value) = current.as_mut() {
                        if name == b"href" && value.href.is_empty() {
                            value.href = captured.trim().to_owned();
                        } else if name == b"displayname" {
                            value.name = captured.trim().to_owned();
                        }
                    }
                    capture.clear();
                    captured.clear();
                }
                if name == b"response" {
                    collections.push(current.take().ok_or("calendar_invalid_response")?);
                }
            }
            Ok(Event::Eof) => return Ok(collections),
            Err(_) => return Err("calendar_invalid_response"),
            _ => {}
        }
    }
}

/// The event calendars among a home's collections, each resolved through
/// `resolve` so its address stays where the account's password may go.
fn dav_calendars(
    xml: &str,
    base: &Url,
    account: &str,
    username: &str,
    provider: &str,
    fallback: &str,
    resolve: &dyn Fn(&Url, &str) -> Result<Url, &'static str>,
) -> Result<Vec<Value>, &'static str> {
    let mut calendars = Vec::new();
    for value in dav_collections(xml)? {
        if !value.is_calendar || (value.saw_component && !value.supports_events) {
            continue;
        }
        let url = resolve(base, &value.href)?;
        if calendars.len() >= MAX_CALENDARS {
            return Err("calendar_too_many_calendars");
        }
        let name = if value.name.is_empty()
            || value.name.len() > 1024
            || value.name.chars().any(char::is_control)
        {
            fallback.to_owned()
        } else {
            value.name
        };
        calendars.push(json!({
            "sourceId": source_id(provider, account, url.as_str(), false),
            "url": url.as_str(),
            "username": username,
            "name": name,
            "readOnly": !value.writable
        }));
    }
    Ok(calendars)
}

const PRINCIPAL: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:current-user-principal/></d:prop></d:propfind>";
const HOME: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:prop><c:calendar-home-set/></d:prop></d:propfind>";
const COLLECTIONS: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\" xmlns:a=\"http://apple.com/ns/ical/\"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><d:current-user-privilege-set/><a:calendar-color/></d:prop></d:propfind>";

async fn icloud(account: &str) -> Result<Value, &'static str> {
    let username = icloud_username(account)?;
    let password = crate::auth::password("imap", account).await?;
    let root = icloud_url("https://caldav.icloud.com/")?;
    let (root, principal_xml) = dav_propfind(root, &username, &password, "0", PRINCIPAL).await?;
    let principal = resolve_icloud(
        &root,
        &nested_href(&principal_xml, b"current-user-principal")?,
    )?;
    let (principal, home_xml) = dav_propfind(principal, &username, &password, "0", HOME).await?;
    let home = resolve_icloud(&principal, &nested_href(&home_xml, b"calendar-home-set")?)?;
    let (home, collections_xml) =
        dav_propfind(home, &username, &password, "1", COLLECTIONS).await?;
    let calendars = dav_calendars(
        &collections_xml,
        &home,
        account,
        &username,
        "icloud",
        "iCloud Calendar",
        &resolve_icloud,
    )?;
    Ok(json!({"provider":"icloud","accountId":account,"calendars":calendars}))
}

/// The principal's home collection named by `home_property`, found from
/// `/.well-known/<service>` and, failing that, the server root (RFC 6764 §5).
pub(crate) async fn mailbox_home(
    client: &reqwest::Client,
    mailbox: &Mailbox,
    password: &str,
    service: &str,
    home_body: &'static str,
    home_property: &[u8],
) -> Result<Url, &'static str> {
    let resolve = |base: &Url, raw: &str| mailbox.resolve(base, raw);
    let mut failure = "calendar_not_found";
    for path in [format!("/.well-known/{service}"), "/".to_owned()] {
        let start = mailbox
            .origin
            .join(&path)
            .map_err(|_| "calendar_invalid_url")?;
        let found = async {
            let (root, xml) = dav_request(
                client,
                "PROPFIND",
                start,
                &mailbox.username,
                password,
                "0",
                PRINCIPAL,
                DISCOVERY_LIMIT,
                &resolve,
            )
            .await?;
            let principal = resolve(&root, &nested_href(&xml, b"current-user-principal")?)?;
            let (principal, xml) = dav_request(
                client,
                "PROPFIND",
                principal,
                &mailbox.username,
                password,
                "0",
                home_body,
                DISCOVERY_LIMIT,
                &resolve,
            )
            .await?;
            resolve(&principal, &nested_href(&xml, home_property)?)
        }
        .await;
        match found {
            Ok(home) => return Ok(home),
            // A refused password or a foreign address is an answer, not a
            // reason to try the password somewhere else.
            Err(error @ ("calendar_auth_refused" | "calendar_origin_refused")) => {
                return Err(error);
            }
            Err(error) => failure = error,
        }
    }
    Err(failure)
}

async fn mailbox_calendars(account: &str) -> Result<Value, &'static str> {
    let mailbox = mailbox(account)?;
    let password = crate::auth::password("imap", account).await?;
    mailbox_calendars_with(super::client()?, account, &mailbox, &password).await
}

async fn mailbox_calendars_with(
    client: &reqwest::Client,
    account: &str,
    mailbox: &Mailbox,
    password: &str,
) -> Result<Value, &'static str> {
    let resolve = |base: &Url, raw: &str| mailbox.resolve(base, raw);
    let home = mailbox_home(
        client,
        mailbox,
        password,
        "caldav",
        HOME,
        b"calendar-home-set",
    )
    .await?;
    let (home, xml) = dav_request(
        client,
        "PROPFIND",
        home,
        &mailbox.username,
        password,
        "1",
        COLLECTIONS,
        DISCOVERY_LIMIT,
        &resolve,
    )
    .await?;
    let calendars = dav_calendars(
        &xml,
        &home,
        account,
        &mailbox.username,
        "imap",
        "Calendar",
        &resolve,
    )?;
    Ok(json!({"provider":"imap","accountId":account,"calendars":calendars}))
}

pub async fn discover(params: &Value) -> Result<Value, &'static str> {
    let account = account_id(params)?.to_owned();
    tokio::time::timeout(std::time::Duration::from_secs(27), async {
        if account.starts_with("outlook:") || account.starts_with("m365:") {
            microsoft(&account).await
        } else {
            match icloud_username(&account) {
                Err("calendar_provider_unsupported") => mailbox_calendars(&account).await,
                _ => icloud(&account).await,
            }
        }
    })
    .await
    .map_err(|_| "calendar_timeout")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn icloud_calendars(xml: &str, base: &Url) -> Vec<Value> {
        dav_calendars(
            xml,
            base,
            "imap:me@icloud.com",
            "me@icloud.com",
            "icloud",
            "iCloud Calendar",
            &resolve_icloud,
        )
        .unwrap()
    }

    #[test]
    fn google_projection_keeps_hidden_permissions_and_refuses_noncanonical_ids() {
        let source = google_calendar(
            "me@example.org",
            &json!({"id":"team@example.org","summary":"Team",
            "accessRole":"reader","hidden":true,"timeZone":"Europe/Paris",
            "defaultReminders":[{"method":"popup","minutes":10}],
            "conferenceProperties":{"allowedConferenceSolutionTypes":["hangoutsMeet"]}}),
        )
        .unwrap();
        assert_eq!(source["selected"], false);
        assert_eq!(source["hidden"], true);
        assert_eq!(source["readOnly"], true);
        assert_eq!(source["timeZone"], "Europe/Paris");
        assert_eq!(source["defaultReminders"][0]["minutes"], 10);
        assert_eq!(source["canCreateMeet"], true);
        for id in [
            "..",
            ".",
            " leading",
            "trailing ",
            "trailing\n",
            "nul\0",
            "cr\r",
        ] {
            assert!(
                google_calendar("me@example.org", &json!({"id":id})).is_err(),
                "{id:?}"
            );
        }
        assert_ne!(
            source["sourceId"],
            google_calendar("other@example.org", &json!({"id":"team@example.org"})).unwrap()["sourceId"]
        );
    }

    #[test]
    fn discovery_accepts_only_one_supported_account() {
        assert_eq!(
            account_id(&json!({"accountId":"outlook:person@example.org"})),
            Ok("outlook:person@example.org")
        );
        assert_eq!(
            account_id(&json!({"accountId":"m365:person@example.org"})),
            Ok("m365:person@example.org")
        );
        for value in [
            json!({}),
            json!({"accountId":"gmail:person@example.org"}),
            json!({"accountId":"imap:person@example.org","extra":true}),
        ] {
            assert_eq!(account_id(&value), Err("invalid_params"));
        }
    }

    #[test]
    fn icloud_credentials_can_only_reach_partition_hosts() {
        for url in [
            "https://caldav.icloud.com/",
            "https://p37-caldav.icloud.com/123/calendars/",
        ] {
            assert!(icloud_url(url).is_ok(), "{url}");
        }
        for url in [
            "http://caldav.icloud.com/",
            "https://icloud.com/",
            "https://p37-caldav.icloud.com.evil.example/",
            "https://user@caldav.icloud.com/",
            "https://pXX-caldav.icloud.com/",
        ] {
            assert!(icloud_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn dav_parser_returns_only_event_calendars_and_access() {
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/123/calendars/work/</d:href><d:propstat><d:prop><d:displayname>Work &amp; Travel</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:write-content/></d:privilege></d:current-user-privilege-set></d:prop></d:propstat></d:response><d:response><d:href>/123/reminders/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response></d:multistatus>"#;
        let base = Url::parse("https://p37-caldav.icloud.com/123/calendars/").unwrap();
        let values = icloud_calendars(xml, &base);
        assert_eq!(values.len(), 1);
        assert_eq!(values[0]["name"], "Work & Travel");
        assert_eq!(values[0]["readOnly"], false);
        assert_eq!(
            values[0]["url"],
            "https://p37-caldav.icloud.com/123/calendars/work/"
        );
    }

    // RFC 3744 lets a server report every privilege at once as `<D:all/>`
    // instead of spelling `write` out. A calendar the owner can write must not
    // arrive read-only, because a discovered source offers no way to say
    // otherwise.
    #[test]
    fn dav_parser_reads_an_aggregate_all_privilege_as_writable() {
        let xml = r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/123/calendars/home/</d:href><d:propstat><d:prop><d:displayname>Home</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:all/></d:privilege></d:current-user-privilege-set></d:prop></d:propstat></d:response><d:response><d:href>/123/calendars/shared/</d:href><d:propstat><d:prop><d:displayname>Shared</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set></d:prop></d:propstat></d:response></d:multistatus>"#;
        let base = Url::parse("https://p37-caldav.icloud.com/123/calendars/").unwrap();
        let values = icloud_calendars(xml, &base);
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["name"], "Home");
        assert_eq!(values[0]["readOnly"], false);
        assert_eq!(values[1]["name"], "Shared");
        assert_eq!(values[1]["readOnly"], true);
    }

    #[test]
    fn mailbox_dav_is_only_https_on_the_imap_host() {
        assert_eq!(
            mailbox_origin(" Mail.Example.org ").unwrap().as_str(),
            "https://mail.example.org/"
        );
        for host in [
            "",
            "mail.example.org:8443",
            "mail.example.org/path",
            "user@mail.example.org",
            "mail..example.org",
            "mail example.org",
            "[::1]",
            "mail\nexample.org",
            "127.0.0.1",
            "localhost",
            "bridge.localhost",
            "10.0.0.5",
            "2130706433",
            "::1",
        ] {
            assert!(mailbox_origin(host).is_err(), "{host:?}");
        }
        let mailbox = Mailbox {
            origin: mailbox_origin("mail.example.org").unwrap(),
            username: "me@example.org".into(),
        };
        let base = Url::parse("https://mail.example.org/dav/").unwrap();
        assert_eq!(
            mailbox
                .resolve(&base, "me%40example.org/")
                .unwrap()
                .as_str(),
            "https://mail.example.org/dav/me%40example.org/"
        );
        assert!(
            mailbox
                .resolve(&base, "https://mail.example.org:443/x/")
                .is_ok()
        );
        for raw in [
            "https://example.org/dav/",
            "http://mail.example.org/dav/",
            "https://mail.example.org:8443/dav/",
            "//other.example.org/dav/",
            "https://me@mail.example.org/dav/",
            "/dav/#fragment",
            "/dav\\x/",
            "/dav/\n",
        ] {
            assert!(mailbox.resolve(&base, raw).is_err(), "{raw:?}");
        }
    }

    // An address a server sends back is compared by the host the URL parser
    // settles on, so spellings of the mail host itself are accepted and
    // everything that only resembles it is not: a trailing dot, a look-alike
    // Unicode letter, an IP address for the same machine and credentials in
    // the authority are all another destination as far as the password goes.
    #[test]
    fn mailbox_origin_compares_the_parsed_host_of_server_addresses() {
        let mailbox = Mailbox {
            origin: mailbox_origin("mail.example.org").unwrap(),
            username: "me@example.org".into(),
        };
        let base = Url::parse("https://mail.example.org/dav/").unwrap();
        for raw in [
            "https://MAIL.Example.ORG/dav/home/",
            "https://mail.example.org:443/dav/home/",
            "https://mail%2Eexample.org/dav/home/",
        ] {
            assert_eq!(
                mailbox.resolve(&base, raw).map(|url| url.to_string()),
                Ok("https://mail.example.org/dav/home/".to_owned()),
                "{raw:?}"
            );
        }
        for raw in [
            // Trailing dot: the same name in DNS, a different origin to TLS
            // and to the URL standard.
            "https://mail.example.org./dav/",
            // Cyrillic а in place of the Latin a.
            "https://m\u{0430}il.example.org/dav/",
            "https://xn--mil-8cd.example.org/dav/",
            "https://127.0.0.1/dav/",
            "https://0x7f.1/dav/",
            "https://2130706433/dav/",
            "https://[::1]/dav/",
            "https://me:pw@mail.example.org/dav/",
            "https://:pw@mail.example.org/dav/",
            "https://me@mail.example.org/dav/",
            "https://mail.example.org@outside.example/dav/",
            "https://outside.example/@mail.example.org/dav/",
            "https://mail.example.org.outside.example/dav/",
        ] {
            assert_eq!(
                mailbox.resolve(&base, raw).err(),
                Some("calendar_origin_refused"),
                "{raw:?}"
            );
        }
        // Without slashes the parser reads the rest as a path on the base,
        // which keeps it on the mail host.
        assert_eq!(
            mailbox
                .resolve(&base, "https:outside.example/dav/")
                .unwrap()
                .host_str(),
            Some("mail.example.org")
        );
        // An internationalised mail host is configured in its ASCII form, and
        // the Unicode spelling of that same name resolves to it.
        let idn = Mailbox {
            origin: mailbox_origin("xn--80a1acny.xn--p1ai").unwrap(),
            username: "me@example.org".into(),
        };
        let idn_base = Url::parse("https://xn--80a1acny.xn--p1ai/dav/").unwrap();
        assert_eq!(
            idn.resolve(
                &idn_base,
                "https://\u{043f}\u{043e}\u{0447}\u{0442}\u{0430}.\u{0440}\u{0444}/dav/home/"
            )
            .map(|url| url.to_string()),
            Ok("https://xn--80a1acny.xn--p1ai/dav/home/".to_owned())
        );
        assert!(
            mailbox_origin("\u{043f}\u{043e}\u{0447}\u{0442}\u{0430}.\u{0440}\u{0444}").is_err()
        );
        assert!(mailbox_origin("mail.example.org.").is_err());
    }

    #[test]
    fn principal_and_home_hrefs_are_scoped_to_their_property() {
        let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/wrong/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/right/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>"#;
        assert_eq!(
            nested_href(xml, b"current-user-principal").unwrap(),
            "/right/"
        );
    }
}
