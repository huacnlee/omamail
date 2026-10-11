//! The operations: paging, search, writes and what is repeated after a failure.

use std::sync::{Arc, Mutex};

use super::super::{Change, Choice, Client, Role, xml};
use super::conn::client;
use super::fake::{self, Fake, Offer, Out, Soap, ews_id, ok, omamail_id, response};
use crate::providers::exchange::{ids, query::Query};

fn tree(soap: &Soap) -> xml::Node {
    let mut tree = xml::parse(soap.body.as_bytes()).unwrap();
    tree.children.swap_remove(1).children.remove(0)
}

async fn basic(script: impl Fn(&Soap) -> Out + Send + Sync + 'static) -> (Fake, Client) {
    let fake = Fake::start(Offer::Basic, move |soap| {
        if soap.op == "GetFolder" {
            Out::Xml(fake::folders())
        } else {
            script(soap)
        }
    })
    .await;
    let client = client(&fake, Choice::Basic, fake::PASSWORD);
    (fake, client)
}

/// A mailbox folder of (seed, seconds) rows, newest first, answering `FindItem` the way the server
/// does for the restrictions the client builds: the received bound, the page size and an offset.
fn folder_script(
    rows: Arc<Mutex<Vec<(u8, u32)>>>,
) -> impl Fn(&Soap) -> Out + Send + Sync + 'static {
    move |soap| {
        let request = tree(soap);
        let view = request.child("IndexedPageItemView").unwrap();
        let limit: usize = view.attr("MaxEntriesReturned").unwrap().parse().unwrap();
        let offset: usize = view.attr("Offset").unwrap().parse().unwrap();
        let bound = request
            .at(&[
                "Restriction",
                "IsLessThan",
                "FieldURIOrConstant",
                "Constant",
            ])
            .map(|c| c.attr("Value").unwrap().to_owned());
        let rows = rows.lock().unwrap();
        let matching: Vec<&(u8, u32)> = rows
            .iter()
            .filter(|(_, ts)| {
                bound.as_deref().is_none_or(|b| {
                    format!("2026-10-01T10:{:02}:{:02}Z", ts / 60, ts % 60).as_str() < b
                })
            })
            .collect();
        let page: Vec<String> = matching
            .iter()
            .skip(offset)
            .take(limit)
            .map(|(seed, ts)| fake::item(*seed, "inbox", *ts))
            .collect();
        Out::Xml(fake::find(
            &page,
            offset + limit >= matching.len(),
            matching.len(),
        ))
    }
}

fn seeds(items: &[crate::providers::exchange::ews::Item]) -> Vec<u8> {
    items
        .iter()
        .map(|item| {
            ids::encode(&item.id)
                .map(|_| item.subject.trim_start_matches("Subject ").parse().unwrap())
                .unwrap()
        })
        .collect()
}

