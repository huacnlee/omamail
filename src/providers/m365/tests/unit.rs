//! Pure functions: identifiers, the query language, header synthesis, link and token validation.
//! String tables are `|`-separated.

use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

use super::super::graph::{Fault, next_link, url};
use super::super::mailbox::{seal, unseal};
use super::super::model::{self, Folder, Query, Role, Roles, Scope};
use super::super::{call, ids, send, signin};
use super::{ACCOUNT, CLIENT, gid, oid};

fn b64(value: Value) -> String {
    URL_SAFE_NO_PAD.encode(value.to_string())
}

#[test]
fn message_ids_have_one_spelling_and_fit_the_cache_file_name() {
    let longest = "A".repeat(156);
    for graph in [gid(1), longest.clone(), "AAMk-_=AAAA".to_owned()] {
        let id = ids::encode(&graph).unwrap();
        assert_eq!(ids::decode(&id).unwrap(), graph);
    }
    assert_eq!(ids::encode(&gid(1)).unwrap(), "ifau222bi5etembqgayucqkbhu");
    // The cache escapes every byte outside [a-z0-9.-] and refuses names over 255 bytes.
    let id = ids::encode(&longest).unwrap();
    assert_eq!(id.len(), 250);
    crate::cache::validate_params(&json!({"accountId": ACCOUNT, "id": id}), true).unwrap();
    let bad = format!(
        "|ifau222|ifau222bi5etembqgayucqkbhv|IFAU222BI5ETEMBQGAYUCQKBHU|{0}=|{0}aa|{1}aa|{2}|1:INBOX|../x|mfrgg43f|{3}",
        "ifau222bi5etembqgayucqkbhu",
        id,
        "ifau222 bi5etembqgayucqkbhu",
        "a".repeat(251)
    );
    for bad in bad.split('|') {
        assert_eq!(
            ids::validate_message_id(bad),
            Err("invalid_params"),
            "{bad:?}"
        );
    }
    // What a server sends that cannot be carried is its fault.
    for bad in [
        "",
        "short",
        "has space 12345",
        "a/b/c/d/e/f",
        "ünïcode12345",
        &"A".repeat(157),
    ] {
        assert_eq!(ids::encode(bad), Err("m365_bad_response"), "{bad:?}");
    }
}

#[test]
fn account_and_client_ids_are_validated_before_use() {
    assert_eq!(
        ids::account_id("m365:a@example.org"),
        Ok("m365:a@example.org")
    );
    let bad = "a@example.org|outlook:a@example.org|m365:A@example.org|m365:|m365:a|m365:a@example|m365:a b@example.org|m365:a@example.org\n";
    for bad in bad
        .split('|')
        .chain([format!("m365:{}@example.org", "a".repeat(400)).as_str()])
    {
        assert_eq!(ids::account_id(bad), Err("invalid_params"), "{bad:?}");
    }
    assert_eq!(
        ids::client_id("ABCDEF01-2345-6789-abcd-ef0123456789").unwrap(),
        "abcdef01-2345-6789-abcd-ef0123456789"
    );
    let bad = "|not-a-guid|00000000-1111-2222-3333-44444444444|00000000111122223333444444444444|0000000g-1111-2222-3333-444444444444|00000000-1111-2222-3333-444444444444\n";
    for bad in bad.split('|') {
        assert_eq!(ids::client_id(bad), Err("invalid_params"), "{bad:?}");
    }
}

#[test]
fn queries_are_the_role_and_text_forms_and_nothing_else() {
    let role = |role, unread, flagged| {
        Ok(Query {
            scope: Scope::Folder(role),
            unread,
            flagged,
        })
    };
    for (text, expected) in [
        ("role:inbox", role(Role::Inbox, false, false)),
        ("ROLE:Junk unseen", role(Role::Junk, true, false)),
        (" role:inbox flagged unseen ", role(Role::Inbox, true, true)),
        ("role:archive", role(Role::Archive, false, false)),
    ] {
        assert_eq!(model::parse(text), expected, "{text}");
    }
    let bad = "|inbox|hello|role:|role: inbox|role:spam|role:inbox unseen unseen|role:inbox other|folder:inbox|text:|text:   |text:\"|text:\u{201c}\u{201d}|text:***|text:()|text:-+|role:inbox\n|text:a\nb";
    for bad in bad
        .split('|')
        .chain([format!("text:{}", "a".repeat(5000)).as_str()])
    {
        assert_eq!(model::parse(bad), Err("invalid_params"), "{bad:?}");
    }
    // Graph reads a search as KQL: the words are searched as words, with nothing that is syntax.
    for (typed, words) in [
        ("  invoice \"OR\" \\ a\u{201d}b  ", "invoice or a b"),
        (
            "from:ada (x OR y) z* a AND NOT b",
            "from ada x or y z a and not b",
        ),
        ("-x +y ~z <q> a=b \u{ff02}c\u{ff02}", "x y z q a b c"),
    ] {
        let query = model::parse(&format!("text:{typed}")).unwrap();
        assert_eq!(query.scope, Scope::Text(words.into()), "{typed}");
    }
    assert_eq!(model::parse("text:a  b").unwrap().canonical(), "text:a b");
    assert_eq!(
        model::parse("role:inbox flagged unseen")
            .unwrap()
            .canonical(),
        "role:inbox unseen flagged"
    );
}

