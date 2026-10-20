//! SOAP request builders, written from Microsoft's EWS reference. Every value interpolated into
//! XML goes through `esc`; ids are base64 the codec checked, a search phrase is rewritten by
//! `query` first.

use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, SecondsFormat};
use quick_xml::escape::escape;

/// The lowest `ExchangeVersionType` with `item:Preview`, `item:Flag` and `SuppressReadReceipts`.
const VERSION: &str = "Exchange2013_SP1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Role {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Junk,
}

impl Role {
    pub const ALL: [Role; 5] = [
        Role::Inbox,
        Role::Sent,
        Role::Drafts,
        Role::Trash,
        Role::Junk,
    ];

    /// The `DistinguishedFolderIdNameType` value; Exchange has no plain "archive" among them.
    pub fn name(self) -> &'static str {
        match self {
            Role::Inbox => "inbox",
            Role::Sent => "sentitems",
            Role::Drafts => "drafts",
            Role::Trash => "deleteditems",
            Role::Junk => "junkemail",
        }
    }
}

/// Every item field a row or message needs.
const ITEM_FIELDS: [&str; 13] = [
    "item:ParentFolderId",
    "message:InternetMessageId",
    "item:Subject",
    "message:From",
    "message:ToRecipients",
    "message:CcRecipients",
    "item:DateTimeReceived",
    "item:DateTimeSent",
    "item:Size",
    "message:IsRead",
    "item:Flag",
    "item:IsDraft",
    "item:Preview",
];

fn esc(text: &str) -> std::borrow::Cow<'_, str> {
    escape(text)
}

fn envelope(body: &str) -> String {
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="utf-8"?><soap:Envelope"#,
            r#" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/""#,
            r#" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages""#,
            r#" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">"#,
            r#"<soap:Header><t:RequestServerVersion Version="{}"/></soap:Header>"#,
            "<soap:Body>{}</soap:Body></soap:Envelope>"
        ),
        VERSION, body
    )
}

