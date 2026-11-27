//! Reading: listings and their paging, header rows, whole messages, attachments, the folder check
//! and the background check.

use serde_json::{Value, json};

use super::super::check;
use super::{ACCOUNT, ADDRESS, Resp, Role, World, err, gid, inbox, isolated, oid, ok, plain_mime};

fn ids(page: &Value) -> Vec<String> {
    let ids = page["page"]["ids"].as_array().unwrap();
    ids.iter()
        .map(|id| id.as_str().unwrap().to_owned())
        .collect()
}

async fn list(world: &World, query: &str, limit: u32, token: &str) -> Result<Value, &'static str> {
    world
        .call(
            "m365.list",
            json!({"query": query, "limit": limit, "pageToken": token}),
        )
        .await
}

/// The newest request that carried `$filter` (or `$search`).
fn last_query(world: &World, param: &str) -> super::Req {
    world
        .fake
        .graph()
        .into_iter()
        .rev()
        .find(|r| r.param(param).is_some())
        .unwrap()
}

#[tokio::test]
async fn a_listing_pages_a_folder_newest_first_with_the_counts_the_screen_shows() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 7);
    {
        let mut state = world.fake.state();
        state.msg(3).flagged = true;
        state.msg(2).read = true;
        state.add(8, Role::Sent, "Sent one").read = true;
    }
    let first = list(&world, "role:inbox", 3, "").await.unwrap();
    assert_eq!(
        (ids(&first), first["page"]["estimate"].clone()),
        (vec![oid(7), oid(6), oid(5)], json!(7))
    );
    assert_eq!(first["rows"][0]["labelIds"], json!(["UNREAD", "INBOX"]));
    assert_eq!(first["rows"][1]["id"], oid(6));
    // The request asks for newest first, ids that survive a move, and no body.
    let sent = world.fake.graph();
    let listing = sent
        .iter()
        .find(|r| r.path.ends_with("/inbox/messages"))
        .unwrap();
    assert_eq!(
        (listing.param("$orderby"), listing.param("$top")),
        (Some("receivedDateTime desc"), Some("3"))
    );
    let select = listing.param("$select").unwrap();
    assert!(select.contains("bodyPreview") && !select.contains("body,"));
    assert_eq!(listing.header("prefer"), Some("IdType=\"ImmutableId\""));
    assert_eq!(listing.header("authorization"), Some("Bearer access-1"));
    let token = first["page"]["nextPageToken"].as_str().unwrap();
    // A later page is the first one's size, whatever limit continues it (Graph's link says `$top`).
    let resized = list(&world, "role:inbox", 1, token).await.unwrap();
    assert_eq!(ids(&resized), [oid(4), oid(3), oid(2)]);
    let second = list(&world, "role:inbox", 3, token).await.unwrap();
    assert_eq!(ids(&second), [oid(4), oid(3), oid(2)]);
    assert_eq!(
        second["rows"][1]["labelIds"],
        json!(["UNREAD", "STARRED", "INBOX"])
    );
    // The estimate is the first page's, whatever has changed since; Graph's own paging shifts with the mail.
    world.fake.state().add(9, Role::Inbox, "Late");
    let third = list(
        &world,
        "role:inbox",
        3,
        second["page"]["nextPageToken"].as_str().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        (
            ids(&third).len(),
            third["page"]["estimate"].clone(),
            third["page"]["nextPageToken"].clone()
        ),
        (2, json!(7), json!(""))
    );
    // A token continues its own query and no other.
    assert_eq!(
        list(&world, "role:sent", 3, token).await,
        Err("invalid_params")
    );
    // An unread view counts unread mail; folder facts come from the folder table (at most a minute
    // old: the late message is not in it), not from the page.
    let unread = list(&world, "role:inbox unseen", 2, "").await.unwrap();
    assert_eq!(
        (ids(&unread).len(), unread["page"]["estimate"].clone()),
        (2, json!(6))
    );
    assert_eq!(
        last_query(&world, "$filter").param("$filter"),
        Some("receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false")
    );
    // A folder the mailbox lacks is said so before anything is listed.
    world.fake.state().roles.retain(|r| *r != Role::Archive);
    ok!(world, "m365.invalidate", {});
    assert_eq!(
        list(&world, "role:archive", 3, "").await,
        Err("m365_folder_unavailable")
    );
}

