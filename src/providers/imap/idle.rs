//! RFC 2177 IDLE on a dedicated, read-only INBOX connection.
//!
//! The account's check loop still polls on its interval; this only wakes it
//! early. An untagged `EXISTS`, `EXPUNGE` or `FETCH` while idling says the
//! INBOX changed, and the check that follows reads what changed through the
//! ordinary path, so nothing here interprets a mailbox.
use super::{
    LIMIT, Result, Wire, advertises, command, connect, literal_length, login, resolve_account,
    write,
};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    future::Future,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::{io::AsyncBufReadExt, sync::Notify, time::Instant};

/// The budget for everything from connecting to examining INBOX, and again for
/// each later command exchange.
const STEP: Duration = Duration::from_secs(22);
/// How often the wall clock is compared with the monotonic one, which stops
/// while the machine sleeps; the same check as the JMAP event stream's.
const RESUME_CHECK: Duration = Duration::from_secs(30);

#[derive(Clone, Copy)]
struct Timing {
    /// How long one IDLE runs before it is ended and issued again: well inside
    /// RFC 2177's 29 minutes, and often enough to keep a quiet connection
    /// through middleboxes that drop idle mappings after a few minutes. The
    /// DONE exchange is also what notices a connection that died without a
    /// word.
    refresh: Duration,
    /// Changes arriving within this long of the first wake the check once
    /// rather than once per line.
    coalesce: Duration,
    first_retry: Duration,
    last_retry: Duration,
}

const TIMING: Timing = Timing {
    refresh: Duration::from_secs(4 * 60),
    coalesce: Duration::from_secs(2),
    first_retry: Duration::from_secs(5),
    last_retry: Duration::from_secs(5 * 60),
};

/// Keep an IDLE session open for `account` until the task is aborted, waking
/// `changed` whenever the server reports an INBOX change.
pub(crate) async fn watch(account: String, changed: Arc<Notify>) {
    supervise(
        || {
            let params = json!({ "accountId": account });
            async move { resolve_account(&params, "imap.idle").await }
        },
        &changed,
        TIMING,
    )
    .await
}

struct Backoff {
    timing: Timing,
    next: Duration,
}

impl Backoff {
    fn new(timing: Timing) -> Self {
        Self {
            timing,
            next: timing.first_retry,
        }
    }

    /// How long to wait before the next session, or `None` to stop.
    /// `refreshed` says the last session completed at least one IDLE period,
    /// which is what counts as having worked.
    fn after(&mut self, error: &str, refreshed: bool) -> Option<Duration> {
        if error == "imap_idle_unsupported" {
            // A server property; asking again would only log in to be told so.
            return None;
        }
        if refreshed {
            self.next = self.timing.first_retry;
        }
        let delay = if error == "mail_auth_failed" || error.starts_with("auth_") {
            // A refused login or a missing credential is unlikely to be
            // different in a few seconds, and each attempt costs the server a
            // LOGIN or Microsoft a token request. Polling reports the error.
            self.timing.last_retry
        } else {
            self.next
        };
        self.next = (self.next * 2).min(self.timing.last_retry);
        Some(delay)
    }
}

/// Up to a fifth more, from the clock, so accounts that lost their connections
/// together do not all reconnect in the same instant.
fn jitter(delay: Duration) -> Duration {
    let spread = (delay.as_nanos() / 5).max(1);
    let seed = SystemTime::UNIX_EPOCH
        .elapsed()
        .map_or(0, |since| since.as_nanos());
    delay + Duration::from_nanos((seed % spread) as u64)
}

async fn supervise<F, Fut>(resolve: F, changed: &Notify, timing: Timing)
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    let mut backoff = Backoff::new(timing);
    let mut first = true;
    loop {
        let mut refreshed = false;
        let error = match tokio::time::timeout(STEP, resolve()).await {
            Ok(Ok(params)) => {
                // The watch checked when it started. Any later session may
                // follow a gap in which a change raised nothing, so it asks for
                // a check of its own.
                let Err(error) = session(params, changed, !first, timing, &mut refreshed).await;
                error
            }
            Ok(Err(error)) => error,
            Err(_) => "request_timed_out",
        };
        first = false;
        let Some(delay) = backoff.after(error, refreshed) else {
            return;
        };
        tokio::time::sleep(jitter(delay)).await;
    }
}

async fn step<T>(future: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(STEP, future)
        .await
        .unwrap_or(Err("request_timed_out"))
}

