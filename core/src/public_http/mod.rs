//! Sender-selected HTTP destinations: validate every DNS answer, then hand the
//! checked numeric sockets directly to the connector. Never follow redirects.
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{
    Client, Method, Url,
    dns::{Addrs, Name, Resolve, Resolving},
};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, OnceLock},
    time::Duration,
};

mod downscale;
mod usage;

const DEADLINE: Duration = Duration::from_secs(20);
const MAX_IMAGE: usize = 5 * 1024 * 1024;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;
static CLIENT: OnceLock<Result<Client, &'static str>> = OnceLock::new();

#[derive(Debug)]
struct PublicResolver;
impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            // Every answer is checked before reqwest may connect, whichever
            // resolver the platform uses.
            let ips = crate::platform::dns::lookup_ips(name.as_str()).await?;
            let addresses = checked_addresses(ips).map_err(std::io::Error::other)?;
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn checked_addresses(ips: Vec<IpAddr>) -> Result<Vec<SocketAddr>, &'static str> {
    if ips.is_empty() || ips.iter().any(|ip| !is_public(*ip)) {
        return Err("public_destination_refused");
    }
    Ok(ips.into_iter().map(|ip| SocketAddr::new(ip, 0)).collect())
}

/// Conservative global-unicast policy, including transition mechanisms that
/// can hide a different effective IPv4 destination.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && ((b == 168) || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Only currently allocated global unicast; excludes mapped IPv4,
            // NAT64, local/multicast and deprecated site-local addresses.
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && s[1] < 0x0200)
                && !(s[0] == 0x2001 && s[1] == 0x0db8)
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

fn parse_url(raw: &str, https_only: bool) -> Result<Url, &'static str> {
    // URL parsing normalizes controls and backslashes, so reject raw bytes first.
    if raw.is_empty()
        || raw.len() > 128 * 1024
        || raw
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return Err("public_url_invalid");
    }
    if raw.split_once("://").is_some_and(|(_, rest)| {
        rest.split(['/', '?', '#'])
            .next()
            .is_some_and(|authority| authority.contains('@'))
    }) {
        return Err("public_url_invalid");
    }
    let mut url = Url::parse(raw).map_err(|_| "public_url_invalid")?;
    if !matches!(url.scheme(), "http" | "https")
        || (https_only && url.scheme() != "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port() == Some(0)
    {
        return Err("public_url_invalid");
    }
    let host = url.host_str().ok_or("public_url_invalid")?;
    if let Ok(ip) = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        if !is_public(ip) {
            return Err("public_destination_refused");
        }
    } else if host.len() > 253
        || !host.contains('.')
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err("public_url_invalid");
    }
    url.set_fragment(None);
    Ok(url)
}

fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(Arc::new(PublicResolver))
        .connect_timeout(Duration::from_secs(10))
        .timeout(DEADLINE)
        .pool_max_idle_per_host(2)
}
fn client() -> Result<&'static Client, &'static str> {
    CLIENT
        .get_or_init(|| client_builder().build().map_err(|_| "public_http_failed"))
        .as_ref()
        .map_err(|error| *error)
}

pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

async fn execute(
    client: &Client,
    url: Url,
    method: Method,
    max: usize,
    deadline: Duration,
) -> Result<Response, &'static str> {
    tokio::time::timeout(deadline, async {
        let mut request = client.request(method.clone(), url);
        if method == Method::POST {
            request = request
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body("List-Unsubscribe=One-Click");
        }
        let mut response = request.send().await.map_err(|_| "public_http_failed")?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("Content-Type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let mut body = Vec::new();
        // Unsubscribe only consumes the status; redirects never consume a body.
        if method == Method::GET && (200..300).contains(&status) {
            if response
                .headers()
                .get("Content-Encoding")
                .is_some_and(|v| v != "identity")
            {
                return Err("public_encoding_refused");
            }
            if response
                .content_length()
                .is_some_and(|size| size > max as u64)
            {
                return Err("public_response_too_large");
            }
            while let Some(chunk) = response.chunk().await.map_err(|_| "public_http_failed")? {
                if chunk.len() > max - body.len() {
                    return Err("public_response_too_large");
                }
                body.extend_from_slice(&chunk);
            }
        }
        Ok(Response {
            status,
            content_type,
            body,
        })
    })
    .await
    .map_err(|_| "public_http_timeout")?
}

