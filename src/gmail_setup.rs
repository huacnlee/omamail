use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read as _, Write as _},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use crate::platform::secrets::{Secret, SecretKey, SecretStore};
use crate::platform::{commands::SystemProcessRunner, secrets::SystemSecretStore};
use crate::providers::{
    gmail::GmailError,
    google_transport::{
        FixedGoogleClient, FixedGoogleEndpoint, GoogleProcessRunner, GoogleResolver,
        SystemGoogleResolver, read_client_file,
    },
};

// How long the loopback listener stays up waiting for Google to come back.
//
// This is a *person's* deadline, not a request's: they have to pick an account,
// read an unverified-app warning and tick three consent boxes. Two minutes was
// short enough that the listener was routinely gone by the time the browser
// redirected, and the user got "This site can't be reached" with no idea why.
const MAX_DEADLINE: Duration = Duration::from_secs(300);

// How long a connection that has already been accepted gets to deliver its
// request line, which is a different question from how long the person gets.
//
// A browser that has finished the TCP handshake writes its GET immediately.
// Anything else that reaches a loopback port — a speculative preconnect, a
// second socket the browser opened and did not use, a scan — sends nothing at
// all, and reading it used to block for whatever was left of `MAX_DEADLINE`.
// That read happens inside the host call the window is awaiting, so one silent
// socket left the setup page sitting on "Waiting for sign-in" for four minutes:
// no error, no message, and nothing to tell it apart from a sign-in the user
// had simply not finished yet. Bounding the read is what turns that into an
// answer.
const CALLBACK_READ_DEADLINE: Duration = Duration::from_secs(5);
const MAX_REQUEST_BYTES: usize = 16_384;
const INVALID_REQUEST: &str = r#"{"ok":false,"error":"invalid Gmail sign-in request"}"#;
// Google takes a full scope URL and refuses a short name with `invalid_scope`,
// so these are spelled out the way `providers/OAuth.js` spells them. `openid`
// and `email` are the two aliases Google does accept bare, and they are what
// returns the address the account is named after.
//
// `gmail.modify` is read plus label and trash changes — it deliberately cannot
// permanently delete. `gmail.send` is what reply and compose need.
// `calendar.events` reads calendars and creates events without broader account
// access.
pub const SCOPES: &str = concat!(
    "openid email",
    " https://www.googleapis.com/auth/gmail.modify",
    " https://www.googleapis.com/auth/gmail.send",
    " https://www.googleapis.com/auth/calendar.events",
);

// The name the refresh token is filed under, and deliberately *not* `SCOPES`.
//
// A grant is half of `SecretKey::gmail`, so it is the credential's stable
// identity: change the text and every existing entry is renamed out from under
// the next read. A scope string is a wire parameter and changes whenever
// Google's spelling does — the two happened to be the same words once, and
// widening `SCOPES` to the full URLs Google requires quietly filed new tokens
// under a key nothing looks in. The account was created and then had no
// credential.
//
// `app/main.js`'s `AUDITED_GOOGLE_GRANT` is the reading end of the same name;
// `tests/test_source.sh` fails when the two drift apart.
pub const GRANT: &str = "gmail.modify gmail.send calendar.events";

pub fn pkce_challenge(verifier: &str) -> Result<String, SetupError> {
    if !(43..=128).contains(&verifier.len())
        || !verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
    {
        return Err(SetupError::Invalid);
    }
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())))
}
pub fn validate_callback(path: &str, state: &str, expected: &str) -> Result<String, SetupError> {
    let url =
        url::Url::parse(&format!("http://127.0.0.1{path}")).map_err(|_| SetupError::Invalid)?;
    if url.path() != "/oauth2callback"
        || state != expected
        || !url
            .query_pairs()
            .any(|(key, value)| key == "state" && value == expected)
    {
        return Err(SetupError::Invalid);
    }
    url.query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .filter(|v| !v.is_empty())
        .ok_or(SetupError::Cancelled)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupError {
    Invalid,
    Expired,
    Cancelled,
    Failed,
    Unavailable,
    /// Google answered and the answer was not one this could use. Its own
    /// reason, because "sign-in failed" sends somebody to look at their
    /// consent screen for a fault that is on this side of the wire.
    Unreadable,
    /// Google was reached and said no. Almost always the client rather than
    /// the person: a secret that does not match the id, a redirect URI the
    /// project does not list, or a code already spent. Worth its own sentence
    /// because "sign-in failed" after a consent screen that plainly succeeded
    /// is the least useful thing this could say.
    Refused,
    /// Google was not reached at all.
    Unreachable,
}
impl SetupError {
    /// Every reason is a fixed string chosen here, never anything read off the
    /// wire. That is what lets `app/setup/adapters.js` carry one to a label
    /// without a redaction question: there is no request, reply or credential
    /// text in any of them.
    pub fn message(&self) -> &'static str {
        match self {
            Self::Invalid => "invalid Gmail sign-in request",
            Self::Expired => "Gmail sign-in timed out",
            Self::Cancelled => "Gmail sign-in was cancelled",
            Self::Failed => "Gmail sign-in failed",
            Self::Unavailable => "Gmail sign-in is unavailable",
            Self::Unreadable => "Google's reply could not be read",
            Self::Refused => {
                "Google refused the sign-in. Check the client secret and that the project lists this redirect URI"
            }
            Self::Unreachable => "Google could not be reached",
        }
    }
}

