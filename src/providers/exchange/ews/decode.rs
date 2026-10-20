//! EWS response decoders: a parsed tree in, typed results out, one per response kind, written from
//! Microsoft's EWS reference. The server controls every byte: success is claimed only for
//! `ResponseClass="Success"` with `NoError`, an answer for another number of items than were asked
//! about is damaged, and no server text reaches an error (`Rej` carries a static code).

use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::DateTime;

use super::xml::{self, Node};

pub const NOT_FOUND: &str = "exchange_message_not_found";
pub const FOLDER: &str = "exchange_folder_unavailable";
pub const THROTTLED: &str = "exchange_throttled";
pub const STALE: &str = "exchange_stale_item";
pub const REJECTED: &str = "exchange_send_rejected";
pub const TOO_LARGE: &str = "exchange_message_too_large";
/// The login was taken and the request refused; nothing was done.
pub const DENIED: &str = "exchange_access_denied";
const INVALID: &str = "exchange_invalid_response";
const SERVER: &str = "exchange_server_error";

/// A failure the server reported, for a whole response or one message in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rej {
    pub code: &'static str,
    /// The server said to ask again later: milliseconds it suggested (zero for none).
    pub wait_ms: Option<u32>,
    /// The server said it did not act; the only proof that repeating a write cannot do it twice.
    pub unprocessed: bool,
}

impl Rej {
    pub const INVALID: Rej = Rej {
        code: INVALID,
        wait_ms: None,
        unprocessed: false,
    };

    fn new(code: &'static str) -> Rej {
        Rej {
            code,
            wait_ms: None,
            unprocessed: false,
        }
    }
}

/// A `ResponseCode`: unknown ones are a plain server error. A refused change key, a busy server and
/// a stopped batch did nothing; a temporary fault may have.
fn classify(code: &str, hint: Option<u32>) -> Rej {
    let reject = |code, unprocessed| Rej {
        code,
        wait_ms: None,
        unprocessed,
    };
    match code.trim() {
        "ErrorItemNotFound" | "ErrorInvalidId" | "ErrorInvalidIdMalformed" => {
            reject(NOT_FOUND, false)
        }
        "ErrorFolderNotFound" => reject(FOLDER, false),
        // Right after a login that worked, so not a refused password.
        "ErrorAccessDenied" | "ErrorNonExistentMailbox" | "ErrorAccountDisabled" => {
            reject(DENIED, false)
        }
        "ErrorServerBusy" => Rej {
            wait_ms: Some(hint.unwrap_or(0)),
            ..reject(THROTTLED, true)
        },
        "ErrorMailboxMoveInProgress"
        | "ErrorInternalServerTransientError"
        | "ErrorInsufficientResources"
        | "ErrorExceededConnectionCount"
        | "ErrorADUnavailable"
        | "ErrorMailboxStoreUnavailable" => Rej {
            wait_ms: Some(0),
            ..reject(SERVER, false)
        },
        "ErrorMessageSizeExceeded" => reject(TOO_LARGE, false),
        "ErrorMimeContentInvalid"
        | "ErrorMailRecipientNotFound"
        | "ErrorInvalidRecipients"
        | "ErrorSendAsDenied"
        | "ErrorQuotaExceeded" => reject(REJECTED, false),
        "ErrorInvalidServerVersion" => reject("exchange_unsupported_server", false),
        "ErrorBatchProcessingStopped" => reject(SERVER, true),
        "ErrorChangeKeyRequiredForWriteOperations"
        | "ErrorChangeKeyRequired"
        | "ErrorStaleObject"
        | "ErrorIrresolvableConflict"
        | "ErrorInvalidChangeKey" => reject(STALE, true),
        _ => reject(SERVER, false),
    }
}

/// The back-off in `MessageXml` (`Value Name="BackOffMilliseconds"`), at most a minute. The position
/// is inferred from the throttling article, so a miss only loses the hint.
fn backoff(node: &Node, depth: usize) -> Option<u32> {
    node.children.iter().find_map(|child| {
        if child.name == "Value" && child.attr("Name") == Some("BackOffMilliseconds") {
            return child
                .text
                .trim()
                .parse::<u32>()
                .ok()
                .map(|ms| ms.min(60_000));
        }
        (depth < 4).then(|| backoff(child, depth + 1)).flatten()
    })
}

/// A decoded response: the operation's element and the server version it announced.
pub struct Reply {
    pub body: Node,
    pub version: Option<String>,
}