#[tokio::test]
async fn a_folder_is_paged_by_time_so_nothing_is_repeated_or_lost_while_the_list_changes() {
    // Three rows share a second: a page boundary inside it must neither repeat nor drop them.
    let rows = Arc::new(Mutex::new(vec![
        (1, 100),
        (2, 99),
        (3, 99),
        (4, 99),
        (5, 98),
        (6, 97),
        (7, 96),
        (8, 95),
        (9, 90),
    ]));
    let (_fake, mut client) = basic(folder_script(rows.clone())).await;
    let query = Query::parse("role:inbox").unwrap();
    let first = client.list(&query, 3, None).await.unwrap();
    assert_eq!(seeds(&first.items), [1, 2, 3]);
    assert_eq!(first.estimate, 120, "the folder's own count");
    // The user trashes the first two rows and mail arrives before the next page is asked for.
    rows.lock().unwrap().retain(|(seed, _)| *seed > 2);
    rows.lock().unwrap().insert(0, (50, 200));
    let (mut shown, mut token) = (seeds(&first.items), first.next);
    // Bounded, so a paging bug fails the test instead of hanging it.
    for _ in 0..20 {
        let Some(next) = token else { break };
        let page = client.list(&query, 3, Some(&next)).await.unwrap();
        assert_eq!(page.estimate, 120, "the estimate travels with the token");
        shown.extend(seeds(&page.items));
        token = page.next;
    }
    assert_eq!(shown, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // A token belongs to its query and to its kind.
    let other = Query::parse("role:sent").unwrap();
    let page = client.list(&query, 3, None).await.unwrap();
    let token = page.next.unwrap();
    for (query, token) in [
        (&other, token.as_str()),
        (&query, "garbage"),
        (&Query::parse("text:a").unwrap(), token.as_str()),
    ] {
        assert_eq!(
            client.list(query, 3, Some(token)).await.err(),
            Some("invalid_params")
        );
    }
}

#[tokio::test]
async fn a_second_with_as_many_rows_as_one_request_can_ask_for_ends_the_listing() {
    let rows = Arc::new(Mutex::new(
        (0..120).map(|seed| (seed as u8, 100)).collect::<Vec<_>>(),
    ));
    let (_fake, mut client) = basic(folder_script(rows)).await;
    let page = client
        .list(&Query::parse("role:inbox").unwrap(), 100, None)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 100);
    assert!(
        page.next.is_none(),
        "the cursor could not see past the rows to skip"
    );
}

#[tokio::test]
async fn unread_and_flagged_views_are_restrictions_and_flagged_counts_its_own_view() {
    let (_fake, mut client) = basic(|soap| {
        assert!(tree(soap).child("Restriction").is_some());
        Out::Xml(fake::find(&[fake::item(1, "inbox", 5)], true, 4))
    })
    .await;
    let flagged = client
        .list(&Query::parse("role:inbox flagged").unwrap(), 25, None)
        .await
        .unwrap();
    assert_eq!(
        flagged.estimate, 1,
        "a page that holds the whole view is the count: the folder's counts do not say how many \
         are flagged, and the view's total lags"
    );
    let unread = client
        .list(&Query::parse("role:inbox unseen").unwrap(), 25, None)
        .await
        .unwrap();
    assert_eq!(unread.estimate, 7, "the folder's unread count");
}

#[tokio::test]
async fn a_flagged_view_longer_than_its_page_is_counted_not_taken_from_the_servers_total() {
    // A live server answered `TotalItemsInView` 13 for minutes while 14 items were flagged.
    let (_fake, mut client) = basic(|soap| {
        let request = tree(soap);
        let shape = request.child("ItemShape").unwrap();
        if shape.child("AdditionalProperties").is_none() {
            let ids: Vec<String> = (0..14).map(|seed| fake::item(seed, "inbox", 5)).collect();
            Out::Xml(fake::find(&ids, true, 13))
        } else {
            Out::Xml(fake::find(&[fake::item(1, "inbox", 5)], false, 13))
        }
    })
    .await;
    let page = client
        .list(&Query::parse("role:inbox flagged").unwrap(), 1, None)
        .await
        .unwrap();
    assert_eq!(
        page.estimate, 14,
        "the matching items counted, not the server's total"
    );
}

#[tokio::test]
async fn a_whole_flagged_view_is_its_rows_while_the_servers_total_lags() {
    // Unflagging the only flagged message: the view is empty, its total still says 1.
    let (_fake, mut client) = basic(|_| Out::Xml(fake::find(&[], true, 1))).await;
    let page = client
        .list(&Query::parse("role:inbox flagged").unwrap(), 1, None)
        .await
        .unwrap();
    assert_eq!(page.estimate, 0, "an empty view counts nothing");
}

fn folder_of(soap: &Soap) -> String {
    let request = tree(soap);
    let parents = request.child("ParentFolderIds").unwrap();
    assert_eq!(
        parents.children.len(),
        1,
        "a query string over several folders is refused by the server"
    );
    parents.children[0].attr("Id").unwrap().to_owned()
}