pub trait OAuthFlow: Send + Sync {
    fn begin(&self, scopes: &str, deadline: Duration) -> Result<FlowBegin, SetupError>;
    fn poll(&self, flow_id: &str) -> Result<FlowPoll, SetupError>;
    fn cancel(&self, flow_id: &str);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowBegin {
    pub flow_id: String,
    pub url: String,
    verifier: String,
    state: String,
    redirect_uri: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlowPoll {
    Pending,
    Callback { state: String, code: String },
}

pub trait RandomSource: Send + Sync {
    fn fill(&self, bytes: &mut [u8]) -> Result<(), SetupError>;
}

pub struct SystemRandom;
impl RandomSource for SystemRandom {
    fn fill(&self, bytes: &mut [u8]) -> Result<(), SetupError> {
        getrandom::fill(bytes).map_err(|_| SetupError::Unavailable)
    }
}

struct ListenerState {
    listener: TcpListener,
    state: String,
    deadline: Instant,
}
pub struct LoopbackOAuthFlow<R> {
    client_id: String,
    random: R,
    listeners: Mutex<HashMap<String, ListenerState>>,
}
impl<R> LoopbackOAuthFlow<R> {
    pub fn new(client_id: impl Into<String>, random: R) -> Self {
        Self {
            client_id: client_id.into(),
            random,
            listeners: Mutex::new(HashMap::new()),
        }
    }
}
impl<R: RandomSource> OAuthFlow for LoopbackOAuthFlow<R> {
    fn begin(&self, scopes: &str, deadline: Duration) -> Result<FlowBegin, SetupError> {
        if !valid_client_id(&self.client_id)
            || deadline.is_zero()
            || deadline > MAX_DEADLINE
            || scopes != SCOPES
        {
            return Err(SetupError::Invalid);
        }
        let mut entropy = [0_u8; 96];
        self.random.fill(&mut entropy)?;
        let verifier = URL_SAFE_NO_PAD.encode(&entropy[..48]);
        let state = URL_SAFE_NO_PAD.encode(&entropy[48..72]);
        let flow_id = URL_SAFE_NO_PAD.encode(&entropy[72..]);
        let challenge = pkce_challenge(&verifier)?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| SetupError::Unavailable)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| SetupError::Unavailable)?;
        let port = listener
            .local_addr()
            .map_err(|_| SetupError::Unavailable)?
            .port();
        let redirect = format!("http://127.0.0.1:{port}/oauth2callback");
        let mut url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
            .map_err(|_| SetupError::Failed)?;
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("response_type", "code")
            .append_pair("scope", scopes)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("access_type", "offline")
            .append_pair("include_granted_scopes", "true")
            .append_pair("prompt", "consent");
        self.listeners
            .lock()
            .map_err(|_| SetupError::Failed)?
            .insert(
                flow_id.clone(),
                ListenerState {
                    listener,
                    state: state.clone(),
                    deadline: Instant::now() + deadline,
                },
            );
        Ok(FlowBegin {
            flow_id,
            url: url.into(),
            verifier,
            state,
            redirect_uri: redirect,
        })
    }
    fn poll(&self, flow_id: &str) -> Result<FlowPoll, SetupError> {
        let (mut stream, state, remaining) = {
            let mut listeners = self.listeners.lock().map_err(|_| SetupError::Failed)?;
            let entry = listeners.get(flow_id).ok_or(SetupError::Invalid)?;
            if Instant::now() >= entry.deadline {
                listeners.remove(flow_id);
                return Err(SetupError::Expired);
            }
            let (stream, _) = match entry.listener.accept() {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    return Ok(FlowPoll::Pending);
                }
                Err(_) => {
                    listeners.remove(flow_id);
                    return Err(SetupError::Failed);
                }
            };
            let state = entry.state.clone();
            let remaining = entry.deadline.saturating_duration_since(Instant::now());
            listeners.remove(flow_id);
            (stream, state, remaining)
        };
        parse_callback_stream(&mut stream, &state, remaining.min(CALLBACK_READ_DEADLINE))
            .map(|code| FlowPoll::Callback { state, code })
    }
    fn cancel(&self, flow_id: &str) {
        if let Ok(mut values) = self.listeners.lock() {
            values.remove(flow_id);
        }
    }
}

fn parse_callback_stream(
    stream: &mut TcpStream,
    expected_state: &str,
    deadline: Duration,
) -> Result<String, SetupError> {
    stream
        .set_read_timeout(Some(deadline))
        .map_err(|_| SetupError::Failed)?;
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 1024];
    while bytes.len() <= 8192 && !bytes.windows(4).any(|v| v == b"\r\n\r\n") {
        let count = stream.read(&mut chunk).map_err(|_| SetupError::Invalid)?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() > 8192 || !bytes.windows(4).any(|v| v == b"\r\n\r\n") {
        return Err(SetupError::Invalid);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| SetupError::Invalid)?;
    let line = text.split("\r\n").next().ok_or(SetupError::Invalid)?;
    let target = line
        .strip_prefix("GET ")
        .and_then(|v| v.strip_suffix(" HTTP/1.1"))
        .ok_or(SetupError::Invalid)?;
    let outcome = validate_callback(target, expected_state, expected_state);
    // The browser is the last thing the user is looking at, and "OK" on a white
    // page tells them nothing about whether to go back. This is the page
    // `providers/OAuth.js` serves, in the palette's own fallback colours: the
    // host has no theme to read, and a page that guessed one would be worse
    // than one that is deliberately plain.
    let _ = stream.write_all(callback_page(outcome.is_err()).as_bytes());
    outcome
}