fn graph_message(change: Value) -> Value {
    let mut message = json!({
        "id": gid(1), "parentFolderId": "folder-inbox", "subject": "Hello", "isRead": false,
        "from": {"emailAddress": {"name": "Bob", "address": "bob@example.org"}},
        "toRecipients": [{"emailAddress": {"name": "Alice", "address": "alice@example.org"}}],
        "receivedDateTime": "2026-10-09T10:00:00Z", "bodyPreview": "Hi there",
    });
    for (key, value) in change.as_object().unwrap() {
        message[key] = value.clone();
    }
    message
}

fn roles() -> Roles {
    let folder = |role: Role| Folder {
        id: format!("folder-{}", role.well_known()),
        total: 0,
        unread: 0,
    };
    Role::ALL
        .into_iter()
        .map(|role| (role, folder(role)))
        .collect()
}

fn summary(change: Value) -> Value {
    let row = model::row(&graph_message(change), &roles()).unwrap();
    crate::message::content::summarize(&row, 0).unwrap()
}

#[test]
fn a_row_is_a_gmail_resource_whose_labels_come_from_the_folder_and_the_flags() {
    let flagged = json!({"isRead": true, "flag": {"flagStatus": "flagged"}});
    let in_folder =
        |name: &str| json!({"parentFolderId": format!("folder-{name}"), "isRead": true});
    for (change, labels) in [
        (json!({}), json!(["UNREAD", "INBOX"])),
        (flagged, json!(["STARRED", "INBOX"])),
        (in_folder("sentitems"), json!(["SENT"])),
        (in_folder("deleteditems"), json!(["TRASH"])),
        (in_folder("junkemail"), json!(["SPAM"])),
        (in_folder("drafts"), json!(["DRAFT"])),
        (in_folder("archive"), json!([])),
        // A message Graph does not say is unread is not shown as new mail; an unknown folder has no role.
        (
            json!({"isRead": null, "parentFolderId": "elsewhere"}),
            json!([]),
        ),
    ] {
        let row = model::row(&graph_message(change.clone()), &roles()).unwrap();
        assert_eq!(row["labelIds"], labels, "{change}");
    }
    let row = model::row(&graph_message(json!({})), &roles()).unwrap();
    assert_eq!(
        (row["id"].clone(), row["threadId"].clone()),
        (json!(oid(1)), json!(oid(1)))
    );
    assert_eq!(row["internalDate"], "1791540000000");
    let shown = summary(json!({"subject": "a < b & c"}));
    assert_eq!(
        (shown["subject"].as_str(), shown["snippet"].as_str()),
        (Some("a < b & c"), Some("Hi there"))
    );
    assert_eq!(
        (
            shown["from"]["email"].clone(),
            shown["to"][0]["name"].clone()
        ),
        (json!("bob@example.org"), json!("Alice"))
    );
    assert_eq!(shown["date"], "2026-10-09T10:00:00.000Z");
    // A row Graph gave an id nothing can carry is an error, left out of the page by the caller.
    assert!(model::row(&graph_message(json!({"id": "a b"})), &roles()).is_err());
}

