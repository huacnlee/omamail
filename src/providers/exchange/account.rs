//! From an account id to a signed-in client, and how an operation runs on it.
//!
//! Settings and password are read from the registry and keyring on every request (a failing
//! request never repairs `accounts.json`; a missing credential is `auth_signed_out` with no socket
//! opened). One client per account is kept between requests and used by one operation at a time. A
//! client whose configuration differs from what was just read is replaced, so a connection is never
//! reused for credentials it was not opened with. A client that heard the server refuse its password
//! stays and answers `exchange_unauthorized` with no traffic until the settings or the password
//! change: a directory that counts failed logons would lock the account.
//!
//! Every call answers within `TOTAL`, the wait for the account's turn included: the window gives a
//! backend request 30 seconds and then stops the whole backend, every other account's work and this
//! module's memory with it. A read gives the turn back at that deadline too.
//!
//! `exchange.invalidate` (sign-out, removal) drops the client and its password once the operation
//! holding it ends, and starts a new generation of the account: a request that read the password
//! before it neither uses nor keeps a client made from it, and answers as signed out. A refusal
//! latched for it outlives the client as a salted fingerprint of the credentials, never the
//! credentials themselves.

use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Arc, LazyLock, Mutex, PoisonError,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use futures_util::future::BoxFuture;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, OwnedMutexGuard};
use tokio::time::{Instant, timeout_at};

use super::ews::{Choice, Client, Config, clock, endpoint};
use super::ids;

const SETTINGS: &str = "exchange_settings_invalid";
const SIGNED_OUT: &str = "auth_signed_out";
const TIMEOUT: &str = "exchange_timeout";
/// What one call may take in all, the account's turn included.
pub const TOTAL: Duration = Duration::from_secs(25);

/// When a call given `total` from now must have answered.
pub fn deadline(total: Duration) -> Instant {
    Instant::now() + clock(total)
}

type Requests = HashMap<(String, String), Arc<Notify>>;

#[derive(Default)]
struct Slot {
    client: Arc<tokio::sync::Mutex<Option<Client>>>,
    /// `exchange.invalidate` found the client in use: it goes when that lease ends.
    stale: AtomicBool,
    /// How many times `exchange.invalidate` has been asked: credentials read under an older one
    /// were read before a sign-out and are never used.
    generation: AtomicU64,
    /// The fingerprint of credentials the server refused, kept when their client goes.
    refused: Mutex<Option<[u8; 32]>>,
}

/// Drops the client, keeping only the fingerprint of credentials it heard refused.
fn retire(client: &mut Option<Client>, slot: &Slot) {
    if let Some(old) = client.take()
        && old.rejected()
    {
        *slot.refused.lock().unwrap_or_else(PoisonError::into_inner) =
            Some(fingerprint(old.config()));
    }
}

/// SHA-256 of a per-process random salt and the credentials, equal for the same credentials. It
/// keeps the password itself out of memory once its client is gone. It is no protection against
/// anyone who can read this process's memory: the salt is there too, and a guess can be checked.
fn fingerprint(config: &Config) -> [u8; 32] {
    static SALT: LazyLock<[u8; 32]> = LazyLock::new(|| {
        // Should the system's random source fail, the salt stays zero and the fingerprint is a
        // plain SHA-256 of the credentials. It is still compared in this process only, and a
        // request never fails over it.
        let mut salt = [0u8; 32];
        let _ = rustls::crypto::ring::default_provider()
            .secure_random
            .fill(&mut salt);
        salt
    });
    let mut hash = Sha256::new();
    hash.update(*SALT);
    let choice = format!("{:?}", config.choice);
    for part in [
        config.url.as_str(),
        choice.as_str(),
        config.login.as_str(),
        config.password.as_str(),
    ] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize().into()
}

static ACCOUNTS: LazyLock<Mutex<HashMap<String, Arc<Slot>>>> = LazyLock::new(Default::default);
/// Reads in flight that `exchange.cancel` can end, by (account, token).
static REQUESTS: LazyLock<Mutex<Requests>> = LazyLock::new(Default::default);

pub struct Lease {
    guard: OwnedMutexGuard<Option<Client>>,
    slot: Arc<Slot>,
}

impl Lease {
    pub fn client(&mut self) -> &mut Client {
        self.guard.as_mut().expect("a lease holds a client")
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.slot.stale.swap(false, Ordering::AcqRel) {
            retire(&mut self.guard, &self.slot);
        }
    }
}

/// The endpoint, login and scheme of a settings block; the login defaults to the address. A URL the
/// policy refuses is `exchange_url_invalid`, any other bad field `exchange_settings_invalid`.
pub fn settings(
    block: &Value,
    address: &str,
) -> Result<(reqwest::Url, String, Choice), &'static str> {
    let block = block.as_object().ok_or(SETTINGS)?;
    let url = endpoint(
        block
            .get("ewsUrl")
            .and_then(Value::as_str)
            .ok_or(SETTINGS)?,
    )?;
    let login = match block.get("username") {
        None | Some(Value::Null) => "",
        Some(Value::String(login)) => login.trim(),
        Some(_) => return Err(SETTINGS),
    };
    let login = if login.is_empty() { address } else { login };
    if login.len() > 512 || login.chars().any(char::is_control) {
        return Err(SETTINGS);
    }
    let choice = match block.get("authScheme") {
        None | Some(Value::Null) => Choice::Auto,
        Some(Value::String(scheme)) => Choice::parse(scheme.trim()).ok_or(SETTINGS)?,
        Some(_) => return Err(SETTINGS),
    };
    Ok((url, login.to_owned(), choice))
}

pub const MAX_PASSWORD: usize = 1024;