/// The page the loopback callback answers with. Mirrors `OAuth.themedPage`.
fn callback_page(failed: bool) -> String {
    const FOREGROUND: &str = "#DEDEDE";
    const BACKGROUND: &str = "#131313";
    let mark = if failed { "#FF5257" } else { "#077CFD" };
    // An open envelope for success, a sealed one for failure — the same two
    // paths the QML draws, so the mark says which happened before the words do.
    let fold = if failed {
        "M1 3.5 L8 8.5 L15 3.5"
    } else {
        "M1 3.5 L8 0.8 L15 3.5"
    };
    let (title, heading, body) = if failed {
        (
            "Sign-in failed",
            "Sign-in did not finish",
            "<p>Google did not complete the authorization.</p>\
             <p>Close this tab and try again from the Omamail window.</p>"
                .to_owned(),
        )
    } else {
        (
            "Omamail",
            "Mailbox connected",
            "<p>Omamail can read this mailbox now. Switch back to the window \u{2014} \
             your mail is already loading.</p>\
             <p>This tab closes itself. If it stays open, it is safe to close.</p>\
             <script>setTimeout(function(){window.close()},600)</script>"
                .to_owned(),
        )
    };
    let page = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>{title}</title><style>\
         *{{box-sizing:border-box}}html,body{{height:100%}}\
         body{{margin:0;background:{BACKGROUND};color:{FOREGROUND};\
         font-family:\"CaskaydiaMono Nerd Font\",\"JetBrains Mono\",ui-monospace,monospace;\
         font-size:13px;line-height:1.7;display:flex;align-items:center;\
         justify-content:center;padding:24px}}\
         main{{width:100%;max-width:420px;border:1px solid {FOREGROUND}66;padding:28px 30px}}\
         svg{{display:block;margin-bottom:18px}}\
         h1{{margin:0 0 10px;font-size:16px;font-weight:700;letter-spacing:-0.01em}}\
         p{{margin:0;color:{FOREGROUND}a6}}\
         p+p{{margin-top:14px;font-size:11px;color:{FOREGROUND}70}}\
         </style></head><body><main>\
         <svg width=\"26\" height=\"26\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"{mark}\" \
         stroke-width=\"1.3\" stroke-linejoin=\"round\">\
         <rect x=\"1\" y=\"3.5\" width=\"14\" height=\"9\"/><path d=\"{fold}\"/></svg>\
         <h1>{heading}</h1>{body}</main></body></html>"
    );
    let status = if failed { "400 Bad Request" } else { "200 OK" };
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Cache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
        // A byte count, not a character count: the em dash is one char and
        // three bytes, and a short Content-Length truncates the page.
        page.len()
    )
}
pub trait OAuthCommitter: Send + Sync {
    fn commit(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
        deadline: Duration,
    ) -> Result<SetupAccount, SetupError>;
    fn revoke_local(&self, _account_id: &str, _client_id: &str) -> Result<(), SetupError> {
        Err(SetupError::Unavailable)
    }
}

pub struct VerifiedGrant {
    email: String,
    refresh_token: Secret,
}
impl VerifiedGrant {
    pub fn new(email: impl Into<String>, refresh_token: Secret) -> Result<Self, SetupError> {
        let email = email.into().to_ascii_lowercase();
        if !valid_email(&email)
            || refresh_token.expose().is_empty()
            || refresh_token.expose().chars().any(char::is_control)
        {
            return Err(SetupError::Failed);
        }
        Ok(Self {
            email,
            refresh_token,
        })
    }
}
impl fmt::Debug for VerifiedGrant {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedGrant")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupAccount {
    pub id: String,
    pub email: String,
    pub provider: &'static str,
    pub client_id: String,
}

pub trait OAuthTokenExchanger: Send + Sync {
    fn exchange(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
        deadline: Duration,
    ) -> Result<VerifiedGrant, SetupError>;
}

pub struct GoogleOAuthExchanger<R, D> {
    client_id: String,
    client_secret: Secret,
    curl: PathBuf,
    runner: R,
    resolver: D,
}

impl<R, D> GoogleOAuthExchanger<R, D> {
    pub fn new(
        client_id: impl Into<String>,
        client_secret: Secret,
        curl: PathBuf,
        runner: R,
        resolver: D,
    ) -> Self {
        Self {
            client_id: client_id.into(),
            client_secret,
            curl,
            runner,
            resolver,
        }
    }
}

impl<R, D> fmt::Debug for GoogleOAuthExchanger<R, D> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GoogleOAuthExchanger")
            .finish_non_exhaustive()
    }
}

// Read for the fields this needs and silent about the rest, the way
// `providers/OAuth.js` reads the same two replies.
//
// Neither shape is ours and neither is frozen. `deny_unknown_fields` here made
// every field Google has ever added a total sign-in failure: a project still in
// Testing — which is every project until somebody presses "Publish app" — gets
// `refresh_token_expires_in` beside the pair, and asking for `openid` gets an
// `id_token`. Refusing the whole reply over a field nothing reads is refusing
// the account. What the fields below *contain* is still checked, which is the
// part that is actually this side's business.
#[derive(Deserialize)]
struct AuthorizationTokenReply {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    token_type: String,
    scope: String,
    #[serde(default)]
    id_token: Option<String>,
}