/// Public calendar subscription fetches use the same pinned-address policy.
pub async fn fetch(url: &str, max_bytes: usize) -> Result<Response, &'static str> {
    execute(
        client()?,
        parse_url(url, false)?,
        Method::GET,
        max_bytes.min(MAX_RESPONSE),
        DEADLINE,
    )
    .await
}
pub async fn unsubscribe(url: &str) -> Result<u16, &'static str> {
    Ok(
        execute(client()?, parse_url(url, true)?, Method::POST, 0, DEADLINE)
            .await?
            .status,
    )
}
/// Sends an opted-in usage batch to Omamail's fixed statistics endpoint.
pub async fn post_usage_batch(body: String) -> Result<u16, &'static str> {
    const ENDPOINT: &str = "https://nsmetry.huacnlee-account.workers.dev/api/events/batch";
    post_usage(client()?, ENDPOINT, body).await
}

async fn post_usage(client: &Client, url: &str, body: String) -> Result<u16, &'static str> {
    if !usage::approved_batch(&body) {
        return Ok(400);
    }
    // The public client has no credential or cookie store and refuses all
    // redirects. Drop the response after reading its status.
    Ok(client
        .post(url)
        .timeout(Duration::from_secs(5))
        .header("Content-Type", "text/plain;charset=UTF-8")
        .body(body)
        .send()
        .await
        .map_err(|_| "analytics_unavailable")?
        .status()
        .as_u16())
}

fn sniff(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if data.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}
fn data_uri(mime: &str, data: &[u8]) -> Result<String, &'static str> {
    Ok(match downscale::prepare(mime, data)? {
        downscale::Prepared::Original => format!("data:{mime};base64,{}", STANDARD.encode(data)),
        downscale::Prepared::Smaller(smaller) => {
            format!("data:{mime};base64,{}", STANDARD.encode(smaller.as_slice()))
        }
    })
}
fn image_data(response: Response) -> Result<String, &'static str> {
    if !(200..300).contains(&response.status) {
        return Err("public_http_refused");
    }
    let data = response.body;
    let mime = sniff(&data).ok_or("public_image_refused")?;
    let claimed = if response.content_type == "image/jpg" {
        "image/jpeg"
    } else {
        &response.content_type
    };
    if claimed != mime {
        return Err("public_image_refused");
    }
    data_uri(mime, &data)
}
/// A picture the message itself carries, such as a `cid:` part, prepared like a
/// fetched one: a known raster signature, shrunk when oversized, refused when
/// its decode would cost more than the limits allow. No network is involved;
/// the declared part type is not trusted, the bytes decide.
pub async fn embedded_image(data: Vec<u8>) -> Result<String, &'static str> {
    // A pasted screenshot is often larger than a fetched picture may be; it is
    // already here, and `downscale` prices its decode before doing it.
    const MAX_EMBEDDED: usize = 16 * 1024 * 1024;
    if data.len() > MAX_EMBEDDED {
        return Err("public_image_refused");
    }
    let mime = sniff(&data).ok_or("public_image_refused")?;
    let _one_decode_at_a_time = downscale::slot().await;
    tokio::task::spawn_blocking(move || data_uri(mime, &data))
        .await
        .map_err(|_| "worker_failed")?
}
pub async fn image(url: &str) -> Result<String, &'static str> {
    let response = fetch(url, MAX_IMAGE).await?;
    let _one_decode_at_a_time = downscale::slot().await;
    tokio::task::spawn_blocking(move || image_data(response))
        .await
        .map_err(|_| "worker_failed")?
}

#[cfg(test)]
mod tests;