#[test]
fn nothing_a_stranger_writes_can_start_a_header_or_a_recipient() {
    let named = |name: &str, address: &str| {
        let party = json!({"emailAddress": {"name": name, "address": address}});
        let second = json!({"emailAddress": {"name": "Second", "address": "second@example.org"}});
        summary(json!({"from": party, "toRecipients": [party, second]}))
    };
    for name in [
        "x\\\" <a@b.c>, \\\"y",
        "Evil\r\nBcc: x@y.z",
        "Name <evil@x.y>",
        "=?UTF-8?B?QQ==?=",
        "Ünï \u{2028} cøde",
        "a, b",
    ] {
        let shown = named(name, "bob@example.org");
        let to = shown["to"].as_array().unwrap();
        assert_eq!(to.len(), 2, "{name:?}");
        assert_eq!(
            (to[0]["email"].clone(), to[1]["email"].clone()),
            (json!("bob@example.org"), json!("second@example.org"))
        );
        assert!(
            !to[0]["name"]
                .as_str()
                .unwrap()
                .contains(['\r', '\n', '\u{2028}'])
        );
        assert_eq!(shown["from"]["email"], "bob@example.org");
    }
    // An address that is not a plain addr-spec is never written as one.
    for address in [
        "a@b@c",
        "a b@c.d",
        "x,y@example.org",
        "\"q\"@example.org",
        "(c)@example.org",
        "/O=ORG/CN=BOB",
        "a@example.org>, <evil@example.org",
    ] {
        let to = named("Bob", address)["to"].as_array().unwrap().clone();
        assert_eq!(to.len(), 2, "{address:?}");
        assert!(
            !to[0]["email"].as_str().unwrap().contains(['<', '>', ',']),
            "{address:?}"
        );
        assert_ne!(to[0]["email"], "evil@example.org");
    }
    // A subject holding an encoded word is shown as typed, not decoded into what it spells.
    let shown = summary(json!({"subject": "=?UTF-8?B?SGVsbG8=?= \r\nBcc: x@y.z"}));
    assert_eq!(shown["subject"], "=?UTF-8?B?SGVsbG8=?= Bcc: x@y.z");
    let escape = summary(json!({"bodyPreview": "&#27;[2J <script>alert(1)</script>"}));
    assert!(!escape["snippet"].as_str().unwrap().contains('\u{1b}'));
    let long = summary(json!({"subject": "s".repeat(5000), "bodyPreview": "p".repeat(5000)}));
    assert!(
        long["subject"].as_str().unwrap().len() <= 998
            && long["snippet"].as_str().unwrap().len() <= 200
    );
}

#[test]
fn only_a_graph_messages_listing_may_be_followed() {
    let good =
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=25&$skiptoken=abc";
    assert!(next_link(good).is_some());
    assert!(
        next_link("https://graph.microsoft.com/v1.0/me/messages?$search=%22x%22&$skiptoken=1")
            .is_some()
    );
    let g = "https://graph.microsoft.com";
    let bad = format!(
        "http://graph.microsoft.com/v1.0/me/messages|{g}.evil.test/v1.0/me/messages|https://graph.microsoft.com@evil.test/v1.0/me/messages|https://user:pw@graph.microsoft.com/v1.0/me/messages|{g}:8443/v1.0/me/messages|https://evil.test/v1.0/me/messages|{g}/v1.0/users/x/messages|{g}/v1.0/me/sendMail|{g}/v1.0/me/../users/x/messages|{g}/v1.0/me/a%2fb/messages|{g}/v1.0/me/a%5cb/messages|{g}/v1.0/me/messages#fragment|{g}/v1.0/me/messages\\x|{g}/v1.0/me/messages x|/v1.0/me/messages|{good}&{}",
        "a".repeat(9000)
    );
    for bad in bad.split('|').chain([""]) {
        assert!(next_link(bad).is_none(), "{bad:.60}");
    }
    for segments in [vec![""], vec![".."], vec!["me", "."]] {
        assert!(url(&segments, &[]).is_err());
    }
    // A query value is encoded so that it cannot add a parameter.
    let url = url(&["me", "messages"], &[("$search", "a&b=c d")]).unwrap();
    assert_eq!(url.query(), Some("$search=a%26b%3Dc%20d"));
}

#[test]
fn a_page_token_continues_only_its_own_query_and_only_toward_graph() {
    let query = model::parse("role:inbox unseen").unwrap();
    let link = reqwest::Url::parse(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=1",
    )
    .unwrap();
    let token = seal(&query, &link, 42, 25).unwrap();
    let cursor = unseal(&token, &query).unwrap();
    assert_eq!(
        (cursor.link, cursor.estimate, cursor.size),
        (link.clone(), 42, 25)
    );
    let canonical = query.canonical();
    let forged = |link: &str| b64(json!({"q": canonical, "e": 1, "l": 25, "n": link}));
    for bad in [
        token.clone(),
        "not base64!".into(),
        b64(json!("text")),
        b64(json!({"q": canonical, "e": "x", "l": 25, "n": link.as_str()})),
        b64(json!({"q": canonical, "e": 1, "l": 25})),
        b64(json!({"q": canonical, "e": u64::MAX, "l": 25, "n": link.as_str()})),
        b64(json!({"q": canonical, "e": 1, "n": link.as_str()})),
        b64(json!({"q": canonical, "e": 1, "l": 101, "n": link.as_str()})),
        forged("https://evil.test/v1.0/me/messages"),
        forged("http://graph.microsoft.com/v1.0/me/messages"),
        "a".repeat(20000),
    ] {
        let other = if bad == token {
            model::parse("role:inbox flagged").unwrap()
        } else {
            query.clone()
        };
        assert_eq!(unseal(&bad, &other).map(|_| ()), Err("invalid_params"));
    }
}