// The OIDC claims for `profile` and `email`. Google adds to this set too, and a
// claim nobody reads must not cost the mailbox.
#[derive(Deserialize)]
struct UserInfoReply {
    sub: String,
    email: String,
    email_verified: bool,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    given_name: Option<String>,
    #[serde(default)]
    family_name: Option<String>,
    #[serde(default)]
    picture: Option<String>,
    #[serde(default)]
    locale: Option<String>,
    #[serde(default)]
    hd: Option<String>,
}

impl<R: GoogleProcessRunner, D: GoogleResolver> OAuthTokenExchanger for GoogleOAuthExchanger<R, D> {
    fn exchange(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
        deadline: Duration,
    ) -> Result<VerifiedGrant, SetupError> {
        if deadline.is_zero()
            || deadline > MAX_DEADLINE
            || !valid_client_id(&self.client_id)
            || !valid_bounded_secret(self.client_secret.expose(), 4096)
            || !valid_bounded_secret(code, 8192)
            || pkce_challenge(verifier).is_err()
            || !valid_loopback_redirect(redirect_uri)
        {
            return Err(SetupError::Invalid);
        }
        let started = Instant::now();
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", &self.client_id)
            .append_pair("client_secret", self.client_secret.expose())
            .append_pair("code", code)
            .append_pair("code_verifier", verifier)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("grant_type", "authorization_code")
            .finish();
        let transport = FixedGoogleClient::new(self.curl.clone(), &self.runner, &self.resolver);
        let body = transport
            .post_form(
                FixedGoogleEndpoint::OAuthToken,
                Secret::new(form),
                remaining(started, deadline)?,
            )
            .map_err(|error| map_google_setup_error("token", error))?;
        let token: AuthorizationTokenReply =
            serde_json::from_slice(&body).map_err(|_| SetupError::Unreadable)?;
        if token.token_type != "Bearer"
            || token.expires_in == 0
            || !valid_bounded_secret(&token.access_token, 16_384)
            || !valid_bounded_secret(&token.refresh_token, 16_384)
            || token.scope.len() > 4096
            || token.scope.chars().any(char::is_control)
            || token
                .id_token
                .as_deref()
                .is_some_and(|value| !valid_bounded_secret(value, 32_768))
        {
            return Err(SetupError::Unreadable);
        }
        let body = transport
            .get_bearer(
                FixedGoogleEndpoint::OidcUserInfo,
                Secret::new(token.access_token),
                remaining(started, deadline)?,
            )
            .map_err(|error| map_google_setup_error("userinfo", error))?;
        let profile: UserInfoReply =
            serde_json::from_slice(&body).map_err(|_| SetupError::Unreadable)?;
        if !profile.email_verified
            || !valid_bounded_secret(&profile.sub, 1024)
            || [
                &profile.name,
                &profile.given_name,
                &profile.family_name,
                &profile.picture,
                &profile.locale,
                &profile.hd,
            ]
            .into_iter()
            .flatten()
            .any(|value| value.len() > 4096 || value.chars().any(char::is_control))
        {
            return Err(SetupError::Unreadable);
        }
        VerifiedGrant::new(profile.email, Secret::new(token.refresh_token))
    }
}

fn valid_bounded_secret(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn valid_loopback_redirect(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.path() == "/oauth2callback"
            && url.query().is_none()
            && url.fragment().is_none()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

/// Which sentence a failed call to Google earns.
///
/// Collapsing all of these into `Failed` was a real cost: "Gmail sign-in
/// failed", arriving straight after a consent screen the person watched
/// succeed, points them at the one part of the flow that worked. The classes
/// are already fixed and carry no wire text, so each can keep its own reason.
///
/// The line on stderr is the host's own record, not the window's. It names the
/// class and the leg it came from and nothing else — `GmailError` is a
/// fieldless enum, so there is no request, reply, token or address in it to
/// leak. It is what turns "it just failed" into something answerable without
/// asking anybody to hand over a log full of their own mail.
fn map_google_setup_error(leg: &'static str, error: GmailError) -> SetupError {
    eprintln!("Gmail setup: the {leg} call to Google returned {error:?}");
    match error {
        GmailError::DeadlineExceeded => SetupError::Expired,
        GmailError::PlatformUnavailable => SetupError::Unavailable,
        // Google answered, with a status outside 200..300. At this point in the
        // flow that is the client's own configuration far more often than
        // anything the person did — a secret that does not match the id, or a
        // redirect URI the project does not list.
        GmailError::AuthRequired => SetupError::Refused,
        // Our own refusal before anything left the machine: a malformed client
        // file, or an endpoint that resolved somewhere it is not allowed to.
        // Nothing about Google to report, so it keeps the general reason.
        GmailError::InvalidRequest => SetupError::Failed,
        GmailError::RemoteFailure => SetupError::Unreachable,
        GmailError::InvalidResponse | GmailError::OutputTooLarge => SetupError::Unreadable,
        GmailError::SecretUnavailable => SetupError::Unavailable,
    }
}

pub struct ProductionOAuthCommitter<E, S> {
    client_path: PathBuf,
    client_id: String,
    client_secret: Secret,
    grant: String,
    secrets: S,
    exchanger: E,
}

impl<E, S> fmt::Debug for ProductionOAuthCommitter<E, S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProductionOAuthCommitter")
            .finish_non_exhaustive()
    }
}

