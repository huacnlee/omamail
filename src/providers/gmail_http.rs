//! Native, pooled HTTP to fixed Google origins. Errors never include request data.
use serde_json::Value;
use std::{sync::OnceLock, time::Duration};

#[cfg(test)]
#[path = "gmail_http_runtime_tests.rs"]
mod runtime_tests;

struct Request {
    url: String,
    method: reqwest::Method,
    content_type: &'static str,
    authorization: Option<reqwest::header::HeaderValue>,
    body: Option<String>,
}

const MAX_INPUT: usize = 64 * 1024;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(20);
static CLIENT: OnceLock<Result<reqwest::Client, &'static str>> = OnceLock::new();

fn client() -> Result<&'static reqwest::Client, &'static str> {
    CLIENT
        .get_or_init(build_client)
        .as_ref()
        .map_err(|error| *error)
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .https_only(true)
        .hickory_dns(true)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(DEADLINE)
}

fn build_client() -> Result<reqwest::Client, &'static str> {
    client_builder().build().map_err(|_| "gmail_http_failed")
}

/// Path entries are individual components, never an arbitrary URL or slash path.
pub async fn get(
    path: &[&str],
    query: &[(String, String)],
    token: &str,
) -> Result<Value, &'static str> {
    let request = prepare_get(path, query, token)?;
    execute(client()?, request, DEADLINE).await
}

pub async fn refresh(id: &str, secret: &str, token: &str) -> Result<Value, &'static str> {
    let request = prepare_refresh(id, secret, token)?;
    execute(client()?, request, DEADLINE).await
}

fn http_error(error: reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "gmail_timeout"
    } else {
        "gmail_http_failed"
    }
}

async fn execute(
    client: &reqwest::Client,
    request: Request,
    deadline: Duration,
) -> Result<Value, &'static str> {
    tokio::time::timeout(deadline, async {
        let empty_success =
            request.authorization.is_some() && request.method != reqwest::Method::GET;
        let empty_post = request.body.is_none()
            && matches!(
                request.method,
                reqwest::Method::POST | reqwest::Method::PUT | reqwest::Method::PATCH
            );
        let mut builder = client.request(request.method, &request.url);
        if let Some(body) = request.body {
            builder = builder
                .header(reqwest::header::CONTENT_TYPE, request.content_type)
                .body(body);
        } else if empty_post {
            // Bodyless Gmail trash/untrash requests still need explicit framing.
            // Some gateways reject a POST without Content-Length with HTTP 411.
            builder = builder.header(reqwest::header::CONTENT_LENGTH, "0");
        }
        if let Some(authorization) = request.authorization {
            builder = builder.header(reqwest::header::AUTHORIZATION, authorization);
        }
        let mut response = builder.send().await.map_err(http_error)?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("gmail_unauthorized");
        }
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                403 => "gmail_forbidden",
                411 => "gmail_length_required",
                429 => "gmail_rate_limited",
                _ => "gmail_http_failed",
            });
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE as u64)
        {
            return Err("gmail_response_too_large");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(http_error)? {
            if chunk.len() > MAX_RESPONSE - bytes.len() {
                return Err("gmail_response_too_large");
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() && empty_success {
            return Ok(serde_json::json!({}));
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "gmail_invalid_response")?;
        if !value.is_object() {
            return Err("gmail_invalid_response");
        }
        Ok(value)
    })
    .await
    .map_err(|_| "gmail_timeout")?
}

fn valid(value: &str) -> Result<(), &'static str> {
    if value.len() > MAX_INPUT || value.bytes().any(|b| b < 32 || b == 127) {
        return Err("gmail_invalid_input");
    }
    Ok(())
}

fn encode(value: &str) -> String {
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            result.push(byte as char);
        } else {
            result.push('%');
            result.push(HEX[(byte >> 4) as usize] as char);
            result.push(HEX[(byte & 15) as usize] as char);
        }
    }
    result
}

fn prepare_get(
    path: &[&str],
    query: &[(String, String)],
    token: &str,
) -> Result<Request, &'static str> {
    valid(token)?;
    if token.is_empty() || path.is_empty() || path.len() > 16 || query.len() > 100 {
        return Err("gmail_invalid_input");
    }
    let mut url = String::from("https://gmail.googleapis.com/gmail/v1/users/me/");
    for (index, part) in path.iter().enumerate() {
        valid(part)?;
        if part.is_empty() || *part == "." || *part == ".." {
            return Err("gmail_invalid_input");
        }
        if index != 0 {
            url.push('/');
        }
        url.push_str(&encode(part));
    }
    for (index, (key, value)) in query.iter().enumerate() {
        valid(key)?;
        valid(value)?;
        url.push(if index == 0 { '?' } else { '&' });
        url.push_str(&encode(key));
        url.push('=');
        url.push_str(&encode(value));
        if url.len() > MAX_INPUT {
            return Err("gmail_invalid_input");
        }
    }
    if url.len() > MAX_INPUT {
        return Err("gmail_invalid_input");
    }
    let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "gmail_invalid_input")?;
    authorization.set_sensitive(true);
    Ok(Request {
        url,
        method: reqwest::Method::GET,
        content_type: "application/json",
        authorization: Some(authorization),
        body: None,
    })
}

fn prepare_refresh(id: &str, secret: &str, token: &str) -> Result<Request, &'static str> {
    for value in [id, secret, token] {
        valid(value)?;
        if value.is_empty() {
            return Err("gmail_invalid_input");
        }
    }
    let body = format!(
        "grant_type=refresh_token&client_id={}&client_secret={}&refresh_token={}",
        encode(id),
        encode(secret),
        encode(token)
    );
    if body.len() > MAX_INPUT {
        return Err("gmail_invalid_input");
    }
    Ok(Request {
        url: "https://oauth2.googleapis.com/token".into(),
        method: reqwest::Method::POST,
        content_type: "application/x-www-form-urlencoded",
        authorization: None,
        body: Some(body),
    })
}

/// Mutations are sent once. A timeout leaves completion unknown and is never retried.
pub async fn write(
    method: reqwest::Method,
    path: &[&str],
    body: Option<&Value>,
    token: &str,
) -> Result<Value, &'static str> {
    let request = prepare_write(method, path, body, token)?;
    execute(client()?, request, DEADLINE).await
}

fn prepare_write(
    method: reqwest::Method,
    path: &[&str],
    body: Option<&Value>,
    token: &str,
) -> Result<Request, &'static str> {
    if !matches!(
        method,
        reqwest::Method::POST
            | reqwest::Method::PUT
            | reqwest::Method::PATCH
            | reqwest::Method::DELETE
    ) {
        return Err("gmail_invalid_input");
    }
    let mut request = prepare_get(path, &[], token)?;
    request.method = method;
    if let Some(body) = body {
        let body = serde_json::to_string(body).map_err(|_| "gmail_invalid_input")?;
        if body.len() > 48 * 1024 * 1024 {
            return Err("gmail_invalid_input");
        }
        request.body = Some(body);
    }
    Ok(request)
}
