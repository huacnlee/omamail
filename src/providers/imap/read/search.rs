//! Bounded account-wide scans with portable page cursors. In-progress work has
//! a continuation; completed snapshots are only a disposable paging cache.
use super::*;
mod cursor;
mod page;
use cursor::{Cursor, Position};
use futures_util::{StreamExt, stream::FuturesUnordered};
use sha2::{Digest, Sha256};
use std::sync::Weak;

const WORKERS: usize = 4;
const MAX_MESSAGES: usize = 250_000;
const MAX_UIDS: usize = 1_000_000;
const BATCH: usize = 4096;
const MAX_SNAPSHOTS: usize = 16;
const TTL: Duration = Duration::from_secs(300);
// A full body is read only to verify an All/Trash overlap. Larger candidates stay
// visible rather than risk the 32 MiB response ceiling failing the whole search.
const CONTENT_LIMIT: u64 = 8 * 1024 * 1024;
const CONTENT_BATCH: usize = 64;

#[derive(Clone, Copy, PartialEq)]
enum Identity {
    FolderUid,
    EmailId,
    GmailId,
    Candidate,
    Content,
}

struct Message {
    uid: u32,
    date: i64,
    size: u64,
    identity: Option<[u8; 32]>,
    candidate: Option<[u8; 32]>,
}

struct FolderScan {
    name: String,
    excluded: bool,
    aggregate: bool,
    rank: u8,
    validity: Option<u32>,
    pending: Vec<u32>,
    fetched: usize,
    messages: Vec<Message>,
}

impl FolderScan {
    fn size(&self) -> usize {
        self.pending.len() + self.messages.len()
    }
    fn done(&self) -> bool {
        self.validity.is_some() && self.fetched == self.pending.len()
    }
}

struct Snapshot {
    token: String,
    owner: [u8; 32],
    authorization: [u8; 32],
    request: String,
    page_request: String,
    criteria: String,
    since: Instant,
    identity: Identity,
    folders: Vec<FolderScan>,
    ordered: Option<Vec<(usize, usize)>>,
    paging: bool,
    verified: BTreeSet<(usize, usize)>,
}

static SNAPSHOTS: OnceLock<tokio::sync::Mutex<Vec<Snapshot>>> = OnceLock::new();
type Gates = BTreeMap<[u8; 32], Weak<tokio::sync::Semaphore>>;
static GATES: OnceLock<tokio::sync::Mutex<Gates>> = OnceLock::new();

async fn gate(owner: [u8; 32]) -> Arc<tokio::sync::Semaphore> {
    let mut gates = GATES.get_or_init(Default::default).lock().await;
    gates.retain(|_, gate| gate.strong_count() > 0);
    if let Some(gate) = gates.get(&owner).and_then(Weak::upgrade) {
        return gate;
    }
    let gate = Arc::new(tokio::sync::Semaphore::new(WORKERS));
    gates.insert(owner, Arc::downgrade(&gate));
    gate
}

async fn worker<T>(
    gate: Arc<tokio::sync::Semaphore>,
    work: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(12), async {
        let _permit = gate.acquire().await.map_err(|_| "worker_failed")?;
        work.await
    })
    .await
    .unwrap_or(Err("request_timed_out"))
}

fn owner(p: &Value) -> [u8; 32] {
    let settings = &p["settings"];
    Sha256::digest(
        json!([
            p["accountId"],
            settings["imapHost"]
                .as_str()
                .unwrap_or("")
                .to_ascii_lowercase(),
            settings["imapPort"],
            settings["username"],
            p["oauth"] == true
        ])
        .to_string(),
    )
    .into()
}

fn authorization(p: &Value) -> [u8; 32] {
    // A changed credential/transport must authenticate on the wire before it
    // can reuse results. This digest stays private, never inside a cursor.
    Sha256::digest(json!([p["settings"], p["credential"], p["oauth"]]).to_string()).into()
}