#[tokio::test]
async fn a_flagged_view_filters_the_inbox_and_estimates_from_what_it_read() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 5);
    for n in [1, 4, 5] {
        world.fake.state().msg(n).flagged = true;
    }
    let flagged = list(&world, "role:inbox flagged", 2, "").await.unwrap();
    // The rows and one more: Graph is not asked to count.
    assert_eq!(
        (ids(&flagged), flagged["page"]["estimate"].clone()),
        (vec![oid(5), oid(4)], json!(3))
    );
    let request = last_query(&world, "$filter");
    assert!(request.param("$count").is_none());
    assert!(
        request
            .param("$filter")
            .unwrap()
            .ends_with("flag/flagStatus eq 'flagged'")
    );
}

#[tokio::test]
async fn a_search_is_one_phrase_over_the_mailbox_without_trash_and_junk() {
    isolated!();
    let world = World::new().await;
    {
        let mut state = world.fake.state();
        for (n, role, subject) in [
            (1, Role::Inbox, "Invoice June"),
            (2, Role::Trash, "Invoice May"),
            (3, Role::Archive, "Invoice April"),
            (4, Role::Junk, "Invoice March"),
            (5, Role::Inbox, "Lunch"),
        ] {
            state.add(n, role, subject);
        }
    }
    // The phrase is `"invoice x"`: no match for that exact text.
    let none = list(&world, "text:  invoice \"x\" ", 10, "").await.unwrap();
    assert!(ids(&none).is_empty());
    let request = last_query(&world, "$search");
    assert_eq!(request.param("$search"), Some("\"invoice x\""));
    assert!(request.param("$orderby").is_none() && request.param("$filter").is_none());
    assert_eq!(
        ids(&list(&world, "text:invoice", 10, "").await.unwrap()),
        [oid(3), oid(1)]
    );
    // A page that held only Trash and Junk is not an empty result: the listing goes on, a few pages.
    {
        let mut state = world.fake.state();
        state.msgs.clear();
        state.add(1, Role::Inbox, "Invoice new");
        (5..=16).for_each(|n| {
            state.add(n, Role::Trash, "Invoice old");
        });
    }
    let reached = list(&world, "text:invoice", 2, "").await.unwrap();
    assert!(
        ids(&reached).is_empty() && reached["page"]["nextPageToken"] != "",
        "the search ends after a few pages and says there is more"
    );
    world
        .fake
        .state()
        .msgs
        .retain(|m| m.folder != Role::Trash || m.id < gid(9));
    assert_eq!(
        ids(&list(&world, "text:invoice", 2, "").await.unwrap()),
        [oid(1)]
    );
}

