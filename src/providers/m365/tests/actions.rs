//! Changing and sending mail, and the shared mail pipeline (`mail.list`, `mail.act`, `mail.send`)
//! running over this provider.

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use std::time::Duration;

use serde_json::{Value, json};

use super::{ACCOUNT, Resp, Role, World, inbox, isolated, oid};

fn writes(world: &World) -> Vec<(String, String, Value)> {
    let sent = world.fake.graph();
    let writes = sent
        .iter()
        .filter(|r| matches!(r.method.as_str(), "PATCH" | "POST") && !r.path.ends_with("sendMail"));
    writes
        .map(|r| {
            (
                r.method.clone(),
                r.path
                    .rsplit('/')
                    .nth(usize::from(r.method == "POST"))
                    .unwrap()
                    .to_owned(),
                r.json(),
            )
        })
        .collect()
}

fn answer(succeeded: &[String], failed: &[String], error: Option<&str>) -> Value {
    json!({"succeededIds": succeeded, "failedIds": failed, "error": error})
}

#[tokio::test]
async fn labels_become_one_patch_or_one_move_per_message_and_every_id_is_answered_once_in_order() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 4);
    let ids = [oid(2), oid(1), oid(2)];
    let ok = answer(&[oid(2), oid(1)], &[], None);
    // Read state and flag together are one PATCH each; the ids are named once, as first asked.
    let both = json!({"ids": ids, "addLabelIds": ["STARRED"], "removeLabelIds": ["UNREAD"]});
    assert_eq!(world.call("m365.modify", both).await.unwrap(), ok);
    let sent = writes(&world);
    assert_eq!(sent.len(), 2);
    assert!(sent.iter().all(|(method, _, body)| method == "PATCH"
        && *body == json!({"isRead": true, "flag": {"flagStatus": "flagged"}})));
    assert!(
        world
            .fake
            .state()
            .msgs
            .iter()
            .filter(|m| m.read && m.flagged)
            .count()
            == 2
    );
    world
        .call(
            "m365.modify",
            json!({"ids": [oid(1)], "addLabelIds": ["UNREAD"], "removeLabelIds": ["STARRED"]}),
        )
        .await
        .unwrap();
    assert!(!world.fake.state().msg(1).flagged && !world.fake.state().msg(1).read);
    // Archive is a move to the archive folder and the id survives it; so is the way back.
    let before = writes(&world).len();
    assert_eq!(
        world
            .call(
                "m365.modify",
                json!({"ids": [oid(3)], "removeLabelIds": ["INBOX"]})
            )
            .await
            .unwrap(),
        answer(&[oid(3)], &[], None)
    );
    assert_eq!(world.fake.state().msg(3).folder, Role::Archive);
    assert_eq!(
        writes(&world)[before],
        (
            "POST".into(),
            super::gid(3),
            json!({"destinationId": "archive"})
        )
    );
    world
        .call(
            "m365.modify",
            json!({"ids": [oid(3)], "addLabelIds": ["INBOX"]}),
        )
        .await
        .unwrap();
    assert_eq!(world.fake.state().msg(3).folder, Role::Inbox);
    world
        .call("m365.trash", json!({"ids": [oid(4), oid(3)]}))
        .await
        .unwrap();
    assert!(
        world
            .fake
            .state()
            .msgs
            .iter()
            .filter(|m| m.folder == Role::Trash)
            .count()
            == 2
    );
    assert_eq!(
        writes(&world).last().unwrap().2,
        json!({"destinationId": "deleteditems"})
    );
    world
        .call("m365.untrash", json!({"ids": [oid(4)]}))
        .await
        .unwrap();
    assert_eq!(world.fake.state().msg(4).folder, Role::Inbox);
    assert_eq!(
        writes(&world).last().unwrap().2,
        json!({"destinationId": "inbox"})
    );
}