fn token() -> Result<String> {
    let mut bytes = [0; 24];
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut bytes)
        .map_err(|_| "random_unavailable")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn has_role(folder: &Folder, boxes: &Mailboxes, role: &str) -> bool {
    folder
        .flags
        .iter()
        .any(|flag| flag.eq_ignore_ascii_case(role))
        || boxes
            .special
            .get(role)
            .is_some_and(|name| name == &folder.name)
}

fn plan(boxes: &Mailboxes, p: &Value, criteria: String) -> Result<Snapshot> {
    let aggregate = boxes.folders.iter().any(|f| has_role(f, boxes, "\\all"));
    let capability = |name: &str| {
        boxes
            .capabilities
            .iter()
            .any(|c| c.eq_ignore_ascii_case(name))
    };
    let identity = if capability("OBJECTID") {
        Identity::EmailId
    } else if capability("X-GM-EXT-1") {
        Identity::GmailId
    } else if aggregate {
        Identity::Candidate
    } else {
        Identity::FolderUid
    };
    let mut folders = Vec::new();
    for folder in &boxes.folders {
        if has_role(folder, boxes, "\\noselect") || has_role(folder, boxes, "\\flagged") {
            continue;
        }
        let excluded = has_role(folder, boxes, "\\trash")
            || has_role(folder, boxes, "\\junk")
            || [
                "trash",
                "deleted items",
                "deleted messages",
                "junk",
                "junk email",
                "spam",
            ]
            .iter()
            .any(|name| folder.name.eq_ignore_ascii_case(name));
        // Excluded folders are read only to subtract their membership from All.
        if excluded && !aggregate {
            continue;
        }
        let all = has_role(folder, boxes, "\\all");
        // \All presents every message in the store (RFC 6154). Without a server
        // identity, physical folders would only add unverifiable duplicates of it.
        if identity == Identity::Candidate && !all && !excluded {
            continue;
        }
        folders.push(FolderScan {
            name: folder.name.clone(),
            excluded,
            aggregate: all,
            rank: if folder.name.eq_ignore_ascii_case("INBOX") {
                0
            } else if all {
                3
            } else if boxes.special.values().any(|n| n == &folder.name) {
                1
            } else {
                2
            },
            validity: None,
            pending: Vec::new(),
            fetched: 0,
            messages: Vec::new(),
        });
    }
    if folders.len() > 2048 || folders.iter().map(|f| f.name.len()).sum::<usize>() > 1_048_576 {
        return Err("mail_response_too_large");
    }
    Ok(Snapshot {
        token: token()?,
        owner: owner(p),
        authorization: authorization(p),
        request: p["requestToken"].as_str().unwrap_or("").into(),
        page_request: p["pageToken"].as_str().unwrap_or("").into(),
        criteria,
        since: Instant::now(),
        identity,
        folders,
        ordered: None,
        paging: false,
        verified: BTreeSet::new(),
    })
}

fn validity(data: &[u8]) -> Result<u32> {
    selected_number(data, "UIDVALIDITY")
}

fn selected_number(data: &[u8], wanted: &str) -> Result<u32> {
    for row in nodes(data)? {
        if row.len() >= 3 && row[0].is("*") && row[1].is("OK") {
            let code = row[2].string()?;
            if let Some((name, value)) = code.trim_matches(['[', ']']).split_once(' ') {
                if name.eq_ignore_ascii_case(wanted) {
                    return value
                        .parse::<u32>()
                        .ok()
                        .filter(|n| *n > 0)
                        .ok_or("imap_invalid_response");
                }
            }
        }
    }
    Err("imap_invalid_response")
}

