//! The `role:` and `text:` queries, the same small language as JMAP's: `role:<inbox|sent|drafts|
//! trash|junk> [unseen] [flagged]` or `text:<words>`. A text query goes to the server as one quoted
//! AQS phrase built here, never as the raw text.

use unicode_normalization::UnicodeNormalization;

use super::ews::Role;

const MAX_TEXT: usize = 4096;
const INVALID: &str = "invalid_params";
const ROLES: [(&str, Role); 5] = [
    ("inbox", Role::Inbox),
    ("sent", Role::Sent),
    ("drafts", Role::Drafts),
    ("junk", Role::Junk),
    ("trash", Role::Trash),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Query {
    Folder {
        role: Role,
        unread: bool,
        flagged: bool,
    },
    Text(String),
}

impl Query {
    pub fn parse(query: &str) -> Result<Query, &'static str> {
        if query.len() > MAX_TEXT + 64 || query.chars().any(char::is_control) {
            return Err(INVALID);
        }
        let query = query.trim();
        if let Some(text) = query.strip_prefix("text:") {
            let text = text.trim();
            // Nothing searchable left (`text:"`) is no query.
            return if text.is_empty() || text.len() > MAX_TEXT || words(text).is_empty() {
                Err(INVALID)
            } else {
                Ok(Query::Text(text.to_owned()))
            };
        }
        let mut words = query
            .strip_prefix("role:")
            .ok_or(INVALID)?
            .split_ascii_whitespace();
        let name = words.next().ok_or(INVALID)?;
        let role = ROLES
            .iter()
            .find(|(word, _)| *word == name)
            .ok_or(INVALID)?
            .1;
        let (mut unread, mut flagged) = (false, false);
        for word in words {
            let flag = match word {
                "unseen" => &mut unread,
                "flagged" => &mut flagged,
                _ => return Err(INVALID),
            };
            if std::mem::replace(flag, true) {
                return Err(INVALID);
            }
        }
        Ok(Query::Folder {
            role,
            unread,
            flagged,
        })
    }

    /// One spelling per meaning: what a page token is bound to.
    pub fn canonical(&self) -> String {
        match self {
            Query::Text(text) => format!("text:{text}"),
            Query::Folder {
                role,
                unread,
                flagged,
            } => {
                let name = ROLES
                    .iter()
                    .find(|(_, r)| r == role)
                    .map_or("", |(name, _)| name);
                format!(
                    "role:{name}{}{}",
                    if *unread { " unseen" } else { "" },
                    if *flagged { " flagged" } else { "" }
                )
            }
        }
    }
}

/// The words of `text` as AQS can take them. `FindItem/QueryString` is "a subset of Advanced Query
/// Syntax": a quoted phrase is exact, `*` after one a prefix match, and `( ) : < > = ~ + -` and
/// upper-case `AND`/`OR`/`NOT` are syntax with no escape for a quote. So text is NFKC-normalized
/// (fullwidth spellings of syntax become ASCII), split at those characters, quotes and controls, and
/// each word loses a leading `+` or `-` and a bare connector its case.
fn words(text: &str) -> Vec<String> {
    let text: String = text.nfkc().collect();
    let syntax = |c: char| {
        c.is_whitespace()
            || c.is_control()
            || "\"\\()<>:=~*\u{ab}\u{bb}\u{201c}\u{201d}\u{201e}\u{fffe}\u{ffff}".contains(c)
    };
    text.split(syntax)
        .filter_map(|word| match word.trim_start_matches(['+', '-']) {
            "" => None,
            word @ ("AND" | "OR" | "NOT") => Some(word.to_ascii_lowercase()),
            word => Some(word.to_owned()),
        })
        .collect()
}

/// The `QueryString` for a text query: the prefix form, `"win product"*`, so half a word matches.
pub fn phrase(text: &str) -> String {
    format!("\"{}\"*", words(text).join(" "))
}
