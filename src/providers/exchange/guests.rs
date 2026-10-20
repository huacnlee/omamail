//! The people of a meeting as a request names them: addresses in two lists (`RequiredAttendees` and
//! `OptionalAttendees`), checked before anything is asked of a server or written to a request.
//!
//! An address here is a person who will be mailed, so it is held to a narrow shape and refused, never
//! repaired: one `@`, printable ASCII, a local part of the characters RFC 5322 calls `atext` with dots
//! between them, a domain of at least two labels of letters, digits and hyphens (a name in another
//! script is its punycode on the wire), at most 254 bytes. No space, control character, quote, angle
//! bracket, comma or semicolon gets through, so a pasted "Ada <ada@example.org>" or a list that was not
//! split is a refusal and not a second recipient. The lists hold at most `MAX_GUESTS` people together,
//! none twice (compared without regard to case, across both lists), and never the mailbox's own
//! address (an invitation to oneself is nobody's intention) where the caller knows it: the handler
//! and the client pass it, a builder passes none.

use std::collections::HashSet;

const INVALID: &str = "invalid_params";
/// The most people one meeting is written with: the bound the detail read applies to what it lists.
pub const MAX_GUESTS: usize = 200;
const MAX_ADDRESS: usize = 254;
const MAX_LOCAL: usize = 64;
const MAX_LABEL: usize = 63;

/// Who a meeting is for, by address, in the order the caller gave them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Guests {
    pub required: Vec<String>,
    pub optional: Vec<String>,
}

impl Guests {
    pub fn len(&self) -> usize {
        self.required.len() + self.optional.len()
    }
}

/// Whether `text` is an address this client will mail.
pub fn is_address(text: &str) -> bool {
    let Some((local, domain)) = text.split_once('@') else {
        return false;
    };
    let atext = |b: u8| b.is_ascii_alphanumeric() || b"!#$%&'*+/=?^_`{|}~-".contains(&b);
    let dotted = (1..=MAX_LOCAL).contains(&local.len())
        && local.split('.').all(|part| !part.is_empty())
        && local.bytes().all(|b| atext(b) || b == b'.');
    let labels: Vec<&str> = domain.split('.').collect();
    let named = labels.len() >= 2
        && labels.iter().all(|label| {
            (1..=MAX_LABEL).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    text.len() <= MAX_ADDRESS && dotted && named
}

/// The lists as a request names them. `owner` is the mailbox's own address, which may be on neither
/// (empty when not known). The lists may be empty here: a caller that needs somebody says so.
pub fn check(required: &[String], optional: &[String], owner: &str) -> Result<(), &'static str> {
    if required.len() + optional.len() > MAX_GUESTS {
        return Err(INVALID);
    }
    let mut seen = HashSet::new();
    for address in required.iter().chain(optional) {
        let own = !owner.is_empty() && address.eq_ignore_ascii_case(owner);
        if !is_address(address) || own || !seen.insert(address.to_ascii_lowercase()) {
            return Err(INVALID);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