async fn step(
    folder: &mut FolderScan,
    p: &Value,
    criteria: &str,
    identity: Identity,
    after: Option<&Position>,
) -> Result<()> {
    let (mut wire, key) = acquire(p).await?;
    let selected = command(&mut wire, &format!("SELECT {}", quote(&folder.name)?)).await?;
    let current = validity(&selected)?;
    if folder.validity.is_some_and(|old| old != current)
        || after.is_some_and(|a| a.folder == folder.name && a.validity != current)
    {
        return Err("imap_search_expired");
    }
    if folder.validity.is_none() {
        // SEARCH returns all matches on one line, whose transport limit is
        // 64 KiB. Inventory UIDs through separate FETCH responses instead,
        // then SEARCH only bounded windows of these existing UIDs. Capturing
        // UIDNEXT excludes later arrivals and avoids walking sparse UID gaps.
        let ceiling = selected_number(&selected, "UIDNEXT")? - 1;
        if ceiling > 0 {
            folder.pending = inventory(&mut wire, ceiling).await?;
        }
        if folder.pending.len() > MAX_UIDS {
            return Err("mail_response_too_large");
        }
        folder.validity = Some(current);
    } else if folder.fetched < folder.pending.len() {
        let end = if identity == Identity::Content {
            // Candidates were chosen at or under CONTENT_LIMIT, so one always fits.
            let mut end = folder.fetched;
            let mut bytes = 0;
            while end < folder.pending.len() && end - folder.fetched < CONTENT_BATCH {
                let size = folder
                    .messages
                    .binary_search_by_key(&folder.pending[end], |m| m.uid)
                    .map_or(CONTENT_LIMIT, |i| folder.messages[i].size);
                if end > folder.fetched && bytes + size > CONTENT_LIMIT {
                    break;
                }
                bytes += size;
                end += 1;
            }
            end
        } else {
            (folder.fetched + BATCH).min(folder.pending.len())
        };
        let inventory = &folder.pending[folder.fetched..end];
        let matches;
        let window = if identity == Identity::Content {
            inventory
        } else {
            let first = inventory[0];
            let last = inventory[inventory.len() - 1];
            let live = if folder.excluded { "" } else { "UNDELETED " };
            let data = command(
                &mut wire,
                &format!("UID SEARCH UID {first}:{last} {live}{criteria}"),
            )
            .await?;
            matches = search_uids(&data)?
                .into_iter()
                .filter(|uid| inventory.binary_search(uid).is_ok())
                .collect::<Vec<_>>();
            &matches
        };
        if window.is_empty() {
            folder.fetched = end;
            release(wire, key).await;
            return Ok(());
        }
        let set = window
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let field = match identity {
            Identity::FolderUid => "",
            Identity::Content => " BODY.PEEK[]",
            Identity::EmailId => " EMAILID",
            Identity::GmailId => " X-GM-MSGID",
            Identity::Candidate => " RFC822.SIZE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]",
        };
        let data = command(
            &mut wire,
            &format!("UID FETCH {set} (UID INTERNALDATE{field})"),
        )
        .await?;
        let messages = fetched(&data, window, identity)?;
        if identity == Identity::Content {
            for message in messages {
                if let Ok(index) = folder
                    .messages
                    .binary_search_by_key(&message.uid, |m| m.uid)
                {
                    folder.messages[index].identity = message.identity;
                }
            }
        } else {
            folder.messages.extend(messages);
        }
        folder.fetched = end;
    }
    release(wire, key).await;
    Ok(())
}

async fn inventory(wire: &mut Wire, ceiling: u32) -> Result<Vec<u32>> {
    write(
        wire,
        format!("O1 UID FETCH 1:{ceiling} (UID)\r\n").as_bytes(),
    )
    .await?;
    let mut uids = BTreeSet::new();
    response_each(wire, "O1", false, |record| {
        uids.extend(
            fetched_dates(record)?
                .into_keys()
                .filter(|uid| *uid <= ceiling),
        );
        if uids.len() > MAX_UIDS {
            return Err("mail_response_too_large");
        }
        Ok(())
    })
    .await?;
    Ok(uids.into_iter().collect())
}