#[tokio::test]
async fn what_cannot_be_done_is_said_per_id_and_nothing_else_is_sent() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 3);
    // A label with no meaning here is never ignored: every id fails and no request is made.
    let unsupported = world
        .call(
            "m365.modify",
            json!({"ids": [oid(1), oid(2)], "addLabelIds": ["IMPORTANT"]}),
        )
        .await
        .unwrap();
    assert_eq!(
        unsupported,
        answer(&[], &[oid(1), oid(2)], Some("invalid_params"))
    );
    assert!(world.fake.graph().is_empty());
    // One message the server does not have: the others are changed and the answer names it.
    let partial = world
        .call(
            "m365.modify",
            json!({"ids": [oid(1), oid(40), oid(2)], "removeLabelIds": ["UNREAD"]}),
        )
        .await
        .unwrap();
    assert_eq!(
        partial,
        answer(
            &[oid(1), oid(2)],
            &[oid(40)],
            Some("m365_message_not_found")
        )
    );
    // A failed update is not followed by its move, and a server error is not asked twice.
    world
        .fake
        .hook(|req| (req.method == "PATCH").then(|| Resp::status(500)));
    let before = writes(&world).len();
    let both = json!({"ids": [oid(3)], "addLabelIds": ["STARRED"], "removeLabelIds": ["INBOX"]});
    assert_eq!(
        world.call("m365.modify", both).await.unwrap(),
        answer(&[], &[oid(3)], Some("m365_server_error"))
    );
    assert_eq!(
        writes(&world).len(),
        before + 1,
        "the move followed a failed update, or the update was repeated"
    );
    // A mailbox without an Archive has nowhere to put them: every id says so, nothing is sent.
    world.fake.hook(|_| None);
    world.fake.state().roles.retain(|r| *r != Role::Archive);
    world.call("m365.invalidate", json!({})).await.unwrap();
    let before = world.fake.graph().len();
    let archived = world
        .call(
            "m365.modify",
            json!({"ids": [oid(1), oid(2)], "removeLabelIds": ["INBOX"]}),
        )
        .await
        .unwrap();
    assert_eq!(
        archived,
        answer(&[], &[oid(1), oid(2)], Some("m365_folder_unavailable"))
    );
    assert!(
        world.fake.graph()[before..]
            .iter()
            .all(|r| r.method == "GET" && r.path.contains("mailFolders"))
    );
    // Signed out: the call fails whole, with nothing half done.
    world
        .call("m365.signOut", json!({"clientId": super::CLIENT}))
        .await
        .unwrap();
    assert_eq!(
        world.call("m365.trash", json!({"ids": [oid(1)]})).await,
        Err("m365_signed_out")
    );
}

