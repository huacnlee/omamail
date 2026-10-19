//! Microsoft Graph mail operations: the documented `/v1.0/me` API, typed and bounded.
//!
//! Folders are found by their well-known names. A listing is Graph's own paging: the token that
//! continues one carries the `@odata.nextLink` whole (Graph says not to take it apart), bound to the
//! query it continues and judged before the network is touched, so a forged token can send the
//! bearer token nowhere but to a Graph messages listing.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::StreamExt as _;
use reqwest::{Method, Url};
use serde_json::{Value, json};

use super::graph::{Fault, Graph, MAX_JSON, Mode, NOT_FOUND, Reply, TOO_LARGE, next_link, url};
use super::ids;
use super::model::{self, Folder, MAX_COUNT, Query, ROW_SELECT, Role, Roles, Scope};

pub(super) const MAX_PAGE: usize = 100;
/// The most a message may weigh: 24 MiB (mail servers are commonly set to accept more than the
/// 16 MiB other providers stop at).
pub(super) const MAX_MIME: usize = 24 * 1024 * 1024;
const FOLDER: &str = "m365_folder_unavailable";
const BAD: &str = "m365_invalid_response";
const FOLDER_SELECT: &str = "id,totalItemCount,unreadItemCount";
/// A search whose whole page was Trash and Junk is asked again this many times, no more.
const MAX_FOLLOW: usize = 3;
const ROLES_TTL: Duration = Duration::from_secs(60);
const MAX_TOKEN: usize = 16 * 1024;

static ROLES: LazyLock<Mutex<HashMap<String, (Instant, Roles)>>> = LazyLock::new(Default::default);

/// Drops what is remembered about a mailbox's folders.
pub(super) fn forget(account: &str) {
    ROLES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(account);
}

pub(super) struct Page {
    pub ids: Vec<String>,
    pub rows: Vec<Value>,
    pub next: String,
    pub estimate: u64,
}