impl Snapshot {
    fn refine(&mut self) {
        // Message-ID and size nominate candidates; they NEVER suppress a result.
        // Only compare bodies for candidates shared by All and Trash/Junk.
        let excluded: BTreeSet<_> = self
            .folders
            .iter()
            .filter(|f| f.excluded)
            .flat_map(|f| f.messages.iter().filter_map(|m| m.candidate))
            .collect();
        let candidates: BTreeSet<_> = self
            .folders
            .iter()
            .filter(|f| f.aggregate)
            .flat_map(|f| f.messages.iter().filter_map(|m| m.candidate))
            .filter(|id| excluded.contains(id))
            .collect();
        for folder in &mut self.folders {
            folder.pending = folder
                .messages
                .iter()
                .filter(|m| {
                    (folder.aggregate || folder.excluded)
                        && m.size <= CONTENT_LIMIT
                        && m.candidate.is_some_and(|id| candidates.contains(&id))
                })
                .map(|m| m.uid)
                .collect();
            folder.fetched = 0;
        }
        self.identity = Identity::Content;
    }

    fn finish(&mut self) {
        let excluded: BTreeSet<_> = self
            .folders
            .iter()
            .filter(|f| f.excluded)
            .flat_map(|f| f.messages.iter().filter_map(|m| m.identity))
            .collect();
        let mut ordered = Vec::new();
        for (f, folder) in self.folders.iter().enumerate().filter(|(_, f)| !f.excluded) {
            for (m, msg) in folder.messages.iter().enumerate() {
                // Only aggregate destinations need subtraction. A real copy in
                // Inbox remains a valid result even if a copy is in Trash.
                if !folder.aggregate || !msg.identity.is_some_and(|id| excluded.contains(&id)) {
                    ordered.push((f, m));
                }
            }
        }
        // A rescan may receive LIST in a different order. Choose the same
        // representative for a server-issued identity independently of that.
        ordered.sort_by(|(af, am), (bf, bm)| {
            let a = &self.folders[*af];
            let b = &self.folders[*bf];
            (a.rank, &a.name, a.messages[*am].uid).cmp(&(b.rank, &b.name, b.messages[*bm].uid))
        });
        let mut seen = BTreeMap::new();
        ordered.retain(|(f, m)| {
            self.folders[*f].messages[*m]
                .identity
                .is_none_or(|id| *seen.entry(id).or_insert(*f) == *f)
        });
        ordered.sort_by(|a, b| self.order(*a).cmp(&self.order(*b)));
        self.ordered = Some(ordered);
        self.paging = true;
        for folder in &mut self.folders {
            folder.pending = Vec::new();
            folder.fetched = 0;
        }
    }

    fn order(
        &self,
        (f, m): (usize, usize),
    ) -> (std::cmp::Reverse<i64>, &str, std::cmp::Reverse<u32>) {
        let folder = &self.folders[f];
        let message = &folder.messages[m];
        cursor::order(message.date, &folder.name, message.uid)
    }

    fn page(&self, cursor: Option<&Cursor>, limit: usize) -> Result<Value> {
        let ordered = self.ordered.as_ref().ok_or("imap_invalid_response")?;
        let offset = self.offset(cursor);
        let ids: Vec<_> = ordered
            .iter()
            .skip(offset)
            .take(limit)
            .map(|(f, m)| {
                format!(
                    "{}:{}",
                    self.folders[*f].messages[*m].uid, self.folders[*f].name
                )
            })
            .collect();
        let next = offset + ids.len();
        let next_cursor = if next < ordered.len() {
            let (f, m) = ordered[next - 1];
            let folder = &self.folders[f];
            let message = &folder.messages[m];
            Cursor::new(
                self.owner,
                &self.criteria,
                Position {
                    date: message.date,
                    folder: folder.name.clone(),
                    uid: message.uid,
                    validity: folder.validity.ok_or("imap_invalid_response")?,
                },
                self.token.clone(),
            )
            .encode()?
        } else {
            String::new()
        };
        Ok(
            json!({"page":{"ids":ids,"threadIds":[],"estimate":ordered.len(),
            "nextPageToken":next_cursor}}),
        )
    }