/// One connection: authenticate, open INBOX read-only, then idle until the
/// connection fails.
async fn session(
    p: Value,
    changed: &Notify,
    announce: bool,
    timing: Timing,
    refreshed: &mut bool,
) -> Result<Infallible> {
    let mut wire = step(async {
        let mut wire = connect(&p["settings"], false).await?;
        login(&mut wire, &p).await?;
        let capabilities = command(&mut wire, "CAPABILITY").await?;
        if !advertises(&capabilities, "IDLE") {
            return Err("imap_idle_unsupported");
        }
        if advertises(&capabilities, "ID") {
            command(&mut wire, "ID (\"name\" \"Omamail\")").await?;
        }
        // EXAMINE rather than SELECT: watching must not clear \Recent.
        command(&mut wire, "EXAMINE \"INBOX\"").await?;
        Ok(wire)
    })
    .await?;
    // Not kept for the life of the connection.
    drop(p);
    if announce {
        changed.notify_one();
    }
    let mut lines = Lines::default();
    // When to wake the check for changes already seen but not yet reported.
    let mut due: Option<Instant> = None;
    let mut resume_clock = tokio::time::interval(RESUME_CHECK);
    let mut last_wall = SystemTime::now();
    loop {
        step(write(&mut wire, b"O1 IDLE\r\n")).await?;
        step(async {
            loop {
                let line = lines.next(&mut wire).await?;
                if line.starts_with(b"+") {
                    return Ok(());
                }
                if tagged(&line).is_some() {
                    return Err("imap_command_failed");
                }
                if changes_inbox(&line)? {
                    due.get_or_insert(Instant::now() + timing.coalesce);
                }
            }
        })
        .await?;
        let refresh_at = Instant::now() + timing.refresh;
        loop {
            let wake = due.map_or(refresh_at, |due| due.min(refresh_at));
            // Biased toward the timers, so a server that never stops sending
            // cannot hold off either the wake or the refresh.
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(wake) => {
                    let now = Instant::now();
                    if due.is_some_and(|due| due <= now) {
                        due = None;
                        changed.notify_one();
                    }
                    if refresh_at <= now {
                        break;
                    }
                }
                _ = resume_clock.tick() => {
                    let now = SystemTime::now();
                    if resumed(last_wall, now) {
                        // The connection almost certainly died while the
                        // machine slept; a new session also asks for a check.
                        return Err("mail_connection_closed");
                    }
                    last_wall = now;
                }
                line = lines.next(&mut wire) => {
                    let line = line?;
                    // A server ends IDLE only when told to. One that ends it
                    // unasked is treated as a failed connection, so it goes
                    // through the backoff rather than straight back into IDLE.
                    if tagged(&line).is_some() {
                        return Err("mail_connection_closed");
                    }
                    if changes_inbox(&line)? {
                        due.get_or_insert(Instant::now() + timing.coalesce);
                    }
                }
            }
        }
        step(write(&mut wire, b"DONE\r\n")).await?;
        step(async {
            loop {
                let line = lines.next(&mut wire).await?;
                match tagged(&line) {
                    Some(true) => return Ok(()),
                    Some(false) => return Err("imap_command_failed"),
                    None => {}
                }
                if changes_inbox(&line)? {
                    due.get_or_insert(Instant::now() + timing.coalesce);
                }
            }
        })
        .await?;
        *refreshed = true;
    }
}

/// Whether more wall-clock time passed between two resume checks than the
/// machine could have spent awake.
fn resumed(last: SystemTime, now: SystemTime) -> bool {
    now.duration_since(last)
        .is_ok_and(|elapsed| elapsed > RESUME_CHECK * 2)
}

/// `Some(true)` for this client's tagged OK, `Some(false)` for any other
/// tagged status, `None` for everything else. Status atoms are
/// case-insensitive.
fn tagged(line: &[u8]) -> Option<bool> {
    let status = line.strip_prefix(b"O1 ")?;
    Some(
        status.len() >= 2
            && status[..2].eq_ignore_ascii_case(b"OK")
            && status.get(2).is_none_or(u8::is_ascii_whitespace),
    )
}

/// Whether an untagged line reports an INBOX change. `* 12 EXISTS`,
/// `* 3 EXPUNGE` and `* 7 FETCH (FLAGS (\Seen))` do; `* OK Still here` and
/// `* 4 RECENT` do not. `* BYE` ends the session.
fn changes_inbox(line: &[u8]) -> Result<bool> {
    let text = String::from_utf8_lossy(line);
    let mut words = text.split_ascii_whitespace();
    if words.next() != Some("*") {
        return Ok(false);
    }
    let Some(first) = words.next() else {
        return Ok(false);
    };
    if first.eq_ignore_ascii_case("BYE") {
        return Err("mail_connection_closed");
    }
    if !first.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(false);
    }
    Ok(words.next().is_some_and(|kind| {
        ["EXISTS", "EXPUNGE", "FETCH"]
            .iter()
            .any(|wanted| kind.eq_ignore_ascii_case(wanted))
    }))
}

/// Response lines, read so that a timeout firing mid-line loses nothing: the
/// bytes consumed so far stay here for the next call. A line announcing a
/// literal is returned without the literal's octets, so a message fragment
/// can never pass for a tagged response or a BYE.
#[derive(Default)]
struct Lines {
    partial: Vec<u8>,
    head: Option<Vec<u8>>,
    skip: usize,
}

impl Lines {
    async fn next(&mut self, w: &mut Wire) -> Result<Vec<u8>> {
        loop {
            // `fill_buf` is cancel-safe, and nothing below awaits between
            // reading bytes and recording them.
            let buf = w.fill_buf().await.map_err(|_| "mail_network_failed")?;
            if buf.is_empty() {
                return Err("mail_connection_closed");
            }
            if self.skip > 0 {
                let n = self.skip.min(buf.len());
                w.consume(n);
                self.skip -= n;
                continue;
            }
            let n = buf
                .iter()
                .position(|b| *b == b'\n')
                .map_or(buf.len(), |n| n + 1);
            if self.partial.len() + n > 65536 {
                return Err("mail_response_too_large");
            }
            self.partial.extend_from_slice(&buf[..n]);
            w.consume(n);
            if !self.partial.ends_with(b"\n") {
                continue;
            }
            let segment = std::mem::take(&mut self.partial);
            match literal_length(&String::from_utf8_lossy(&segment)) {
                Some(Ok(size)) if size <= LIMIT => {
                    self.head.get_or_insert(segment);
                    self.skip = size;
                }
                Some(_) => return Err("imap_invalid_response"),
                None => return Ok(self.head.take().unwrap_or(segment)),
            }
        }
    }
}

#[cfg(test)]
mod tests;
