//! Gmail listed by conversation, as Gmail's own web client lists it.
//!
//! `threads.list` answers thread ids; each thread is then read in its minimal
//! form (ids, labels, dates: no headers or bodies) to pick the message that
//! stands for it in the list and to name its members. The representative is
//! what the rest of the application reads and acts on, exactly as a JMAP or
//! HEY row is, and the block beside it carries the members every
//! conversation-scoped action expands to.
use serde_json::{Value, json};

/// The most members one conversation lists. A thread longer than this keeps
/// its newest messages, which are the ones a rail is read for.
const MAX_MEMBERS: usize = 100;

fn labels(message: &Value) -> Vec<&str> {
    message["labelIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn has(message: &Value, label: &str) -> bool {
    labels(message).contains(&label)
}

fn date(message: &Value) -> i64 {
    message["internalDate"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| message["internalDate"].as_i64())
        .unwrap_or(0)
}

fn terms(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|term| term.to_ascii_lowercase())
        .collect()
}

/// The label a listing is about, from the operators Omamail's mailboxes and
/// most typed searches use: the member carrying it is the one shown.
fn wanted_label(query: &str) -> Option<&'static str> {
    let terms = terms(query);
    let any = |options: &[&str]| terms.iter().any(|t| options.contains(&t.as_str()));
    if any(&["is:unread"]) {
        Some("UNREAD")
    } else if any(&["is:starred"]) {
        Some("STARRED")
    } else if any(&["in:sent", "is:sent", "label:sent"]) {
        Some("SENT")
    } else if any(&["in:trash", "label:trash"]) {
        Some("TRASH")
    } else if any(&["in:spam", "label:spam"]) {
        Some("SPAM")
    } else if any(&["in:inbox", "label:inbox"]) {
        Some("INBOX")
    } else {
        None
    }
}

/// Trash and Spam members are left out of a conversation unless the listing
/// is about them, the rule the JMAP rail follows: archiving a conversation
/// must not pull a message the user threw away back into it.
fn visible(message: &Value, query: &str) -> bool {
    let terms = terms(query);
    let said = |word: &str| terms.iter().any(|t| t == word);
    // `in:anywhere` takes Trash and Spam in only when the query does not
    // exclude them again: All mail is `in:anywhere -in:spam -in:trash`.
    let about = |folder: &str| {
        said(&format!("in:{folder}"))
            || said(&format!("label:{folder}"))
            || (said("in:anywhere") && !said(&format!("-in:{folder}")))
    };
    let trashed = has(message, "TRASH") && !about("trash");
    let spam = has(message, "SPAM") && !about("spam");
    !trashed && !spam && !has(message, "DRAFT")
}

/// Drafts are listed one by one: a draft is something being written, opened
/// into the composer on its own, and the drafts view is built for that.
pub(super) fn applies(query: &str) -> bool {
    !terms(query).iter().any(|t| {
        matches!(
            t.as_str(),
            "in:drafts" | "in:draft" | "is:draft" | "label:draft"
        )
    })
}

/// The representative's id and the conversation block for one thread read in
/// `format=minimal`, or None for a thread with nothing left to show.
pub(super) fn block(thread: &Value, query: &str) -> Option<(String, Value)> {
    let id = thread["id"].as_str().filter(|id| !id.is_empty())?;
    let mut members: Vec<&Value> = thread["messages"]
        .as_array()?
        .iter()
        .filter(|m| m["id"].as_str().is_some_and(|id| !id.is_empty()))
        .collect();
    members.sort_by_key(|m| date(m));
    let mut shown: Vec<&Value> = members
        .iter()
        .copied()
        .filter(|m| visible(m, query))
        .collect();
    if shown.is_empty() {
        // A thread the query matched only through a message the rule hides
        // (a reply in the trash, say) still needs a row to stand for it.
        shown = members
            .iter()
            .copied()
            .filter(|m| !has(m, "DRAFT"))
            .collect();
    }
    if shown.is_empty() {
        shown = members.clone();
    }
    if shown.len() > MAX_MEMBERS {
        shown.drain(..shown.len() - MAX_MEMBERS);
    }
    let newest = |pick: &dyn Fn(&Value) -> bool| shown.iter().rev().find(|m| pick(m)).copied();
    let representative = wanted_label(query)
        .and_then(|label| newest(&|m: &Value| has(m, label)))
        // Gmail's own row reads as the last thing someone else said, so the
        // reply the user sent last is not what stands for the conversation.
        .or_else(|| newest(&|m: &Value| !has(m, "SENT")))
        .or_else(|| shown.last().copied())?;
    let ids: Vec<&str> = shown.iter().filter_map(|m| m["id"].as_str()).collect();
    Some((
        representative["id"].as_str()?.to_owned(),
        json!({
            "id": id,
            "count": ids.len(),
            "unread": shown.iter().any(|m| has(m, "UNREAD")),
            "flagged": shown.iter().any(|m| has(m, "STARRED")),
            "memberIds": ids,
        }),
    ))
}