    fn offset(&self, cursor: Option<&Cursor>) -> usize {
        cursor.map_or(0, |c| {
            self.ordered.as_ref().map_or(0, |ordered| {
                ordered.partition_point(|i| self.order(*i) <= c.after.order())
            })
        })
    }
}

pub(super) async fn call(p: &Value) -> Result<Value> {
    let raw = p["query"]
        .as_str()
        .and_then(|q| q.strip_prefix("search:"))
        .ok_or("invalid_params")?;
    let (_, criteria) = query(&format!("folder:INBOX {raw}"))?;
    let limit = p["limit"].as_u64().unwrap_or(25).clamp(1, 100) as usize;
    let page = p["pageToken"].as_str().unwrap_or("");
    let continuation = p["continuation"].as_str().unwrap_or("");
    let owner = owner(p);
    let authorization = authorization(p);
    let cursor = if page.is_empty() {
        None
    } else {
        Some(Cursor::decode(page, owner, &criteria)?)
    };
    let id = if !continuation.is_empty() {
        if continuation.len() > 128 || !safe(continuation) {
            return Err("invalid_params");
        }
        continuation
    } else {
        cursor.as_ref().map_or("", |c| c.snapshot.as_str())
    };
    let cached = if !id.is_empty() {
        let mut snapshots = SNAPSHOTS.get_or_init(Default::default).lock().await;
        snapshots.retain(|s| s.since.elapsed() < TTL);
        let index = snapshots.iter().position(|s| {
            s.token == id
                && s.owner == owner
                && s.criteria == criteria
                && if continuation.is_empty() {
                    s.ordered.is_some() && !s.paging && s.authorization == authorization
                } else {
                    (s.ordered.is_none() || s.paging)
                        && s.request == p["requestToken"].as_str().unwrap_or("")
                        && s.page_request == page
                }
        });
        index.map(|index| snapshots.remove(index))
    } else {
        None
    };
    let mut snapshot = if let Some(mut snapshot) = cached {
        if continuation.is_empty() {
            snapshot.request = p["requestToken"].as_str().unwrap_or("").into();
            snapshot.page_request = page.into();
            snapshot.paging = true;
            snapshot.verified.clear();
        }
        snapshot
    } else {
        if !continuation.is_empty() {
            return Err("imap_search_expired");
        }
        let boxes = worker(gate(owner).await, async {
            let (mut wire, key) = acquire(p).await?;
            let boxes = mailboxes(&mut wire, p).await?;
            release(wire, key).await;
            Ok(boxes)
        })
        .await?;
        plan(&boxes, p, criteria)?
    };
    if snapshot.authorization != authorization {
        snapshot.verified.clear();
    }
    if snapshot.ordered.is_none() {
        let gate = gate(owner).await;
        let identity = snapshot.identity;
        let criteria = &snapshot.criteria;
        let after = cursor.as_ref().map(|c| &c.after);
        let mut work = FuturesUnordered::new();
        for folder in snapshot
            .folders
            .iter_mut()
            .filter(|f| !f.done())
            .take(WORKERS)
        {
            let gate = gate.clone();
            work.push(worker(gate, step(folder, p, criteria, identity, after)));
        }
        while let Some(result) = work.next().await {
            result?;
        }
        drop(work);
        if snapshot
            .folders
            .iter()
            .map(|f| f.pending.len())
            .sum::<usize>()
            > MAX_UIDS
            || snapshot
                .folders
                .iter()
                .map(|f| f.messages.len())
                .sum::<usize>()
                > MAX_MESSAGES
        {
            return Err("mail_response_too_large");
        }
        if snapshot.folders.iter().all(FolderScan::done) && snapshot.identity == Identity::Candidate
        {
            snapshot.refine();
        }
        if snapshot.folders.iter().all(FolderScan::done) {
            snapshot.finish();
        }
        snapshot.authorization = authorization;
        snapshot.since = Instant::now();
    } else {
        snapshot.paging = !snapshot.verify_page(p, cursor.as_ref(), limit).await?;
        snapshot.authorization = authorization;
    }
    let result = if snapshot.ordered.is_none() || snapshot.paging {
        json!({"page":{"ids":[],"threadIds":[],"estimate":0,"nextPageToken":""},"continuation":snapshot.token})
    } else {
        snapshot.verified.clear();
        snapshot.page(cursor.as_ref(), limit)?
    };
    let size = snapshot.folders.iter().map(FolderScan::size).sum::<usize>();
    let mut snapshots = SNAPSHOTS.get_or_init(Default::default).lock().await;
    snapshots.retain(|s| s.since.elapsed() < TTL);
    while snapshots.len() >= MAX_SNAPSHOTS
        || snapshots
            .iter()
            .map(|s| s.folders.iter().map(FolderScan::size).sum::<usize>())
            .sum::<usize>()
            + size
            > MAX_UIDS * 2
    {
        snapshots.remove(0);
    }
    snapshots.push(snapshot);
    Ok(result)
}

