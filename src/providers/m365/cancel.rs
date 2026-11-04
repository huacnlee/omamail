//! Request tokens, `m365.cancel` and the deadline every call runs under.
//!
//! A listing, a message fetch or a verification may carry a `requestToken`; `m365.cancel` ends the
//! call registered under that account and token with `m365_cancelled`, dropping its requests where
//! they stand. Mutations and sends take no token and are never cancelled: a caller that gives up
//! cannot leave a half-applied batch it does not know about.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Notify;

/// Above the operation's own 20 seconds in `graph`, below the 30 the desktop waits.
pub(super) const DEADLINE: Duration = Duration::from_secs(25);
/// A full message: the body may take `MIME_BUDGET`, then the parse. Above that, below the desktop.
pub(super) const READ_DEADLINE: Duration = Duration::from_secs(70);
const MAX_REGISTERED: usize = 64;

/// Test builds: a shorter deadline for the calls that follow.
#[cfg(test)]
pub(super) static SHORT_DEADLINE: Mutex<Option<Duration>> = Mutex::new(None);

type Key = (String, String);
static CALLS: LazyLock<Mutex<HashMap<Key, Arc<Notify>>>> = LazyLock::new(Default::default);

struct Registration(Key, Arc<Notify>);

impl Drop for Registration {
    fn drop(&mut self) {
        CALLS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
    }
}

pub(super) fn cancel(account: &str, token: &str) -> Value {
    let calls = CALLS.lock().unwrap_or_else(PoisonError::into_inner);
    let found = calls.get(&(account.to_owned(), token.to_owned()));
    if let Some(notify) = found {
        // A permit is kept, so a cancel that lands before the call first waits still ends it.
        notify.notify_one();
    }
    json!({"cancelled": found.is_some()})
}

/// Runs `work` for at most `DEADLINE`, or until `token` (when there is one) is cancelled; either
/// way `work` is dropped where it stands. A token already in use is `invalid_params`.
pub(super) async fn guarded<T>(
    account: &str,
    token: Option<&str>,
    work: impl Future<Output = Result<T, &'static str>>,
) -> Result<T, &'static str> {
    bounded(account, token, DEADLINE, work).await
}

/// Same as `guarded`, for a call whose caller waits `limit` (before a test build shortens it, as
/// `limit` says).
pub(super) async fn guarded_for<T>(
    account: &str,
    limit: Duration,
    work: impl Future<Output = Result<T, &'static str>>,
) -> Result<T, &'static str> {
    bounded(account, None, limit, work).await
}

/// The deadline a call given `limit` runs under: `limit`, or in a test build the one a test set.
pub(super) fn limit(limit: Duration) -> Duration {
    #[cfg(test)]
    if let Some(short) = *SHORT_DEADLINE
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
    {
        return short;
    }
    limit
}

/// Same as `guarded`, for a call that downloads a message body.
pub(super) async fn guarded_read<T>(
    account: &str,
    token: Option<&str>,
    work: impl Future<Output = Result<T, &'static str>>,
) -> Result<T, &'static str> {
    bounded(account, token, READ_DEADLINE, work).await
}

async fn bounded<T>(
    account: &str,
    token: Option<&str>,
    limit: Duration,
    work: impl Future<Output = Result<T, &'static str>>,
) -> Result<T, &'static str> {
    let registration = token
        .map(|token| {
            let mut calls = CALLS.lock().unwrap_or_else(PoisonError::into_inner);
            let key = (account.to_owned(), token.to_owned());
            if calls.contains_key(&key) {
                return Err("invalid_params");
            }
            if calls.len() >= MAX_REGISTERED {
                return Err("m365_request_limit");
            }
            let notify = Arc::new(Notify::new());
            calls.insert(key.clone(), Arc::clone(&notify));
            Ok(Registration(key, notify))
        })
        .transpose()?;
    let bounded = async {
        tokio::time::timeout(self::limit(limit), work)
            .await
            .unwrap_or(Err("m365_timeout"))
    };
    match &registration {
        None => bounded.await,
        Some(Registration(_, notify)) => tokio::select! {
            result = bounded => result,
            () = notify.notified() => Err("m365_cancelled"),
        },
    }
}
