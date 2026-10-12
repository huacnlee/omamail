//! Documents in and out: the XML limits, MS-NLMP known answers, request builders and decoders.

use super::super::{decode, ntlm, soap, xml};
use super::fake::{self, ews_id};

fn hex(text: &str) -> Vec<u8> {
    let digits: Vec<u8> = text.bytes().filter(u8::is_ascii_hexdigit).collect();
    digits
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

#[test]
fn xml_parses_what_exchange_writes_and_refuses_what_a_hostile_server_could() {
    let tree = xml::parse(
        br#"<a:r xmlns:a="u" x="1"><a:s k="&amp;">t&lt;&#x41;<![CDATA[ <c>]]></a:s><e/></a:r>"#,
    )
    .unwrap();
    assert_eq!((tree.name.as_str(), tree.attr("x")), ("r", Some("1")));
    assert_eq!(tree.child("s").unwrap().text, "t<A <c>");
    assert_eq!(tree.child("s").unwrap().attr("k"), Some("&"));
    // Exchange writes a property value XML cannot carry as a character reference: U+FFFD, not a failure.
    assert_eq!(
        xml::parse(b"<a>x&#x1;y&#xD800;</a>").unwrap().text,
        "x\u{fffd}y\u{fffd}"
    );
    let deep = "<a>".repeat(40) + &"</a>".repeat(40);
    let wide = format!("<a>{}</a>", "<b/>".repeat(200_001));
    for (name, bad) in [
        (
            "doctype",
            "<!DOCTYPE a [<!ENTITY e \"x\">]><a>&e;</a>".to_owned(),
        ),
        ("unknown entity", "<a>&nbsp;</a>".to_owned()),
        ("depth", deep),
        ("elements", wide),
        ("two roots", "<a/><b/>".to_owned()),
        ("unclosed", "<a><b></a>".to_owned()),
        ("not xml", "no".to_owned()),
    ] {
        assert_eq!(
            xml::parse(bad.as_bytes()).err(),
            Some("exchange_invalid_response"),
            "{name}"
        );
    }
    // At most 64 attributes to an element, each counted with the elements: neither one start tag
    // nor many small ones can be a whole response, and a bomb is refused at once rather than after
    // every attribute was compared with every other.
    let attributes = |n: usize| (0..n).map(|i| format!(" a{i}=\"\"")).collect::<String>();
    assert!(xml::parse(format!("<a{}/>", attributes(64)).as_bytes()).is_ok());
    let started = std::time::Instant::now();
    for (name, bad) in [
        ("65 attributes", format!("<a{}/>", attributes(65))),
        ("bomb", format!("<a{}/>", attributes(100_000))),
        (
            "budget",
            format!("<a>{}</a>", format!("<b{}/>", attributes(50)).repeat(5_000)),
        ),
    ] {
        assert_eq!(
            xml::parse(bad.as_bytes()).err(),
            Some("exchange_invalid_response"),
            "{name}"
        );
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
}

#[test]
fn ntlm_matches_the_ms_nlmp_known_answers() {
    // 4.2.4: NTOWFv2("Password", "User", "Domain"), its NTLMv2 response over the example TargetInfo
    // (client challenge aa.., time 0) and the SessionBaseKey.
    let key = ntlm::ntowf_v2("Password", "User", "Domain");
    assert_eq!(key[..], hex("0c868a403bfd7a93a3001ef22ef02e3f")[..]);
    let info = hex("02000c0044006f006d00610069006e0001000c00530065007200760065007200 00000000");
    let (response, session_base_key) =
        ntlm::ntlmv2(&key, &hex("0123456789abcdef"), &[0xaa; 8], &[0; 8], &info);
    assert_eq!(response[..16], hex("68cd0ab851e51c96aabc927bebef6a1c")[..]);
    assert_eq!(
        session_base_key[..],
        hex("8de40ccadbc14a82f15cb0ad0de95ca3")[..]
    );
    // The client the way IIS sees it, refused by the verifier if any of NTLMv2, the MIC, the channel
    // binding or the service name is off (`fake::verify`).
}

#[test]
fn channel_binding_is_the_md5_of_the_gss_struct_over_the_certificate_hash() {
    // RFC 5929 with the repository's certificate (sha256WithRSA): the verifier computes it apart.
    let binding = ntlm::channel_binding(&fake::server_cert()).unwrap();
    assert_eq!(binding.len(), 16);
    // Not a certificate: refused as a TLS failure, never a panic.
    for junk in [
        &b""[..],
        b"\x30\x03\x01\x01\xff",
        &fake::server_cert()[..40],
    ] {
        assert_eq!(ntlm::channel_binding(junk), Err("exchange_tls_failed"));
    }
}

#[test]
fn authenticate_refuses_a_challenge_that_cannot_carry_the_protection() {
    let ok = |challenge: &[u8]| {
        ntlm::authenticate(
            "a",
            "p",
            &ntlm::negotiate(),
            challenge,
            [0; 8],
            "HTTP/h",
            [0; 16],
        )
    };
    // No timestamp in the TargetInfo: answering would let a relaying peer switch the binding off.
    assert_eq!(ok(&fake::challenge(false)), Err("exchange_auth_failed"));
    assert!(ok(&fake::challenge(true)).is_ok());
    assert_eq!(ok(b"NTLMSSP\0"), Err("exchange_auth_failed"));
    assert_eq!(ok(&[0u8; 100]), Err("exchange_auth_failed"));
    assert_eq!(
        ntlm::authenticate("", "p", &[], &[], [0; 8], "", [0; 16]),
        Err("invalid_params")
    );
}

fn built(request: &str) -> xml::Node {
    let mut tree = xml::parse(request.as_bytes()).unwrap();
    assert_eq!(
        tree.at(&["Header", "RequestServerVersion"])
            .unwrap()
            .attr("Version"),
        Some("Exchange2013_SP1")
    );
    tree.children.swap_remove(1).children.remove(0)
}

#[test]
fn requests_say_what_the_server_needs_and_escape_what_they_carry() {
    let find = built(&soap::find_items(
        soap::Role::Inbox,
        25,
        50,
        &[],
        Some("\"a <b> & c\"*"),
    ));
    assert_eq!(find.attr("Traversal"), Some("Shallow"));
    assert_eq!(
        find.child("IndexedPageItemView").unwrap().attr("Offset"),
        Some("50")
    );
    assert_eq!(
        find.at(&["ParentFolderIds", "DistinguishedFolderId"])
            .unwrap()
            .attr("Id"),
        Some("inbox")
    );
    assert_eq!(find.text_at(&["QueryString"]), Some("\"a <b> & c\"*"));
    assert!(
        find.child("Restriction").is_none(),
        "a query string excludes restrictions"
    );

    // Two conditions need an `And`; the received bound is the end of the cursor's second.
    let both = built(&soap::find_items(
        soap::Role::Junk,
        5,
        0,
        &[
            soap::Condition::ReceivedBy(1_790_000_000_999),
            soap::Condition::Unread,
        ],
        None,
    ));
    let restriction = both.child("Restriction").unwrap().child("And").unwrap();
    assert_eq!(
        restriction
            .at(&["IsLessThan", "FieldURIOrConstant", "Constant"])
            .unwrap()
            .attr("Value"),
        Some("2026-09-21T14:13:21Z")
    );
    assert_eq!(
        restriction
            .at(&["IsEqualTo", "FieldURI"])
            .unwrap()
            .attr("FieldURI"),
        Some("message:IsRead")
    );
    let flagged = built(&soap::find_items(
        soap::Role::Inbox,
        5,
        0,
        &[soap::Condition::Flagged],
        None,
    ));
    let equal = flagged.at(&["Restriction", "IsEqualTo"]).unwrap();
    assert_eq!(
        equal.child("ExtendedFieldURI").unwrap().attr("PropertyTag"),
        Some("0x1090")
    );

    let update = built(&soap::update_items(
        &[("id1".into(), "key\"1".into())],
        &soap::Change::Flag(true),
    ));
    assert_eq!(update.attr("SuppressReadReceipts"), Some("true"));
    assert_eq!(
        update
            .at(&["ItemChanges", "ItemChange", "ItemId"])
            .unwrap()
            .attr("ChangeKey"),
        Some("key\"1")
    );
    assert_eq!(
        update.text_at(&[
            "ItemChanges",
            "ItemChange",
            "Updates",
            "SetItemField",
            "Message",
            "Flag",
            "FlagStatus"
        ]),
        Some("Flagged")
    );

    let moved = built(&soap::move_items(&["id1".into()], soap::Role::Trash));
    assert_eq!(moved.text_at(&["ReturnNewItemIds"]), Some("true"));
    assert_eq!(
        moved
            .at(&["ToFolderId", "DistinguishedFolderId"])
            .unwrap()
            .attr("Id"),
        Some("deleteditems")
    );

    let create = built(&soap::send_message(b"Bcc: a@example.org\r\n\r\nx"));
    assert_eq!(create.attr("MessageDisposition"), Some("SendAndSaveCopy"));
    assert_eq!(
        create
            .at(&["SavedItemFolderId", "DistinguishedFolderId"])
            .unwrap()
            .attr("Id"),
        Some("sentitems")
    );
    assert_eq!(
        create.text_at(&["Items", "Message", "MimeContent"]),
        Some("QmNjOiBhQGV4YW1wbGUub3JnDQoNCng=")
    );

    // A draft is filed, not sent, in Drafts, and marked read and unsent so it opens as a draft.
    let draft = built(&soap::save_draft(b"Bcc: a@example.org\r\n\r\nx"));
    assert_eq!(draft.attr("MessageDisposition"), Some("SaveOnly"));
    assert_eq!(
        draft
            .at(&["SavedItemFolderId", "DistinguishedFolderId"])
            .unwrap()
            .attr("Id"),
        Some("drafts")
    );
    let message = draft.at(&["Items", "Message"]).unwrap();
    assert_eq!(
        message.text_at(&["MimeContent"]),
        Some("QmNjOiBhQGV4YW1wbGUub3JnDQoNCng=")
    );
    let flags = message.child("ExtendedProperty").unwrap();
    assert_eq!(
        (
            flags.child("ExtendedFieldURI").unwrap().attr("PropertyTag"),
            flags.text_at(&["Value"])
        ),
        (Some("0x0E07"), Some("9"))
    );
    // Deleted into the dumpster, recoverable by the server, never past it.
    let delete = built(&soap::delete_items(&["id\"1".into()]));
    assert_eq!(delete.attr("DeleteType"), Some("SoftDelete"));
    assert_eq!(
        delete.at(&["ItemIds", "ItemId"]).unwrap().attr("Id"),
        Some("id\"1")
    );

    let keys = built(&soap::get_keys(&["a".into()]));
    assert!(
        keys.at(&["ItemShape"])
            .unwrap()
            .child("AdditionalProperties")
            .is_none()
    );
    assert_eq!(
        built(&soap::get_items(&["a".into()], true)).text_at(&["ItemShape", "IncludeMimeContent"]),
        Some("true")
    );
}

fn body(envelope: String) -> xml::Node {
    decode::envelope(envelope.as_bytes())
        .map_err(|rej| rej.code)
        .unwrap()
        .body
}

#[test]
fn folders_and_items_decode_to_what_the_resource_builder_reads() {
    let folders = decode::folders(&body(fake::folders()), 5).unwrap();
    let inbox = folders[0].as_ref().ok().unwrap();
    assert_eq!(
        (inbox.id.as_str(), inbox.total, inbox.unread),
        ("inbox", 120, 7)
    );

    let one = format!(
        r#"<t:Message><t:ItemId Id="{}" ChangeKey="CQAA"/><t:ParentFolderId Id="f1"/><t:Subject>Hi &amp; bye</t:Subject>
        <t:DateTimeReceived>2026-10-01T10:00:00Z</t:DateTimeReceived><t:DateTimeSent>0001-01-01T00:00:00Z</t:DateTimeSent><t:Size>12</t:Size>
        <t:IsRead>true</t:IsRead><t:Flag><t:FlagStatus>Flagged</t:FlagStatus></t:Flag><t:IsDraft>false</t:IsDraft>
        <t:From><t:Mailbox><t:Name>Ada</t:Name><t:EmailAddress>ada@example.org</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType></t:Mailbox></t:From>
        <t:ToRecipients><t:Mailbox><t:Name>/O=EX/CN=bob</t:Name><t:EmailAddress>/O=EX/CN=bob</t:EmailAddress><t:RoutingType>EX</t:RoutingType></t:Mailbox></t:ToRecipients>
        <t:MimeContent CharacterSet="UTF-8">aGk
        h</t:MimeContent></t:Message>"#,
        ews_id(1)
    );
    let found = decode::get(
        &body(fake::response(
            "GetItem",
            &[fake::ok("GetItem", &format!("<m:Items>{one}</m:Items>"))],
        )),
        1,
        true,
    )
    .unwrap();
    let item = found[0].as_ref().ok().unwrap();
    assert_eq!(
        (item.change_key.as_str(), item.subject.as_str(), item.size),
        ("CQAA", "Hi & bye", 12)
    );
    assert!(item.read && item.flagged && !item.draft);
    assert_eq!(item.received_ms, Some(1_790_848_800_000));
    assert_eq!(
        item.sent_ms, None,
        "a date before 1970 is the sentinel for none"
    );
    assert_eq!(item.mime.as_deref(), Some(&b"hi!"[..]));
    assert_eq!(item.from.as_ref().unwrap().address, "ada@example.org");
    // An X.500 address is no SMTP one: the name is kept, the address is not.
    assert_eq!(
        (item.to[0].name.as_str(), item.to[0].address.as_str()),
        ("/O=EX/CN=bob", "")
    );
}

#[test]
fn a_response_is_trusted_only_as_far_as_it_is_well_formed() {
    let inbox = || {
        fake::ok(
            "GetFolder",
            r#"<m:Folders><t:Folder><t:FolderId Id="i"/><t:TotalCount>1</t:TotalCount><t:UnreadCount>0</t:UnreadCount></t:Folder></m:Folders>"#,
        )
    };
    // Another number of answers than questions, another operation's answer, no class: damaged.
    for (name, document) in [
        ("short", fake::response("GetFolder", &[inbox()])),
        ("wrong operation", fake::response("GetItem", &[inbox(), inbox()])),
        ("no class", fake::response("GetFolder", &["<m:GetFolderResponseMessage><m:ResponseCode>NoError</m:ResponseCode></m:GetFolderResponseMessage>".repeat(2)])),
        ("success with an error code", fake::response("GetFolder", &[fake::message("GetFolder", "Success", "ErrorAccessDenied", ""), inbox()])),
        ("no counts", fake::response("GetFolder", &[fake::ok("GetFolder", "<m:Folders><t:Folder><t:FolderId Id=\"i\"/></t:Folder></m:Folders>"), inbox()])),
    ] {
        let answer = decode::folders(&body(document), 2).map(|all| all.into_iter().all(|r| r.is_ok()));
        assert!(matches!(answer, Err(_) | Ok(false)), "{name}");
    }
    assert!(decode::envelope(b"<html/>").is_err());
}

#[test]
fn server_codes_become_static_codes_and_say_whether_the_server_acted() {
    // (ResponseCode, our code, may a write be repeated, back-off asked for)
    let table = [
        (
            "ErrorItemNotFound",
            "exchange_message_not_found",
            false,
            false,
        ),
        ("ErrorAccessDenied", "exchange_access_denied", false, false),
        ("ErrorServerBusy", "exchange_throttled", true, true),
        (
            "ErrorInternalServerTransientError",
            "exchange_server_error",
            false,
            true,
        ),
        (
            "ErrorBatchProcessingStopped",
            "exchange_server_error",
            true,
            false,
        ),
        (
            "ErrorChangeKeyRequiredForWriteOperations",
            "exchange_stale_item",
            true,
            false,
        ),
        (
            "ErrorMailRecipientNotFound",
            "exchange_send_rejected",
            false,
            false,
        ),
        // The server refused the message's content; it is not a message too large to read.
        (
            "ErrorMimeContentInvalid",
            "exchange_send_rejected",
            false,
            false,
        ),
        (
            "ErrorMessageSizeExceeded",
            "exchange_message_too_large",
            false,
            false,
        ),
        (
            "ErrorInvalidServerVersion",
            "exchange_unsupported_server",
            false,
            false,
        ),
        ("ErrorSomethingNew", "exchange_server_error", false, false),
    ];
    for (code, ours, unprocessed, wait) in table {
        let rej = decode::envelope(fake::fault(code).as_bytes())
            .err()
            .unwrap();
        assert_eq!(
            (rej.code, rej.unprocessed, rej.wait_ms.is_some()),
            (ours, unprocessed, wait),
            "{code}"
        );
        let per_message = decode::outcomes(
            &body(fake::response(
                "MoveItem",
                &[fake::message("MoveItem", "Error", code, "")],
            )),
            "MoveItem",
            1,
        )
        .unwrap();
        assert_eq!(per_message[0].err().map(|r| r.code), Some(ours), "{code}");
    }
    // The back-off the server suggests, bounded to a minute.
    let hint = |ms: &str| {
        let busy = fake::message(
            "MoveItem",
            "Error",
            "ErrorServerBusy",
            &format!(
                r#"<m:MessageXml><t:Value Name="BackOffMilliseconds">{ms}</t:Value></m:MessageXml>"#
            ),
        );
        decode::outcomes(&body(fake::response("MoveItem", &[busy])), "MoveItem", 1).unwrap()[0]
            .err()
            .unwrap()
            .wait_ms
    };
    assert_eq!((hint("250"), hint("9999999")), (Some(250), Some(60_000)));
}
