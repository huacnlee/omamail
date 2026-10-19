//! Device-code sign-in: `m365.signInBegin`, `m365.signInPoll` and `m365.signOut`.
//!
//! One code asks Microsoft only for Graph scopes (`auth::m365::SCOPE`), so one entry of the code at
//! microsoft.com/devicelogin grants mail and calendar together. Every request to the login host goes
//! through `auth::m365`; nothing a token or a device code is leaves Rust.
//!
//! - `signInBegin {accountId, address, clientId}` asks the device-code endpoint of the address's
//!   organization (see `auth::m365::login`) for a code and keeps the `device_code` here, in a table of
//!   at most four requests, each until Microsoft's own expiry (at most 30 minutes). What goes back is
//!   a unique `requestId` (a handle, not a secret), the `userCode` to type and the page to type it at.
//! - `signInPoll {requestId}` makes one token request, and only when the interval Microsoft gave has
//!   passed since the last: a call sooner is answered `pending` without contacting Microsoft, so any
//!   rhythm of the caller is safe. There is no background task; an abandoned request just lapses. The
//!   exchange runs on a task of its own: a caller that goes away cannot stop it between Microsoft
//!   handing over a refresh token and the keyring saving it. A poll waits for it at most `POLL_WAIT`
//!   (a keyring may be waiting for somebody to unlock it) and then answers `pending` with the warning
//!   `m365_exchange_running`: the exchange goes on, and a later poll of the same request has its
//!   outcome. That warning is this case's alone: a token request that failed in transit (its own
//!   `m365_timeout` included) is over, and saved nothing.
//! - A grant is judged before anything is stored: the Graph permissions must be in it, there must be a
//!   refresh token, and the id token must name the address the code was started for by one of its
//!   `email`, `preferred_username` or `upn` claims (a sign-in name can differ from the mail address),
//!   else `m365_wrong_account`, or `m365_auth_failed` when it names nobody, and nothing is kept. Then
//!   the refresh token goes to the keyring; `m365.verify` is the caller's next step.
//! - A finished request answers the same final state for five minutes; an unknown one is `expired` (the
//!   usual cause is a backend restart between begin and poll).
//! - `signOut` deletes the keyring item under the refresh lane, which a refresh holds until its keyring
//!   save is done. It waits for the lane at most `LANE_WAIT` and then answers `m365_timeout`: the
//!   sign-out may not have been done, and the window says so rather than outwaiting its own 30 seconds.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::time::Instant;
use zeroize::Zeroizing;

use super::{ids, mailbox, params, read};
use crate::auth::m365::{
    SCOPE, change, consent_needed, login, login_at, permissions_granted, save_grant, tenant_unknown,
};

const MAX_PENDING: usize = 4;
const DONE_TTL: Duration = Duration::from_secs(5 * 60);
/// How long a poll waits for its exchange: above the login request's own 20 seconds, below the 30 the
/// desktop waits for an answer.
const POLL_WAIT: Duration = Duration::from_secs(24);
/// The warning of a poll that stopped waiting while its exchange goes on, which may yet save a grant.
const EXCHANGE_RUNNING: &str = "m365_exchange_running";
/// How long a sign-out or an invalidation waits for the mailbox's refresh lane, which a refresh holds
/// for its whole exchange and keyring save (a keyring may be waiting for somebody to unlock it): below
/// the 30 seconds the desktop waits for an answer, after which it stops the whole backend.
const LANE_WAIT: Duration = Duration::from_secs(20);
const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// The pages Microsoft sends people to for a device code.
const PAGES: [&str; 4] = [
    "microsoft.com",
    "www.microsoft.com",
    "login.microsoft.com",
    "login.microsoftonline.com",
];
const FAILED: &str = "m365_auth_failed";
const BAD: &str = "m365_invalid_response";

struct Pending {
    account: String,
    address: String,
    client_id: String,
    /// The login authority that answered the device-code request: the token requests go there too.
    authority: String,
    device_code: Zeroizing<String>,
    expires: Instant,
    interval: Duration,
    next_poll: Instant,
    /// A token request of this sign-in is in the air.
    polling: bool,
}

#[derive(Clone)]
struct Done {
    state: &'static str,
    error: Option<&'static str>,
    signed_in_as: Option<String>,
}

enum Entry {
    Pending(Pending),
    Done(Done, Instant),
}

static FLOWS: LazyLock<Mutex<HashMap<String, Entry>>> = LazyLock::new(Default::default);

#[cfg(test)]
/// Test builds: Microsoft's interval is replaced, so a test need not wait it out.
pub(super) static INTERVAL: Mutex<Option<Duration>> = Mutex::new(None);