/// The client of `account`, ready for one operation that ends by `deadline` (it waits for its turn).
pub async fn lease(account: &str, deadline: Instant) -> Result<Lease, &'static str> {
    ids::account(account)?;
    let lookup = account.to_owned();
    let entry =
        tokio::task::spawn_blocking(move || crate::auth::settings_readonly("exchange", &lookup))
            .await
            .map_err(|_| "worker_failed")??;
    let (url, login, choice) =
        settings(&entry["exchange"], ids::account(account)?).map_err(|_| SETTINGS)?;
    let slot = ACCOUNTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .entry(account.to_owned())
        .or_default()
        .clone();
    // Before the password is read: a sign-out after this point is seen once the turn comes.
    let generation = slot.generation.load(Ordering::Acquire);
    let password = crate::auth::password("exchange", account).await?;
    if password.len() > MAX_PASSWORD {
        return Err("auth_secret_invalid");
    }
    let config = Config::new(url, choice, &login, &password);
    let mut guard = Arc::clone(&slot.client).lock_owned().await;
    if slot.stale.swap(false, Ordering::AcqRel) {
        retire(&mut guard, &slot);
    }
    // Signed out while this waited for its turn: the password it read is not used, and the
    // slot keeps whatever a request made after the sign-out put there.
    if slot.generation.load(Ordering::Acquire) != generation {
        return Err(SIGNED_OUT);
    }
    if !guard
        .as_ref()
        .is_some_and(|client| client.config().same(&config))
    {
        let mut client = Client::new(Arc::new(config));
        let refused = *slot.refused.lock().unwrap_or_else(PoisonError::into_inner);
        if refused == Some(fingerprint(client.config())) {
            client.refuse();
        }
        *guard = Some(client);
    }
    let mut lease = Lease { guard, slot };
    lease.client().until(deadline);
    Ok(lease)
}

/// Drops the client, its connection and its password, but not a refusal of the password: now, or
/// for a client in use when its operation ends. A request that read the password before this and is
/// still waiting for its turn answers `auth_signed_out` when the turn comes.
pub fn invalidate(account: &str) {
    let slot = ACCOUNTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(account)
        .cloned();
    let Some(slot) = slot else { return };
    slot.generation.fetch_add(1, Ordering::AcqRel);
    slot.stale.store(true, Ordering::Release);
    if let Ok(mut guard) = Arc::clone(&slot.client).try_lock_owned()
        && slot.stale.swap(false, Ordering::AcqRel)
    {
        retire(&mut guard, &slot);
    }
}

/// A sign-in the server accepted lifts a refusal it had latched for these same credentials.
pub fn accepted(account: &str, config: &Config) {
    let slot = ACCOUNTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(account)
        .cloned();
    let Some(slot) = slot else { return };
    {
        let mut refused = slot.refused.lock().unwrap_or_else(PoisonError::into_inner);
        if *refused == Some(fingerprint(config)) {
            *refused = None;
        }
    }
    if let Ok(mut guard) = Arc::clone(&slot.client).try_lock_owned()
        && guard
            .as_ref()
            .is_some_and(|client| client.config().same(config))
    {
        *guard = None;
    }
}

/// Whether a client (and so a password) is kept for `account`.
#[cfg(test)]
pub fn kept(account: &str) -> bool {
    let slot = ACCOUNTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(account)
        .cloned();
    slot.is_some_and(|slot| {
        slot.client
            .try_lock()
            .map_or(true, |client| client.is_some())
    })
}

pub fn cancel(account: &str, token: &str) -> bool {
    let requests = REQUESTS.lock().unwrap_or_else(PoisonError::into_inner);
    requests
        .get(&(account.to_owned(), token.to_owned()))
        .is_some_and(|notify| {
            notify.notify_one();
            true
        })
}

struct Registered((String, String));

impl Drop for Registered {
    fn drop(&mut self) {
        REQUESTS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// `work` until `deadline`, ended early by `exchange.cancel` for its token.
pub async fn guarded<T>(
    account: &str,
    token: Option<String>,
    deadline: Instant,
    work: impl Future<Output = Result<T, &'static str>>,
) -> Result<T, &'static str> {
    let bounded = async { timeout_at(deadline, work).await.unwrap_or(Err(TIMEOUT)) };
    let Some(token) = token else {
        return bounded.await;
    };
    let key = (account.to_owned(), token);
    let notify = Arc::new(Notify::new());
    {
        let mut requests = REQUESTS.lock().unwrap_or_else(PoisonError::into_inner);
        if requests.len() >= 64 || requests.contains_key(&key) {
            return Err("invalid_params");
        }
        requests.insert(key.clone(), Arc::clone(&notify));
    }
    let _registered = Registered(key);
    tokio::select! {
        result = bounded => result,
        () = notify.notified() => Err("exchange_cancelled"),
    }
}

/// A read-only operation. It waits for the account's turn (cancellable), then runs on a task of its
/// own that owns the lease: a caller that gives up (`j`/`k` in the list) leaves the signed-in
/// connection alone instead of costing a handshake and a logon. The task ends at the call's
/// deadline whatever it is doing, and the account's turn with it.
pub async fn read<T, F>(account: &str, token: Option<String>, work: F) -> Result<T, &'static str>
where
    T: Send + 'static,
    F: for<'a> FnOnce(&'a mut Client) -> BoxFuture<'a, Result<T, &'static str>> + Send + 'static,
{
    let deadline = deadline(TOTAL);
    guarded(account, token, deadline, async {
        let mut lease = lease(account, deadline).await?;
        tokio::spawn(async move {
            timeout_at(deadline, work(lease.client()))
                .await
                .unwrap_or(Err(TIMEOUT))
        })
        .await
        .map_err(|_| "worker_failed")?
    })
    .await
}