impl<E, S> ProductionOAuthCommitter<E, S> {
    pub fn new(
        client_path: impl Into<PathBuf>,
        client_id: impl Into<String>,
        client_secret: Secret,
        grant: impl Into<String>,
        secrets: S,
        exchanger: E,
    ) -> Self {
        Self {
            client_path: client_path.into(),
            client_id: client_id.into(),
            client_secret,
            grant: grant.into(),
            secrets,
            exchanger,
        }
    }
}

impl<E, S: SecretStore> ProductionOAuthCommitter<E, S> {
    pub fn revoke_local(&self, account_id: &str, client_id: &str) -> Result<(), SetupError> {
        if client_id != self.client_id || !valid_client_id(client_id) {
            return Err(SetupError::Invalid);
        }
        let email = account_id.to_ascii_lowercase();
        if !valid_email(&email) {
            return Err(SetupError::Invalid);
        }
        let key =
            SecretKey::gmail(client_id, &email, &self.grant).map_err(|_| SetupError::Invalid)?;
        self.secrets.delete(&key).map_err(|_| SetupError::Failed)
    }
}

impl<E: OAuthTokenExchanger, S: SecretStore> OAuthCommitter for ProductionOAuthCommitter<E, S> {
    fn commit(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
        deadline: Duration,
    ) -> Result<SetupAccount, SetupError> {
        if code.is_empty()
            || verifier.is_empty()
            || deadline.is_zero()
            || deadline > MAX_DEADLINE
            || !valid_client_id(&self.client_id)
            || self.client_secret.expose().is_empty()
            || self.client_secret.expose().chars().any(char::is_control)
            || self.grant.is_empty()
            || self.grant.len() > 4096
            || self.grant.chars().any(char::is_control)
        {
            return Err(SetupError::Invalid);
        }
        let started = Instant::now();
        let grant =
            self.exchanger
                .exchange(code, verifier, redirect_uri, remaining(started, deadline)?)?;
        let key = SecretKey::gmail(&self.client_id, &grant.email, &self.grant)
            .map_err(|_| SetupError::Invalid)?;
        let old_file = snapshot_file(&self.client_path)?;
        let old_secret = self.secrets.get(&key).map_err(|_| SetupError::Failed)?;
        let body = serde_json::json!({
            "clientId": self.client_id,
            "clientSecret": self.client_secret.expose(),
        })
        .to_string();
        write_atomic(&self.client_path, body.as_bytes(), 0o600)?;
        if self.secrets.set(&key, grant.refresh_token).is_err() {
            restore_file(&self.client_path, old_file.as_ref());
            restore_secret(&self.secrets, &key, old_secret);
            return Err(SetupError::Failed);
        }
        Ok(SetupAccount {
            id: grant.email.clone(),
            email: grant.email,
            provider: "gmail",
            client_id: self.client_id.clone(),
        })
    }

    fn revoke_local(&self, account_id: &str, client_id: &str) -> Result<(), SetupError> {
        Self::revoke_local(self, account_id, client_id)
    }
}

fn remaining(started: Instant, deadline: Duration) -> Result<Duration, SetupError> {
    deadline
        .checked_sub(started.elapsed())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(SetupError::Expired)
}

fn valid_email(value: &str) -> bool {
    value.len() <= 320
        && !value.chars().any(char::is_control)
        && value.split_once('@').is_some_and(|(local, host)| {
            !local.is_empty() && host.contains('.') && !host.ends_with('.')
        })
}

fn valid_client_id(value: &str) -> bool {
    value.len() <= 2048
        && value.ends_with(".apps.googleusercontent.com")
        && !value.chars().any(char::is_control)
}

struct FileSnapshot {
    bytes: Vec<u8>,
    mode: u32,
}