#[cfg(test)]
/// Test builds: a shorter wait of a poll for its exchange.
pub(super) static SHORT_POLL_WAIT: Mutex<Option<Duration>> = Mutex::new(None);

#[cfg(test)]
/// Test builds: a shorter wait of a sign-out or an invalidation for the refresh lane.
pub(super) static SHORT_LANE_WAIT: Mutex<Option<Duration>> = Mutex::new(None);

/// `work`, which waits for the mailbox's refresh lane, or `m365_timeout` once `LANE_WAIT` has passed:
/// a wait still for the lane then did nothing, and one that got it finishes on a task of its own.
pub(super) async fn within_lane_wait<T>(
    work: impl Future<Output = Result<T, &'static str>>,
) -> Result<T, &'static str> {
    #[cfg(test)]
    let short = *SHORT_LANE_WAIT
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    #[cfg(not(test))]
    let short: Option<Duration> = None;
    tokio::time::timeout(short.unwrap_or(LANE_WAIT), work)
        .await
        .map_err(|_| "m365_timeout")?
}

fn poll_wait() -> Duration {
    #[cfg(test)]
    if let Some(wait) = *SHORT_POLL_WAIT
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
    {
        return wait;
    }
    POLL_WAIT
}

/// The wait between two token requests of one sign-in: what Microsoft said.
fn between_polls(told: u64) -> Duration {
    #[cfg(test)]
    if let Some(wait) = *INTERVAL.lock().unwrap_or_else(PoisonError::into_inner) {
        return wait;
    }
    Duration::from_secs(told)
}

fn flows() -> MutexGuard<'static, HashMap<String, Entry>> {
    FLOWS.lock().unwrap_or_else(PoisonError::into_inner)
}

fn done(state: &'static str, error: Option<&'static str>) -> Done {
    Done {
        state,
        error,
        signed_in_as: None,
    }
}

fn answer(done: &Done) -> Value {
    let mut out = json!({"state": done.state});
    if let Some(error) = done.error {
        out["error"] = json!(error);
    }
    if let Some(who) = &done.signed_in_as {
        out["signedInAs"] = json!(who);
    }
    out
}

/// Drops what has lapsed: a pending request past its expiry becomes `expired`, a finished one past
/// `DONE_TTL` goes.
fn tidy(map: &mut HashMap<String, Entry>) {
    let now = Instant::now();
    map.retain(|_, entry| !matches!(entry, Entry::Done(_, until) if *until <= now));
    for entry in map.values_mut() {
        if matches!(entry, Entry::Pending(p) if p.expires <= now && !p.polling) {
            *entry = Entry::Done(done("expired", None), now + DONE_TTL);
        }
    }
}

/// A short unique handle for a request. It protects nothing: the device code is the secret.
fn handle() -> String {
    static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let digest = Sha256::digest(format!("{count}:{now}:{}", std::process::id()));
    digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `https` on one of Microsoft's sign-in pages, with nothing added: no user name, port or fragment.
pub(super) fn verification_uri(text: &str) -> Option<String> {
    if text.len() > 256 || text.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let url = reqwest::Url::parse(text).ok()?;
    (url.scheme() == "https"
        && PAGES.contains(&url.host_str()?)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none())
    .then(|| url.to_string())
}

/// A token, secret or code as Microsoft sends one: non-empty, bounded, printable.
fn secret(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|text| !text.is_empty() && text.len() <= 16 * 1024)
        .filter(|text| !text.chars().any(|c| c.is_control() || c.is_whitespace()))
}

/// The code for a failed device-code or token request that is not one of the flow's own states.
pub(super) fn flow_error(status: u16, body: &Value) -> &'static str {
    match (status, body["error"].as_str().unwrap_or("")) {
        (429, _) => "m365_throttled",
        (500..=599, _) => "m365_server_error",
        _ if consent_needed(body) => "m365_consent_required",
        _ if tenant_unknown(body) => "m365_tenant_invalid",
        (_, "access_denied") => "m365_access_denied",
        _ => FAILED,
    }
}