#[tokio::test]
async fn the_shared_pipeline_lists_plans_and_acts_through_this_provider() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 3);
    world.fake.state().msg(2).flagged = true;
    let session = crate::backend::Session::default();
    let listed = session
        .dispatch("mail.list", &json!({"mailbox": "inbox", "limit": 2}))
        .await
        .unwrap();
    assert_eq!(listed["accountId"], ACCOUNT);
    let first = &listed["messages"][0];
    assert_eq!(
        (
            first["id"].clone(),
            first["subject"].clone(),
            first["unread"].clone()
        ),
        (json!(oid(3)), json!("Message 3"), json!(true))
    );
    assert_eq!(
        (first["from"]["email"].clone(), listed["estimate"].clone()),
        (json!("bob@example.org"), json!(3))
    );
    assert_ne!(listed["nextPageToken"], "");
    let starred = session
        .dispatch("mail.list", &json!({"mailbox": "starred"}))
        .await
        .unwrap();
    assert_eq!(starred["messages"].as_array().unwrap().len(), 1);
    assert_eq!(starred["messages"][0]["starred"], true);
    let found = session
        .dispatch("mail.list", &json!({"query": "Message 1"}))
        .await
        .unwrap();
    assert_eq!(found["messages"].as_array().unwrap().len(), 1);
    // A plan reads nothing it has no need of and changes nothing; executing it moves the message.
    for (operation, role) in [("archive", Role::Archive), ("trash", Role::Trash)] {
        let params = json!({"operation": operation, "ids": [oid(1)]});
        let preview = session.dispatch("mail.act", &params).await.unwrap();
        assert_eq!(preview["targetIds"], json!([oid(1)]));
        assert_eq!(
            world.fake.state().msg(1).folder,
            Role::Inbox,
            "a preview moved a message"
        );
        let result = session
            .dispatch(
                "mail.act",
                &json!({"operation": operation, "ids": [oid(1)], "execute": true}),
            )
            .await
            .unwrap();
        assert_eq!(
            (result["succeededIds"].clone(), result["failedIds"].clone()),
            (json!([oid(1)]), json!([]))
        );
        assert_eq!(world.fake.state().msg(1).folder, role);
        world.fake.state().msg(1).folder = Role::Inbox;
    }
    let read = session
        .dispatch(
            "mail.act",
            &json!({"operation": "read", "ids": [oid(2)], "execute": true}),
        )
        .await
        .unwrap();
    assert_eq!(read["succeededIds"], json!([oid(2)]));
    assert!(world.fake.state().msg(2).read);
    // A mailbox with no Archive refuses the plan before anything is sent.
    world.fake.state().roles.retain(|r| *r != Role::Archive);
    world.call("m365.invalidate", json!({})).await.unwrap();
    let refused = session
        .dispatch(
            "mail.act",
            &json!({"operation": "archive", "ids": [oid(1)], "execute": true}),
        )
        .await;
    assert!(refused.is_err(), "{refused:?}");
    assert_eq!(world.fake.state().msg(1).folder, Role::Inbox);
    // Spam is not an action this provider declares.
    assert!(
        session
            .dispatch(
                "mail.act",
                &json!({"operation": "spam", "ids": [oid(1)], "execute": true})
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_plan_asks_only_about_where_mail_goes_and_saves_no_rotated_token() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    let session = crate::backend::Session::default();
    // Marking read moves nothing: its plan asks nobody anything.
    let params = json!({"operation": "read", "ids": [oid(1)]});
    let preview = session.dispatch("mail.act", &params).await.unwrap();
    assert_eq!(preview["targetIds"], json!([oid(1)]));
    assert!(world.fake.graph().is_empty() && world.fake.login().is_empty());
    // Archiving reads the folders, with a token whose rotated refresh token is not saved.
    let params = json!({"operation": "archive", "ids": [oid(1)]});
    session.dispatch("mail.act", &params).await.unwrap();
    assert!(!world.fake.graph().is_empty());
    assert_eq!(world.fake.state().issued, 1, "the refresh token rotated");
    assert!(
        world.store.puts.lock().unwrap().is_empty(),
        "a plan wrote the keyring"
    );
    assert_eq!(world.store.token().as_deref(), Some("refresh-0"));
}

#[tokio::test]
async fn a_send_given_up_on_before_it_was_written_was_not_sent() {
    isolated!();
    let world = World::new().await;
    world.deadlines(300, 5000);
    // The token never comes, so the request's clock runs out before the message went anywhere.
    world
        .fake
        .hook(|req| (!req.path.starts_with("/v1.0/")).then_some(Resp::Stall));
    let message = raw("From: alice@example.org\r\nTo: bob@example.org\r\n");
    assert_eq!(
        world.call("m365.send", json!({"raw": message})).await,
        Err("m365_send_not_attempted")
    );
    assert!(world.fake.graph().is_empty() && world.fake.state().sent.is_empty());
}

#[tokio::test]
async fn a_send_refused_its_token_and_given_up_on_while_a_fresh_one_is_fetched_was_not_sent() {
    isolated!();
    let world = World::new().await;
    world.deadlines(300, 5000);
    // Graph refuses the token, which applied nothing; the fresh token never comes, so the clock runs
    // out before the second attempt was written. The first attempt's write is not this one's.
    let refreshes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = std::sync::Arc::clone(&refreshes);
    world.fake.hook(move |req| {
        if req.path.ends_with("sendMail") {
            let refused = json!({"error": {"code": "InvalidAuthenticationToken"}});
            return Some(Resp::json(401, refused));
        }
        let refresh = req.field("grant_type").as_deref() == Some("refresh_token");
        let later = refresh && counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0;
        later.then_some(Resp::Stall)
    });
    // Reach the retried refresh before spending the request's clock. Polling while yielding
    // keeps paused time from auto-advancing while the loopback socket and keyring do real work.
    tokio::time::pause();
    let message = raw("From: alice@example.org\r\nTo: bob@example.org\r\n");
    let send = world.call("m365.send", json!({"raw": message}));
    tokio::pin!(send);
    let started = std::time::Instant::now();
    while refreshes.load(std::sync::atomic::Ordering::SeqCst) < 2 {
        assert!(
            futures_util::poll!(send.as_mut()).is_pending(),
            "send ended before the retried refresh reached the login host"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "retried refresh never arrived"
        );
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_millis(300)).await;
    assert_eq!(send.await, Err("m365_send_not_attempted"));
    let sends = world.fake.graph();
    assert_eq!(
        sends
            .iter()
            .filter(|r| r.path.ends_with("sendMail"))
            .count(),
        1
    );
    assert_eq!(refreshes.load(std::sync::atomic::Ordering::SeqCst), 2);
}

fn raw(headers: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!(
        "{headers}Subject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nHello\r\n"
    ))
}

