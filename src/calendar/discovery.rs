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
            (value.starts_with("outlook:") || value.starts_with("imap:"))
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
    if provider == "microsoft" && is_default {
        return format!("microsoft:{account}");
    }
    let mut digest = Sha256::new();
    digest.update(provider.as_bytes());
    digest.update([0]);
    digest.update(account.as_bytes());
    digest.update([0]);
    digest.update(remote.as_bytes());
    format!("{provider}:{account}:{:x}", digest.finalize())
}

async fn response_body(mut response: Response) -> Result<String, &'static str> {
    if response
        .content_length()
        .is_some_and(|size| size > DISCOVERY_LIMIT as u64)
    {
        return Err("calendar_response_too_large");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "calendar_network_failed")?
    {
        if chunk.len() > DISCOVERY_LIMIT - bytes.len() {
            return Err("calendar_response_too_large");
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "calendar_invalid_response")
}

async fn microsoft(account: &str) -> Result<Value, &'static str> {
    crate::auth::settings("outlook", account)?;
    let token = crate::auth::access_token("outlook", account, "graph").await?;
    microsoft_with_client(super::client()?, account, &token).await
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

// Same trust rule as `resolve_icloud`, generalized to whatever origin the
// user entered instead of a hardcoded Apple host allowlist: a hop is trusted
// only when it names the exact scheme, host and port the account was
// configured with. This is what stops a malicious or compromised CalDAV
// server from redirecting discovery into handing this account's credentials
// to a different origin.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn caldav_url(raw: &str) -> Result<Url, &'static str> {
    if raw.is_empty() || raw.len() > 8192 || raw.chars().any(char::is_control) || raw.contains('\\')
    {
        return Err("calendar_invalid_url");
    }
    let url = Url::parse(raw).map_err(|_| "calendar_invalid_url")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !url.host_str().is_some_and(|host| !host.is_empty())
    {
        return Err("calendar_invalid_url");
    }
    Ok(url)
}

fn resolve_within_origin(origin: &Url, base: &Url, raw: &str) -> Result<Url, &'static str> {
    if raw.is_empty() || raw.len() > 8192 || raw.chars().any(char::is_control) || raw.contains('\\')
    {
        return Err("calendar_invalid_response");
    }
    let url = base.join(raw).map_err(|_| "calendar_invalid_response")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !same_origin(&url, origin)
    {
        return Err("calendar_origin_refused");
    }
    Ok(url)
}

pub(super) fn icloud_username(account: &str) -> Result<String, &'static str> {
    if !account.starts_with("imap:") {
        return Err("calendar_provider_unsupported");
    }
    let settings = crate::auth::settings("imap", account)?;
    let host = settings["imap"]["imapHost"].as_str().unwrap_or("").trim();
    let email = settings["email"].as_str().unwrap_or("").trim();
    let domain = email.rsplit_once('@').map(|(_, value)| value).unwrap_or("");
    if !host.eq_ignore_ascii_case("imap.mail.me.com")
        && !["icloud.com", "me.com", "mac.com"]
            .iter()
            .any(|value| domain.eq_ignore_ascii_case(value))
    {
        return Err("calendar_provider_unsupported");
    }
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

async fn dav_propfind(
    url: Url,
    username: &str,
    password: &str,
    depth: &str,
    body: &'static str,
    resolve: &dyn Fn(&Url, &str) -> Result<Url, &'static str>,
) -> Result<(Url, String), &'static str> {
    dav_propfind_with_client(super::client()?, url, username, password, depth, body, resolve).await
}

async fn dav_propfind_with_client(
    client: &reqwest::Client,
    mut url: Url,
    username: &str,
    password: &str,
    depth: &str,
    body: &'static str,
    resolve: &dyn Fn(&Url, &str) -> Result<Url, &'static str>,
) -> Result<(Url, String), &'static str> {
    for _ in 0..4 {
        let response = client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), url.clone())
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
        return Ok((url, response_body(response).await?));
    }
    Err("calendar_too_many_redirects")
}

fn local_name(raw: &[u8]) -> &[u8] {
    raw.rsplit(|byte| *byte == b':').next().unwrap_or(raw)
}