/// The code for a login request that failed in transit.
fn link_error(code: &'static str) -> &'static str {
    match code {
        "auth_transport_failed" => "m365_network_failed",
        "auth_timeout" => "m365_timeout",
        _ => BAD,
    }
}

pub(super) async fn begin(request: &Value) -> Result<Value, &'static str> {
    let map = params::object(request, &["accountId", "address", "clientId"])?;
    let account = params::account(map)?;
    // The id is the address, lower-cased: nothing else is the same mailbox.
    let address = params::text(map, "address")?.to_ascii_lowercase();
    if format!("m365:{address}") != account {
        return Err("invalid_params");
    }
    let client_id = ids::client_id(params::text(map, "clientId")?)?;
    let (authority, status, body) = login(
        &address,
        "device",
        &[("client_id", &client_id), ("scope", SCOPE)],
    )
    .await
    .map_err(link_error)?;
    if status != 200 {
        return Err(flow_error(status, &body));
    }
    let device_code = secret(&body["device_code"]).ok_or(BAD)?;
    let user_code = body["user_code"]
        .as_str()
        .filter(|code| {
            (4..=32).contains(&code.len())
                && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        .ok_or(BAD)?;
    let uri = body["verification_uri"]
        .as_str()
        .and_then(verification_uri)
        .ok_or(BAD)?;
    let lifetime = body["expires_in"].as_u64().unwrap_or(0).clamp(60, 30 * 60);
    let told = body["interval"].as_u64().unwrap_or(5).clamp(1, 60);
    let interval = between_polls(told);
    let request_id = handle();
    let now = Instant::now();
    let mut map = flows();
    tidy(&mut map);
    let pending = |entry: &Entry| match entry {
        Entry::Pending(p) => Some(p.expires),
        Entry::Done(..) => None,
    };
    if map.values().filter_map(pending).count() >= MAX_PENDING {
        // The newest request wins: the oldest pending one gives way.
        let oldest = map
            .iter()
            .filter_map(|(id, entry)| pending(entry).map(|expires| (expires, id.clone())))
            .min()
            .map(|(_, id)| id);
        oldest.iter().for_each(|id| drop(map.remove(id)));
    }
    map.insert(
        request_id.clone(),
        Entry::Pending(Pending {
            account: account.to_owned(),
            address,
            client_id,
            authority,
            device_code: Zeroizing::new(device_code.to_owned()),
            expires: now + Duration::from_secs(lifetime),
            interval,
            next_poll: now + interval,
            polling: false,
        }),
    );
    Ok(json!({
        "requestId": request_id,
        "userCode": user_code,
        "verificationUri": uri,
        "expiresIn": lifetime,
        "interval": told,
    }))
}

/// What one token request of a sign-in came to.
enum Step {
    /// Ask again after the interval; `warning` names a transient failure, `slower` a `slow_down`.
    Pending {
        warning: Option<&'static str>,
        slower: bool,
    },
    Final(Done),
}

pub(super) async fn poll(request: &Value) -> Result<Value, &'static str> {
    let map = params::object(request, &["requestId"])?;
    let id = params::text(map, "requestId")?;
    if id.len() != 32 || !id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err("invalid_params");
    }
    let id = id.to_owned();
    let (account, address, client_id, authority, device_code) = {
        let mut map = flows();
        tidy(&mut map);
        match map.get_mut(&id) {
            None => return Ok(answer(&done("expired", None))),
            Some(Entry::Done(done, _)) => return Ok(answer(done)),
            Some(Entry::Pending(pending)) => {
                let now = Instant::now();
                if pending.polling || now < pending.next_poll {
                    return Ok(json!({"state": "pending"}));
                }
                pending.polling = true;
                pending.next_poll = now + pending.interval;
                (
                    pending.account.clone(),
                    pending.address.clone(),
                    pending.client_id.clone(),
                    pending.authority.clone(),
                    pending.device_code.clone(),
                )
            }
        }
    };
    // A task of its own, which also records the outcome: once Microsoft has given a refresh token for
    // the code it must be saved, and the request must say so, whether or not the caller is still there.
    let exchanged = tokio::spawn(async move {
        let step = exchange(
            &id,
            &account,
            &address,
            &client_id,
            &authority,
            &device_code,
        )
        .await;
        let mut map = flows();
        match step {
            Step::Final(done) => {
                let out = answer(&done);
                map.insert(id, Entry::Done(done, Instant::now() + DONE_TTL));
                out
            }
            Step::Pending { warning, slower } => {
                if let Some(Entry::Pending(pending)) = map.get_mut(&id) {
                    pending.polling = false;
                    if slower {
                        pending.interval = (pending.interval + Duration::from_secs(5))
                            .min(Duration::from_secs(60));
                    }
                    pending.next_poll = Instant::now() + pending.interval;
                }
                let mut out = json!({"state": "pending"});
                if let Some(warning) = warning {
                    out["warning"] = json!(warning);
                }
                out
            }
        }
    });
    match tokio::time::timeout(poll_wait(), exchanged).await {
        Ok(answer) => answer.map_err(|_| "worker_failed"),
        // Still exchanging or saving: the task carries on and records what it came to.
        Err(_) => Ok(json!({"state": "pending", "warning": EXCHANGE_RUNNING})),
    }
}