#[tokio::test]
async fn a_message_goes_to_graph_once_as_composed_blind_copy_and_all() {
    isolated!();
    let world = World::new().await;
    let message = "From: alice@example.org\r\nTo: bob@example.org\r\nBcc: blind@example.org\r\n";
    let sent = world
        .call("m365.send", json!({"raw": raw(message)}))
        .await
        .unwrap();
    assert_eq!(sent, json!({"sent": true, "warning": ""}));
    let requests: Vec<_> = world
        .fake
        .graph()
        .into_iter()
        .filter(|r| r.path == "/v1.0/me/sendMail")
        .collect();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(
        (request.method.as_str(), request.header("content-type")),
        ("POST", Some("text/plain"))
    );
    assert_eq!(request.header("authorization"), Some("Bearer access-1"));
    // Graph is given the MIME exactly as composed, Bcc header included (what Graph then does with it
    // was only observed on one work tenant, not documented). It is in no other request.
    let mime = String::from_utf8(STANDARD.decode(&request.body).unwrap()).unwrap();
    assert_eq!(
        mime,
        String::from_utf8(URL_SAFE_NO_PAD.decode(raw(message)).unwrap()).unwrap()
    );
    assert!(mime.contains("Bcc: blind@example.org"));
    assert_eq!(
        world
            .fake
            .graph()
            .iter()
            .filter(|r| String::from_utf8_lossy(&r.body).contains("blind"))
            .count(),
        0
    );
    assert!(!sent.to_string().contains("blind"));
    assert_eq!(world.fake.state().sent.len(), 1);
    // The only identity there is is the mailbox's own, and asking costs no request.
    let before = world.fake.graph().len();
    assert_eq!(
        world.call("m365.sendAs", json!({})).await.unwrap(),
        json!([{"email": "alice@example.org", "displayName": "", "isPrimary": true, "isDefault": true}])
    );
    assert_eq!(world.fake.graph().len(), before);
}

#[tokio::test]
async fn a_failed_send_is_never_repeated_and_says_whether_it_can_have_gone_out() {
    isolated!();
    let world = World::new().await;
    let message = raw("From: alice@example.org\r\nTo: bob@example.org\r\n");
    let attempts = |world: &World| {
        world
            .fake
            .graph()
            .iter()
            .filter(|r| r.path.ends_with("sendMail"))
            .count()
    };
    let mut total = 0;
    for (status, retry, code) in [
        (400, None, "m365_send_rejected"),
        (403, None, "m365_send_rejected"),
        (413, None, "m365_message_too_large"),
        (429, Some("1"), "m365_send_not_attempted"),
        (500, None, "m365_send_failed"),
        (503, Some("1"), "m365_send_failed"),
        (504, None, "m365_send_failed"),
        (302, None, "m365_send_failed"),
    ] {
        world.fake.hook(move |req| {
            req.path.ends_with("sendMail").then(|| {
                let resp = Resp::json(
                    status,
                    json!({"error": {"code": "SomeCode", "message": "secret words"}}),
                );
                retry.map_or(resp, |after| {
                    Resp::with(Resp::json(status, json!({})), "Retry-After", after)
                })
            })
        });
        assert_eq!(
            world.call("m365.send", json!({"raw": message})).await,
            Err(code),
            "{status}"
        );
        total += 1;
        assert_eq!(attempts(&world), total, "{status} was repeated");
    }
    // Exchange's own code for a message too large is a refusal for the size, whatever the status.
    world.fake.hook(|req| {
        req.path
            .ends_with("sendMail")
            .then(|| Resp::json(400, json!({"error": {"code": "ErrorMessageSizeExceeded"}})))
    });
    assert_eq!(
        world.call("m365.send", json!({"raw": message})).await,
        Err("m365_message_too_large")
    );
    total += 1;
    assert_eq!(attempts(&world), total);
    // A reply that never comes may have been sent: unknown, and not repeated.
    world.deadlines(300, 2000);
    world
        .fake
        .hook(|req| req.path.ends_with("sendMail").then_some(Resp::Stall));
    assert_eq!(
        world.call("m365.send", json!({"raw": message})).await,
        Err("m365_send_failed")
    );
    assert_eq!(attempts(&world), total + 1);
    // Nothing was written when there is no token: that is a definite refusal.
    world.fake.hook(|_| None);
    world
        .call("m365.signOut", json!({"clientId": super::CLIENT}))
        .await
        .unwrap();
    let before = attempts(&world);
    assert_eq!(
        world.call("m365.send", json!({"raw": message})).await,
        Err("m365_send_not_attempted")
    );
    assert_eq!(attempts(&world), before);
}

