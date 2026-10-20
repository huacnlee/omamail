//! Listing a folder and searching, with stateless page tokens.
//!
//! A folder is listed newest first by a cursor on received time rather than by offset, which moves
//! when mail arrives or leaves (trashing from the list would skip rows). `DateTimeReceived` is whole
//! seconds, so a request bounds at the end of the cursor's second and that second's rows come back:
//! the token names the ids already shown from it and they are dropped. A second holding as many rows
//! as one request can ask for cannot be paged past.
//!
//! A text search asks one folder per request (a live Exchange 15.2 answers `ErrorInvalidOperation` to
//! a `QueryString` over several), merges the newest rows of Inbox, Sent and Drafts, and continues
//! each folder from its own offset: the rows a page took from a folder are a prefix of that folder's
//! answer, so its next offset is where it asked plus what was used. Rows fetched and not used are
//! fetched again, and mail arriving or leaving between pages can repeat or skip a result, as
//! Microsoft's paged-search guidance warns.
//!
//! A token comes from the caller: it is bound to its query, bounded and checked, and not signed (a
//! forged one shows another slice of the caller's own mailbox).

use std::{cmp::Reverse, collections::BTreeMap};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

use super::{
    client::{Client, MAX_IDS},
    decode::{self, Found, Item},
    soap::{Condition, Role},
};
use crate::providers::exchange::{
    ids,
    query::{self, Query},
};

const INVALID: &str = "invalid_params";
const MAX_TOKEN: usize = 32 * 1024;
/// 9999-12-31T23:59:58.999Z, so the end of its second is still a four-digit year.
const MAX_MS: i64 = 253_402_300_798_999;
const MAX_OFFSET: u32 = 1_000_000;
/// Shown as "about N": a forged figure is bounded, not believed.
const MAX_ESTIMATE: u64 = 100_000_000;
/// How many items of a flagged view are counted one by one before a server's total is believed.
const COUNTED: usize = 1000;
const SEARCHED: [(&str, Role); 3] = [
    ("inbox", Role::Inbox),
    ("sent", Role::Sent),
    ("drafts", Role::Drafts),
];

pub struct Page {
    pub items: Vec<Item>,
    pub next: Option<String>,
    pub estimate: u64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Token {
    q: String,
    /// A folder listing: the received time of the last row shown and the ids shown from its second.
    t: Option<i64>,
    #[serde(default)]
    s: Vec<String>,
    /// A search: the offset of each folder still to ask.
    o: Option<BTreeMap<String, u32>>,
    e: u64,
}

impl Token {
    fn decode(token: &str, query: &Query) -> Result<Token, &'static str> {
        let bytes = URL_SAFE_NO_PAD.decode(token).map_err(|_| INVALID)?;
        let token: Token = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
        let shape = match (&query, token.t, &token.o) {
            (Query::Folder { .. }, Some(t), None) => {
                (0..=MAX_MS).contains(&t)
                    && token.s.len() <= MAX_IDS
                    && token.s.iter().all(|id| ids::validate(id).is_ok())
            }
            (Query::Text(_), None, Some(o)) => {
                token.s.is_empty()
                    && !o.is_empty()
                    && o.iter().all(|(name, at)| {
                        SEARCHED.iter().any(|(n, _)| n == name) && *at <= MAX_OFFSET
                    })
            }
            _ => false,
        };
        if token.q != query.canonical() || !shape || token.e > MAX_ESTIMATE {
            return Err(INVALID);
        }
        Ok(token)
    }

    fn encode(&self) -> Option<String> {
        let token = URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).ok()?);
        (token.len() <= MAX_TOKEN).then_some(token)
    }
}

fn second(ms: i64) -> i64 {
    ms.div_euclid(1000)
}