impl Graph {
    /// One folder by its well-known name; `None` when the mailbox has none (Graph answers 404).
    pub(super) async fn folder(&self, role: Role) -> Result<Option<Folder>, &'static str> {
        let url = url(
            &["me", "mailFolders", role.well_known()],
            &[("$select", FOLDER_SELECT)],
        )?;
        match self.get(&url).await {
            Ok(value) => model::folder(&value).map(Some),
            // Only "not found" is an absent folder; a 404 that names a refusal is the refusal.
            Err(fault) if fault.status == 404 && fault.code == NOT_FOUND => Ok(None),
            Err(fault) => Err(fault.code),
        }
    }

    /// The folder table, at most a minute old: one request per role, four at a time. A role the
    /// mailbox lacks is absent (an Archive exists only once somebody has made one); a mailbox
    /// without an Inbox is not a mailbox.
    pub(super) async fn roles(&self, fresh: bool) -> Result<Roles, &'static str> {
        if !fresh
            && let Some((at, roles)) = ROLES
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&self.account)
            && at.elapsed() < ROLES_TTL
        {
            return Ok(roles.clone());
        }
        let mut found = futures_util::stream::iter(Role::ALL)
            .map(|role| async move { (role, self.folder(role).await) })
            .buffered(4);
        let mut roles = Roles::new();
        // The first failure ends the lookup: the requests still in the air are dropped.
        while let Some((role, answer)) = found.next().await {
            if let Some(folder) = answer? {
                roles.insert(role, folder);
            }
        }
        if !roles.contains_key(&Role::Inbox) {
            return Err(FOLDER);
        }
        ROLES
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(self.account.clone(), (Instant::now(), roles.clone()));
        Ok(roles)
    }

    /// One page of a listing. A folder query lists that folder newest first; a text query is Graph's
    /// `$search` over the mailbox with Trash and Junk taken out. `cursor` is what `unseal` made of the
    /// previous page's token.
    ///
    /// `estimate`: a folder's unread or total count (from `roles`), and otherwise the rows plus one if
    /// more exist. Later pages repeat the first one's, and are the size the first one asked for.
    pub(super) async fn page(
        &self,
        roles: &Roles,
        query: &Query,
        limit: usize,
        cursor: Option<Cursor>,
    ) -> Result<Page, &'static str> {
        if !(1..=MAX_PAGE).contains(&limit) {
            return Err("invalid_params");
        }
        // Graph's link carries the first page's `$top`: a later page is that size whatever is asked.
        let limit = cursor.as_ref().map_or(limit, |cursor| cursor.size);
        let mut fetched = match &query.scope {
            Scope::Folder(role) => {
                if !roles.contains_key(role) {
                    return Err(FOLDER);
                }
                let url = match &cursor {
                    Some(cursor) => cursor.link.clone(),
                    None => folder_url(*role, query, limit)?,
                };
                self.fetch(url, limit, roles, &[]).await?
            }
            Scope::Text(text) => {
                let url = match &cursor {
                    Some(cursor) => cursor.link.clone(),
                    None => {
                        let top = limit.to_string();
                        let phrase = format!("\"{text}\"");
                        url(
                            &["me", "messages"],
                            &[
                                ("$search", &phrase),
                                ("$top", &top),
                                ("$select", ROW_SELECT),
                            ],
                        )?
                    }
                };
                let skip: Vec<&str> = [Role::Trash, Role::Junk]
                    .iter()
                    .filter_map(|role| roles.get(role).map(|folder| folder.id.as_str()))
                    .collect();
                self.fetch(url, limit, roles, &skip).await?
            }
        };
        let more = fetched.next.is_some();
        let fallback = fetched.rows.len() as u64 + u64::from(more);
        let estimate = match (&cursor, &query.scope) {
            (Some(cursor), _) => cursor.estimate,
            (None, Scope::Folder(role)) if !query.flagged => roles
                .get(role)
                .map(|f| if query.unread { f.unread } else { f.total })
                .unwrap_or(fallback)
                .max(fallback),
            _ => fallback,
        }
        .min(MAX_COUNT);
        let next = fetched
            .next
            .take()
            .map(|link| seal(query, &link, estimate, limit))
            .transpose()?
            .unwrap_or_default();
        Ok(Page {
            ids: fetched.ids,
            rows: fetched.rows,
            next,
            estimate,
        })
    }

    /// The rows of one listing answer, and the link to the next. A message whose id cannot be carried is
    /// left out, as is one in a `skip` folder; a search answer that was nothing else is asked for again
    /// from its own link, `MAX_FOLLOW` times at most.
    async fn fetch(
        &self,
        mut url: Url,
        limit: usize,
        roles: &Roles,
        skip: &[&str],
    ) -> Result<Fetched, &'static str> {
        for follow in 0.. {
            let document = self.get(&url).await.map_err(|fault| {
                if fault.status == 404 && fault.code == NOT_FOUND {
                    FOLDER
                } else {
                    fault.code
                }
            })?;
            let values = document["value"].as_array().ok_or(BAD)?;
            if values.len() > limit {
                return Err(BAD);
            }
            let next = match document.get("@odata.nextLink") {
                None | Some(Value::Null) => None,
                Some(Value::String(link)) => Some(next_link(link).ok_or(BAD)?),
                Some(_) => return Err(BAD),
            };
            let mut fetched = Fetched {
                ids: Vec::new(),
                rows: Vec::new(),
                next: next.clone(),
            };
            for value in values {
                let parent = value["parentFolderId"].as_str().unwrap_or("");
                if skip.contains(&parent) {
                    continue;
                }
                if let Ok(row) = model::row(value, roles) {
                    fetched
                        .ids
                        .push(row["id"].as_str().unwrap_or("").to_owned());
                    fetched.rows.push(row);
                }
            }
            match next {
                Some(next)
                    if fetched.rows.is_empty() && !skip.is_empty() && follow < MAX_FOLLOW =>
                {
                    url = next;
                }
                _ => return Ok(fetched),
            }
        }
        unreachable!()
    }

    /// The header properties of one message, by Graph id.
    pub(super) async fn header(&self, graph_id: &str) -> Result<Value, &'static str> {
        let url = url(&["me", "messages", graph_id], &[("$select", ROW_SELECT)])?;
        let mut message = self.get(&url).await.map_err(|fault| fault.code)?;
        // The id asked for is the id the caller holds: the answer is not trusted to rename it.
        message["id"] = json!(graph_id);
        Ok(message)
    }

    /// The whole message as MIME, at most `MAX_MIME` bytes.
    pub(super) async fn mime(&self, graph_id: &str) -> Result<Vec<u8>, &'static str> {
        let url = url(&["me", "messages", graph_id, "$value"], &[])?;
        let reply = self
            .request(Mode::Read, Method::GET, &url, None, MAX_MIME)
            .await
            .map_err(|fault| {
                if fault.code == TOO_LARGE {
                    "m365_message_too_large"
                } else {
                    fault.code
                }
            })?;
        if reply.body.is_empty() {
            return Err(BAD);
        }
        Ok(reply.body)
    }

    /// Sets the read state and/or the flag of one message (`PATCH`, which is the same twice).
    pub(super) async fn update(
        &self,
        graph_id: &str,
        read: Option<bool>,
        flagged: Option<bool>,
    ) -> Result<(), &'static str> {
        let mut body = serde_json::Map::new();
        if let Some(read) = read {
            body.insert("isRead".into(), json!(read));
        }
        if let Some(flagged) = flagged {
            let status = if flagged { "flagged" } else { "notFlagged" };
            body.insert("flag".into(), json!({"flagStatus": status}));
        }
        let url = url(&["me", "messages", graph_id], &[])?;
        let body = Value::Object(body).to_string();
        // Graph answers with the whole message, which is not read: the 2xx is what says it was done.
        self.request(
            Mode::Write,
            Method::PATCH,
            &url,
            Some(("application/json", body.as_bytes())),
            0,
        )
        .await
        .map(|_| ())
        .map_err(|fault| fault.code)
    }

    /// Moves one message to the folder a role names; its id stays (immutable ids).
    pub(super) async fn move_to(&self, graph_id: &str, role: Role) -> Result<(), &'static str> {
        let url = url(&["me", "messages", graph_id, "move"], &[])?;
        let body = json!({"destinationId": role.well_known()}).to_string();
        self.request(
            Mode::Write,
            Method::POST,
            &url,
            Some(("application/json", body.as_bytes())),
            0,
        )
        .await
        .map(|_| ())
        .map_err(|fault| fault.code)
    }

    /// `POST /me/<what>` with the whole MIME message as base64 text, the one way Graph takes one, on
    /// a clock that grows with its size up to `budget`.
    async fn post_mime(
        &self,
        what: &str,
        mode: Mode,
        mime: &[u8],
        ceiling: usize,
        budget: Duration,
    ) -> Result<Reply, Fault> {
        let text = base64::engine::general_purpose::STANDARD.encode(mime);
        let url = url(&["me", what], &[]).map_err(|code| Fault {
            code,
            status: 0,
            sent: false,
        })?;
        let clock = self.upload_clock(text.len(), budget);
        let body = Some(("text/plain", text.as_bytes()));
        self.request_within(mode, Method::POST, &url, body, ceiling, clock)
            .await
    }

    /// `POST /me/messages` with the MIME: Graph files it in Drafts as a draft and answers `201` with
    /// the message, whose (immutable) id is the new draft's Omamail id when the answer could be read.
    pub(super) async fn create_draft(
        &self,
        mime: &[u8],
        budget: Duration,
    ) -> Result<Option<String>, Fault> {
        let reply = self
            .post_mime("messages", Mode::Write, mime, MAX_JSON, budget)
            .await?;
        let id = serde_json::from_slice::<Value>(&reply.body)
            .ok()
            .and_then(|value| value["id"].as_str().and_then(|id| ids::encode(id).ok()));
        Ok(id)
    }

    /// Whether a message is a draft: Graph says so, or it is in the Drafts folder.
    pub(super) async fn is_draft(
        &self,
        graph_id: &str,
        roles: &Roles,
    ) -> Result<bool, &'static str> {
        let url = url(
            &["me", "messages", graph_id],
            &[("$select", "isDraft,parentFolderId")],
        )?;
        let message = self.get(&url).await.map_err(|fault| fault.code)?;
        let parent = message["parentFolderId"].as_str();
        Ok(message["isDraft"] == true
            || roles
                .get(&Role::Drafts)
                .is_some_and(|drafts| parent == Some(drafts.id.as_str())))
    }

    /// `DELETE /me/messages/{id}`, answered `204`.
    pub(super) async fn delete(&self, graph_id: &str) -> Result<(), &'static str> {
        let url = url(&["me", "messages", graph_id], &[])?;
        self.request(Mode::Write, Method::DELETE, &url, None, 0)
            .await
            .map(|_| ())
            .map_err(|fault| fault.code)
    }

    /// `POST /me/sendMail` with the MIME, answered `202 Accepted`. Never repeated: what a failure
    /// proves about the message is `send`'s decision.
    pub(super) async fn send_mail(&self, mime: &[u8], budget: Duration) -> Result<(), Fault> {
        let reply = self
            .post_mime("sendMail", Mode::Once, mime, 0, budget)
            .await?;
        if reply.status == 202 {
            Ok(())
        } else {
            Err(Fault {
                code: "m365_bad_response",
                status: reply.status,
                sent: true,
            })
        }
    }
}