fn snapshot_file(path: &Path) -> Result<Option<FileSnapshot>, SetupError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(SetupError::Failed),
    };
    let metadata = file.metadata().map_err(|_| SetupError::Failed)?;
    if !metadata.file_type().is_file() || metadata.len() > 65_536 {
        return Err(SetupError::Failed);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| SetupError::Failed)?;
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o777
    };
    #[cfg(not(unix))]
    let mode = 0;
    Ok(Some(FileSnapshot { bytes, mode }))
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<(), SetupError> {
    let parent = path.parent().ok_or(SetupError::Failed)?;
    fs::create_dir_all(parent).map_err(|_| SetupError::Failed)?;
    // The directory holds a client secret, so it is the user's alone. Without
    // this a fresh `~/.config/omamail` inherits the umask and the 0600 on the
    // file is the only thing standing.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| SetupError::Failed)?;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(SetupError::Failed)?;
    let temporary = parent.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options
                .mode(mode)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let mut file = options.open(&temporary).map_err(|_| SetupError::Failed)?;
        let metadata = file.metadata().map_err(|_| SetupError::Failed)?;
        if !metadata.file_type().is_file() {
            return Err(SetupError::Failed);
        }
        file.write_all(bytes).map_err(|_| SetupError::Failed)?;
        file.sync_all().map_err(|_| SetupError::Failed)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            file.set_permissions(fs::Permissions::from_mode(mode))
                .map_err(|_| SetupError::Failed)?;
        }
        drop(file);
        fs::rename(&temporary, path).map_err(|_| SetupError::Failed)?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| SetupError::Failed)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn restore_file(path: &Path, snapshot: Option<&FileSnapshot>) {
    match snapshot {
        Some(snapshot) => {
            let _ = write_atomic(path, &snapshot.bytes, snapshot.mode);
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

fn restore_secret(store: &dyn SecretStore, key: &SecretKey, old: Option<Secret>) {
    match old {
        Some(secret) => {
            let _ = store.set(key, secret);
        }
        None => {
            let _ = store.delete(key);
        }
    }
}

pub struct GmailSetup<F, C> {
    flow: F,
    committer: C,
    pending: Mutex<HashMap<String, Pending>>,
}
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    deny_unknown_fields,
    rename_all_fields = "camelCase"
)]
enum SetupRequest {
    #[serde(rename = "gmail.oauth.begin")]
    Begin { deadline_ms: u64 },
    #[serde(rename = "gmail.oauth.cancel")]
    Cancel { flow_id: String },
    #[serde(rename = "gmail.oauth.status")]
    Status { flow_id: String },
    #[serde(rename = "gmail.oauth.revokeLocal")]
    RevokeLocal {
        account_id: String,
        client_id: String,
    },
}
pub fn dispatch_json<F: OAuthFlow, C: OAuthCommitter>(
    setup: &GmailSetup<F, C>,
    input: &str,
) -> String {
    if input.len() > MAX_REQUEST_BYTES {
        return INVALID_REQUEST.into();
    }
    let request: SetupRequest = match serde_json::from_str(input) {
        Ok(v) => v,
        Err(_) => return INVALID_REQUEST.into(),
    };
    match request {
        SetupRequest::Begin { deadline_ms } => {
            match setup.begin(Duration::from_millis(deadline_ms)) {
                Ok(begin) => serde_json::json!({"ok":true,"flowId":begin.flow_id,"url":begin.url})
                    .to_string(),
                Err(e) => serde_json::json!({"ok":false,"error":e.message()}).to_string(),
            }
        }
        SetupRequest::Cancel { flow_id } => {
            setup.cancel(&flow_id);
            r#"{"ok":true}"#.into()
        }
        SetupRequest::Status { flow_id } => match setup.status(&flow_id) {
            Ok(SetupStatus::Pending) => r#"{"ok":true,"status":"pending"}"#.into(),
            Ok(SetupStatus::Completed(account)) => {
                serde_json::json!({"ok":true,"status":"completed","account":account}).to_string()
            }
            Err(error) => {
                serde_json::json!({"ok":false,"status":"error","error":error.message()}).to_string()
            }
        },
        SetupRequest::RevokeLocal {
            account_id,
            client_id,
        } => match setup.revoke_local(&account_id, &client_id) {
            Ok(()) => r#"{"ok":true,"data":{"revoked":true,"outcome":"deleted"}}"#.into(),
            Err(error) => serde_json::json!({
                "ok":false,
                "credentialOutcome": if error == SetupError::Invalid { "beforeEffect" } else { "uncertain" },
                "error":error.message()
            }).to_string(),
        },
    }
}

pub fn dispatch_unavailable(input: &str) -> String {
    if input.len() > MAX_REQUEST_BYTES || serde_json::from_str::<SetupRequest>(input).is_err() {
        INVALID_REQUEST.into()
    } else {
        serde_json::json!({"ok":false,"error":SetupError::Unavailable.message()}).to_string()
    }
}

type ProductionSetup = GmailSetup<
    LoopbackOAuthFlow<SystemRandom>,
    ProductionOAuthCommitter<
        GoogleOAuthExchanger<SystemProcessRunner, SystemGoogleResolver>,
        SystemSecretStore,
    >,
>;

// The two requests that own the client file itself. They are answered before a
// setup is resolved, because the whole point of `saveClient` is that there is
// no client yet — a request routed through `SetupRequest` would be answered
// "Gmail sign-in is unavailable" forever.
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    deny_unknown_fields,
    rename_all_fields = "camelCase"
)]
enum ClientRequest {
    #[serde(rename = "gmail.oauth.saveClient")]
    Save {
        client_id: String,
        // Google issues desktop clients with and without a secret, so an empty
        // one is a client that has none rather than a malformed request.
        #[serde(default)]
        client_secret: String,
    },
    #[serde(rename = "gmail.oauth.client")]
    Describe {
        /// The setup page asks for the secret so its field can show what is
        /// stored, the way `SetupPage.qml`'s `syncFromStore` does: a box that
        /// cannot show the current value is a box that can only overwrite it,
        /// and there would be no way to read a client back off this machine.
        /// The settings page does not ask, so it never holds one.
        #[serde(default)]
        include_secret: bool,
    },
}

struct CurrentClient {
    client_id: String,
    secret_digest: [u8; 32],
    setup: Arc<ProductionSetup>,
}

impl CurrentClient {
    fn matches(&self, client_id: &str, secret_digest: &[u8; 32]) -> bool {
        self.client_id == client_id && &self.secret_digest == secret_digest
    }
}

/// The client file is read per dispatch rather than once at install, so a
/// client saved through `gmail.oauth.saveClient` signs the next account in
/// without a restart. The setup built from it is kept for as long as the file
/// names the same client, because a flow's loopback listener and its PKCE
/// verifier live inside it and a rebuilt one would forget both mid-sign-in.
pub struct ProductionGmailSetup {
    client_path: PathBuf,
    current: Mutex<Option<CurrentClient>>,
}

impl fmt::Debug for ProductionGmailSetup {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProductionGmailSetup")
            .field("client_path", &self.client_path)
            .finish_non_exhaustive()
    }
}