#[tokio::test]
async fn the_outbox_hands_graph_the_queued_message_whole_and_keeps_the_draft_when_graph_refuses() {
    isolated!();
    let world = World::new().await;
    // The draft each message was written from: one per send.
    for n in [21, 22] {
        world.fake.state().add(n, Role::Drafts, "Draft");
    }
    let session = crate::backend::Session::default();
    let message =
        raw("From: alice@example.org\r\nTo: bob@example.org\r\nBcc: blind@example.org\r\n");
    let queue = |id: &'static str| {
        let draft = match id {
            "one" => oid(21),
            "two" => oid(22),
            _ => String::new(),
        };
        let job = json!({"accountId": ACCOUNT, "provider": "m365", "sendId": id, "delaySeconds": 0,
            "payload": {"raw": message, "threadId": "t1", "sendId": id, "draftId": draft}});
        let session = &session;
        async move {
            session.dispatch("outbox.enqueue", &job).await.unwrap();
            let mut done = json!({"accountId": ACCOUNT, "sendId": id});
            session.finish_cli_send(&mut done).await.unwrap();
            done["outbox"]["entries"][0]["clone"].clone()
        }
    };
    let _ = queue("one").await;
    let entry = session
        .dispatch(
            "outbox.snapshot",
            &json!({"accountId": ACCOUNT, "sendId": "one"}),
        )
        .await
        .unwrap();
    assert_eq!(entry["entries"][0]["state"], "sent");
    // One request, the MIME as queued (blind copy included, for Graph to deliver and to hide), and no
    // field the provider does not take: it refuses unknown ones, so `threadId` never reached it.
    let sent = world.fake.state().sent.clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        STANDARD.decode(&sent[0]).unwrap(),
        URL_SAFE_NO_PAD.decode(&message).unwrap()
    );
    // Once it is sent, the draft it was written from is deleted.
    let drafts = |world: &World| {
        world
            .fake
            .state()
            .msgs
            .iter()
            .map(|m| m.id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(drafts(&world), [super::gid(22)]);
    // A refusal by Graph is definitely not a send: the entry fails and nothing is sent twice.
    world
        .fake
        .hook(|req| req.path.ends_with("sendMail").then(|| Resp::status(400)));
    let _ = queue("two").await;
    let entry = session
        .dispatch(
            "outbox.snapshot",
            &json!({"accountId": ACCOUNT, "sendId": "two"}),
        )
        .await
        .unwrap();
    assert_eq!(
        (
            entry["entries"][0]["state"].clone(),
            entry["entries"][0]["error"].clone()
        ),
        (json!("failed"), json!("outbox_send_refused"))
    );
    assert_eq!(world.fake.state().sent.len(), 1);
    assert_eq!(
        drafts(&world),
        [super::gid(22)],
        "an unsent message keeps its draft"
    );
    // Microsoft refusing the message for its size is as definite.
    world
        .fake
        .hook(|req| req.path.ends_with("sendMail").then(|| Resp::status(413)));
    let _ = queue("large").await;
    let entry = session
        .dispatch(
            "outbox.snapshot",
            &json!({"accountId": ACCOUNT, "sendId": "large"}),
        )
        .await
        .unwrap();
    assert_eq!(
        (
            entry["entries"][0]["state"].clone(),
            entry["entries"][0]["error"].clone()
        ),
        (json!("failed"), json!("outbox_send_refused"))
    );
    assert_eq!(world.fake.state().sent.len(), 1);
    // A reply that never came may have been sent: it is shown as unknown, not as refused.
    world.deadlines(300, 2000);
    world
        .fake
        .hook(|req| req.path.ends_with("sendMail").then_some(Resp::Stall));
    let _ = queue("three").await;
    let entry = session
        .dispatch(
            "outbox.snapshot",
            &json!({"accountId": ACCOUNT, "sendId": "three"}),
        )
        .await
        .unwrap();
    assert_eq!(entry["entries"][0]["state"], "unknown");
}

/// A message of `size` bytes of body, as `m365.send` takes one.
fn sized(size: usize) -> String {
    URL_SAFE_NO_PAD.encode(format!(
        "From: alice@example.org\r\nTo: bob@example.org\r\nSubject: Big\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\n{}\r\n",
        "x".repeat(size)
    ))
}

#[tokio::test]
async fn a_large_message_is_given_longer_to_upload_and_a_small_one_is_not() {
    isolated!();
    let world = World::new().await;
    world.deadlines(300, 5000);
    // The token is fetched first, so what follows times only the upload.
    assert!(
        world
            .call("m365.send", json!({"raw": sized(10)}))
            .await
            .is_ok()
    );
    world.fake.hook(|req| {
        req.path
            .ends_with("sendMail")
            .then(|| Resp::Wait(Duration::from_millis(900), Box::new(Resp::status(202))))
    });
    // A short message has the request's own clock, which an answer this slow misses.
    assert_eq!(
        world.call("m365.send", json!({"raw": sized(10)})).await,
        Err("m365_send_failed")
    );
    // A megabyte has seconds more, still inside the call's deadline, and the same answer is in time.
    assert_eq!(
        world
            .call("m365.send", json!({"raw": sized(1024 * 1024)}))
            .await,
        Ok(json!({"sent": true, "warning": ""}))
    );
    assert_eq!(world.fake.state().sent.len(), 1);
}

#[tokio::test]
async fn a_batch_that_runs_out_of_time_answers_for_what_was_done_and_begins_nothing_more() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 48);
    // Each change takes a fifth of a second and four go at a time: the call's two seconds end
    // part-way through the batch.
    world.deadlines(5000, 2000);
    world.fake.hook(|req| {
        (req.method == "PATCH").then(|| {
            Resp::Wait(
                Duration::from_millis(200),
                Box::new(Resp::json(200, json!({}))),
            )
        })
    });
    let ids: Vec<String> = (1..=48).map(oid).collect();
    let started = std::time::Instant::now();
    let answer = world
        .call(
            "m365.modify",
            json!({"ids": ids, "removeLabelIds": ["UNREAD"]}),
        )
        .await
        .expect("a batch answers for its ids, not with one error for all of them");
    assert!(started.elapsed() < Duration::from_millis(2500));
    let list = |key: &str| -> Vec<String> { serde_json::from_value(answer[key].clone()).unwrap() };
    let (succeeded, failed) = (list("succeededIds"), list("failedIds"));
    assert!(!succeeded.is_empty() && !failed.is_empty(), "{answer}");
    assert_eq!(answer["error"], "m365_timeout");
    // Every id once, in order: what was done first, what was never begun after it.
    assert_eq!([succeeded.clone(), failed.clone()].concat(), ids);
    // Graph was asked to change exactly what is reported done: a request already written was waited
    // for, and nothing reported failed was sent.
    let mut patched: Vec<String> = world
        .fake
        .graph()
        .iter()
        .filter(|r| r.method == "PATCH")
        .map(|r| super::super::ids::encode(r.path.rsplit('/').next().unwrap()).unwrap())
        .collect();
    patched.sort();
    let mut done = succeeded.clone();
    done.sort();
    assert_eq!(patched, done);
}