#[tokio::test]
async fn header_rows_come_from_the_listing_and_a_missing_message_does_not_fail_the_others() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 3);
    let listed = list(&world, "role:inbox", 3, "").await.unwrap();
    let asked = |world: &World| {
        world
            .fake
            .graph()
            .iter()
            .filter(|r| r.path.starts_with("/v1.0/me/messages/"))
            .count()
    };
    let rows = ok!(world, "m365.messages", {"ids": [oid(3), oid(1)], "full": false});
    assert_eq!(
        rows["messages"],
        json!([listed["rows"][0], listed["rows"][2]])
    );
    assert_eq!((rows["warning"].clone(), asked(&world)), (Value::Null, 0));
    // A message nobody listed is read once; one Graph does not have is left out and said so.
    world.fake.state().add(4, Role::Inbox, "Fresh");
    world.fake.state().add(5, Role::Inbox, "Unlisted");
    let mixed = ok!(world, "m365.messages", {"ids": [oid(4), oid(77), oid(3)], "full": false});
    assert_eq!(
        (
            mixed["messages"].as_array().unwrap().len(),
            mixed["warning"].clone()
        ),
        (2, json!("partial"))
    );
    let headers = mixed["messages"][0]["payload"]["headers"]
        .as_array()
        .unwrap();
    assert_eq!(
        (
            mixed["messages"][0]["id"].clone(),
            headers.iter().find(|h| h["name"] == "Subject").unwrap()["value"].clone()
        ),
        (json!(oid(4)), json!("Fresh"))
    );
    // Nothing found is an answer when "not found" is why, and an error when something else is.
    let none = ok!(world, "m365.messages", {"ids": [oid(77)], "full": false});
    assert_eq!(
        (none["messages"].clone(), none["warning"].clone()),
        (json!([]), json!("partial"))
    );
    world.fake.hook(|req| {
        req.path
            .starts_with("/v1.0/me/messages/")
            .then(|| Resp::status(500))
    });
    assert_eq!(
        err!(world, "m365.messages", {"ids": [oid(5)], "full": false}),
        "m365_server_error"
    );
    // A change drops what was remembered: the next read shows it.
    world.fake.hook(|_| None);
    ok!(world, "m365.modify", {"ids": [oid(3)], "removeLabelIds": ["UNREAD"]});
    let after = ok!(world, "m365.messages", {"ids": [oid(3)], "full": false});
    assert_eq!(after["messages"][0]["labelIds"], json!(["INBOX"]));
}

fn multipart() -> Vec<u8> {
    "From: Bob <bob@example.org>\r\nTo: alice@example.org\r\nSubject: With file\r\nDate: Fri, 9 Oct 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee attached.\r\n--b\r\nContent-Type: application/octet-stream; name=\"a.bin\"\r\nContent-Disposition: attachment; filename=\"a.bin\"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAwQF\r\n--b--\r\n".into()
}

#[tokio::test]
async fn a_whole_message_is_the_shared_parse_of_its_mime_and_attachments_are_fetched_by_part() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    world.fake.state().add(2, Role::Inbox, "With file").mime = multipart();
    let read = ok!(world, "m365.read", {"id": oid(2), "full": true});
    assert_eq!(
        (
            read["id"].clone(),
            read["labelIds"].clone(),
            read["sizeEstimate"].clone()
        ),
        (
            json!(oid(2)),
            json!(["UNREAD", "INBOX"]),
            json!(multipart().len())
        )
    );
    assert_eq!(
        read["payload"]["parts"][0]["body"]["data"],
        "U2VlIGF0dGFjaGVkLg"
    );
    let attachment = read["payload"]["parts"][1]["body"]["attachmentId"]
        .as_str()
        .unwrap();
    assert_eq!(attachment, "part:2");
    assert_eq!(
        ok!(world, "m365.attachment", {"messageId": oid(2), "attachmentId": attachment}),
        json!({"data": "AAECAwQF"})
    );
    for (message, part, code) in [
        (2, "part:9", "m365_attachment_not_found"),
        (1, "part:1", "m365_attachment_not_found"),
        (55, "part:1", "m365_message_not_found"),
    ] {
        assert_eq!(
            err!(world, "m365.attachment", {"messageId": oid(message), "attachmentId": part}),
            code
        );
    }
    // `messages` with `full` is the same resource, many at a time.
    let many = ok!(world, "m365.messages", {"ids": [oid(2), oid(1)], "full": true});
    assert_eq!(
        (
            many["messages"][0].clone(),
            many["messages"][1]["id"].clone()
        ),
        (read, json!(oid(1)))
    );
    assert_eq!(
        err!(world, "m365.read", {"id": oid(66), "full": true}),
        "m365_message_not_found"
    );
    // A message Graph has with a MIME nobody can read is not shown as an empty one.
    world.fake.state().msg(1).mime = Vec::new();
    assert_eq!(
        err!(world, "m365.read", {"id": oid(1), "full": true}),
        "m365_invalid_response"
    );
}