impl ProductionGmailSetup {
    pub fn dispatch(&self, input: &str) -> String {
        if input.len() <= MAX_REQUEST_BYTES {
            match serde_json::from_str::<ClientRequest>(input) {
                Ok(ClientRequest::Save {
                    client_id,
                    client_secret,
                }) => return self.save_client(&client_id, &Secret::new(client_secret)),
                Ok(ClientRequest::Describe { include_secret }) => {
                    return self.describe_client(include_secret);
                }
                Err(_) => {}
            }
        }
        match self.resolve() {
            Some(setup) => dispatch_json(setup.as_ref(), input),
            None => dispatch_unavailable(input),
        }
    }

    fn save_client(&self, client_id: &str, client_secret: &Secret) -> String {
        match self.store_client(client_id, client_secret) {
            Ok(()) => r#"{"ok":true}"#.into(),
            Err(message) => serde_json::json!({ "ok": false, "error": message }).to_string(),
        }
    }

    fn store_client(&self, client_id: &str, client_secret: &Secret) -> Result<(), &'static str> {
        if !valid_client_id(client_id) {
            return Err("That is not a Google client ID. It ends in .apps.googleusercontent.com");
        }
        let secret = client_secret.expose();
        if !secret.is_empty() && !valid_bounded_secret(secret, 4096) {
            return Err("That client secret is too long, or has a line break in it");
        }
        // Opens the existing file with O_NOFOLLOW, so a symlink left at
        // oauth-client.json is refused rather than written through.
        snapshot_file(&self.client_path).map_err(
            |_| "oauth-client.json is not a plain file. Remove it and save the client again",
        )?;
        // An empty box means the secret was cleared, and clearing it removes
        // it — the same as `SetupPage.qml`'s save. That is only safe because
        // the field is populated from the stored client when the page opens,
        // so an empty box is a decision rather than an accident.
        //
        // A client with no secret is stored with no `clientSecret` at all: an
        // empty one would be a secret sent to Google's token endpoint.
        let body = Secret::new(
            if secret.is_empty() {
                serde_json::json!({ "clientId": client_id })
            } else {
                serde_json::json!({ "clientId": client_id, "clientSecret": secret })
            }
            .to_string(),
        );
        write_atomic(&self.client_path, body.expose().as_bytes(), 0o600)
            .map_err(|_| "The OAuth client could not be written to oauth-client.json")
    }

    fn describe_client(&self, include_secret: bool) -> String {
        match read_client_file(&self.client_path) {
            Ok(client) if valid_client_id(client.client_id()) => {
                let mut data = serde_json::json!({
                    "present": true,
                    "clientId": client.client_id(),
                    "description": client_description(client.client_id()),
                });
                if include_secret {
                    // Held in a `Secret` right up to the reply so it is zeroed
                    // on the way out, and only ever placed here when the caller
                    // asked. It never reaches a log or a label: the field that
                    // receives it is masked until the reader presses the eye.
                    let secret = client.client_secret();
                    data["clientSecret"] = serde_json::Value::String(secret.expose().to_owned());
                }
                serde_json::json!({ "ok": true, "data": data }).to_string()
            }
            _ => r#"{"ok":true,"data":{"present":false,"clientId":"","description":""}}"#.into(),
        }
    }

    fn resolve(&self) -> Option<Arc<ProductionSetup>> {
        let client = read_client_file(&self.client_path).ok()?;
        if !valid_client_id(client.client_id()) {
            return None;
        }
        let client_id = client.client_id().to_owned();
        let client_secret = client.client_secret();
        let secret_digest: [u8; 32] = Sha256::digest(client_secret.expose().as_bytes()).into();
        let mut current = self.current.lock().ok()?;
        if let Some(existing) = current
            .as_ref()
            .filter(|existing| existing.matches(&client_id, &secret_digest))
        {
            return Some(Arc::clone(&existing.setup));
        }
        let setup = Arc::new(build_setup(
            self.client_path.clone(),
            client_id.clone(),
            client_secret,
        ));
        *current = Some(CurrentClient {
            client_id,
            secret_digest,
            setup: Arc::clone(&setup),
        });
        Some(setup)
    }
}

// What the settings page shows in place of "No client yet". It is the QML's
// `Credentials.describe`: the client id's own head, and never the secret.
fn client_description(client_id: &str) -> String {
    match client_id.find('-') {
        Some(index) => client_id[..index].to_owned(),
        None => client_id.chars().take(8).collect(),
    }
}

fn build_setup(client_path: PathBuf, client_id: String, client_secret: Secret) -> ProductionSetup {
    let flow = LoopbackOAuthFlow::new(client_id.clone(), SystemRandom);
    let exchanger = GoogleOAuthExchanger::new(
        client_id.clone(),
        client_secret.clone(),
        PathBuf::from("curl"),
        SystemProcessRunner,
        SystemGoogleResolver,
    );
    let committer = ProductionOAuthCommitter::new(
        client_path,
        client_id,
        client_secret,
        // The keyring's name for this credential, not the scopes it was asked
        // for. See `GRANT`.
        GRANT,
        SystemSecretStore::default(),
        exchanger,
    );
    GmailSetup::new(flow, committer)
}