pub fn envelope(bytes: &[u8]) -> Result<Reply, Rej> {
    let mut root = xml::parse(bytes).map_err(|_| Rej::INVALID)?;
    if root.name != "Envelope" {
        return Err(Rej::INVALID);
    }
    let version = root.at(&["Header", "ServerVersionInfo"]).and_then(|info| {
        let part = |name| info.attr(name)?.trim().parse::<u32>().ok();
        Some(format!(
            "{}.{}.{}",
            part("MajorVersion")?,
            part("MinorVersion")?,
            part("MajorBuildNumber").unwrap_or(0)
        ))
    });
    let at = root
        .children
        .iter()
        .position(|child| child.name == "Body")
        .ok_or(Rej::INVALID)?;
    let body = root
        .children
        .swap_remove(at)
        .children
        .into_iter()
        .next()
        .ok_or(Rej::INVALID)?;
    if body.name == "Fault" {
        // `detail/ResponseCode`, else the name behind the prefix of `faultcode`.
        let code = body
            .at(&["detail", "ResponseCode"])
            .map(|node| node.text.as_str())
            .or_else(|| {
                let faultcode = body.child("faultcode")?;
                faultcode.text.rsplit(':').next()
            });
        let hint = body
            .at(&["detail", "MessageXml"])
            .and_then(|xml| backoff(xml, 1));
        return Err(code.map_or(Rej::new(SERVER), |code| classify(code, hint)));
    }
    Ok(Reply { body, version })
}

/// The response messages of `body`, in request order, for `expected` of them.
fn messages<'a>(
    body: &'a Node,
    response: &str,
    message: &str,
    expected: usize,
) -> Result<Vec<&'a Node>, Rej> {
    let found: Vec<&Node> = match body.child("ResponseMessages") {
        Some(list) if body.name == response => list.children(message),
        _ => return Err(Rej::INVALID),
    };
    if found.len() == expected {
        Ok(found)
    } else {
        Err(Rej::INVALID)
    }
}

fn check(message: &Node) -> Result<(), Rej> {
    let code = message.text_at(&["ResponseCode"]).unwrap_or("");
    match message.attr("ResponseClass") {
        Some("Success") if code == "NoError" => Ok(()),
        Some("Warning" | "Error") => Err(classify(
            code,
            message.child("MessageXml").and_then(|xml| backoff(xml, 1)),
        )),
        _ => Err(Rej::INVALID),
    }
}

/// Decodes each of `expected` messages with `each`; one that fails fails alone.
fn each<T>(
    body: &Node,
    response: &str,
    message: &str,
    expected: usize,
    each: impl Fn(&Node) -> Result<T, Rej>,
) -> Result<Vec<Result<T, Rej>>, Rej> {
    let found = messages(body, response, message, expected)?;
    Ok(found
        .into_iter()
        .map(|node| check(node).and_then(|()| each(node)))
        .collect())
}

fn number(text: Option<&str>) -> Option<u64> {
    text?.trim().parse().ok()
}