/// One member of a thread read in `format=metadata`, as `gmail.read` answers
/// it, beside the conversation it now belongs to: what a later read of a
/// remembered row is served from once a write may have changed its labels.
pub(super) fn member(thread: &Value, query: &str, id: &str) -> Option<(Value, Value)> {
    let (_, block) = block(thread, query)?;
    let message = thread["messages"]
        .as_array()?
        .iter()
        .find(|m| m["id"].as_str() == Some(id))?;
    Some((message.clone(), block))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, date: i64, labels: &[&str]) -> Value {
        json!({"id": id, "internalDate": date.to_string(), "labelIds": labels})
    }

    #[test]
    fn the_inbox_shows_the_newest_message_someone_else_sent() {
        let thread = json!({"id": "t1", "messages": [
            message("a", 1, &["INBOX"]),
            message("b", 3, &["SENT"]),
            message("c", 2, &["INBOX", "UNREAD"]),
        ]});
        let (representative, block) = block(&thread, "in:inbox").unwrap();
        assert_eq!(representative, "c");
        assert_eq!(block["memberIds"], json!(["a", "c", "b"]), "oldest first");
        assert_eq!(block["count"], 3);
        assert_eq!(block["unread"], true);
        assert_eq!(block["flagged"], false);
    }

    #[test]
    fn a_view_about_a_label_shows_the_member_that_carries_it() {
        let thread = json!({"id": "t", "messages": [
            message("old", 1, &["INBOX", "STARRED"]),
            message("new", 2, &["INBOX"]),
        ]});
        assert_eq!(block(&thread, "is:starred").unwrap().0, "old");
        assert_eq!(
            block(&thread, "in:sent").unwrap().0,
            "new",
            "no sent member: the newest"
        );
        let sent = json!({"id": "t", "messages": [message("q", 1, &["INBOX"]), message("r", 2, &["SENT"])]});
        assert_eq!(block(&sent, "in:sent").unwrap().0, "r");
        assert_eq!(block(&sent, "").unwrap().0, "q");
    }

    #[test]
    fn trash_spam_and_drafts_stay_out_unless_the_view_is_about_them() {
        let thread = json!({"id": "t", "messages": [
            message("kept", 1, &["INBOX"]),
            message("binned", 2, &["TRASH"]),
            message("draft", 3, &["DRAFT"]),
        ]});
        let (_, inbox) = block(&thread, "in:inbox").unwrap();
        assert_eq!(inbox["memberIds"], json!(["kept"]));
        let (representative, trash) = block(&thread, "in:trash").unwrap();
        assert_eq!(representative, "binned");
        assert_eq!(trash["memberIds"], json!(["kept", "binned"]));
        let only_trash = json!({"id": "t", "messages": [message("x", 1, &["TRASH"])]});
        assert_eq!(block(&only_trash, "from:someone").unwrap().0, "x");
    }

    #[test]
    fn all_mail_keeps_trash_and_spam_out_as_its_query_says() {
        let thread = json!({"id": "t", "messages": [
            message("kept", 1, &["INBOX"]),
            message("binned", 2, &["TRASH"]),
            message("junk", 3, &["SPAM"]),
        ]});
        let (representative, all) = block(&thread, "in:anywhere -in:spam -in:trash").unwrap();
        assert_eq!(representative, "kept");
        assert_eq!(all["memberIds"], json!(["kept"]));
        let (_, everything) = block(&thread, "in:anywhere").unwrap();
        assert_eq!(everything["memberIds"], json!(["kept", "binned", "junk"]));
    }

    #[test]
    fn a_member_is_served_with_its_conversation() {
        let thread = json!({"id": "t", "messages": [message("a", 1, &["INBOX"]), message("b", 2, &["INBOX"])]});
        let (payload, block) = member(&thread, "in:inbox", "a").unwrap();
        assert_eq!(payload["id"], "a");
        assert_eq!(block["count"], 2);
        assert!(member(&thread, "in:inbox", "gone").is_none());
    }

    #[test]
    fn drafts_are_listed_one_by_one_and_empty_threads_have_no_row() {
        assert!(!applies("in:drafts"));
        assert!(applies("in:inbox"));
        assert!(block(&json!({"id": "t", "messages": []}), "").is_none());
        assert!(block(&json!({"messages": [message("a", 1, &[])]}), "").is_none());
    }
}
