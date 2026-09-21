//! Secret Service over D-Bus, retaining the installed plugin's exact attributes.
//! One connection and one encrypted session are shared by every operation and
//! outlive it, because opening a session per operation and tearing it down
//! immediately races the daemon's own handshake. One deadline still covers the
//! whole operation: opening the session, every method, prompt completion and a
//! second attempt if there is one. A call that fails drops the shared session,
//! and the read is repeated on a fresh one.
use super::*;
use ::secret_service::{EncryptionType, SecretService};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError},
    time::{Duration, Instant},
};

const DEADLINE: Duration = Duration::from_secs(5);
const CLOSE_DEADLINE: Duration = Duration::from_millis(250);

#[derive(Clone, Copy)]
enum Operation<'a> {
    Get,
    Put(&'a [u8]),
    Delete,
}

/// Why an operation produced no secret. Only a session that failed is worth
/// dropping: a locked item and a locked collection are answers the daemon gave
/// over a connection that is still good, and dropping the session for those
/// would renegotiate on every read against a keyring that is merely locked.
enum Fault {
    Answer(Error),
    /// The call did not complete. A read may be repeated on a fresh session.
    Transport,
    /// The deadline passed. The session is unusable and nothing is repeated:
    /// the deadline is the caller's bound and a second attempt would double it.
    Timeout,
}

impl Fault {
    fn error(self) -> Error {
        match self {
            Fault::Answer(error) => error,
            Fault::Transport | Fault::Timeout => Error::Unavailable,
        }
    }
}

/// A negotiated session. `SecretService` owns the connection it was built on,
/// so dropping the last `Arc` closes it. Held behind an `Arc` so an operation
/// keeps it alive after it has been dropped from the cache.
struct Session {
    service: SecretService<'static>,
}

/// The runtime owning the shared connection's zbus tasks, and the session.
struct Shared {
    runtime: tokio::runtime::Runtime,
    session: Mutex<Option<Arc<Session>>>,
}

impl Shared {
    /// One worker, so credential operations still run alongside each other as
    /// they did when each built its own runtime. A current-thread runtime would
    /// serialise every operation behind whichever one holds it, and a stuck
    /// prompt would then block them all for the whole deadline.
    fn new() -> Result<Self, Error> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(|_| Error::Unavailable)?;
        Ok(Self {
            runtime,
            session: Mutex::new(None),
        })
    }
}

/// A failed build is not remembered: the next operation tries again, as it did
/// when every operation built its own runtime.
fn shared() -> Result<&'static Shared, Error> {
    static SHARED: OnceLock<Shared> = OnceLock::new();
    if let Some(shared) = SHARED.get() {
        return Ok(shared);
    }
    // A racing caller may install theirs first, in which case ours is dropped.
    let _ = SHARED.set(Shared::new()?);
    SHARED.get().ok_or(Error::Unavailable)
}

/// The session slot, recovered if a panic poisoned it. The slot is only written
/// once the connection is built, so a poisoned lock guards nothing broken and
/// refusing it would disable credentials for the life of the process.
fn slot(shared: &Shared) -> MutexGuard<'_, Option<Arc<Session>>> {
    shared
        .session
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// What is left of the caller's deadline, or None once it has passed. One
/// budget covers opening the session, the operation and any second attempt.
fn remaining(until: Instant) -> Option<Duration> {
    until
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
}

async fn session_bus() -> Result<zbus::Connection, Error> {
    zbus::connection::Builder::session()
        .map_err(|_| Error::Unavailable)?
        .method_timeout(DEADLINE)
        .build()
        .await
        .map_err(|_| Error::Unavailable)
}

fn run(key: &CredentialKey, operation: Operation<'_>) -> Result<Option<Secret>, Error> {
    run_on(shared()?, key, operation, session_bus, DEADLINE)
}