#[tokio::test]
async fn a_search_merges_one_request_per_folder_and_continues_each_from_its_own_offset() {
    let rows = |folder: &str| -> Vec<(u8, u32)> {
        match folder {
            "inbox" => vec![(1, 100), (4, 90), (7, 80)],
            "sentitems" => vec![(2, 95), (5, 85)],
            _ => vec![(3, 99), (6, 60)],
        }
    };
    let (fake, mut client) = basic(move |soap| {
        let request = tree(soap);
        assert_eq!(request.text_at(&["QueryString"]), Some("\"report\"*"));
        let folder = folder_of(soap);
        let view = request.child("IndexedPageItemView").unwrap();
        let (limit, offset): (usize, usize) = (
            view.attr("MaxEntriesReturned").unwrap().parse().unwrap(),
            view.attr("Offset").unwrap().parse().unwrap(),
        );
        let all = rows(&folder);
        let page: Vec<String> = all
            .iter()
            .skip(offset)
            .take(limit)
            .map(|(seed, ts)| fake::item(*seed, &folder, *ts))
            .collect();
        Out::Xml(fake::find(&page, offset + limit >= all.len(), all.len()))
    })
    .await;
    let query = Query::parse("text:report").unwrap();
    let (mut shown, mut token, mut estimates) = (Vec::new(), None, Vec::new());
    for _ in 0..20 {
        let page = client.list(&query, 3, token.as_deref()).await.unwrap();
        shown.extend(seeds(&page.items));
        estimates.push(page.estimate);
        match page.next {
            Some(next) => token = Some(next),
            None => break,
        }
    }
    // Newest first across folders, every message once, and the first page's estimate (the sum of
    // what each folder said it holds) carried by every token.
    assert_eq!(shown, [1, 3, 2, 4, 5, 7, 6]);
    assert_eq!(estimates, [7, 7, 7]);
    // Only the folders where mail lives are asked: never Trash or Junk.
    assert_eq!(fake.log.count("FindItem"), 3 + 3 + 1);
}

#[tokio::test]
async fn one_folder_failing_fails_the_whole_search_page() {
    let (_fake, mut client) = basic(|soap| {
        if folder_of(soap) == "sentitems" {
            Out::Xml(fake::fault("ErrorInvalidOperation"))
        } else {
            Out::Xml(fake::find(&[fake::item(1, "inbox", 5)], true, 1))
        }
    })
    .await;
    assert_eq!(
        client
            .list(&Query::parse("text:report").unwrap(), 3, None)
            .await
            .err(),
        Some("exchange_server_error")
    );
}

fn keys_script(
    stale_rounds: usize,
) -> (
    Arc<Mutex<Vec<String>>>,
    impl Fn(&Soap) -> Out + Send + Sync + 'static,
) {
    let (gets, updates) = (
        Arc::new(Mutex::new(0usize)),
        Arc::new(Mutex::new(Vec::<String>::new())),
    );
    let seen = updates.clone();
    let script = move |soap: &Soap| match soap.op.as_str() {
        "GetItem" => {
            let mut gets = gets.lock().unwrap();
            *gets += 1;
            let n = tree(soap).child("ItemIds").unwrap().children.len();
            let one = |_: usize| {
                ok(
                    "GetItem",
                    &format!(
                        r#"<m:Items><t:Message><t:ItemId Id="{}" ChangeKey="k{}"/></t:Message></m:Items>"#,
                        ews_id(1),
                        *gets
                    ),
                )
            };
            Out::Xml(response("GetItem", &(0..n).map(one).collect::<Vec<_>>()))
        }
        "UpdateItem" => {
            let request = tree(soap);
            let changes = request.child("ItemChanges").unwrap().children("ItemChange");
            let keys: Vec<String> = changes
                .iter()
                .map(|c| {
                    c.child("ItemId")
                        .unwrap()
                        .attr("ChangeKey")
                        .unwrap()
                        .to_owned()
                })
                .collect();
            let round = updates.lock().unwrap().len();
            updates.lock().unwrap().extend(keys.clone());
            let answer = |_: &String| {
                if round < stale_rounds {
                    fake::message(
                        "UpdateItem",
                        "Error",
                        "ErrorChangeKeyRequiredForWriteOperations",
                        "",
                    )
                } else {
                    ok("UpdateItem", "")
                }
            };
            Out::Xml(response(
                "UpdateItem",
                &keys.iter().map(answer).collect::<Vec<_>>(),
            ))
        }
        _ => Out::Drop,
    };
    (seen, script)
}