#[tokio::test]
async fn requests_name_exactly_their_fields_and_are_refused_before_any_account_is_read() {
    let (id, a) = (oid(1), "m365:a@example.org");
    let list = |extra: &str| format!(r#"{{"query":"role:inbox","limit":5{extra}}}"#);
    let ids = |extra: &str| format!(r#"{{"ids":["{id}"]{extra}}}"#);
    for (method, params) in [
        (
            "m365.list",
            r#"{"query":"role:nowhere","limit":5}"#.to_owned(),
        ),
        ("m365.list", r#"{"query":"role:inbox","limit":101}"#.into()),
        ("m365.list", r#"{"query":"role:inbox","limit":1.5}"#.into()),
        ("m365.list", list(r#","extra":true"#)),
        ("m365.list", list(r#","pageToken":"forged""#)),
        ("m365.list", list(r#","requestToken":"""#)),
        ("m365.messages", r#"{"ids":["BAD"],"full":false}"#.into()),
        ("m365.messages", r#"{"ids":[],"full":false}"#.into()),
        ("m365.messages", ids(r#","full":"yes""#)),
        ("m365.read", format!(r#"{{"id":"{id}","full":false}}"#)),
        ("m365.modify", ids("")),
        (
            "m365.modify",
            ids(r#","addLabelIds":["UNREAD"],"removeLabelIds":["UNREAD"]"#),
        ),
        ("m365.trash", r#"{"ids":[]}"#.into()),
        ("m365.send", r#"{"raw":"not base64url!"}"#.into()),
        (
            "m365.signInBegin",
            format!(r#"{{"address":"b@example.org","clientId":"{CLIENT}"}}"#),
        ),
        ("m365.signInBegin", r#"{"address":"a@example.org"}"#.into()),
        // There is no tenant to name: the address decides.
        (
            "m365.signInBegin",
            format!(
                r#"{{"address":"a@example.org","clientId":"{CLIENT}","tenant":"organizations"}}"#
            ),
        ),
        ("m365.signOut", r#"{"clientId":"forged"}"#.into()),
        ("m365.cancel", "{}".into()),
    ] {
        let mut params: Value = serde_json::from_str(&params).unwrap();
        params["accountId"] = json!(a);
        assert_eq!(
            call(method, &params).await,
            Err("invalid_params"),
            "{method} {params}"
        );
    }
    let foreign = json!({"accountId": "imap:a@example.org", "query": "role:inbox", "limit": 5});
    assert_eq!(call("m365.list", &foreign).await, Err("invalid_params"));
    assert_eq!(
        call("m365.signInPoll", &json!({"requestId": "short"})).await,
        Err("invalid_params")
    );
    for method in ["m365.check", "m365.token", "m365.signInCancel", "imap.list"] {
        assert_eq!(call(method, &json!({})).await, Err("method_not_found"));
    }
}

#[test]
fn a_send_body_is_exactly_canonical_base64url_within_the_ceiling() {
    let raw = URL_SAFE_NO_PAD.encode(b"To: a@example.org\r\n\r\nx");
    assert_eq!(send::decode(&raw).unwrap(), b"To: a@example.org\r\n\r\nx");
    let ceiling = crate::message::MAX_MESSAGE;
    for (bad, expected) in [
        (format!("{raw}="), "invalid_params"),
        (format!(" {raw}"), "invalid_params"),
        (String::new(), "invalid_params"),
        ("AB".into(), "invalid_params"),
        (
            URL_SAFE_NO_PAD.encode(vec![b'x'; ceiling + 1]),
            "m365_message_too_large",
        ),
        (
            "A".repeat(ceiling.div_ceil(3) * 4 + 1),
            "m365_message_too_large",
        ),
    ] {
        assert_eq!(send::decode(&bad), Err(expected), "{:.20}", bad);
    }
    assert!(send::decode(&URL_SAFE_NO_PAD.encode(vec![b'x'; ceiling])).is_ok());
}

#[test]
fn a_failed_send_proves_only_what_the_status_proves() {
    for (status, sent, code) in [
        (0, false, "m365_send_not_attempted"),
        (0, true, "m365_send_failed"),
        (401, true, "m365_send_not_attempted"),
        (429, true, "m365_send_not_attempted"),
        (400, true, "m365_send_rejected"),
        (413, true, "m365_message_too_large"),
        (500, true, "m365_send_failed"),
        (302, true, "m365_send_failed"),
    ] {
        assert_eq!(
            send::classify(Fault {
                code: "x",
                status,
                sent
            }),
            code,
            "{status}"
        );
    }
    // Refused for its size by Exchange's own code: as definite whatever status carried it.
    let sized = Fault {
        code: "m365_message_too_large",
        status: 400,
        sent: true,
    };
    assert_eq!(send::classify(sized), "m365_message_too_large");
}

#[test]
fn an_upload_has_longer_the_larger_it_is_and_never_longer_than_its_caller_waits() {
    let graph = super::super::graph::Graph::new(ACCOUNT);
    let (second, twenty) = (Duration::from_secs(1), Duration::from_secs(20));
    let quarter = 256 * 1024;
    assert_eq!(graph.upload_clock(0, 24 * second), twenty);
    assert_eq!(graph.upload_clock(quarter - 1, 24 * second), twenty);
    assert_eq!(graph.upload_clock(4 * quarter, 50 * second), 24 * second);
    assert_eq!(graph.upload_clock(4 * quarter, 22 * second), 22 * second);
    assert_eq!(
        graph.upload_clock(16 * 1024 * 1024 * 4 / 3, 49 * second),
        49 * second
    );
}

#[test]
fn sign_in_accepts_only_microsofts_pages_and_names_only_what_the_id_token_says() {
    assert!(signin::verification_uri("https://microsoft.com/devicelogin").is_some());
    assert!(
        signin::verification_uri("https://login.microsoftonline.com/common/oauth2/deviceauth")
            .is_some()
    );
    let bad = "http://microsoft.com/devicelogin|https://microsoft.com.evil.test/devicelogin|https://evil.test/devicelogin|https://user@microsoft.com/devicelogin|https://microsoft.com:444/devicelogin|https://microsoft.com/devicelogin#x|https://microsoft.com/device login|javascript:alert(1)";
    for bad in bad.split('|') {
        assert!(signin::verification_uri(bad).is_none(), "{bad}");
    }
    let token = |claims: Value| format!("e30.{}.sig", b64(claims));
    assert_eq!(
        signin::claim_names(&token(json!({"preferred_username": " Alice@Example.org "}))),
        ["alice@example.org"]
    );
    // All three, in the order the browser's own sign-in name comes first; empty ones are left out.
    assert_eq!(
        signin::claim_names(&token(
            json!({"upn": "c@example.org", "email": "b@example.org", "preferred_username": "a@example.org"})
        )),
        ["a@example.org", "b@example.org", "c@example.org"]
    );
    assert_eq!(
        signin::claim_names(&token(
            json!({"preferred_username": " ", "email": "b@example.org"})
        )),
        ["b@example.org"]
    );
    for none in ["", "garbage", "a.b.c", "e30.e30.sig"] {
        assert!(signin::claim_names(none).is_empty(), "{none}");
    }
    // Microsoft's own numbers say consent and tenant problems; its words are never copied.
    for (status, body, code) in [
        (
            400,
            json!({"error_codes": [65001]}),
            "m365_consent_required",
        ),
        (
            400,
            json!({"error_description": "AADSTS90094: needs admin"}),
            "m365_consent_required",
        ),
        (
            400,
            json!({"error": "invalid_tenant"}),
            "m365_tenant_invalid",
        ),
        (400, json!({"error_codes": [90002]}), "m365_tenant_invalid"),
        (400, json!({"error": "access_denied"}), "m365_access_denied"),
        (
            400,
            json!({"error": "invalid_client", "error_description": "secret words"}),
            "m365_auth_failed",
        ),
        (429, json!({}), "m365_throttled"),
        (503, json!({}), "m365_server_error"),
    ] {
        assert_eq!(signin::flow_error(status, &body), code, "{body}");
    }
}

#[test]
fn four_requests_at_a_time_per_mailbox_and_not_for_the_whole_process() {
    let slots = super::super::graph::slots;
    let a = slots("m365:slots-a@example.org");
    let held: Vec<_> = (0..4)
        .map(|_| std::sync::Arc::clone(&a).try_acquire_owned().unwrap())
        .collect();
    assert!(std::sync::Arc::clone(&a).try_acquire_owned().is_err());
    assert!(slots("m365:slots-a@example.org").try_acquire().is_err());
    assert!(slots("m365:slots-b@example.org").try_acquire().is_ok());
    drop(held);
}