/// Runs one operation on the shared session, opening it if there is none.
///
/// One `block_on` and one deadline cover opening the session and running the
/// operation, so a credential read costs the caller exactly what it asked for.
///
/// A session the daemon has forgotten fails the next call on it, so the session
/// is dropped and a read is repeated on a fresh one. Only a read: a request
/// already written to the socket cannot be retracted, and the daemon may have
/// committed it, so repeating `CreateItem` would leave two items carrying the
/// same attributes and `find` would answer `Ambiguous` for the rest of the
/// credential's life. A write reports the failure and the caller asks again.
fn run_on<F, C>(
    shared: &Shared,
    key: &CredentialKey,
    operation: Operation<'_>,
    connect: F,
    deadline: Duration,
) -> Result<Option<Secret>, Error>
where
    F: Fn() -> C,
    C: Future<Output = Result<zbus::Connection, Error>>,
{
    let until = Instant::now() + deadline;
    match attempt(shared, key, operation, &connect, until) {
        Ok(secret) => Ok(secret),
        Err((_, Fault::Answer(error))) => Err(error),
        Err((session, fault)) => {
            if let Some(session) = session {
                invalidate(shared, &session);
            }
            let repeatable =
                matches!(fault, Fault::Transport) && matches!(operation, Operation::Get);
            if !repeatable {
                return Err(fault.error());
            }
            attempt(shared, key, operation, &connect, until).map_err(|(_, fault)| fault.error())
        }
    }
}

/// One attempt at the operation on the shared session, opening one if there is
/// none. Returns the session it used alongside any fault, so the caller drops
/// that session and not a newer one.
#[allow(clippy::type_complexity)]
fn attempt<F, C>(
    shared: &Shared,
    key: &CredentialKey,
    operation: Operation<'_>,
    connect: &F,
    until: Instant,
) -> Result<Option<Secret>, (Option<Arc<Session>>, Fault)>
where
    F: Fn() -> C,
    C: Future<Output = Result<zbus::Connection, Error>>,
{
    let session = match acquire(shared, connect, until) {
        Ok(session) => session,
        Err(fault) => return Err((None, fault)),
    };
    let Some(left) = remaining(until) else {
        return Err((Some(session), Fault::Timeout));
    };
    shared
        .runtime
        .block_on(async {
            tokio::time::timeout(left, execute(&session.service, key, operation))
                .await
                .unwrap_or(Err(Fault::Timeout))
        })
        .map_err(|fault| (Some(session), fault))
}

/// The shared session, negotiated if there is none.
///
/// The lock is held across the negotiation so that two callers arriving at an
/// empty slot do not each open one; opening a single session is the point. It
/// is held outside the runtime rather than inside a task, so a caller waiting
/// for it is only waiting for another thread to finish negotiating, and no
/// prompt is ever awaited underneath it: every prompting call is in `execute`.
fn acquire<F, C>(shared: &Shared, connect: &F, until: Instant) -> Result<Arc<Session>, Fault>
where
    F: Fn() -> C,
    C: Future<Output = Result<zbus::Connection, Error>>,
{
    let mut held = slot(shared);
    if let Some(session) = held.as_ref() {
        return Ok(session.clone());
    }
    let Some(left) = remaining(until) else {
        return Err(Fault::Timeout);
    };
    let service = shared.runtime.block_on(async {
        let mut opened = None;
        let result = tokio::time::timeout(left, async {
            let connection = connect().await.map_err(|_| Fault::Transport)?;
            opened = Some(connection.clone());
            SecretService::connect_with_existing(EncryptionType::Dh, connection)
                .await
                .map_err(|_| Fault::Transport)
        })
        .await
        .unwrap_or(Err(Fault::Timeout));
        // A session that half-opened still holds a name on the bus.
        if let (Err(_), Some(connection)) = (&result, opened) {
            close(connection).await;
        }
        result
    })?;
    let session = Arc::new(Session { service });
    *held = Some(session.clone());
    Ok(session)
}

/// Drops the session from the cache so the next operation opens a fresh one.
///
/// It is not closed here. Concurrent operations run on their own blocking
/// threads and share this connection, and closing it terminates their in-flight
/// calls; the last `Arc` to be released closes it instead, once nobody is using
/// it. Only this session is evicted: a concurrent operation may already have
/// replaced it, and that replacement is still good.
fn invalidate(shared: &Shared, session: &Arc<Session>) {
    let mut held = slot(shared);
    if held
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, session))
    {
        *held = None;
    }
}

/// This is close, never graceful_shutdown: waiting for a pending prompt or an
/// outstanding clone before closing would recreate the indefinite wait. It runs
/// when a session has already failed rather than after every operation, so it
/// no longer races the handshake of the session that follows it.
async fn close(connection: zbus::Connection) {
    let _ = tokio::time::timeout(CLOSE_DEADLINE, connection.close()).await;
}