#[tokio::test]
async fn a_refused_token_waits_for_a_slow_refresh_no_longer_than_the_batch() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 2);
    world.deadlines(5000, 1000);
    // Graph refuses both changes' token, the second a moment after the first. The refresh that
    // follows the first refusal takes three seconds, and holds the mailbox's refresh lane all that
    // time: the second refusal waits for that lane to forget its token.
    let refreshes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = std::sync::Arc::clone(&refreshes);
    world.fake.hook(move |req| {
        if req.method == "PATCH" {
            let refused = Resp::json(
                401,
                json!({"error": {"code": "InvalidAuthenticationToken"}}),
            );
            return Some(if req.path.ends_with(&super::gid(2)) {
                Resp::Wait(Duration::from_millis(200), Box::new(refused))
            } else {
                refused
            });
        }
        let refresh = req.field("grant_type").as_deref() == Some("refresh_token");
        let later = refresh && counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0;
        later.then(|| {
            Resp::Wait(
                Duration::from_secs(3),
                Box::new(Resp::json(400, json!({"error": "temporarily_unavailable"}))),
            )
        })
    });
    let started = std::time::Instant::now();
    let answered = world
        .call(
            "m365.modify",
            json!({"ids": [oid(1), oid(2)], "removeLabelIds": ["UNREAD"]}),
        )
        .await
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "the batch answered after {:?}, past its deadline",
        started.elapsed()
    );
    assert_eq!(
        answered,
        answer(&[], &[oid(1), oid(2)], Some("m365_timeout"))
    );
    assert_eq!(refreshes.load(std::sync::atomic::Ordering::SeqCst), 2);
}
