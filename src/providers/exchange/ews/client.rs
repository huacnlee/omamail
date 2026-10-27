//! Typed EWS operations over one signed-in connection.
//!
//! Callers pass Omamail ids and roles; `soap` builds the XML and `decode` reads it. Rules:
//!
//! - The first request on every stream is the folder lookup, which carries the credentials, so a
//!   wrong password shows there and nothing else is ever written first (a send must never be the
//!   request that discovers it).
//! - Reads are repeated once after a stream lost mid-request or a back-off the server asked for
//!   (at most five seconds); a write is never repeated except when its request was provably not
//!   written (`Lost::Unsent`) or answered 401 without credentials, which the server did not process.
//!   The one other repetition is an `UpdateItem` refused over a stale change key.
//! - An operation has a deadline (`until`). A read is cut at it; a write is never cut once written,
//!   so one starts only while its own whole request deadline still ends by then, and otherwise is
//!   `exchange_timeout` with nothing written. Until the server has accepted this client's
//!   credentials once, the sign-in is held to the same rule: a request with an unproven password
//!   that was cut could be counted by the directory as a failed logon that the latch below never
//!   heard of, so a stream is not even dialled unless its sign-in can run to the end. Once they
//!   have been accepted, a stream opened again (after one was lost, or for a read that waited for
//!   its turn) signs in with the time that is left, like a read.
//! - A 401 to credentials this client sent latches it: it answers `exchange_unauthorized` with no
//!   traffic until the account layer replaces it with one made for other credentials. A 401 to a
//!   request that carried none says only that the stream lost its sign-in, and latches nothing.
//! - A client whose first stream signed in with NTLM uses NTLM on every later one, so a server that
//!   stops offering it is refused rather than sent the password as Basic. Basic is never kept that
//!   way: a first stream that something stripped of NTLM must not decide every later one.
//! - Errors are static codes, never server text.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use super::{
    conn::{self, Choice, Config, Conn, Lost, status_code},
    decode::{self, Item, Rej},
    soap::{self, Change, Role},
    xml::Node,
};
use crate::providers::exchange::ids;

pub mod calendar;
pub mod detail;
pub mod folders;
pub mod meeting;
pub mod series;

const UNAUTHORIZED: &str = "exchange_unauthorized";
/// Two streams in a row lost their sign-in before a request: something in between keeps dropping it.
const SIGN_IN_LOST: &str = "exchange_auth_failed";
const NOT_ATTEMPTED: &str = "exchange_send_not_attempted";
const TIMEOUT: &str = "exchange_timeout";
/// A draft whose `CreateItem` may have been processed, though no answer said so.
const DRAFT_UNCONFIRMED: &str = "exchange_draft_unconfirmed";
/// A reply's longest back-off a read waits out.
const MAX_WAIT_MS: u32 = 5_000;
const FOLDERS_FRESH: Duration = Duration::from_secs(60);
/// A read response large enough to be parsed away from the async workers.
const BLOCKING_BYTES: usize = 256 * 1024;
pub const MAX_IDS: usize = 100;
/// Messages per `GetItem` with MIME: each can be megabytes.
pub const MAX_MIME_IDS: usize = 10;

pub type Outcome = Result<(), &'static str>;