fn id_attr(node: Option<&Node>, name: &str) -> Option<String> {
    let value = node?.attr(name)?.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

#[derive(Clone)]
pub struct Folder {
    pub id: String,
    pub total: u64,
    pub unread: u64,
}

/// `GetFolderResponse`: id and counts per folder.
pub fn folders(body: &Node, expected: usize) -> Result<Vec<Result<Folder, Rej>>, Rej> {
    each(
        body,
        "GetFolderResponse",
        "GetFolderResponseMessage",
        expected,
        |message| {
            let folder = message
                .child("Folders")
                .and_then(|list| list.children.first())
                .ok_or(Rej::INVALID)?;
            Ok(Folder {
                id: id_attr(folder.child("FolderId"), "Id").ok_or(Rej::INVALID)?,
                total: number(folder.text_at(&["TotalCount"])).ok_or(Rej::INVALID)?,
                unread: number(folder.text_at(&["UnreadCount"])).ok_or(Rej::INVALID)?,
            })
        },
    )
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Party {
    pub name: String,
    pub address: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Item {
    pub id: String,
    pub change_key: String,
    pub folder: String,
    pub message_id: String,
    pub subject: String,
    pub from: Option<Party>,
    pub to: Vec<Party>,
    pub cc: Vec<Party>,
    pub received_ms: Option<i64>,
    pub sent_ms: Option<i64>,
    pub size: u64,
    pub read: bool,
    pub flagged: bool,
    pub draft: bool,
    pub preview: String,
    pub mime: Option<Vec<u8>>,
}

pub struct Found {
    pub items: Vec<Item>,
    /// `IncludesLastItemInRange`: the page ends the view.
    pub last: bool,
    pub total: Option<u64>,
}

/// `FindItemResponse` of a request for one folder.
pub fn find(body: &Node) -> Result<Found, Rej> {
    let [message] = messages(body, "FindItemResponse", "FindItemResponseMessage", 1)?[..] else {
        return Err(Rej::INVALID);
    };
    check(message)?;
    let root = message.child("RootFolder").ok_or(Rej::INVALID)?;
    let items = root
        .child("Items")
        .map(|items| {
            items
                .children
                .iter()
                .map(|node| item(node, false))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let last = match root.attr("IncludesLastItemInRange") {
        Some(value) => value.trim() == "true",
        None => items.is_empty(),
    };
    Ok(Found {
        last,
        total: number(root.attr("TotalItemsInView")),
        items,
    })
}

/// The items an id-only `FindItem` listed, and whether that was all of them.
pub fn count(body: &Node) -> Result<(u64, bool), Rej> {
    let [message] = messages(body, "FindItemResponse", "FindItemResponseMessage", 1)?[..] else {
        return Err(Rej::INVALID);
    };
    check(message)?;
    let root = message.child("RootFolder").ok_or(Rej::INVALID)?;
    let listed = root.child("Items").map_or(0, |items| items.children.len()) as u64;
    let last = match root.attr("IncludesLastItemInRange") {
        Some(value) => value.trim() == "true",
        None => listed == 0,
    };
    Ok((listed, last))
}

fn first_item(message: &Node) -> Result<&Node, Rej> {
    message
        .child("Items")
        .and_then(|items| items.children.first())
        .ok_or(Rej::INVALID)
}

/// `GetItemResponse`: the items, with their MIME when it was asked for.
pub fn get(body: &Node, expected: usize, mime: bool) -> Result<Vec<Result<Item, Rej>>, Rej> {
    each(
        body,
        "GetItemResponse",
        "GetItemResponseMessage",
        expected,
        |message| item(first_item(message)?, mime),
    )
}

/// `GetItemResponse` for change keys only: (id, key) per item.
/// An item's id and current change key.
pub type Key = (String, String);

pub fn keys(body: &Node, expected: usize) -> Result<Vec<Result<Key, Rej>>, Rej> {
    each(
        body,
        "GetItemResponse",
        "GetItemResponseMessage",
        expected,
        |message| {
            let id = first_item(message)?.child("ItemId");
            Ok((
                id_attr(id, "Id").ok_or(Rej::INVALID)?,
                id_attr(id, "ChangeKey").ok_or(Rej::INVALID)?,
            ))
        },
    )
}

/// `UpdateItemResponse`, `MoveItemResponse` and `CreateItemResponse`: one outcome per item.
pub fn outcomes(body: &Node, kind: &str, expected: usize) -> Result<Vec<Result<(), Rej>>, Rej> {
    each(
        body,
        &format!("{kind}Response"),
        &format!("{kind}ResponseMessage"),
        expected,
        |_| Ok(()),
    )
}

/// One item element (`Message`, `Item`, ...). The id is required; the change key and folder read
/// as empty when missing, an absent `IsRead` as unread.
fn item(node: &Node, mime: bool) -> Result<Item, Rej> {
    let id = node.child("ItemId");
    let text = |name: &str| node.text_at(&[name]).unwrap_or("");
    let flag = |name: &str| text(name) == "true";
    let time = |name: &str| {
        DateTime::parse_from_rfc3339(text(name))
            .ok()
            .map(|date| date.timestamp_millis())
            .filter(|ms| *ms >= 0)
    };
    let parties = |name: &str| {
        node.child(name).map_or_else(Vec::new, |list| {
            list.children("Mailbox")
                .into_iter()
                .filter_map(party)
                .collect()
        })
    };
    Ok(Item {
        id: id_attr(id, "Id").ok_or(Rej::INVALID)?,
        change_key: id_attr(id, "ChangeKey").unwrap_or_default(),
        folder: id_attr(node.child("ParentFolderId"), "Id").unwrap_or_default(),
        message_id: text("InternetMessageId").to_owned(),
        subject: node
            .child("Subject")
            .map_or_else(String::new, |s| s.text.clone()),
        from: node.at(&["From", "Mailbox"]).and_then(party),
        to: parties("ToRecipients"),
        cc: parties("CcRecipients"),
        received_ms: time("DateTimeReceived"),
        sent_ms: time("DateTimeSent"),
        size: number(node.text_at(&["Size"])).unwrap_or(0),
        read: flag("IsRead"),
        flagged: node.text_at(&["Flag", "FlagStatus"]) == Some("Flagged"),
        draft: flag("IsDraft"),
        preview: text("Preview").to_owned(),
        mime: match (mime, node.child("MimeContent")) {
            (true, Some(content)) => Some(base64(&content.text)?),
            _ => None,
        },
    })
}

fn party(node: &Node) -> Option<Party> {
    let text = |name| node.text_at(&[name]).unwrap_or("");
    // An address that is no SMTP one with no `@` is an X.500 name: shown by its display name only.
    let routing = text("RoutingType");
    let smtp = routing.is_empty() || routing.eq_ignore_ascii_case("SMTP");
    let address = text("EmailAddress");
    let address = if smtp || address.contains('@') {
        address
    } else {
        ""
    };
    (!text("Name").is_empty() || !address.is_empty()).then(|| Party {
        name: text("Name").to_owned(),
        address: address.to_owned(),
    })
}

/// The most MIME one message may hold when it is read. Exchange servers are commonly set to accept
/// more than the shared `message::MAX_MESSAGE` (16 MiB), and a message that Outlook opens must open
/// here; sends keep the shared limit.
pub const MAX_MIME: usize = 24 * 1024 * 1024;

/// `MimeContent`: base64, refused undecoded when it would pass `MAX_MIME`.
fn base64(text: &str) -> Result<Vec<u8>, Rej> {
    let compact: Vec<u8> = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if compact.len() > MAX_MIME.div_ceil(3) * 4 {
        return Err(Rej::new(TOO_LARGE));
    }
    STANDARD.decode(compact).map_err(|_| Rej::INVALID)
}