#[tokio::test]
async fn a_stale_change_key_is_read_again_and_the_update_sent_once_more() {
    let (updates, script) = keys_script(1);
    let (fake, mut client) = basic(script).await;
    let outcomes = client
        .mark(&[omamail_id(1)], Change::Read(true))
        .await
        .unwrap();
    assert_eq!(outcomes, [Ok(())]);
    // The server refused k1 as not applied; the key was read again and only then sent.
    assert_eq!(*updates.lock().unwrap(), ["k1", "k2"]);
    assert_eq!(
        fake.log.ops(),
        [
            "GetFolder",
            "GetItem",
            "UpdateItem",
            "GetItem",
            "UpdateItem"
        ]
    );
}

#[tokio::test]
async fn a_key_that_is_stale_twice_is_reported_and_never_a_third_time() {
    let (updates, script) = keys_script(9);
    let (_fake, mut client) = basic(script).await;
    let outcomes = client
        .mark(&[omamail_id(1)], Change::Flag(true))
        .await
        .unwrap();
    assert_eq!(outcomes, [Err("exchange_stale_item")]);
    assert_eq!(updates.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn moves_report_the_ids_that_were_asked_about_and_a_missing_folder_sends_nothing() {
    let (fake, mut client) = basic(|soap| match soap.op.as_str() {
        "MoveItem" => Out::Xml(response(
            "MoveItem",
            &[
                ok("MoveItem", ""),
                fake::message("MoveItem", "Error", "ErrorItemNotFound", ""),
            ],
        )),
        _ => Out::Drop,
    })
    .await;
    let asked = [omamail_id(1), omamail_id(2)];
    assert_eq!(
        client.move_to(&asked, Role::Trash).await.unwrap(),
        [Ok(()), Err("exchange_message_not_found")]
    );
    assert_eq!(
        client.move_to(&["bad".to_owned()], Role::Trash).await.err(),
        Some("invalid_params")
    );
    let missing = Fake::start(Offer::Basic, |soap| {
        if soap.op == "GetFolder" {
            Out::Xml(fake::folders_without("trash"))
        } else {
            Out::Drop
        }
    })
    .await;
    let mut client = super::conn::client(&missing, Choice::Basic, fake::PASSWORD);
    assert_eq!(
        client.move_to(&asked, Role::Trash).await.err(),
        Some("exchange_folder_unavailable")
    );
    assert_eq!(missing.log.ops(), ["GetFolder"]);
    assert_eq!(fake.log.count("MoveItem"), 1);
}

#[tokio::test]
async fn a_read_is_repeated_once_after_a_lost_stream_and_a_write_never() {
    let (fake, mut client) = basic(|soap| match (soap.op.as_str(), soap.conn) {
        ("GetItem", 0) | ("MoveItem", _) => Out::Drop,
        _ => Out::Xml(fake::items(&[1])),
    })
    .await;
    let read = client.items(&[omamail_id(1)], false).await.unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(
        fake.log.count("GetItem"),
        2,
        "once on the lost stream, once on a new one"
    );
    // The move may have been applied: reported, not sent again.
    let moved = client.move_to(&[omamail_id(1)], Role::Trash).await.unwrap();
    assert_eq!(moved, [Err("exchange_connection_closed")]);
    assert_eq!(fake.log.count("MoveItem"), 1);
}

#[tokio::test]
async fn a_read_waits_out_a_short_back_off_once_and_a_write_does_not() {
    let busy = |kind: &str| {
        fake::message(
            kind,
            "Error",
            "ErrorServerBusy",
            r#"<m:MessageXml><t:Value Name="BackOffMilliseconds">50</t:Value></m:MessageXml>"#,
        )
    };
    let calls = Arc::new(Mutex::new(0));
    let (fake, mut client) = basic(move |soap| match soap.op.as_str() {
        "GetItem" => {
            *calls.lock().unwrap() += 1;
            Out::Xml(if *calls.lock().unwrap() == 1 {
                response("GetItem", &[busy("GetItem")])
            } else {
                fake::items(&[1])
            })
        }
        _ => Out::Xml(response("MoveItem", &[busy("MoveItem")])),
    })
    .await;
    assert!(client.items(&[omamail_id(1)], false).await.unwrap()[0].is_ok());
    assert_eq!(fake.log.count("GetItem"), 2);
    assert_eq!(
        client.move_to(&[omamail_id(1)], Role::Trash).await.unwrap(),
        [Err("exchange_throttled")]
    );
    assert_eq!(fake.log.count("MoveItem"), 1);
}

#[tokio::test]
async fn a_401_without_credentials_is_not_processed_so_the_request_signs_in_again_and_goes_once_more()
 {
    let first = Arc::new(Mutex::new(true));
    let fake = Fake::start(Offer::Ntlm, move |soap| match soap.op.as_str() {
        "GetFolder" => Out::Xml(fake::folders()),
        _ if std::mem::replace(&mut *first.lock().unwrap(), false) => {
            Out::Status(401, vec![("WWW-Authenticate", "NTLM".into())])
        }
        _ => Out::Xml(fake::done("MoveItem", 1)),
    })
    .await;
    let mut client = super::conn::client(&fake, Choice::Ntlm, fake::PASSWORD);
    assert_eq!(
        client.move_to(&[omamail_id(1)], Role::Trash).await.unwrap(),
        [Ok(())]
    );
    assert_eq!(
        fake.log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
}

#[tokio::test]
async fn a_send_not_signed_in_by_its_deadline_is_not_attempted_and_writes_nothing() {
    let fake = Fake::start(Offer::Basic, |soap| match soap.op.as_str() {
        "GetFolder" => Out::Later(3_000, fake::folders()),
        _ => Out::Xml(fake::done("CreateItem", 1)),
    })
    .await;
    let mut client = super::conn::client(&fake, Choice::Basic, fake::PASSWORD);
    let started = std::time::Instant::now();
    // The message could be written only while its whole request still ends by the deadline.
    client.until(
        tokio::time::Instant::now()
            + std::time::Duration::from_millis(300)
            + super::super::DEADLINE,
    );
    assert_eq!(client.send(b"x").await, Err("exchange_send_not_attempted"));
    // The folder lookup carried the password and is not cut: a cut one could be counted as a
    // failed logon. The message is not written after it.
    assert!(started.elapsed() >= std::time::Duration::from_millis(3_000));
    assert_eq!(fake.log.count("GetFolder"), 1);
    assert_eq!(fake.log.count("CreateItem"), 0);
    // The stream it signed in is kept: the next try does not sign in again.
    client.until(
        tokio::time::Instant::now() + std::time::Duration::from_secs(1) + super::super::DEADLINE,
    );
    client.send(b"x").await.unwrap();
    assert_eq!(fake.log.ops(), ["GetFolder", "CreateItem"]);
    assert_eq!(
        fake.log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

/// The sign-in waits for a whole request's time only while the server has not accepted the
/// password: a cut one could be a failed logon the latch never hears of. Unproven, a call with less
/// time sends nothing; accepted once, a stream lost under a late read is opened again with the time
/// that is left, and the read is answered.
#[tokio::test]
async fn only_a_password_not_yet_accepted_waits_for_a_whole_request_to_sign_in() {
    use std::sync::atomic::Ordering::SeqCst;
    let (fake, mut client) = basic(|soap| match (soap.op.as_str(), soap.conn) {
        ("GetItem", 0) => Out::Drop,
        _ => Out::Xml(fake::items(&[1])),
    })
    .await;
    let short = || tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    client.until(short());
    assert_eq!(
        client.items(&[omamail_id(1)], false).await.err(),
        Some("exchange_timeout")
    );
    assert_eq!(
        fake.log.connections.load(SeqCst),
        0,
        "no stream was dialled"
    );
    assert!(fake.log.ops().is_empty());
    client.until(
        tokio::time::Instant::now() + std::time::Duration::from_secs(1) + super::super::DEADLINE,
    );
    client.refresh().await.unwrap();
    client.until(short());
    let read = client.items(&[omamail_id(1)], false).await.unwrap();
    assert!(read[0].is_ok());
    assert_eq!(
        fake.log.ops(),
        ["GetFolder", "GetItem", "GetFolder", "GetItem"]
    );
    assert_eq!(fake.log.connections.load(SeqCst), 2);
}

/// NTLM signs a stream in; a 401 to a later request on it carries no credentials to refuse.
async fn sign_in_lost(script: impl Fn(&Soap) -> Out + Send + Sync + 'static) -> (Fake, Client) {
    let fake = Fake::start(Offer::Ntlm, move |soap| match soap.op.as_str() {
        "GetFolder" => Out::Xml(fake::folders()),
        _ => script(soap),
    })
    .await;
    let client = super::conn::client(&fake, Choice::Ntlm, fake::PASSWORD);
    (fake, client)
}

#[tokio::test]
async fn a_401_to_a_request_that_carried_no_credentials_never_latches_the_password() {
    let lost = || Out::Status(401, vec![("WWW-Authenticate", "NTLM".into())]);
    // A read: once on the old stream, once on a new one that signed in again.
    let (fake, mut client) = sign_in_lost(move |_| lost()).await;
    assert_eq!(
        client.items(&[omamail_id(1)], false).await.err(),
        Some("exchange_auth_failed")
    );
    assert!(!client.rejected());
    assert!(client.items(&[omamail_id(1)], false).await.is_err());
    assert_eq!(fake.log.count("GetItem"), 4, "the password was not latched");
    // A send, twice: the 401 proves it was not processed, and neither latches.
    let (fake, mut client) = sign_in_lost(move |_| lost()).await;
    for _ in 0..2 {
        assert_eq!(client.send(b"x").await, Err("exchange_send_not_attempted"));
    }
    assert!(!client.rejected());
    assert_eq!(fake.log.count("CreateItem"), 2);
}

#[tokio::test]
async fn a_draft_is_filed_in_drafts_and_only_a_draft_is_deleted() {
    let bodies = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = bodies.clone();
    let (fake, mut client) = basic(move |soap| {
        seen.lock().unwrap().push(soap.body.clone());
        match soap.op.as_str() {
            "CreateItem" => Out::Xml(fake::done("CreateItem", 1)),
            "DeleteItem" => Out::Xml(fake::done("DeleteItem", 1)),
            // Seed 1 is in Drafts, seed 2 in the Inbox.
            _ => {
                let folder = if soap.body.contains(&ews_id(1)) {
                    "drafts"
                } else {
                    "inbox"
                };
                Out::Xml(response(
                    "GetItem",
                    &[ok(
                        "GetItem",
                        &format!("<m:Items>{}</m:Items>", fake::item(1, folder, 5)),
                    )],
                ))
            }
        }
    })
    .await;
    client.save_draft(b"Subject: draft\r\n\r\nx").await.unwrap();
    let create = tree(&Soap {
        op: String::new(),
        body: bodies.lock().unwrap().last().unwrap().clone(),
        conn: 0,
    });
    assert_eq!(create.attr("MessageDisposition"), Some("SaveOnly"));
    client.delete_draft(&omamail_id(1)).await.unwrap();
    let delete = tree(&Soap {
        op: String::new(),
        body: bodies.lock().unwrap().last().unwrap().clone(),
        conn: 0,
    });
    assert_eq!(delete.attr("DeleteType"), Some("SoftDelete"));
    assert_eq!(
        delete.at(&["ItemIds", "ItemId"]).unwrap().attr("Id"),
        Some(ews_id(1).as_str())
    );
    // A message outside Drafts is no draft: refused, and nothing is deleted.
    assert_eq!(
        client.delete_draft(&omamail_id(2)).await,
        Err("exchange_message_not_found")
    );
    assert_eq!(fake.log.count("DeleteItem"), 1);
}

fn create_answer(case: &str) -> Out {
    let refusal = |code: &str| {
        Out::Xml(response(
            "CreateItem",
            &[fake::message("CreateItem", "Error", code, "")],
        ))
    };
    match case {
        "confirmed" => Out::Xml(fake::done("CreateItem", 1)),
        "refused" => refusal("ErrorMailRecipientNotFound"),
        "busy" => refusal("ErrorServerBusy"),
        "lost" => Out::Drop,
        "torn" => Out::Torn,
        "gateway" => Out::Status(503, vec![]),
        "fault" => Out::Xml(fake::fault("ErrorInternalServerError")),
        "too large" => refusal("ErrorMessageSizeExceeded"),
        "bad mime" => refusal("ErrorMimeContentInvalid"),
        "no folder" => refusal("ErrorFolderNotFound"),
        "denied" => refusal("ErrorAccessDenied"),
        _ => Out::Xml("<html/>".into()),
    }
}

#[tokio::test]
async fn a_send_says_what_is_known_of_it_and_is_never_repeated() {
    let table = [
        ("confirmed", Ok(())),
        ("refused", Err("exchange_send_rejected")),
        ("too large", Err("exchange_send_rejected")),
        ("bad mime", Err("exchange_send_rejected")),
        // Refused before anything went out: no folder to save the copy in, or no right to send.
        ("no folder", Err("exchange_send_rejected")),
        ("denied", Err("exchange_send_rejected")),
        // The server said it did not act, so nothing was sent.
        ("busy", Err("exchange_send_not_attempted")),
        // Anything else may have been accepted: an answer lost or torn, a gateway's 503, a fault
        // that is not a refusal, an answer nobody can read.
        ("lost", Err("exchange_send_failed")),
        ("torn", Err("exchange_send_failed")),
        ("gateway", Err("exchange_send_failed")),
        ("fault", Err("exchange_send_failed")),
        ("unreadable", Err("exchange_send_failed")),
    ];
    for (case, expected) in table {
        let (fake, mut client) = basic(move |soap| {
            if soap.op == "CreateItem" {
                create_answer(case)
            } else {
                Out::Drop
            }
        })
        .await;
        assert_eq!(
            client.send(b"To: a@example.org\r\n\r\nhi").await,
            expected,
            "{case}"
        );
        assert_eq!(fake.log.count("CreateItem"), 1, "{case}");
    }
}

#[tokio::test]
async fn a_draft_whose_answer_was_lost_is_unconfirmed_and_never_saved_twice() {
    let table = [
        ("confirmed", Ok(())),
        // The server's own answer about the draft is what it is.
        ("refused", Err("exchange_send_rejected")),
        ("busy", Err("exchange_throttled")),
        // It may be in Drafts already: an answer lost, torn or unreadable, a gateway's 503.
        ("lost", Err("exchange_draft_unconfirmed")),
        ("torn", Err("exchange_draft_unconfirmed")),
        ("gateway", Err("exchange_draft_unconfirmed")),
        ("fault", Err("exchange_draft_unconfirmed")),
        ("unreadable", Err("exchange_draft_unconfirmed")),
    ];
    for (case, expected) in table {
        let (fake, mut client) = basic(move |soap| {
            if soap.op == "CreateItem" {
                create_answer(case)
            } else {
                Out::Drop
            }
        })
        .await;
        assert_eq!(
            client.save_draft(b"Subject: d\r\n\r\nx").await,
            expected,
            "{case}"
        );
        assert_eq!(fake.log.count("CreateItem"), 1, "{case}");
    }
}

#[tokio::test]
async fn a_send_goes_down_a_stream_that_just_answered_and_replaces_one_that_closed() {
    let (fake, mut client) = basic(|soap| match (soap.op.as_str(), soap.conn) {
        ("CreateItem", _) => Out::Xml(fake::done("CreateItem", 1)),
        _ => Out::Drop,
    })
    .await;
    // The folder lookup signs the stream in; the message is the second request on it.
    client.send(b"x").await.unwrap();
    assert_eq!(fake.log.ops(), ["GetFolder", "CreateItem"]);
    // Closed by the server while idle: found before anything is written, so nothing is lost or doubled.
    let closing = Fake::start(Offer::Basic, |soap| match soap.op.as_str() {
        "GetFolder" if soap.conn == 0 => Out::XmlClose(fake::folders()),
        "GetFolder" => Out::Xml(fake::folders()),
        _ => Out::Xml(fake::done("CreateItem", 1)),
    })
    .await;
    let mut client = super::conn::client(&closing, Choice::Basic, fake::PASSWORD);
    client.refresh().await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    client.send(b"x").await.unwrap();
    assert_eq!(closing.log.ops(), ["GetFolder", "GetFolder", "CreateItem"]);
    // A password the server refuses is found before the message is written.
    let refusing = Fake::start(Offer::Basic, |_| Out::Drop).await;
    let mut client = super::conn::client(&refusing, Choice::Basic, "wrong");
    assert_eq!(client.send(b"x").await, Err("exchange_send_not_attempted"));
    assert_eq!(refusing.log.count("CreateItem"), 0);
    assert_eq!(
        client.send(&vec![b'x'; 16 * 1024 * 1024 + 1]).await,
        Err("exchange_message_too_large")
    );
}

/// A message of about `size` bytes: headers and one base64 attachment.
fn big_mime(size: usize) -> Vec<u8> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(vec![7u8; size * 3 / 4]);
    let lines: Vec<&str> = data
        .as_bytes()
        .chunks(76)
        .map(|line| std::str::from_utf8(line).unwrap())
        .collect();
    format!(
        "From: a@example.org\r\nSubject: big\r\nMIME-Version: 1.0\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"big.bin\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
        lines.join("\r\n")
    )
    .into_bytes()
}

#[tokio::test]
async fn a_message_past_the_shared_16_mib_limit_is_read_whole_up_to_24_mib() {
    let mime = big_mime(20 * 1024 * 1024);
    let sent = mime.clone();
    let (_fake, mut client) =
        basic(move |_| Out::Xml(response("GetItem", &[fake::item_message(1, Some(&sent))]))).await;
    let item = client
        .items(&[omamail_id(1)], true)
        .await
        .unwrap()
        .pop()
        .unwrap()
        .unwrap();
    assert_eq!(item.mime.as_deref(), Some(&mime[..]));
    let folders = client.folders().await.unwrap();
    let resource = crate::providers::exchange::resource::message(&item, &folders).unwrap();
    assert_eq!(resource["payload"]["body"]["size"], 15 * 1024 * 1024);
}

#[tokio::test]
async fn a_message_over_the_read_ceiling_is_refused_as_too_large() {
    let over = vec![b'a'; super::super::MAX_MIME + 1];
    let (_fake, mut client) =
        basic(move |_| Out::Xml(response("GetItem", &[fake::item_message(1, Some(&over))]))).await;
    let read = client.items(&[omamail_id(1)], true).await.unwrap();
    assert_eq!(read[0].as_ref().err(), Some(&"exchange_message_too_large"));
}