/// Takes the resolved client path rather than resolving one, so where the file
/// lives is a decision made once, at the host boundary, and a test can point
/// this at its own directory instead of the user's.
pub fn production(client_path: PathBuf) -> ProductionGmailSetup {
    ProductionGmailSetup {
        client_path,
        current: Mutex::new(None),
    }
}
struct Pending {
    state: String,
    verifier: String,
    redirect_uri: String,
    deadline: Instant,
    polling: bool,
}
impl<F: OAuthFlow, C: OAuthCommitter> GmailSetup<F, C> {
    pub fn new(flow: F, committer: C) -> Self {
        Self {
            flow,
            committer,
            pending: Mutex::new(HashMap::new()),
        }
    }
    pub fn begin(&self, deadline: Duration) -> Result<FlowBegin, SetupError> {
        if deadline.is_zero() || deadline > MAX_DEADLINE {
            return Err(SetupError::Invalid);
        }
        let begin = self.flow.begin(SCOPES, deadline)?;
        self.pending.lock().map_err(|_| SetupError::Failed)?.insert(
            begin.flow_id.clone(),
            Pending {
                state: begin.state.clone(),
                verifier: begin.verifier.clone(),
                redirect_uri: begin.redirect_uri.clone(),
                deadline: Instant::now() + deadline,
                polling: false,
            },
        );
        Ok(begin)
    }
    pub fn cancel(&self, flow_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(flow_id);
        }
        self.flow.cancel(flow_id);
    }
    pub fn revoke_local(&self, account_id: &str, client_id: &str) -> Result<(), SetupError> {
        self.committer.revoke_local(account_id, client_id)
    }
    pub fn status(&self, flow_id: &str) -> Result<SetupStatus, SetupError> {
        let remaining = {
            let mut values = self.pending.lock().map_err(|_| SetupError::Failed)?;
            let pending = values.get_mut(flow_id).ok_or(SetupError::Invalid)?;
            if pending.polling {
                return Ok(SetupStatus::Pending);
            }
            pending.polling = true;
            pending.deadline.checked_duration_since(Instant::now())
        };
        let Some(remaining) = remaining else {
            self.pending
                .lock()
                .map_err(|_| SetupError::Failed)?
                .remove(flow_id);
            self.flow.cancel(flow_id);
            return Err(SetupError::Expired);
        };
        let poll = match self.flow.poll(flow_id) {
            Ok(poll) => poll,
            Err(error) => {
                self.pending
                    .lock()
                    .map_err(|_| SetupError::Failed)?
                    .remove(flow_id);
                return Err(error);
            }
        };
        match poll {
            FlowPoll::Pending => {
                if let Some(pending) = self
                    .pending
                    .lock()
                    .map_err(|_| SetupError::Failed)?
                    .get_mut(flow_id)
                {
                    pending.polling = false;
                }
                Ok(SetupStatus::Pending)
            }
            FlowPoll::Callback { state, code } => {
                let pending = self
                    .pending
                    .lock()
                    .map_err(|_| SetupError::Failed)?
                    .remove(flow_id)
                    .ok_or(SetupError::Invalid)?;
                if state != pending.state || code.is_empty() {
                    return Err(SetupError::Invalid);
                }
                self.committer
                    .commit(&code, &pending.verifier, &pending.redirect_uri, remaining)
                    .map(SetupStatus::Completed)
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SetupStatus {
    Pending,
    Completed(SetupAccount),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Flow(AtomicBool);
    impl OAuthFlow for Flow {
        fn begin(&self, scopes: &str, _: Duration) -> Result<FlowBegin, SetupError> {
            // The full URLs Google requires; a short name is refused with
            // `invalid_scope` and no account can be created.
            assert_eq!(scopes, SCOPES);
            assert!(scopes.contains("https://www.googleapis.com/auth/gmail.modify"));
            Ok(FlowBegin {
                flow_id: "flow-id".into(),
                url: "https://accounts.example/".into(),
                verifier: "verifier".into(),
                state: "host-state".into(),
                redirect_uri: "http://127.0.0.1:4321/oauth2callback".into(),
            })
        }
        fn poll(&self, _: &str) -> Result<FlowPoll, SetupError> {
            Ok(FlowPoll::Callback {
                state: "host-state".into(),
                code: "code".into(),
            })
        }
        fn cancel(&self, _: &str) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    struct Commit;
    impl OAuthCommitter for Commit {
        fn commit(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: Duration,
        ) -> Result<SetupAccount, SetupError> {
            Err(SetupError::Failed)
        }
    }
    #[test]
    fn fixed_scopes_state_and_failed_commit_roll_back() {
        let flow = Flow(AtomicBool::new(false));
        let commit = Commit;
        let setup = GmailSetup::new(flow, commit);
        assert!(setup.begin(Duration::from_secs(1)).is_ok());
        assert_eq!(setup.status("flow-id"), Err(SetupError::Failed));
    }
    #[test]
    fn a_client_is_described_by_its_own_head_the_way_the_qml_describes_it() {
        assert_eq!(
            client_description("123456-abc.apps.googleusercontent.com"),
            "123456"
        );
        assert_eq!(
            client_description("abcdefghij.apps.googleusercontent.com"),
            "abcdefgh"
        );
    }
    #[test]
    fn dispatcher_rejects_unknown_and_invalid_deadlines_without_echoing_input() {
        let setup = GmailSetup::new(Flow(AtomicBool::new(false)), Commit);
        for input in [
            r#"{"operation":"gmail.oauth.begin","deadlineMs":0}"#,
            r#"{"operation":"gmail.oauth.begin","state":"0123456789abcdef","deadlineMs":120001,"secret":"nope"}"#,
            r#"{"operation":"omamail-effects","secret":"nope"}"#,
        ] {
            let reply = dispatch_json(&setup, input);
            assert_eq!(
                reply,
                r#"{"ok":false,"error":"invalid Gmail sign-in request"}"#
            );
            assert!(!reply.contains("nope"));
        }
    }
}