fn append_reference(target: &mut String, reference: &BytesRef<'_>) -> Result<(), &'static str> {
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

#[derive(Default)]
struct DavCalendar {
    href: String,
    name: String,
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

fn dav_calendars(
    xml: &str,
    base: &Url,
    fallback_name: &str,
    resolve: &dyn Fn(&Url, &str) -> Result<Url, &'static str>,
    build: &dyn Fn(&Url, &str, bool) -> Value,
) -> Result<Vec<Value>, &'static str> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut current: Option<DavCalendar> = None;
    let mut capture = Vec::<u8>::new();
    let mut captured = String::new();
    let mut calendars = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let name = local_name(event.name().as_ref()).to_vec();
                if name == b"response" {
                    current = Some(DavCalendar::default());
                }
                if let Some(value) = current.as_mut() {
                    match name.as_slice() {
                        b"calendar" => value.is_calendar = true,
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
                    let value = current.take().ok_or("calendar_invalid_response")?;
                    if value.is_calendar && (!value.saw_component || value.supports_events) {
                        let url = resolve(base, &value.href)?;
                        if calendars.len() >= MAX_CALENDARS {
                            return Err("calendar_too_many_calendars");
                        }
                        let name = if value.name.is_empty()
                            || value.name.len() > 1024
                            || value.name.chars().any(char::is_control)
                        {
                            fallback_name.to_owned()
                        } else {
                            value.name
                        };
                        calendars.push(build(&url, &name, value.writable));
                    }
                }
            }
            Ok(Event::Eof) => return Ok(calendars),
            Err(_) => return Err("calendar_invalid_response"),
            _ => {}
        }
    }
}

const PRINCIPAL: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:current-user-principal/></d:prop></d:propfind>";
const HOME: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:prop><c:calendar-home-set/></d:prop></d:propfind>";
const COLLECTIONS: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\" xmlns:a=\"http://apple.com/ns/ical/\"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><d:current-user-privilege-set/><a:calendar-color/></d:prop></d:propfind>";

async fn icloud(account: &str) -> Result<Value, &'static str> {
    let username = icloud_username(account)?;
    let password = crate::auth::password("imap", account).await?;
    let root = icloud_url("https://caldav.icloud.com/")?;
    let (root, principal_xml) =
        dav_propfind(root, &username, &password, "0", PRINCIPAL, &resolve_icloud).await?;
    let principal = resolve_icloud(
        &root,
        &nested_href(&principal_xml, b"current-user-principal")?,
    )?;
    let (principal, home_xml) =
        dav_propfind(principal, &username, &password, "0", HOME, &resolve_icloud).await?;
    let home = resolve_icloud(&principal, &nested_href(&home_xml, b"calendar-home-set")?)?;
    let (home, collections_xml) =
        dav_propfind(home, &username, &password, "1", COLLECTIONS, &resolve_icloud).await?;
    let build = |url: &Url, name: &str, writable: bool| {
        json!({
            "sourceId": source_id("icloud", account, url.as_str(), false),
            "url": url.as_str(),
            "username": username,
            "name": name,
            "readOnly": !writable
        })
    };
    let calendars = dav_calendars(
        &collections_xml,
        &home,
        "iCloud Calendar",
        &resolve_icloud,
        &build,
    )?;
    Ok(json!({"provider":"icloud","accountId":account,"calendars":calendars}))
}

pub async fn discover(params: &Value) -> Result<Value, &'static str> {
    let account = account_id(params)?.to_owned();
    tokio::time::timeout(std::time::Duration::from_secs(27), async {
        if account.starts_with("outlook:") {
            microsoft(&account).await
        } else {
            icloud(&account).await
        }
    })
    .await
    .map_err(|_| "calendar_timeout")?
}

fn caldav_server_params(params: &Value) -> Result<(String, String, String), &'static str> {
    let fields = params.as_object().ok_or("invalid_params")?;
    if fields.len() != 3
        || fields
            .keys()
            .any(|key| !["url", "username", "password"].contains(&key.as_str()))
    {
        return Err("invalid_params");
    }
    let url = bounded_text(params, "url").ok_or("invalid_params")?;
    let username = bounded_text(params, "username").ok_or("invalid_params")?;
    let password = params["password"]
        .as_str()
        .filter(|value| {
            !value.is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control)
        })
        .ok_or("invalid_params")?
        .to_owned();
    Ok((url, username, password))
}

// RFC 6764: a bare server address is expected to answer at its own
// `.well-known/caldav` with a redirect naming where the real service lives.
// A server with no well-known support answers with an ordinary failure
// (commonly 404), which is not itself an error here — discovery falls back
// to the address the user entered. An authentication refusal or a redirect
// that tried to leave the entered origin is a real answer and is returned
// as-is rather than papered over by that fallback.
async fn resolve_caldav_root(
    client: &reqwest::Client,
    origin: &Url,
    username: &str,
    password: &str,
    resolve: &dyn Fn(&Url, &str) -> Result<Url, &'static str>,
) -> Result<Url, &'static str> {
    let well_known = origin
        .join("/.well-known/caldav")
        .map_err(|_| "calendar_invalid_url")?;
    match dav_propfind_with_client(client, well_known, username, password, "0", PRINCIPAL, resolve)
        .await
    {
        Ok((resolved, _)) => Ok(resolved),
        Err("calendar_request_failed") => Ok(origin.clone()),
        Err(code) => Err(code),
    }
}

async fn caldav_server(url: &str, username: &str, password: &str) -> Result<Value, &'static str> {
    caldav_server_with_client(super::client()?, url, username, password).await
}