#[tokio::test]
async fn a_message_reads_up_to_24_mib_and_not_a_byte_more() {
    isolated!();
    let world = World::new().await;
    let big = |size: usize| {
        let mut mime = plain_mime("Big");
        mime.resize(size, b'x');
        mime
    };
    world.fake.state().add(1, Role::Inbox, "Big").mime = big(17 * 1024 * 1024);
    world.fake.state().add(2, Role::Inbox, "Bigger").mime = big(24 * 1024 * 1024 + 1);
    assert_eq!(
        ok!(world, "m365.read", {"id": oid(1), "full": true})["sizeEstimate"],
        17 * 1024 * 1024
    );
    assert_eq!(
        err!(world, "m365.read", {"id": oid(2), "full": true}),
        "m365_message_too_large"
    );
    // The ceiling is the same for an attachment and for a batch, where the rest still arrive.
    assert_eq!(
        err!(world, "m365.attachment", {"messageId": oid(2), "attachmentId": "part:"}),
        "m365_message_too_large"
    );
    let both = ok!(world, "m365.messages", {"ids": [oid(1), oid(2)], "full": true});
    assert_eq!(
        (
            both["messages"].as_array().unwrap().len(),
            both["warning"].clone()
        ),
        (1, json!("partial"))
    );
}

#[tokio::test]
async fn verify_says_what_the_mailbox_has_and_withdraws_what_it_lacks() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 3);
    world.fake.state().msg(1).read = true;
    world.fake.state().add(4, Role::Sent, "Out").read = true;
    let verified = ok!(world, "m365.verify", {});
    assert_eq!(
        (
            verified["ok"].clone(),
            verified["email"].clone(),
            verified["refusals"].clone()
        ),
        (json!(true), json!(ADDRESS), json!({}))
    );
    assert_eq!(
        (
            verified["roles"]["inbox"].clone(),
            verified["roles"]["sent"].clone()
        ),
        (
            json!({"total": 3, "unread": 2}),
            json!({"total": 1, "unread": 0})
        )
    );
    // No Archive and no Sent folder: those roles are null and the matching abilities are withdrawn.
    world
        .fake
        .state()
        .roles
        .retain(|r| !matches!(r, Role::Archive | Role::Sent));
    let lacking = ok!(world, "m365.verify", {});
    assert_eq!(
        (
            lacking["roles"]["archive"].clone(),
            lacking["roles"]["sent"].clone()
        ),
        (Value::Null, Value::Null)
    );
    assert_eq!(
        lacking["refusals"]["archive"],
        "No Archive folder was found in this mailbox"
    );
    assert_eq!(
        lacking["refusals"]["send"],
        "No Sent folder was found in this mailbox"
    );
    // Without an Inbox it is not a mailbox.
    world.fake.state().roles.clear();
    assert_eq!(err!(world, "m365.verify", {}), "m365_folder_unavailable");
}

#[tokio::test]
async fn the_background_check_counts_unread_mail_and_its_fingerprint_follows_the_inbox() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 5);
    let first = check(ACCOUNT).await.unwrap();
    assert_eq!(
        (
            first["estimate"].clone(),
            first["messages"].as_array().unwrap().len(),
            first["messages"][0]["id"].clone()
        ),
        (json!(5), 3, json!(oid(5)))
    );
    assert_eq!(
        check(ACCOUNT).await.unwrap()["fingerprint"],
        first["fingerprint"]
    );
    world.fake.state().msg(5).read = true;
    let read = check(ACCOUNT).await.unwrap();
    assert_eq!(
        (
            read["fingerprint"] != first["fingerprint"],
            read["estimate"].clone()
        ),
        (true, json!(4))
    );
    world.fake.state().add(6, Role::Inbox, "New");
    assert_ne!(
        check(ACCOUNT).await.unwrap()["fingerprint"],
        read["fingerprint"]
    );
    assert_eq!(
        check("m365:stranger@example.org").await,
        Err("auth_account_missing")
    );
    assert_eq!(
        check("outlook:alice@example.org").await,
        Err("invalid_params")
    );
}