async fn exchange(
    id: &str,
    account: &str,
    address: &str,
    client_id: &str,
    authority: &str,
    device_code: &str,
) -> Step {
    let fields = [
        ("client_id", client_id),
        ("grant_type", GRANT_TYPE),
        ("device_code", device_code),
    ];
    let (status, body) = match login_at(authority, "token", &fields).await {
        Ok(answer) => answer,
        Err(code) => {
            return Step::Pending {
                warning: Some(link_error(code)),
                slower: false,
            };
        }
    };
    if status != 200 {
        return match body["error"].as_str().unwrap_or("") {
            "authorization_pending" => Step::Pending {
                warning: None,
                slower: false,
            },
            "slow_down" => Step::Pending {
                warning: None,
                slower: true,
            },
            "authorization_declined" => Step::Final(done("declined", None)),
            "expired_token" | "code_expired" => Step::Final(done("expired", None)),
            _ => match flow_error(status, &body) {
                // Throttling and a server's own trouble are the service's, not the flow's: keep asking.
                code @ ("m365_throttled" | "m365_server_error") => Step::Pending {
                    warning: Some(code),
                    slower: false,
                },
                code => Step::Final(done("failed", Some(code))),
            },
        };
    }
    Step::Final(grant(id, account, address, client_id, &body).await)
}

/// A successful token response: judged, then kept.
async fn grant(id: &str, account: &str, address: &str, client_id: &str, body: &Value) -> Done {
    let failed = |code| done("failed", Some(code));
    if secret(&body["access_token"]).is_none() {
        return failed(BAD);
    }
    if let Some(scope) = body["scope"].as_str()
        && !permissions_granted(scope)
    {
        return failed("m365_consent_required");
    }
    // Without a refresh token (`offline_access`) a sign-in would be signed out within the hour.
    let Some(refresh) = secret(&body["refresh_token"]) else {
        return failed(BAD);
    };
    // Whose code was it? An id token that names accounts, none of them the address asked for, is a
    // code entered as somebody else, and nothing of it is kept; nor of one that names nobody (`openid`
    // and `email` were asked for), since whose it is cannot be told.
    let names = claim_names(body["id_token"].as_str().unwrap_or(""));
    if names.is_empty() {
        return failed(FAILED);
    }
    if !names.iter().any(|name| name == address) {
        return Done {
            signed_in_as: names.into_iter().next(),
            ..failed("m365_wrong_account")
        };
    }
    // A sign-out can end this flow before or during its keyring write. The pending checks and
    // rollback share the refresh lane, so that rollback cannot delete a newer flow's saved grant.
    let request = id.to_owned();
    match save_grant(account, client_id, refresh, move || pending(&request)).await {
        Ok(true) => {}
        Ok(false) => return done("expired", None),
        Err(code) => return failed(code),
    }
    mailbox::forget(account);
    read::forget(account, None);
    done("signedIn", None)
}

fn pending(id: &str) -> bool {
    matches!(flows().get(id), Some(Entry::Pending(_)))
}

/// The names an id token gives the person (`preferred_username`, `email`, `upn`), trimmed and
/// lower-cased, in that order and without empty ones; the first is what the browser signed in as. The
/// token is Microsoft's own answer over TLS and is read for this alone: it authorizes nothing here.
pub(super) fn claim_names(id_token: &str) -> Vec<String> {
    let claims = id_token
        .split('.')
        .nth(1)
        .filter(|_| id_token.len() <= 16 * 1024)
        .and_then(|payload| URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    ["preferred_username", "email", "upn"]
        .iter()
        .filter_map(|name| claims[*name].as_str())
        .map(|text| {
            text.chars()
                .filter(|c| !c.is_control())
                .take(254)
                .collect::<String>()
        })
        .map(|text| text.trim().to_lowercase())
        .filter(|text| !text.is_empty())
        .collect()
}

/// A sign-in begun for this mailbox and application is not going to finish into the keyring item that
/// is being emptied. One of another application ID writes an item of its own and is left alone: the
/// window signs out a cancelled sign-in of the ID typed before while one with the ID typed now waits.
pub(super) fn end_flows(account: &str, client_id: &str) {
    flows().retain(|_, entry| {
        !matches!(entry, Entry::Pending(p) if p.account == account && p.client_id == client_id)
    });
}

/// `m365.signOut {accountId, clientId}`: the keyring item goes, and with it everything in memory.
pub(super) async fn sign_out(request: &Value) -> Result<Value, &'static str> {
    let map = params::object(request, &["accountId", "clientId"])?;
    let account = params::account(map)?;
    let client_id = ids::client_id(params::text(map, "clientId")?)?;
    end_flows(account, &client_id);
    // Perhaps not signed out: the keyring item may still be there, and the window says so.
    within_lane_wait(change(account, &client_id, None)).await?;
    mailbox::forget(account);
    read::forget(account, None);
    Ok(json!({"signedOut": true}))
}
