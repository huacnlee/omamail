//! Calendar HTTP is owned by the backend; view code receives bounded documents.
use reqwest::{Client, Method, Url};
use serde_json::{Value, json};
use std::{sync::OnceLock, time::Duration};

const LIMIT: usize = 16 * 1024 * 1024;
static CLIENT: OnceLock<Result<Client, &'static str>> = OnceLock::new();

fn client() -> Result<&'static Client, &'static str> {
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .https_only(true)
                .hickory_dns(true)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|_| "calendar_network_failed")
        })
        .as_ref()
        .map_err(|e| *e)
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    let s = value[key].as_str().ok_or("calendar_invalid_input")?;
    if s.is_empty() || s.len() > 8192 || s.chars().any(char::is_control) {
        return Err("calendar_invalid_input");
    }
    Ok(s)
}

fn configured_url(raw: &str) -> Result<Url, &'static str> {
    if raw.chars().any(char::is_control) || raw.contains('\\') {
        return Err("calendar_invalid_url");
    }
    let url = Url::parse(raw).map_err(|_| "calendar_invalid_url")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("calendar_invalid_url");
    }
    Ok(url)
}

fn event_url(base: &Url, href: &str) -> Result<Url, &'static str> {
    if href.is_empty()
        || href.len() > 8192
        || href.chars().any(char::is_control)
        || href.contains('\\')
    {
        return Err("calendar_invalid_url");
    }
    let mut collection = base.clone();
    if !collection.path().ends_with('/') {
        collection.set_path(&format!("{}/", collection.path()));
    }
    let url = collection.join(href).map_err(|_| "calendar_invalid_url")?;
    if url.origin() != base.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("calendar_origin_refused");
    }
    Ok(url)
}

struct Request {
    url: Url,
    method: Method,
    body: String,
    kind: String,
    source_id: String,
    username: String,
}

fn prepare(params: &Value) -> Result<Request, &'static str> {
    let source = &params["source"];
    let kind = text(source, "kind")?;
    let op = text(params, "operation")?;
    let method = match op {
        "list" => Method::GET,
        "create" => Method::POST,
        "update" => Method::PATCH,
        "delete" => Method::DELETE,
        _ => return Err("calendar_invalid_operation"),
    };
    let body = params["body"].as_str().unwrap_or("").to_owned();
    if body.len() > LIMIT {
        return Err("calendar_input_too_large");
    }
    let mut request = Request {
        url: Url::parse("https://www.googleapis.com/calendar/v3/calendars/primary/events").unwrap(),
        method,
        body,
        kind: kind.into(),
        source_id: String::new(),
        username: String::new(),
    };
    match kind {
        "google" | "microsoft" => {
            if kind == "microsoft" {
                request.url = Url::parse(if op == "list" {
                    "https://graph.microsoft.com/v1.0/me/calendarView"
                } else {
                    "https://graph.microsoft.com/v1.0/me/events"
                })
                .unwrap();
            }
            if op == "update" || op == "delete" {
                let id = text(params, "eventId")?;
                if id == "." || id == ".." {
                    return Err("calendar_invalid_input");
                }
                request.url.path_segments_mut().unwrap().push(id);
            }
            if op == "list" {
                let start = text(params, "start")?;
                let end = text(params, "end")?;
                let mut query = request.url.query_pairs_mut();
                if kind == "google" {
                    query.extend_pairs([
                        ("singleEvents", "true"),
                        ("orderBy", "startTime"),
                        ("maxResults", "2500"),
                        ("timeMin", start),
                        ("timeMax", end),
                    ]);
                } else {
                    query.extend_pairs([
                        ("startDateTime", start),
                        ("endDateTime", end),
                        ("$top", "500"),
                        ("$orderby", "start/dateTime"),
                    ]);
                }
            }
            if op == "create" || op == "update" {
                let value: Value =
                    serde_json::from_str(&request.body).map_err(|_| "calendar_invalid_input")?;
                if !value.is_object() {
                    return Err("calendar_invalid_input");
                }
            }
        }
        "caldav" => {
            request.source_id = text(source, "id")?.into();
            request.username = text(source, "username")?.into();
            let base = configured_url(text(source, "url")?)?;
            request.url = if op == "list" {
                base
            } else {
                event_url(&base, text(params, "href")?)?
            };
            request.method = match op {
                "list" => Method::from_bytes(b"REPORT").unwrap(),
                "create" | "update" => Method::PUT,
                _ => Method::DELETE,
            };
        }
        _ => return Err("calendar_provider_unsupported"),
    }
    Ok(request)
}

/// OAuth tokens remain inside Rust; CalDAV credentials are loaded only after
/// validating the exact destination, and redirects are never followed.
pub async fn call(params: &Value, token: Option<&str>) -> Result<Value, &'static str> {
    tokio::time::timeout(Duration::from_secs(24), call_inner(params, token))
        .await
        .map_err(|_| "calendar_timeout")?
}