async fn find<'a>(
    service: &'a SecretService<'a>,
    attrs: &HashMap<String, String>,
) -> Result<Option<::secret_service::Item<'a>>, Fault> {
    let result = service
        .search_items(
            attrs
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect(),
        )
        .await
        .map_err(|_| Fault::Transport)?;
    if result.unlocked.len() + result.locked.len() > 1 {
        return Err(Fault::Answer(Error::Ambiguous));
    }
    if let Some(item) = result.locked.into_iter().next() {
        service
            .unlock_all(&[&item])
            .await
            .map_err(|_| Fault::Answer(Error::Unavailable))?;
        return Ok(Some(item));
    }
    Ok(result.unlocked.into_iter().next())
}

async fn execute(
    service: &SecretService<'_>,
    key: &CredentialKey,
    operation: Operation<'_>,
) -> Result<Option<Secret>, Fault> {
    let attrs = key
        .attributes()
        .map_err(Fault::Answer)?
        .into_iter()
        .collect();
    let item = find(service, &attrs).await?;
    match operation {
        Operation::Get => {
            let item = item.ok_or(Fault::Answer(Error::Missing))?;
            let secret = item.get_secret().await.map_err(|_| Fault::Transport)?;
            Ok(Some(Secret::new(secret).map_err(Fault::Answer)?))
        }
        Operation::Put(secret) => {
            if let Some(item) = item {
                item.set_secret(secret, "application/octet-stream")
                    .await
                    .map_err(|_| Fault::Transport)?;
            } else {
                let collection = service
                    .get_default_collection()
                    .await
                    .map_err(|_| Fault::Transport)?;
                if collection.is_locked().await.map_err(|_| Fault::Transport)? {
                    return Err(Fault::Answer(Error::Unavailable));
                }
                // Keep older grants intact until the current-scope item exists.
                collection
                    .create_item(
                        "Omamail",
                        attrs
                            .iter()
                            .map(|(k, v)| (k.as_str(), v.as_str()))
                            .collect(),
                        secret,
                        false,
                        "application/octet-stream",
                    )
                    .await
                    .map_err(|_| Fault::Transport)?;
            }
            Ok(None)
        }
        Operation::Delete => {
            item.ok_or(Fault::Answer(Error::Missing))?
                .delete()
                .await
                .map_err(|_| Fault::Transport)?;
            Ok(None)
        }
    }
}

/// One operation on a private session, closed immediately afterwards. The
/// connection-lifetime tests observe a single attempt this way; production
/// shares one session through `run` and lets the last reference close it.
#[cfg(test)]
fn run_with(
    key: &CredentialKey,
    operation: Operation<'_>,
    connect: impl Future<Output = Result<zbus::Connection, Error>>,
    deadline: Duration,
) -> Result<Option<Secret>, Error> {
    let shared = Shared::new()?;
    let connect = Mutex::new(Some(connect));
    let opened: Mutex<Option<zbus::Connection>> = Mutex::new(None);
    let result = run_on(
        &shared,
        key,
        operation,
        || {
            let taken = connect.lock().ok().and_then(|mut slot| slot.take());
            async {
                let connection = match taken {
                    Some(connect) => connect.await?,
                    None => return Err(Error::Unavailable),
                };
                if let Ok(mut slot) = opened.lock() {
                    *slot = Some(connection.clone());
                }
                Ok(connection)
            }
        },
        deadline,
    );
    let Shared { runtime, session } = shared;
    drop(session);
    // Awaited rather than left to drop, so the bus has deregistered the name by
    // the time a one-shot returns.
    if let Some(connection) = opened.lock().ok().and_then(|mut slot| slot.take()) {
        runtime.block_on(async { close(connection).await });
    }
    // zbus's async reader/signal tasks are owned by this runtime. There is no
    // detached blocking secret-service call left behind when the worker returns.
    runtime.shutdown_timeout(Duration::ZERO);
    result
}

pub(super) fn get(key: &CredentialKey) -> Result<Secret, Error> {
    run(key, Operation::Get)?.ok_or(Error::Unavailable)
}
pub(super) fn put(key: &CredentialKey, secret: &[u8]) -> Result<(), Error> {
    run(key, Operation::Put(secret)).map(|_| ())
}
pub(super) fn delete(key: &CredentialKey) -> Result<(), Error> {
    run(key, Operation::Delete).map(|_| ())
}

#[cfg(test)]
#[path = "secret_service_tests.rs"]
mod tests;