fn field(uri: &str) -> String {
    format!(r#"<t:FieldURI FieldURI="{uri}"/>"#)
}

fn folder(role: Role) -> String {
    format!(r#"<t:DistinguishedFolderId Id="{}"/>"#, role.name())
}

fn item_shape(mime: bool) -> String {
    let mime = if mime {
        "<t:IncludeMimeContent>true</t:IncludeMimeContent>"
    } else {
        ""
    };
    let fields: String = ITEM_FIELDS.iter().map(|uri| field(uri)).collect();
    format!(
        "<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>{mime}<t:AdditionalProperties>{fields}</t:AdditionalProperties></m:ItemShape>"
    )
}

fn item_ids(ids: &[String]) -> String {
    let ids: String = ids
        .iter()
        .map(|id| format!(r#"<t:ItemId Id="{}"/>"#, esc(id)))
        .collect();
    format!("<m:ItemIds>{ids}</m:ItemIds>")
}

pub fn get_folders(roles: &[Role]) -> String {
    let folders: String = roles.iter().map(|role| folder(*role)).collect();
    let fields = ["folder:TotalCount", "folder:UnreadCount"]
        .map(field)
        .concat();
    envelope(&format!(
        "<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>{fields}</t:AdditionalProperties></m:FolderShape><m:FolderIds>{folders}</m:FolderIds></m:GetFolder>"
    ))
}

pub enum Condition {
    /// Received before the end of the second this instant (milliseconds) falls in: `DateTimeReceived`
    /// is whole seconds, so a bound at the instant would lose later rows of its second.
    ReceivedBy(i64),
    Unread,
    Flagged,
}

/// `PidTagFlagStatus` (MS-OXOFLAG 2.2.1.1) equal to `followupFlagged`, as `item:Flag` is a structure
/// a comparison cannot name.
const FLAGGED: &str = r#"<t:ExtendedFieldURI PropertyTag="0x1090" PropertyType="Integer"/>"#;

fn restriction(conditions: &[Condition]) -> String {
    let compare = |op: &str, path: &str, value: &str| {
        format!(
            r#"<t:{op}>{path}<t:FieldURIOrConstant><t:Constant Value="{value}"/></t:FieldURIOrConstant></t:{op}>"#
        )
    };
    let parts: String = conditions
        .iter()
        .map(|condition| match condition {
            Condition::ReceivedBy(ms) => {
                let end = DateTime::from_timestamp(ms.div_euclid(1000) + 1, 0).unwrap_or_default();
                let end = end.to_rfc3339_opts(SecondsFormat::Secs, true);
                compare("IsLessThan", &field("item:DateTimeReceived"), &end)
            }
            Condition::Unread => compare("IsEqualTo", &field("message:IsRead"), "false"),
            Condition::Flagged => compare("IsEqualTo", FLAGGED, "2"),
        })
        .collect();
    match conditions.len() {
        0 => String::new(),
        // `And` needs two or more children.
        1 => format!("<m:Restriction>{parts}</m:Restriction>"),
        _ => format!("<m:Restriction><t:And>{parts}</t:And></m:Restriction>"),
    }
}

/// `FindItem` over one folder, newest received first. A text search (`phrase`) takes no
/// restriction ("QueryString excludes the use of EWS restrictions") and the server refuses one over
/// several folders, so callers ask one folder at a time.
pub fn find_items(
    role: Role,
    limit: usize,
    offset: usize,
    conditions: &[Condition],
    phrase: Option<&str>,
) -> String {
    let query = phrase.map_or_else(String::new, |phrase| {
        format!("<m:QueryString>{}</m:QueryString>", esc(phrase))
    });
    envelope(&format!(
        concat!(
            r#"<m:FindItem Traversal="Shallow">{}"#,
            r#"<m:IndexedPageItemView MaxEntriesReturned="{}" Offset="{}" BasePoint="Beginning"/>{}"#,
            r#"<m:SortOrder><t:FieldOrder Order="Descending">{}</t:FieldOrder></m:SortOrder>"#,
            "<m:ParentFolderIds>{}</m:ParentFolderIds>{}</m:FindItem>"
        ),
        item_shape(false),
        limit,
        offset,
        restriction(conditions),
        field("item:DateTimeReceived"),
        folder(role),
        query
    ))
}

/// `FindItem` asking for item ids alone, up to `limit`: how many items match, counted rather than
/// taken from `TotalItemsInView`, which a live server left behind a restricted view for minutes.
pub fn count_items(role: Role, limit: usize, conditions: &[Condition]) -> String {
    envelope(&format!(
        concat!(
            r#"<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>"#,
            r#"<m:IndexedPageItemView MaxEntriesReturned="{}" Offset="0" BasePoint="Beginning"/>{}"#,
            "<m:ParentFolderIds>{}</m:ParentFolderIds></m:FindItem>"
        ),
        limit,
        restriction(conditions),
        folder(role)
    ))
}

/// `GetItem`: the rows with `mime` false, the whole message as base64 `MimeContent` with it.
pub fn get_items(ids: &[String], mime: bool) -> String {
    envelope(&format!(
        "<m:GetItem>{}{}</m:GetItem>",
        item_shape(mime),
        item_ids(ids)
    ))
}

/// `GetItem` for the current change keys: `UpdateItem` needs them and a key is new after any change.
pub fn get_keys(ids: &[String]) -> String {
    envelope(&format!(
        "<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>{}</m:GetItem>",
        item_ids(ids)
    ))
}

pub enum Change {
    Read(bool),
    Flag(bool),
}

/// `UpdateItem` of read state or follow-up flag for (id, change key) pairs. Read receipts are
/// suppressed: "If IsReadReceiptRequested is true, setting IsRead to true sends a read receipt".
pub fn update_items(items: &[(String, String)], change: &Change) -> String {
    let update = match change {
        Change::Read(read) => format!(
            "{}<t:Message><t:IsRead>{read}</t:IsRead></t:Message>",
            field("message:IsRead")
        ),
        Change::Flag(flagged) => format!(
            "{}<t:Message><t:Flag><t:FlagStatus>{}</t:FlagStatus></t:Flag></t:Message>",
            field("item:Flag"),
            if *flagged { "Flagged" } else { "NotFlagged" }
        ),
    };
    let changes: String = items
        .iter()
        .map(|(id, key)| {
            format!(
                r#"<t:ItemChange><t:ItemId Id="{}" ChangeKey="{}"/><t:Updates><t:SetItemField>{update}</t:SetItemField></t:Updates></t:ItemChange>"#,
                esc(id),
                esc(key)
            )
        })
        .collect();
    envelope(&format!(
        r#"<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AutoResolve" SuppressReadReceipts="true"><m:ItemChanges>{changes}</m:ItemChanges></m:UpdateItem>"#
    ))
}

/// `MoveItem`; an id changes on a move, hence `ReturnNewItemIds`.
pub fn move_items(ids: &[String], to: Role) -> String {
    envelope(&format!(
        "<m:MoveItem><m:ToFolderId>{}</m:ToFolderId>{}<m:ReturnNewItemIds>true</m:ReturnNewItemIds></m:MoveItem>",
        folder(to),
        item_ids(ids)
    ))
}

/// `CreateItem` sending one MIME message and filing a copy in Sent. A `Bcc` header in the MIME is
/// honoured and left out of the delivered copies (measured on Exchange 2019). The answer carries
/// no id, so success is the response code.
pub fn send_message(mime: &[u8]) -> String {
    envelope(&format!(
        r#"<m:CreateItem MessageDisposition="SendAndSaveCopy"><m:SavedItemFolderId>{}</m:SavedItemFolderId><m:Items><t:Message><t:MimeContent CharacterSet="UTF-8">{}</t:MimeContent></t:Message></m:Items></m:CreateItem>"#,
        folder(Role::Sent),
        STANDARD.encode(mime)
    ))
}

/// `CreateItem` filing one MIME message in Drafts. `PidTagMessageFlags` (0x0E07, MS-OXCMSG) is set
/// to read and unsent (`mfRead` 0x1 with `mfUnsent` 0x8), which only a new item can be given: a
/// message made from MIME is otherwise filed as one that was received, and opens as no draft.
pub fn save_draft(mime: &[u8]) -> String {
    envelope(&format!(
        r#"<m:CreateItem MessageDisposition="SaveOnly"><m:SavedItemFolderId>{}</m:SavedItemFolderId><m:Items><t:Message><t:MimeContent CharacterSet="UTF-8">{}</t:MimeContent><t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x0E07" PropertyType="Integer"/><t:Value>9</t:Value></t:ExtendedProperty></t:Message></m:Items></m:CreateItem>"#,
        folder(Role::Drafts),
        STANDARD.encode(mime)
    ))
}

/// `DeleteItem` into the dumpster: the server can still recover it, and Deleted Items does not
/// gain a copy for every save that replaced a draft.
pub fn delete_items(ids: &[String]) -> String {
    envelope(&format!(
        r#"<m:DeleteItem DeleteType="SoftDelete">{}</m:DeleteItem>"#,
        item_ids(ids)
    ))
}
