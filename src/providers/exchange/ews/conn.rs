//! One signed-in HTTP/1.1 connection to an EWS endpoint. NTLM authenticates a TCP connection rather
//! than a request, so this keeps its own stream (hyper's single-connection client over
//! tokio-rustls) instead of a pool, and the TLS certificate it hashes for the channel binding is
//! the one on that stream.
//!
//! - The password goes only to the configured host, after the TLS handshake verified it, and only
//!   once the server asked for it: NTLM sends a response never the password; Basic needs a 401 that
//!   offers it. Redirects are never followed, environment proxies never read.
//! - ALPN offers `http/1.1` only: IIS refuses connection-bound NTLM over HTTP/2.
//! - NTLM's AUTHENTICATE rides with the first request that has a body, so a wrong password shows
//!   there. A 401 to a request that carried credentials is `exchange_unauthorized`.
//! - Responses are bounded (`MAX_BODY`, and 64 KiB for anything but a 200 or a SOAP fault), every
//!   request ends by the instant its caller gives (at most `DEADLINE` away), and errors are static
//!   codes.

use std::{net::IpAddr, sync::Arc, time::Duration};

use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Request, Uri, body::Bytes, client::conn::http1, header};
use hyper_util::rt::TokioIo;
use reqwest::Url;
use rustls::{ClientConfig, RootCertStore, pki_types::ServerName};
use tokio::time::{Instant, timeout_at};
use tokio_rustls::TlsConnector;
use zeroize::Zeroizing;

use super::ntlm;

const LENIENT: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    base64::engine::GeneralPurposeConfig::new()
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
);

/// A message of `decode::MAX_MIME` as base64 (32 MiB), a server's line wrapping (3 %) and the envelope.
pub const MAX_BODY: usize = 36 * 1024 * 1024;
const MAX_ERROR_BODY: usize = 64 * 1024;
pub const DEADLINE: Duration = Duration::from_secs(20);

/// A duration on this provider's clock, which a test may run faster (`tests::HURRY`): a deadline
/// test then takes about a second instead of half a minute, every deadline in proportion.
pub fn clock(duration: Duration) -> Duration {
    #[cfg(test)]
    let duration = duration
        / super::tests::HURRY
            .load(std::sync::atomic::Ordering::Relaxed)
            .max(1);
    duration
}
const CLOSED: &str = "exchange_connection_closed";
const TIMEOUT: &str = "exchange_timeout";
const UNAUTHORIZED: &str = "exchange_unauthorized";
const SUFFIX: &str = "/ews/exchange.asmx";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Choice {
    Auto,
    Ntlm,
    Basic,
}

impl Choice {
    pub fn parse(text: &str) -> Option<Choice> {
        Some(match text {
            "auto" => Choice::Auto,
            "ntlm" => Choice::Ntlm,
            "basic" => Choice::Basic,
            _ => return None,
        })
    }
}

pub struct Config {
    pub url: Url,
    pub choice: Choice,
    pub login: String,
    pub password: Zeroizing<String>,
    pub roots: Arc<RootCertStore>,
}

/// The configured endpoint: `https://host[:port]/<prefix>/EWS/Exchange.asmx` and nothing the URL
/// parser could read two ways (credentials, query, fragment).
pub fn endpoint(text: &str) -> Result<Url, &'static str> {
    let url = Url::parse(text.trim()).map_err(|_| "exchange_url_invalid")?;
    let plain = url.scheme() != "https"
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().to_ascii_lowercase().ends_with(SUFFIX);
    if plain {
        Err("exchange_url_invalid")
    } else {
        Ok(url)
    }
}

impl Config {
    pub fn new(url: Url, choice: Choice, login: &str, password: &str) -> Config {
        Config {
            url,
            choice,
            login: login.to_owned(),
            password: Zeroizing::new(password.to_owned()),
            #[cfg(not(test))]
            roots: crate::tls::roots(),
            #[cfg(test)]
            roots: super::tests::fake::roots(),
        }
    }
}

impl Config {
    /// Whether another configuration signs in the same way.
    pub fn same(&self, other: &Config) -> bool {
        self.url == other.url
            && self.choice == other.choice
            && self.login == other.login
            && *self.password == *other.password
    }
}

enum Auth {
    Basic(Zeroizing<String>),
    /// The AUTHENTICATE message, until the first request carries it.
    Ntlm(Option<Zeroizing<String>>),
}

pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    /// `WWW-Authenticate` values, `Retry-After` in seconds.
    pub challenges: Vec<String>,
    pub retry_after: Option<u64>,
}