impl Client {
    /// One page of `query`: `limit` is 1 to 100 and `token` the `next` of the previous page of the
    /// same query. `estimate` is the rows if the listing ends here, else a count the server gave
    /// (the folder's unread or total count, the view's total for flagged, the sum of a search's
    /// folders), carried by the token afterwards.
    pub async fn list(
        &mut self,
        query: &Query,
        limit: usize,
        token: Option<&str>,
    ) -> Result<Page, &'static str> {
        if !(1..=MAX_IDS).contains(&limit) {
            return Err(INVALID);
        }
        let token = token.map(|token| Token::decode(token, query)).transpose()?;
        match query {
            Query::Folder {
                role,
                unread,
                flagged,
            } => {
                self.folder_page(query, (*role, *unread, *flagged), limit, token)
                    .await
            }
            Query::Text(text) => self.search_page(query, text, limit, token).await,
        }
    }

    async fn folder_page(
        &mut self,
        query: &Query,
        (role, unread, flagged): (Role, bool, bool),
        limit: usize,
        token: Option<Token>,
    ) -> Result<Page, &'static str> {
        // The first page reads the counts it reports; later pages use the table they came with.
        let folders = if token.is_none() {
            self.refresh().await?
        } else {
            self.folders().await?
        };
        let folder = folders.get(role).ok_or(decode::FOLDER)?;
        let cursor = token.as_ref().and_then(|token| token.t);
        let shown = token.as_ref().map_or(&[][..], |token| &token.s[..]);
        let mut conditions = Vec::new();
        conditions.extend(cursor.map(Condition::ReceivedBy));
        conditions.extend(unread.then_some(Condition::Unread));
        conditions.extend(flagged.then_some(Condition::Flagged));
        // Rows of the boundary second already shown can fill the answer: ask for them too.
        let found = self
            .find(
                role,
                (limit + shown.len()).min(MAX_IDS),
                0,
                &conditions,
                None,
            )
            .await?;
        let (total, includes_last) = (found.total, found.last);
        let mut rows: Vec<Item> = found
            .items
            .into_iter()
            .filter(|item| !shown.contains(&ids::encode(&item.id).unwrap_or_default()))
            .filter(|item| match (item.received_ms, cursor) {
                (Some(ms), Some(newest)) => second(ms) <= second(newest),
                _ => true,
            })
            .collect();
        rows.sort_by_key(|item| Reverse(item.received_ms));
        let more = !includes_last || rows.len() > limit;
        rows.truncate(limit);
        let estimate = match &token {
            Some(token) => token.e,
            None => {
                let counted = if unread { folder.unread } else { folder.total };
                let fallback = rows.len() as u64 + u64::from(more);
                // A flagged view has no folder count, and the server's `TotalItemsInView` for it
                // was seen minutes behind on a live server: a page that holds all of it is the
                // count, and when it does not, the matching items are counted.
                let count = match (flagged, more) {
                    (false, _) => counted,
                    (true, false) => rows.len() as u64,
                    (true, true) => match self.count(role, COUNTED, &conditions).await? {
                        (listed, true) => listed,
                        (listed, false) => listed.max(total.unwrap_or(0)),
                    },
                };
                count.max(fallback).min(MAX_ESTIMATE)
            }
        };
        let next = more
            .then(|| next_cursor(query, &rows, cursor, shown, estimate))
            .flatten();
        Ok(Page {
            items: rows,
            next,
            estimate,
        })
    }

    async fn search_page(
        &mut self,
        query: &Query,
        text: &str,
        limit: usize,
        token: Option<Token>,
    ) -> Result<Page, &'static str> {
        let folders = self.folders().await?;
        let have = |name: &str| {
            SEARCHED
                .iter()
                .find(|(n, _)| *n == name)
                .filter(|(_, role)| folders.get(*role).is_some())
        };
        // A token's folder the account no longer has is dropped; none left is no search.
        let plan: Vec<(&str, Role, u32)> = match &token {
            None => SEARCHED
                .iter()
                .filter(|(_, role)| folders.get(*role).is_some())
                .map(|(name, role)| (*name, *role, 0))
                .collect(),
            Some(token) => token
                .o
                .iter()
                .flatten()
                .filter_map(|(name, at)| have(name).map(|(name, role)| (*name, *role, *at)))
                .collect(),
        };
        if plan.is_empty() {
            return Err(decode::FOLDER);
        }
        let phrase = query::phrase(text);
        let mut lanes: Vec<(&str, u32, Found, usize)> = Vec::new();
        for (name, role, at) in plan {
            let found = self
                .find(role, limit, at as usize, &[], Some(&phrase))
                .await?;
            lanes.push((name, at, found, 0));
        }
        let sum = lanes
            .iter()
            .try_fold(0u64, |sum, lane| sum.checked_add(lane.2.total?));
        // The newest `limit` rows by their fronts only, so each folder's share is a prefix.
        let newest = |lane: &(&str, u32, Found, usize)| {
            lane.2.items.get(lane.3).map(|item| {
                (
                    Reverse(item.received_ms),
                    ids::encode(&item.id).unwrap_or_default(),
                )
            })
        };
        let mut rows = Vec::new();
        while rows.len() < limit {
            let Some(best) = (0..lanes.len())
                .filter(|&i| newest(&lanes[i]).is_some())
                .min_by_key(|&i| newest(&lanes[i]))
            else {
                break;
            };
            rows.push(lanes[best].2.items[lanes[best].3].clone());
            lanes[best].3 += 1;
        }
        let resume: BTreeMap<String, u32> = lanes
            .iter()
            .filter(|(_, _, found, used)| {
                !(*used == found.items.len() && (found.last || found.items.is_empty()))
            })
            .filter_map(|(name, at, _, used)| {
                u32::try_from(u64::from(*at) + *used as u64)
                    .ok()
                    .filter(|at| *at <= MAX_OFFSET)
                    .map(|at| ((*name).to_owned(), at))
            })
            .collect();
        let estimate = match &token {
            Some(token) => token.e,
            None if resume.is_empty() => rows.len() as u64,
            None => sum.unwrap_or(0).max(rows.len() as u64 + 1),
        }
        .min(MAX_ESTIMATE);
        let next = (!resume.is_empty())
            .then(|| {
                Token {
                    q: query.canonical(),
                    o: Some(resume),
                    e: estimate,
                    ..Token::default()
                }
                .encode()
            })
            .flatten();
        Ok(Page {
            items: rows,
            next,
            estimate,
        })
    }
}

/// The cursor after `rows`: their last time, with the ids shown from that second (the previous
/// page's too when it is the same second). `None` when the page cannot be continued.
fn next_cursor(
    query: &Query,
    rows: &[Item],
    previous: Option<i64>,
    shown: &[String],
    estimate: u64,
) -> Option<String> {
    // A row without a time is in no second, and the restriction never matches it.
    let boundary = rows.iter().rev().find_map(|item| item.received_ms)?;
    let mut skip: Vec<String> = rows
        .iter()
        .filter(|item| item.received_ms.map(second) == Some(second(boundary)))
        .filter_map(|item| ids::encode(&item.id).ok())
        .collect();
    if previous.is_some_and(|previous| second(previous) == second(boundary)) {
        skip.extend(shown.iter().cloned());
    }
    // A request that must skip as many rows as it may ask for cannot see past them.
    if skip.len() >= MAX_IDS || !(0..=MAX_MS).contains(&boundary) {
        return None;
    }
    Token {
        q: query.canonical(),
        t: Some(boundary),
        s: skip,
        e: estimate,
        ..Token::default()
    }
    .encode()
}