/// A failed request's code, and whether a write may have been applied all the same.
type Failed = (&'static str, bool);

#[derive(Clone, Default)]
pub struct Folders(HashMap<Role, decode::Folder>);

impl Folders {
    pub fn get(&self, role: Role) -> Option<&decode::Folder> {
        self.0.get(&role)
    }

    pub fn role_of(&self, folder_id: &str) -> Option<Role> {
        if folder_id.is_empty() {
            return None;
        }
        Role::ALL.into_iter().find(|role| {
            self.0
                .get(role)
                .is_some_and(|folder| folder.id == folder_id)
        })
    }
}

/// A failed request: what the caller may do about it depends on what is known of its fate.
struct Fail {
    code: &'static str,
    wait_ms: Option<u32>,
    /// It may have reached the server.
    sent: bool,
    /// The stream died or answered 401 without being asked for credentials: safe to repeat.
    again: bool,
    /// The server said it did not act.
    unprocessed: bool,
}

impl Fail {
    fn of(rej: Rej) -> Fail {
        Fail {
            code: rej.code,
            wait_ms: rej.wait_ms,
            sent: true,
            again: false,
            unprocessed: rej.unprocessed,
        }
    }

    fn link(code: &'static str, sent: bool, again: bool) -> Fail {
        Fail {
            code,
            wait_ms: None,
            sent,
            again,
            unprocessed: false,
        }
    }
}

pub struct Client {
    config: Arc<Config>,
    conn: Option<Conn>,
    folders: Option<(Folders, Instant)>,
    version: Option<String>,
    rejected: bool,
    /// The server has accepted these credentials once: a later sign-in is not held to the rule for
    /// an unproven password (`open`).
    proven: bool,
    /// NTLM, once a stream signed in with it: every later stream must use it.
    signed_in_with: Option<Choice>,
    /// When the operation in hand must be over (`until`).
    deadline: Option<tokio::time::Instant>,
}

impl Client {
    pub fn new(config: Arc<Config>) -> Client {
        Client {
            config,
            conn: None,
            folders: None,
            version: None,
            rejected: false,
            proven: false,
            signed_in_with: None,
            deadline: None,
        }
    }

    /// The deadline of the operation about to run on this client.
    pub fn until(&mut self, deadline: tokio::time::Instant) {
        self.deadline = Some(deadline);
    }

    /// When a request that starts now must end, or `None` when it may not start: a read is cut at
    /// the deadline, a write never is, so it starts only while its whole request deadline fits.
    fn limit(&self, write: bool) -> Option<tokio::time::Instant> {
        let now = tokio::time::Instant::now();
        let whole = now + conn::clock(conn::DEADLINE);
        match self.deadline {
            None => Some(whole),
            Some(end) if write => (whole <= end).then_some(whole),
            Some(end) => (now < end).then_some(whole.min(end)),
        }
    }

    /// Whether a write could still start before the deadline.
    pub fn may_write(&self) -> bool {
        self.limit(true).is_some()
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// The server's `15.2.2562`, once an answer carried it.
    pub fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }

    /// The scheme the connection signed in with.
    pub fn scheme(&self) -> &'static str {
        self.conn.as_ref().map_or("", |conn| conn.scheme)
    }

    /// Drops the connection and the folders, never the refusal of a password or the scheme.
    #[cfg(test)]
    pub fn forget(&mut self) {
        self.conn = None;
        self.folders = None;
    }

    /// Whether the server refused the credentials this client sent.
    pub fn rejected(&self) -> bool {
        self.rejected
    }

    /// A refusal latched for these credentials before this client was made.
    pub fn refuse(&mut self) {
        self.rejected = true;
    }

    /// One request on `conn`, decoded to its operation element; past the deadline, nothing is sent.
    async fn round(&mut self, body: &str, write: bool) -> Result<Node, Fail> {
        let Some(until) = self.limit(write) else {
            return Err(Fail::link(TIMEOUT, false, false));
        };
        let conn = self.conn.as_mut().expect("a connection is open");
        let carried = conn.carries_credentials();
        let reply = match conn.post(body.as_bytes().to_vec(), until).await {
            Ok(reply) => reply,
            Err(Lost::Unsent) => return Err(Fail::link("exchange_connection_closed", false, true)),
            Err(Lost::Sent(code)) => {
                return Err(Fail::link(code, true, code == "exchange_connection_closed"));
            }
        };
        match reply.status {
            200 | 500 => {}
            // Authentication comes before EWS: a 401 was not processed, and without credentials the
            // server lost the sign-in of this stream.
            401 => return Err(Fail::link(UNAUTHORIZED, true, !carried)),
            status => {
                // A throttle names its own wait or leaves it to us (zero).
                let wait = matches!(status, 429 | 503)
                    .then(|| reply.retry_after.unwrap_or(0).saturating_mul(1000));
                let wait_ms = wait.map(|ms| u32::try_from(ms).unwrap_or(u32::MAX));
                return Err(Fail {
                    wait_ms,
                    ..Fail::link(status_code(status), true, false)
                });
            }
        }
        let bytes = reply.body;
        let decoded = if bytes.len() > BLOCKING_BYTES {
            tokio::task::spawn_blocking(move || decode::envelope(&bytes))
                .await
                .unwrap_or(Err(Rej::INVALID))
        } else {
            decode::envelope(&bytes)
        };
        let decoded = decoded.map_err(Fail::of)?;
        self.version = decoded.version.or(self.version.take());
        Ok(decoded.body)
    }

    /// Signs in and learns the folders with the first request of a new stream. That request carries
    /// the credentials. Until the server has accepted them once it is a write in all but name: it
    /// starts only while its whole request ends by the deadline and is never cut, and the stream is
    /// ready by the last moment it may start. Credentials already accepted sign in like a read.
    async fn open(&mut self) -> Result<(), &'static str> {
        self.conn = None;
        let choice = self.signed_in_with.unwrap_or(self.config.choice);
        let now = tokio::time::Instant::now();
        let until = match self.deadline {
            _ if self.proven => self.limit(false).ok_or(TIMEOUT)?,
            None => now + conn::clock(conn::DEADLINE),
            Some(end) => end
                .checked_sub(conn::clock(conn::DEADLINE))
                .filter(|start_by| *start_by > now)
                .ok_or(TIMEOUT)?,
        };
        self.conn = Some(Conn::open(&self.config, choice, until).await?);
        let unproven = !self.proven;
        let found = match self.round(&soap::get_folders(&Role::ALL), unproven).await {
            Ok(node) => decode::folders(&node, Role::ALL.len()).map_err(|rej| rej.code),
            Err(fail) => Err(fail.code),
        };
        match found
            .and_then(|found| folders_of(found, self.folders.as_ref().map(|(known, _)| known)))
        {
            Ok(folders) => {
                self.folders = Some((folders, Instant::now()));
                self.proven = true;
                if self.scheme() == "ntlm" {
                    self.signed_in_with = Some(Choice::Ntlm);
                }
                Ok(())
            }
            Err(code) => Err(self.poison(code)),
        }
    }

    /// A stream that can carry a request, signed in if it has to be; whether it was just opened.
    pub async fn ready(&mut self) -> Result<bool, &'static str> {
        if self.rejected {
            return Err(UNAUTHORIZED);
        }
        if let Some(conn) = &mut self.conn
            && conn.usable().await
        {
            return Ok(false);
        }
        self.open().await.map(|()| true)
    }

    fn poison(&mut self, code: &'static str) -> &'static str {
        if code == UNAUTHORIZED {
            self.rejected = true;
        }
        self.conn = None;
        code
    }

    /// One request and its decoded answer, repeated at most once under the rules of the module
    /// header (`read`: it changes nothing).
    async fn call<T>(
        &mut self,
        body: &str,
        read: bool,
        decode: impl Fn(&Node) -> Result<T, Rej>,
    ) -> Result<T, &'static str> {
        self.exchange(body, read, decode)
            .await
            .map_err(|(code, _)| code)
    }

    /// `call`, saying of a failure whether the write may have been applied: it was written and
    /// neither a 401 nor the server's own word says it was not processed.
    async fn exchange<T>(
        &mut self,
        body: &str,
        read: bool,
        decode: impl Fn(&Node) -> Result<T, Rej>,
    ) -> Result<T, Failed> {
        let mut repeated = false;
        loop {
            self.ready().await.map_err(|code| (code, false))?;
            let fail = match self
                .round(body, !read)
                .await
                .and_then(|node| decode(&node).map_err(Fail::of))
            {
                Ok(value) => return Ok(value),
                Err(fail) => fail,
            };
            // Not written for want of time: there is no more time to write it in.
            let late = !fail.sent && fail.code == TIMEOUT;
            let again =
                !late && (!fail.sent || (fail.again && (read || fail.code == UNAUTHORIZED)));
            // No hint is a second; a wait that would outlast the deadline is not waited.
            let wait = fail
                .wait_ms
                .filter(|ms| read && *ms <= MAX_WAIT_MS)
                .map(|ms| Duration::from_millis(if ms == 0 { 1000 } else { u64::from(ms) }))
                .filter(|wait| {
                    self.deadline
                        .is_none_or(|end| tokio::time::Instant::now() + *wait < end)
                });
            if late || repeated || !(again || wait.is_some()) {
                let applied = fail.sent && !fail.unprocessed && fail.code != UNAUTHORIZED;
                return Err(match fail.code {
                    // Only a 401 to credentials this client sent refuses the password.
                    UNAUTHORIZED if fail.again => {
                        self.conn = None;
                        (SIGN_IN_LOST, false)
                    }
                    UNAUTHORIZED => (self.poison(UNAUTHORIZED), false),
                    code => (code, applied),
                });
            }
            repeated = true;
            if again {
                // A lost stream or a bare 401 is signed in afresh.
                self.conn = None;
            } else if let Some(wait) = wait {
                tokio::time::sleep(wait).await;
            }
        }
    }

    /// The folder table, at most a minute old.
    pub async fn folders(&mut self) -> Result<Folders, &'static str> {
        self.ready().await?;
        match &self.folders {
            Some((folders, at)) if at.elapsed() < FOLDERS_FRESH => Ok(folders.clone()),
            _ => self.refresh().await,
        }
    }

    /// The folder table as the server has it now, counts included.
    pub async fn refresh(&mut self) -> Result<Folders, &'static str> {
        // A stream just opened has asked already.
        if let (true, Some((folders, _))) = (self.ready().await?, &self.folders) {
            return Ok(folders.clone());
        }
        let found = self
            .call(&soap::get_folders(&Role::ALL), true, |node| {
                decode::folders(node, Role::ALL.len())
            })
            .await?;
        let folders = folders_of(found, self.folders.as_ref().map(|(known, _)| known))?;
        self.folders = Some((folders.clone(), Instant::now()));
        Ok(folders)
    }

    /// Items by Omamail id, one result per id in request order; MIME only for the few that fit.
    pub async fn items(
        &mut self,
        omamail: &[String],
        mime: bool,
    ) -> Result<Vec<Result<Item, &'static str>>, &'static str> {
        let wire = wire_ids(omamail, if mime { MAX_MIME_IDS } else { MAX_IDS })?;
        let found = self
            .call(&soap::get_items(&wire, mime), true, |node| {
                whole(decode::get(node, wire.len(), mime)?)
            })
            .await?;
        // Keyed by the id asked for: the server need not spell an id the same way twice.
        Ok(found
            .into_iter()
            .zip(wire)
            .map(|(item, asked)| {
                item.map(|item| Item { id: asked, ..item })
                    .map_err(|rej| rej.code)
            })
            .collect())
    }

    /// One `FindItem` over one folder.
    pub async fn find(
        &mut self,
        role: Role,
        limit: usize,
        offset: usize,
        conditions: &[soap::Condition],
        phrase: Option<&str>,
    ) -> Result<decode::Found, &'static str> {
        self.call(
            &soap::find_items(role, limit, offset, conditions, phrase),
            true,
            decode::find,
        )
        .await
    }

    /// How many items in `role` match `conditions`, counted up to `limit`, and whether that was all.
    pub async fn count(
        &mut self,
        role: Role,
        limit: usize,
        conditions: &[soap::Condition],
    ) -> Result<(u64, bool), &'static str> {
        self.call(
            &soap::count_items(role, limit, conditions),
            true,
            decode::count,
        )
        .await
    }

    /// Sets the read flag or follow-up flag; one outcome per distinct id, repeats sharing it.
    pub async fn mark(
        &mut self,
        omamail: &[String],
        change: Change,
    ) -> Result<Vec<Outcome>, &'static str> {
        let wire = wire_ids(omamail, MAX_IDS)?;
        let mut done: Vec<Option<Outcome>> = vec![None; wire.len()];
        let mut pending: Vec<usize> = (0..wire.len()).collect();
        // A key goes stale when anything changes the item; those items alone get fresh keys once.
        for round in 0..2 {
            let ids: Vec<String> = pending.iter().map(|&at| wire[at].clone()).collect();
            let keys = match self.keys(&ids).await {
                Ok(keys) => keys,
                Err(code) => {
                    pending.iter().for_each(|&at| done[at] = Some(Err(code)));
                    break;
                }
            };
            let (mut asked, mut items) = (Vec::new(), Vec::new());
            for (&at, key) in pending.iter().zip(keys) {
                match key {
                    Ok(key) => {
                        items.push((wire[at].clone(), key));
                        asked.push(at);
                    }
                    Err(code) => done[at] = Some(Err(code)),
                }
            }
            if items.is_empty() {
                break;
            }
            let answers = self
                .call(&soap::update_items(&items, &change), false, |node| {
                    decode::outcomes(node, "UpdateItem", items.len())
                })
                .await;
            let answers = match answers {
                Ok(answers) => answers,
                Err(code) => {
                    asked.iter().for_each(|&at| done[at] = Some(Err(code)));
                    break;
                }
            };
            pending.clear();
            for (&at, answer) in asked.iter().zip(answers) {
                match answer {
                    Ok(()) => done[at] = Some(Ok(())),
                    Err(rej) if rej.code == decode::STALE && round == 0 => pending.push(at),
                    Err(rej) => done[at] = Some(Err(rej.code)),
                }
            }
            if pending.is_empty() {
                break;
            }
        }
        Ok(spread(omamail, &wire, done))
    }

    async fn keys(
        &mut self,
        ids: &[String],
    ) -> Result<Vec<Result<String, &'static str>>, &'static str> {
        let found = self
            .call(&soap::get_keys(ids), true, |node| {
                whole(decode::keys(node, ids.len())?)
            })
            .await?;
        Ok(found
            .into_iter()
            .map(|key| key.map(|(_, key)| key).map_err(|rej| rej.code))
            .collect())
    }

    /// Moves messages to the folder of `role`. An EWS id changes on a move, so outcomes are
    /// reported for the ids that were asked about.
    pub async fn move_to(
        &mut self,
        omamail: &[String],
        role: Role,
    ) -> Result<Vec<Outcome>, &'static str> {
        if self.folders().await?.get(role).is_none() {
            return Err(decode::FOLDER);
        }
        let wire = wire_ids(omamail, MAX_IDS)?;
        let answers = match self
            .call(&soap::move_items(&wire, role), false, |node| {
                decode::outcomes(node, "MoveItem", wire.len())
            })
            .await
        {
            Ok(answers) => answers,
            Err(code) => return Ok(vec![Err(code); omamail.len()]),
        };
        let done = answers
            .into_iter()
            .map(|answer| Some(answer.map_err(|rej| rej.code)))
            .collect();
        Ok(spread(omamail, &wire, done))
    }

    /// Sends one message and files a copy in Sent. `Ok` only on the server's confirmation:
    /// `exchange_send_not_attempted` says nothing was written, `exchange_send_rejected` that the
    /// server refused it, anything else (`exchange_send_failed`) that it may have been accepted
    /// and is never sent again by this client. Like every write it starts only while its request
    /// deadline ends by the client's (`until`), so the turn, a stream and the signed-in folder
    /// lookup get what is left before that, and a sign-in that ends later leaves it unwritten.
    pub async fn send(&mut self, mime: &[u8]) -> Result<(), &'static str> {
        if mime.len() > crate::message::MAX_MESSAGE {
            return Err(decode::TOO_LARGE);
        }
        // Signed in before the message is written: a refused password or a dead stream is found by
        // the folder lookup, never by the request that carries the message. A sign-in with an
        // unproven password is not cut (`open`); a message whose request no longer fits after it is
        // not written (`round`).
        self.ready().await.map_err(|_| NOT_ATTEMPTED)?;
        let sent = match self.round(&soap::send_message(mime), true).await {
            Ok(node) => decode::outcomes(&node, "CreateItem", 1).map_err(Fail::of),
            Err(fail) => Err(fail),
        };
        match sent.map(|mut answers| answers.pop()) {
            Ok(Some(Ok(()))) => Ok(()),
            Ok(Some(Err(rej))) => Err(send_code(rej.code, rej.unprocessed)),
            Ok(None) => Err("exchange_send_failed"),
            // Not written for want of time: the stream signed in for it is kept for the next try.
            Err(fail) if !fail.sent && fail.code == TIMEOUT => Err(NOT_ATTEMPTED),
            Err(fail) => {
                // A lost stream, an unreadable answer and any HTTP status leave it unknown (a
                // gateway can answer 503 for a request its backend ran); a 401 or a request that
                // was not written proves nothing was sent. A 401 latches only credentials it refused.
                self.poison(if fail.code == UNAUTHORIZED && !fail.again {
                    UNAUTHORIZED
                } else {
                    ""
                });
                Err(if !fail.sent || fail.code == UNAUTHORIZED {
                    NOT_ATTEMPTED
                } else {
                    send_code(fail.code, fail.unprocessed)
                })
            }
        }
    }

    /// Files one MIME message in Drafts. Like any write it is repeated only when the request
    /// provably was not processed; one whose answer was lost is `exchange_draft_unconfirmed`, since
    /// the draft may be in Drafts already.
    pub async fn save_draft(&mut self, mime: &[u8]) -> Result<(), &'static str> {
        if mime.len() > crate::message::MAX_MESSAGE {
            return Err(decode::TOO_LARGE);
        }
        if self.folders().await?.get(Role::Drafts).is_none() {
            return Err(decode::FOLDER);
        }
        let answer = self
            .exchange(&soap::save_draft(mime), false, |node| {
                decode::outcomes(node, "CreateItem", 1)
            })
            .await;
        match answer {
            Ok(mut answers) => answers
                .pop()
                .unwrap_or(Err(Rej::INVALID))
                .map_err(|rej| rej.code),
            Err((_, true)) => Err(DRAFT_UNCONFIRMED),
            Err((code, false)) => Err(code),
        }
    }

    /// Deletes one draft, and only an item the server says is in Drafts: anything else is
    /// `exchange_message_not_found` and nothing is deleted.
    pub async fn delete_draft(&mut self, omamail: &str) -> Result<(), &'static str> {
        let drafts = self
            .folders()
            .await?
            .get(Role::Drafts)
            .map(|folder| folder.id.clone())
            .ok_or(decode::FOLDER)?;
        let asked = [omamail.to_owned()];
        let item = self
            .items(&asked, false)
            .await?
            .pop()
            .unwrap_or(Err(decode::NOT_FOUND))?;
        if item.folder != drafts {
            return Err(decode::NOT_FOUND);
        }
        let wire = wire_ids(&asked, 1)?;
        let mut answers = self
            .call(&soap::delete_items(&wire), false, |node| {
                decode::outcomes(node, "DeleteItem", 1)
            })
            .await?;
        answers
            .pop()
            .unwrap_or(Err(Rej::INVALID))
            .map_err(|rej| rej.code)
    }
}