pub enum Lost {
    /// The request was not written: sending it again cannot do anything twice.
    Unsent,
    /// It may have been: only a read may be sent again.
    Sent(&'static str),
}

pub struct Conn {
    send: http1::SendRequest<Full<Bytes>>,
    target: String,
    host: String,
    auth: Auth,
    /// The scheme signed in with, `ntlm` or `basic`.
    pub scheme: &'static str,
    /// A request began and did not end: the stream may hold half of an answer.
    dirty: bool,
}

fn hash_header(scheme: &str, raw: &[u8]) -> Zeroizing<String> {
    Zeroizing::new(format!("{scheme} {}", STANDARD.encode(raw)))
}

/// What a `WWW-Authenticate` value offers for `scheme`: its token, or `Some("")` for the bare name.
fn offer<'a>(replies: &'a [String], scheme: &str) -> Option<&'a str> {
    replies
        .iter()
        .flat_map(|value| value.split(','))
        .find_map(|item| {
            let item = item.trim();
            let (name, token) = item.split_once(' ').unwrap_or((item, ""));
            name.eq_ignore_ascii_case(scheme).then_some(token.trim())
        })
}

impl Conn {
    /// Dials, verifies TLS and chooses the scheme (`choice`, which the client may have narrowed from
    /// the configured one) by `until`; NTLM is carried through the CHALLENGE so that the first
    /// `post` signs in.
    pub async fn open(
        config: &Config,
        choice: Choice,
        until: Instant,
    ) -> Result<Conn, &'static str> {
        timeout_at(until, Self::open_inner(config, choice))
            .await
            .unwrap_or(Err(TIMEOUT))
    }

    async fn open_inner(config: &Config, choice: Choice) -> Result<Conn, &'static str> {
        let (mut conn, mut cert) = Self::dial(config).await?;
        let mut scheme = choice;
        if scheme != Choice::Ntlm {
            // Nothing is sent that could be a credential before the server names what it takes.
            let reply = conn.post_with(None, Vec::new()).await.map_err(lost)?;
            if reply.status != 401 {
                return Err(status_code(reply.status));
            }
            let ntlm = offer(&reply.challenges, "ntlm").is_some();
            let basic = offer(&reply.challenges, "basic").is_some();
            scheme = match (scheme, ntlm, basic) {
                (Choice::Auto, true, _) => Choice::Ntlm,
                (Choice::Auto | Choice::Basic, _, true) => Choice::Basic,
                _ => return Err("exchange_auth_scheme_unsupported"),
            };
            // NTLM belongs to the stream it starts on: a server that closed the probe's gets a new one.
            if conn.send.ready().await.is_err() {
                (conn, cert) = Self::dial(config).await?;
            }
        }
        if scheme == Choice::Basic {
            if config.login.contains(':') {
                return Err("invalid_params");
            }
            let raw = Zeroizing::new(format!("{}:{}", config.login, *config.password));
            conn.auth = Auth::Basic(hash_header("Basic", raw.as_bytes()));
            conn.scheme = "basic";
            return Ok(conn);
        }
        let binding = ntlm::channel_binding(&cert)?;
        let negotiate = ntlm::negotiate();
        let reply = conn
            .post_with(Some(hash_header("NTLM", &negotiate)), Vec::new())
            .await
            .map_err(lost)?;
        // What the server said, not a guess: an answer that is no challenge is no NTLM refusal.
        if reply.status != 401 {
            return Err(status_code(reply.status));
        }
        let token = match offer(&reply.challenges, "ntlm") {
            Some(token) if !token.is_empty() => token,
            Some(_) => return Err("exchange_auth_failed"),
            None => return Err("exchange_auth_scheme_unsupported"),
        };
        // Servers differ on the padding of a token.
        let challenge = LENIENT.decode(token).map_err(|_| "exchange_auth_failed")?;
        let mut client_challenge = [0u8; 8];
        rustls::crypto::ring::default_provider()
            .secure_random
            .fill(&mut client_challenge)
            .map_err(|_| "exchange_auth_failed")?;
        let host = config
            .url
            .host_str()
            .unwrap_or_default()
            .trim_matches(['[', ']']);
        let authenticate = ntlm::authenticate(
            &config.login,
            &config.password,
            &negotiate,
            &challenge,
            client_challenge,
            &format!("HTTP/{host}"),
            binding,
        )?;
        conn.auth = Auth::Ntlm(Some(hash_header("NTLM", &authenticate)));
        // The CHALLENGE came on this stream and so must the AUTHENTICATE.
        conn.send.ready().await.map_err(|_| CLOSED)?;
        Ok(conn)
    }

    async fn dial(config: &Config) -> Result<(Conn, Vec<u8>), &'static str> {
        let url = &config.url;
        let port = url.port_or_known_default().unwrap_or(443);
        let host = url
            .host_str()
            .ok_or("exchange_url_invalid")?
            .trim_matches(['[', ']']);
        let name = match host.parse::<IpAddr>() {
            Ok(ip) => ServerName::IpAddress(ip.into()),
            Err(_) => ServerName::try_from(host.to_owned()).map_err(|_| "exchange_url_invalid")?,
        };
        // IMAP's resolver and connect loop; `localhost` is the loopback address there too.
        let local = host.eq_ignore_ascii_case("localhost");
        let tcp = crate::providers::imap::dial_host(if local { "127.0.0.1" } else { host }, port)
            .await
            .map_err(|code| match code {
                "mail_dns_failed" => "exchange_dns_failed",
                _ => "exchange_network_failed",
            })?;
        let mut tls =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .map_err(|_| "exchange_tls_failed")?
                .with_root_certificates(Arc::clone(&config.roots))
                .with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let stream = TlsConnector::from(Arc::new(tls))
            .connect(name, tcp)
            .await
            .map_err(|_| "exchange_tls_failed")?;
        let cert = stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|chain| chain.first())
            .map(|cert| cert.as_ref().to_vec())
            .ok_or("exchange_tls_failed")?;
        let (send, driver) = http1::Builder::new()
            .max_buf_size(64 * 1024)
            .handshake(TokioIo::new(stream))
            .await
            .map_err(|_| CLOSED)?;
        tokio::spawn(driver);
        let host = url.host_str().unwrap_or_default();
        let conn = Conn {
            send,
            target: url.path().to_owned(),
            host: url
                .port()
                .map_or_else(|| host.to_owned(), |port| format!("{host}:{port}")),
            auth: Auth::Ntlm(None),
            scheme: "ntlm",
            dirty: false,
        };
        Ok((conn, cert))
    }

    /// Whether the stream can carry another request.
    pub async fn usable(&mut self) -> bool {
        !self.dirty && self.send.ready().await.is_ok()
    }

    /// One SOAP request, given up at `until`.
    pub async fn post(&mut self, body: Vec<u8>, until: Instant) -> Result<Reply, Lost> {
        let header = match &mut self.auth {
            Auth::Basic(value) => Some(value.clone()),
            Auth::Ntlm(pending) => pending.take(),
        };
        timeout_at(until, self.post_with(header, body))
            .await
            .unwrap_or(Err(Lost::Sent(TIMEOUT)))
    }

    /// Whether the next request carries credentials (a 401 to it means they were refused).
    pub fn carries_credentials(&self) -> bool {
        matches!(&self.auth, Auth::Basic(_) | Auth::Ntlm(Some(_)))
    }

    async fn post_with(
        &mut self,
        auth: Option<Zeroizing<String>>,
        body: Vec<u8>,
    ) -> Result<Reply, Lost> {
        self.dirty = true;
        let uri = Uri::try_from(self.target.as_str()).map_err(|_| Lost::Unsent)?;
        // hyper leaves Content-Length off an empty body, and IIS answers a POST without one with
        // `411 Length Required` instead of its 401 challenge: always say it, zero included.
        let mut request = Request::post(uri)
            .header(header::HOST, &self.host)
            .header(header::CONTENT_TYPE, "text/xml; charset=utf-8")
            .header(header::CONTENT_LENGTH, body.len());
        if let Some(value) = auth {
            let mut value = header::HeaderValue::from_str(&value).map_err(|_| Lost::Unsent)?;
            value.set_sensitive(true);
            request = request.header(header::AUTHORIZATION, value);
        }
        let request = request
            .body(Full::new(Bytes::from(body)))
            .map_err(|_| Lost::Unsent)?;
        let response = match self.send.try_send_request(request).await {
            Ok(response) => response,
            Err(error) if error.message().is_some() => return Err(Lost::Unsent),
            Err(_) => return Err(Lost::Sent(CLOSED)),
        };
        let status = response.status().as_u16();
        let text = |name| {
            response
                .headers()
                .get_all(name)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let challenges = text(header::WWW_AUTHENTICATE).collect();
        let retry_after = text(header::RETRY_AFTER).find_map(|v| v.trim().parse().ok());
        let limit = if matches!(status, 200 | 500) {
            MAX_BODY
        } else {
            MAX_ERROR_BODY
        };
        let body = Limited::new(response.into_body(), limit)
            .collect()
            .await
            .map_err(|error| {
                // Anything but the limit is a stream that ended or broke.
                Lost::Sent(
                    if error
                        .downcast_ref::<http_body_util::LengthLimitError>()
                        .is_some()
                    {
                        "exchange_response_too_large"
                    } else {
                        CLOSED
                    },
                )
            })?
            .to_bytes()
            .to_vec();
        self.dirty = false;
        Ok(Reply {
            status,
            body,
            challenges,
            retry_after,
        })
    }
}

fn lost(error: Lost) -> &'static str {
    match error {
        Lost::Unsent => CLOSED,
        Lost::Sent(code) => code,
    }
}

/// What an HTTP status other than 200 and 500 says about the request.
pub fn status_code(status: u16) -> &'static str {
    match status {
        401 => UNAUTHORIZED,
        300..=399 => "exchange_redirect_refused",
        429 | 503 => "exchange_throttled",
        _ => "exchange_invalid_response",
    }
}
