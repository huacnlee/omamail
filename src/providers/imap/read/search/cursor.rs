//! A page boundary, not a reference to required server-side state. The cache
//! hint can disappear; the position still describes where a fresh scan resumes.
use super::*;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;

const MAX_CURSOR: usize = 32768;

// Used both when sorting a scan and comparing it with a cursor. Arrival date
// and UID descend; folder names ascend to break cross-folder ties.
pub(super) fn order(date: i64, folder: &str, uid: u32) -> (Reverse<i64>, &str, Reverse<u32>) {
    (Reverse(date), folder, Reverse(uid))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Position {
    pub date: i64,
    pub folder: String,
    pub uid: u32,
    pub validity: u32,
}

impl Position {
    pub fn order(&self) -> (Reverse<i64>, &str, Reverse<u32>) {
        order(self.date, &self.folder, self.uid)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Cursor {
    version: u8,
    binding: [u8; 32],
    pub after: Position,
    pub snapshot: String,
}

impl Cursor {
    pub fn new(owner: [u8; 32], criteria: &str, after: Position, snapshot: String) -> Self {
        Self {
            version: 1,
            binding: binding(owner, criteria),
            after,
            snapshot,
        }
    }

    pub fn encode(&self) -> Result<String> {
        let bytes = serde_json::to_vec(self).map_err(|_| "invalid_params")?;
        let token = URL_SAFE_NO_PAD.encode(bytes);
        if token.len() > MAX_CURSOR {
            return Err("mail_response_too_large");
        }
        Ok(token)
    }

    pub fn decode(token: &str, owner: [u8; 32], criteria: &str) -> Result<Self> {
        if token.len() > MAX_CURSOR {
            return Err("invalid_params");
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(token)
            .map_err(|_| "invalid_params")?;
        let cursor: Self = serde_json::from_slice(&bytes).map_err(|_| "invalid_params")?;
        if cursor.version != 1
            || cursor.after.uid == 0
            || cursor.after.validity == 0
            || cursor.after.folder.is_empty()
            || cursor.snapshot.len() != 32
            || URL_SAFE_NO_PAD.decode(&cursor.snapshot).is_err()
        {
            return Err("invalid_params");
        }
        quote(&cursor.after.folder)?;
        if cursor.binding != binding(owner, criteria) {
            return Err("imap_search_expired");
        }
        Ok(cursor)
    }
}

fn binding(owner: [u8; 32], criteria: &str) -> [u8; 32] {
    // Version also fixes scope and ordering semantics. No credential digest is
    // exported in a cursor, and an OAuth refresh does not change its binding.
    Sha256::digest(json!(["imap-account-search-v1", owner, criteria]).to_string()).into()
}