struct Fetched {
    ids: Vec<String>,
    rows: Vec<Value>,
    next: Option<Url>,
}

fn folder_url(role: Role, query: &Query, limit: usize) -> Result<Url, &'static str> {
    let top = limit.to_string();
    // `$orderby` properties must lead `$filter` (Graph's `InefficientFilter`): an always-true bound
    // on the sort property is how a flag filter keeps the newest-first order.
    let mut filter = Vec::new();
    if query.unread || query.flagged {
        filter.push("receivedDateTime ge 1900-01-01T00:00:00Z");
    }
    if query.unread {
        filter.push("isRead eq false");
    }
    if query.flagged {
        filter.push("flag/flagStatus eq 'flagged'");
    }
    let filter = filter.join(" and ");
    let mut params = vec![
        ("$top", top.as_str()),
        ("$select", ROW_SELECT),
        ("$orderby", "receivedDateTime desc"),
    ];
    if !filter.is_empty() {
        params.push(("$filter", filter.as_str()));
    }
    url(
        &["me", "mailFolders", role.well_known(), "messages"],
        &params,
    )
}

pub(super) fn seal(
    query: &Query,
    link: &Url,
    estimate: u64,
    size: usize,
) -> Result<String, &'static str> {
    let token = URL_SAFE_NO_PAD
        .encode(json!({"q":query.canonical(),"e":estimate,"l":size,"n":link.as_str()}).to_string());
    (token.len() <= MAX_TOKEN).then_some(token).ok_or(BAD)
}

/// Where a listing continues: the link the client will follow, the first page's estimate and the size
/// its pages are.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Cursor {
    pub link: Url,
    pub estimate: u64,
    pub size: usize,
}

/// The cursor of a page token, which must be one of ours for this very query.
pub(super) fn unseal(token: &str, query: &Query) -> Result<Cursor, &'static str> {
    const INVALID: &str = "invalid_params";
    let bytes = URL_SAFE_NO_PAD
        .decode(token.get(..MAX_TOKEN).unwrap_or(token))
        .map_err(|_| INVALID)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
    let estimate = value["e"]
        .as_u64()
        .filter(|e| *e <= MAX_COUNT)
        .ok_or(INVALID)?;
    let size = value["l"]
        .as_u64()
        .filter(|l| (1..=MAX_PAGE as u64).contains(l))
        .ok_or(INVALID)? as usize;
    if token.len() > MAX_TOKEN || value["q"] != query.canonical() {
        return Err(INVALID);
    }
    let link = next_link(value["n"].as_str().ok_or(INVALID)?).ok_or(INVALID)?;
    Ok(Cursor {
        link,
        estimate,
        size,
    })
}