async fn caldav_server_with_client(
    client: &reqwest::Client,
    url: &str,
    username: &str,
    password: &str,
) -> Result<Value, &'static str> {
    let origin = caldav_url(url)?;
    let resolve = |base: &Url, raw: &str| resolve_within_origin(&origin, base, raw);
    let root = resolve_caldav_root(client, &origin, username, password, &resolve).await?;
    let (root, principal_xml) =
        dav_propfind_with_client(client, root, username, password, "0", PRINCIPAL, &resolve)
            .await?;
    let principal = resolve(&root, &nested_href(&principal_xml, b"current-user-principal")?)?;
    let (principal, home_xml) =
        dav_propfind_with_client(client, principal, username, password, "0", HOME, &resolve)
            .await?;
    let home = resolve(&principal, &nested_href(&home_xml, b"calendar-home-set")?)?;
    let (home, collections_xml) =
        dav_propfind_with_client(client, home, username, password, "1", COLLECTIONS, &resolve)
            .await?;
    let build = |url: &Url, name: &str, writable: bool| {
        json!({"url": url.as_str(), "name": name, "readOnly": !writable})
    };
    let calendars = dav_calendars(&collections_xml, &home, "Calendar", &resolve, &build)?;
    Ok(json!({"calendars": calendars}))
}

pub async fn discover_caldav_server(params: &Value) -> Result<Value, &'static str> {
    let (url, username, password) = caldav_server_params(params)?;
    tokio::time::timeout(
        std::time::Duration::from_secs(27),
        caldav_server(&url, &username, &password),
    )
    .await
    .map_err(|_| "calendar_timeout")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_accepts_only_one_supported_account() {
        assert_eq!(
            account_id(&json!({"accountId":"outlook:person@example.org"})),
            Ok("outlook:person@example.org")
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
        let build = |url: &Url, name: &str, writable: bool| {
            json!({"url": url.as_str(), "name": name, "readOnly": !writable})
        };
        let values = dav_calendars(xml, &base, "Calendar", &resolve_icloud, &build).unwrap();
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
        let build = |url: &Url, name: &str, writable: bool| {
            json!({"url": url.as_str(), "name": name, "readOnly": !writable})
        };
        let values = dav_calendars(xml, &base, "Calendar", &resolve_icloud, &build).unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["name"], "Home");
        assert_eq!(values[0]["readOnly"], false);
        assert_eq!(values[1]["name"], "Shared");
        assert_eq!(values[1]["readOnly"], true);
    }

    #[test]
    fn principal_and_home_hrefs_are_scoped_to_their_property() {
        let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/wrong/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/right/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>"#;
        assert_eq!(
            nested_href(xml, b"current-user-principal").unwrap(),
            "/right/"
        );
    }

    #[test]
    fn caldav_url_accepts_only_a_plain_https_server_address() {
        assert!(caldav_url("https://caldav.fastmail.com/").is_ok());
        assert!(caldav_url("https://caldav.fastmail.com/dav/").is_ok());
        for url in [
            "",
            "http://caldav.fastmail.com/",
            "https://user:pass@caldav.fastmail.com/",
            "https://caldav.fastmail.com/#fragment",
            "not a url",
            "https://",
        ] {
            assert!(caldav_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn generic_caldav_credentials_can_only_reach_the_entered_origin() {
        let origin = Url::parse("https://caldav.fastmail.com/").unwrap();
        let base = Url::parse("https://caldav.fastmail.com/dav/calendars/user/me/").unwrap();
        for href in [
            "/dav/calendars/user/me/work/",
            "work/",
            "https://caldav.fastmail.com/dav/calendars/user/me/personal/",
        ] {
            assert!(
                resolve_within_origin(&origin, &base, href).is_ok(),
                "{href}"
            );
        }
        for href in [
            "https://outside.example.test/stolen",
            "//outside.example.test/stolen",
            "http://caldav.fastmail.com/stolen",
            "https://caldav.fastmail.com:8443/stolen",
            "https://caldav.fastmail.com@outside.example.test/stolen",
            "https://caldav.fastmail.com/stolen#fragment",
        ] {
            assert!(
                resolve_within_origin(&origin, &base, href).is_err(),
                "{href}"
            );
        }
    }

    #[test]
    fn caldav_server_params_require_exactly_url_username_and_password() {
        assert!(
            caldav_server_params(&json!({
                "url": "https://caldav.fastmail.com/",
                "username": "me@fastmail.com",
                "password": "app-password"
            }))
            .is_ok()
        );
        for value in [
            json!({}),
            json!({"url": "https://caldav.fastmail.com/"}),
            json!({
                "url": "https://caldav.fastmail.com/",
                "username": "me@fastmail.com",
                "password": ""
            }),
            json!({
                "url": "https://caldav.fastmail.com/",
                "username": "me@fastmail.com",
                "password": "app-password",
                "extra": true
            }),
        ] {
            assert_eq!(caldav_server_params(&value), Err("invalid_params"));
        }
    }
}