async fn call_inner(params: &Value, token: Option<&str>) -> Result<Value, &'static str> {
    let request = prepare(params)?;
    let password = if request.kind == "caldav" {
        let id = request.source_id.clone();
        Some(
            tokio::task::spawn_blocking(move || {
                let args = [
                    "lookup",
                    "service",
                    "omamail",
                    "kind",
                    "calendar-password",
                    "source",
                    &id,
                ]
                .map(String::from);
                let bytes =
                    crate::process::run("secret-tool", &args, b"", Duration::from_secs(5), 65536)?;
                let value = String::from_utf8(bytes).map_err(|_| "calendar_password_missing")?;
                if value.is_empty() || value.chars().any(char::is_control) {
                    return Err("calendar_password_missing");
                }
                Ok(value)
            })
            .await
            .map_err(|_| "calendar_password_missing")??,
        )
    } else {
        None
    };
    let paginated = params["operation"] == "list" && request.kind != "caldav";
    let origin = request.url.clone();
    let mut result = execute(client()?, request, token, password.as_deref()).await?;
    if !paginated {
        return Ok(result);
    }
    let mut payload: Value = serde_json::from_str(result["body"].as_str().unwrap_or(""))
        .map_err(|_| "calendar_invalid_response")?;
    let items_key = if params["source"]["kind"] == "google" {
        "items"
    } else {
        "value"
    };
    let mut total_bytes = result["body"].as_str().unwrap_or("").len();
    for _ in 0..100 {
        let next = next_page(&origin, &payload, items_key)?;
        let Some(next) = next else {
            result["body"] = Value::String(
                serde_json::to_string(&payload).map_err(|_| "calendar_invalid_response")?,
            );
            return Ok(result);
        };
        let mut request = prepare(params)?;
        request.url = next;
        let answer = execute(client()?, request, token, None).await?;
        let body = answer["body"].as_str().ok_or("calendar_invalid_response")?;
        total_bytes += body.len();
        if total_bytes > LIMIT {
            return Err("calendar_response_too_large");
        }
        let mut page: Value =
            serde_json::from_str(body).map_err(|_| "calendar_invalid_response")?;
        let mut items = payload[items_key].as_array().cloned().unwrap_or_default();
        items.extend(page[items_key].as_array().cloned().unwrap_or_default());
        page[items_key] = Value::Array(items);
        payload = page;
    }
    Err("calendar_too_many_pages")
}

fn next_page(origin: &Url, payload: &Value, items_key: &str) -> Result<Option<Url>, &'static str> {
    if items_key == "items" {
        let Some(token) = payload["nextPageToken"].as_str().filter(|s| !s.is_empty()) else {
            return Ok(None);
        };
        if token.len() > 8192 || token.chars().any(char::is_control) {
            return Err("calendar_invalid_response");
        }
        let mut next = origin.clone();
        next.query_pairs_mut().append_pair("pageToken", token);
        Ok(Some(next))
    } else {
        let Some(raw) = payload["@odata.nextLink"]
            .as_str()
            .filter(|s| !s.is_empty())
        else {
            return Ok(None);
        };
        let next = configured_url(raw)?;
        if next.origin() != origin.origin() || next.path() != origin.path() {
            return Err("calendar_origin_refused");
        }
        Ok(Some(next))
    }
}

async fn execute(
    client: &Client,
    request: Request,
    token: Option<&str>,
    password: Option<&str>,
) -> Result<Value, &'static str> {
    let mut builder = client.request(request.method.clone(), request.url);
    if request.kind == "caldav" {
        builder = builder.basic_auth(request.username, password);
        if request.method.as_str() == "REPORT" {
            builder = builder
                .header("Depth", "1")
                .header("Content-Type", "application/xml; charset=utf-8");
        } else {
            builder = builder.header("Content-Type", "text/calendar; charset=utf-8");
        }
    } else {
        let token = token
            .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
            .ok_or("calendar_auth_required")?;
        builder = builder
            .bearer_auth(token)
            .header("Content-Type", "application/json");
        if request.kind == "microsoft" {
            builder = builder.header("Prefer", "outlook.timezone=\"UTC\"");
        }
    }
    let mut response = builder
        .body(request.body)
        .send()
        .await
        .map_err(|_| "calendar_network_failed")?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("calendar_auth_refused");
    }
    if !status.is_success() {
        return Err("calendar_request_failed");
    }
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err("calendar_response_too_large");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "calendar_network_failed")?
    {
        if chunk.len() > LIMIT - bytes.len() {
            return Err("calendar_response_too_large");
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "calendar_invalid_response")?;
    Ok(json!({"body":body,"status":status.as_u16()}))
}

#[cfg(test)]
mod tests;