fn fetched(data: &[u8], window: &[u32], identity: Identity) -> Result<Vec<Message>> {
    let mut found = BTreeMap::new();
    for row in nodes(data)? {
        if row.len() < 4 || !row[0].is("*") || !row[2].is("FETCH") {
            continue;
        }
        let mut uid = None;
        let mut date = None;
        let mut id = None;
        let mut header = None;
        let mut size = None;
        for pair in row[3].list().as_chunks::<2>().0 {
            if pair[0].is("UID") {
                uid = pair[1].number();
            }
            if pair[0].is("INTERNALDATE") {
                date = Some(
                    chrono::DateTime::parse_from_str(
                        pair[1].string()?.trim(),
                        "%d-%b-%Y %H:%M:%S %z",
                    )
                    .map(|date| date.timestamp_millis())
                    .unwrap_or(0),
                );
            }
            if identity == Identity::Candidate
                && pair[0]
                    .text()
                    .to_ascii_uppercase()
                    .starts_with(b"BODY[HEADER")
            {
                header = Some(pair[1].text());
            }
            if pair[0].is("RFC822.SIZE") {
                size = pair[1].string()?.parse::<u64>().ok();
            }
            let bytes = match identity {
                Identity::Content if pair[0].is("BODY[]") => Some(pair[1].text()),
                Identity::GmailId if pair[0].is("X-GM-MSGID") => Some(pair[1].text()),
                Identity::EmailId if pair[0].is("EMAILID") => {
                    pair[1].list().first().map(Node::text)
                }
                _ => None,
            };
            if let Some(bytes) = bytes.filter(|bytes| !bytes.is_empty() && *bytes != b"NIL") {
                id = Some(Sha256::digest(bytes).into());
            }
        }
        if let (Some(uid), Some(date)) = (uid, date) {
            if window.binary_search(&uid).is_ok() {
                if matches!(
                    identity,
                    Identity::EmailId | Identity::GmailId | Identity::Content
                ) && id.is_none()
                {
                    return Err("imap_invalid_response");
                }
                let candidate = if identity == Identity::Candidate {
                    let mut hash = Sha256::new();
                    hash.update(size.ok_or("imap_invalid_response")?.to_be_bytes());
                    // An absent Message-ID is an empty field, never a wildcard:
                    // the size still has to match before any body is read.
                    hash.update(header.ok_or("imap_invalid_response")?);
                    Some(hash.finalize().into())
                } else {
                    None
                };
                found.insert(
                    uid,
                    Message {
                        uid,
                        date,
                        size: size.unwrap_or(0),
                        identity: id,
                        candidate,
                    },
                );
            }
        }
    }
    Ok(found.into_values().collect())
}

#[cfg(test)]
mod tests;