fn send_code(code: &'static str, unprocessed: bool) -> &'static str {
    match code {
        // A message over the server's size limit is refused like any other, and so is one the
        // server would not take for want of a folder or of rights: nothing went out.
        decode::REJECTED | decode::TOO_LARGE | decode::FOLDER | decode::DENIED => decode::REJECTED,
        // The server said it did not act, except stale-key codes, which belong to `UpdateItem`.
        _ if unprocessed && code != decode::STALE => "exchange_send_not_attempted",
        _ => "exchange_send_failed",
    }
}

/// Every message of a batch told to wait is the whole request turned away, which a read repeats.
fn whole<T>(results: Vec<Result<T, Rej>>) -> Result<Vec<Result<T, Rej>>, Rej> {
    let worst = results
        .iter()
        .filter_map(|result| result.as_ref().err())
        .filter(|rej| rej.wait_ms.is_some())
        .max_by_key(|rej| rej.wait_ms);
    match worst {
        Some(rej)
            if results.iter().all(Result::is_err)
                && results
                    .iter()
                    .all(|r| r.as_ref().err().is_some_and(|e| e.wait_ms.is_some())) =>
        {
            Err(*rej)
        }
        _ => Ok(results),
    }
}

fn wire_ids(omamail: &[String], max: usize) -> Result<Vec<String>, &'static str> {
    if omamail.is_empty() || omamail.len() > max {
        return Err("invalid_params");
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for id in omamail {
        let wire = ids::decode(id)?;
        // An id given twice is sent once: both copies would carry the same change key.
        if seen.insert(wire.clone()) {
            out.push(wire);
        }
    }
    Ok(out)
}

/// One outcome per id as asked, repeats sharing the outcome of their first.
fn spread(omamail: &[String], wire: &[String], done: Vec<Option<Outcome>>) -> Vec<Outcome> {
    omamail
        .iter()
        .map(|id| {
            let at = ids::decode(id)
                .ok()
                .and_then(|id| wire.iter().position(|w| *w == id));
            at.and_then(|at| done[at])
                .unwrap_or(Err("exchange_invalid_response"))
        })
        .collect()
}

/// The table from one `GetFolder` answer. A missing Inbox ends the sign-in; another folder that is
/// not there is absent, and one that could not be read keeps what was last known of it.
fn folders_of(
    found: Vec<Result<decode::Folder, Rej>>,
    known: Option<&Folders>,
) -> Result<Folders, &'static str> {
    let mut folders = Folders::default();
    for (role, result) in Role::ALL.into_iter().zip(found) {
        match result {
            Ok(folder) => {
                folders.0.insert(role, folder);
            }
            Err(rej) if role == Role::Inbox => return Err(rej.code),
            Err(rej) if rej.code != decode::FOLDER => {
                if let Some(old) = known.and_then(|known| known.get(role)) {
                    folders.0.insert(role, old.clone());
                }
            }
            Err(_) => {}
        }
    }
    Ok(folders)
}
