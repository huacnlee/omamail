//! The wire: where credentials may go, how much a server may say, how long a call may take, what a
//! throttle costs, and cancelling.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::{ACCOUNT, Fake, Resp, World, inbox, isolated};

async fn list(world: &World) -> Result<Value, &'static str> {
    world
        .call("m365.list", json!({"query": "role:inbox", "limit": 5}))
        .await
}

fn listing(req: &super::Req) -> bool {
    req.path.ends_with("/inbox/messages")
}

#[tokio::test]
async fn credentials_go_to_graph_and_the_login_host_alone_and_never_follow_a_link_away() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 2);
    let elsewhere = Fake::start().await;
    let away = elsewhere.base.clone();
    let away_base = away.clone();
    // A server that points the next page, or a redirect, anywhere else is a broken or hostile one.
    for link in [
        format!("{away}/v1.0/me/messages"),
        format!("{away}/v1.0/me/mailFolders/inbox/messages"),
        "http://127.0.0.1:9/v1.0/me/mailFolders/inbox/messages".to_owned(),
        "https://graph.microsoft.com/v1.0/users/x/messages".to_owned(),
        "javascript:alert(1)".to_owned(),
    ] {
        let served = link.clone();
        world.fake.hook(move |req| {
            listing(req).then(|| Resp::json(200, json!({"value": [], "@odata.nextLink": served})))
        });
        assert_eq!(list(&world).await, Err("m365_invalid_response"), "{link}");
    }
    world.fake.hook(move |req| {
        listing(req).then(|| Resp::status(302).with("Location", &format!("{away}/v1.0/me/stolen")))
    });
    assert_eq!(list(&world).await, Err("m365_bad_response"));
    // The login host's redirect is no more followed than Graph's: the refresh token is not sent on.
    let login_away = away_base.clone();
    world.fake.hook(move |req| {
        req.path
            .ends_with("/token")
            .then(|| Resp::status(302).with("Location", &format!("{login_away}/stolen")))
    });
    world.call("m365.invalidate", json!({})).await.unwrap();
    assert_eq!(list(&world).await, Err("m365_invalid_response"));
    assert!(
        elsewhere.state().seen.is_empty(),
        "the login redirect was followed"
    );
    // The one place that attaches the token refuses a URL of another origin before any byte is sent.
    let foreign = reqwest::Url::parse(&format!("{away_base}/v1.0/me/messages")).unwrap();
    let refused = super::super::graph::Graph::new(ACCOUNT)
        .request(
            super::super::graph::Mode::Read,
            reqwest::Method::GET,
            &foreign,
            None,
            1024,
        )
        .await;
    assert_eq!(
        refused.err().map(|fault| (fault.code, fault.sent)),
        Some(("m365_invalid_request", false))
    );
    // A forged page token never produces a request at all.
    world.fake.hook(|_| None);
    let forged = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        json!({"q": "role:inbox", "e": 1, "n": format!("{}/v1.0/me/messages", elsewhere.base)})
            .to_string(),
    );
    let before = world.fake.graph().len();
    let params = json!({"query": "role:inbox", "limit": 5, "pageToken": forged});
    assert_eq!(world.call("m365.list", params).await, Err("invalid_params"));
    assert_eq!(world.fake.graph().len(), before);
    assert!(
        elsewhere.state().seen.is_empty(),
        "something was sent to another host: {:?}",
        elsewhere.state().seen
    );
    // The bearer token is on every Graph request and on no login request; the refresh token and the
    // client's secrets are on none of Graph's.
    world.call("m365.invalidate", json!({})).await.unwrap();
    list(&world).await.unwrap();
    assert!(
        world
            .fake
            .login()
            .iter()
            .all(|r| r.header("authorization").is_none())
    );
    for request in world.fake.graph() {
        let everything = format!("{request:?}");
        assert!(
            !everything.contains("refresh-") && !everything.contains("device-code"),
            "{everything}"
        );
        assert!(
            request
                .header("authorization")
                .is_some_and(|value| value.starts_with("Bearer access-")),
            "{everything}"
        );
    }
}

#[tokio::test]
async fn an_error_is_a_code_and_never_what_the_server_said_or_a_token() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    for (status, body, code) in [
        (
            400,
            json!({"error": {"code": "BadRequest", "message": "Bearer access-1 refresh-1"}}),
            "m365_invalid_request",
        ),
        (
            403,
            json!({"error": {"code": "ErrorAccessDenied", "message": "access-1"}}),
            "m365_access_denied",
        ),
        (
            404,
            json!({"error": {"code": "ErrorFolderNotFound", "message": "access-1"}}),
            "m365_folder_unavailable",
        ),
        (
            500,
            json!({"error": {"code": "x", "message": "access-1"}}),
            "m365_server_error",
        ),
        (
            418,
            json!({"error": "access-1 refresh-1"}),
            "m365_invalid_request",
        ),
        (200, json!(["access-1"]), "m365_invalid_response"),
    ] {
        world
            .fake
            .hook(move |req| listing(req).then(|| Resp::json(status, body.clone())));
        let failure = list(&world).await.unwrap_err();
        assert_eq!(failure, code, "{status}");
        assert!(!failure.contains("access-") && !failure.contains("refresh-"));
    }
}

#[tokio::test]
async fn no_server_can_make_the_client_read_or_hold_more_than_the_bounds() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    let huge = 4 * 1024 * 1024 + 1;
    // Declared too long, or no length and too long: refused, not read to the end.
    world
        .fake
        .hook(move |req| listing(req).then(|| Resp::Lying(huge, vec![b' '; 100])));
    assert_eq!(list(&world).await, Err("m365_response_too_large"));
    world
        .fake
        .hook(move |req| listing(req).then(|| Resp::Chunked(vec![vec![b' '; 1024 * 1024]; 5])));
    assert_eq!(list(&world).await, Err("m365_response_too_large"));
    // The excess of an error answer is no error of its own: it is read only for its code.
    world
        .fake
        .hook(move |req| listing(req).then(|| Resp::Send(503, vec![], vec![b'x'; 200_000])));
    assert_eq!(list(&world).await, Err("m365_server_error"));
    world
        .fake
        .hook(move |req| listing(req).then(|| Resp::Lying(huge, vec![])));
    // More rows than were asked for, or rows of the wrong kind, are a broken server.
    let row = json!({"id": super::gid(1), "subject": "x"});
    world.fake.hook(move |req| {
        listing(req).then(|| Resp::json(200, json!({"value": vec![row.clone(); 6]})))
    });
    assert_eq!(list(&world).await, Err("m365_invalid_response"));
    world
        .fake
        .hook(|req| listing(req).then(|| Resp::json(200, json!({"value": "none"}))));
    assert_eq!(list(&world).await, Err("m365_invalid_response"));
    // A row whose id cannot be carried is left out; the rest of the page stands.
    let bad = json!({"id": "has space", "subject": "x"});
    let good = json!({"id": super::gid(2), "subject": "y"});
    world.fake.hook(move |req| {
        listing(req).then(|| Resp::json(200, json!({"value": [bad.clone(), good.clone()]})))
    });
    let page = list(&world).await.unwrap();
    assert_eq!(page["page"]["ids"], json!([super::oid(2)]));
}

#[tokio::test]
async fn a_change_graph_confirmed_is_done_however_long_its_answer() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 2);
    // Graph answers a change with the whole message, which is never read: the 2xx is the answer.
    world
        .fake
        .hook(|req| (req.method == "PATCH").then(|| Resp::Lying(64 * 1024 * 1024, b"{}".to_vec())));
    let done = world
        .call(
            "m365.modify",
            json!({"ids": [super::oid(1)], "removeLabelIds": ["UNREAD"]}),
        )
        .await
        .unwrap();
    assert_eq!(done["succeededIds"], json!([super::oid(1)]));
    world.fake.hook(|req| {
        req.path
            .ends_with("/move")
            .then(|| Resp::Chunked(vec![vec![b' '; 1024 * 1024]; 5]))
    });
    let done = world
        .call("m365.trash", json!({"ids": [super::oid(2)]}))
        .await
        .unwrap();
    assert_eq!(done["succeededIds"], json!([super::oid(2)]));
}

#[tokio::test]
async fn every_message_of_a_full_read_has_a_clock_of_its_own() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 3);
    // Two bodies at a time, each slower than a request's clock: the third message's requests start
    // after that clock has run out for the first two, and still have their own.
    world.deadlines(400, 8000);
    *super::super::graph::SHORT_MIME.lock().unwrap() = Some(Duration::from_secs(3));
    world.fake.hook(|req| {
        req.path.ends_with("/$value").then(|| {
            let body = super::plain_mime("Slow");
            Resp::Wait(
                Duration::from_millis(600),
                Box::new(Resp::Send(200, vec![], body)),
            )
        })
    });
    let ids: Vec<String> = (1..=3).map(super::oid).collect();
    let read = world
        .call("m365.messages", json!({"ids": ids, "full": true}))
        .await
        .unwrap();
    assert_eq!(read["warning"], Value::Null);
    assert_eq!(read["messages"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn a_throttled_read_waits_as_told_within_bounds_and_a_write_only_after_a_429() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 2);
    let count = |world: &World, method: &str| {
        world
            .fake
            .graph()
            .iter()
            .filter(|r| r.method == method && r.path.contains("/me/messages"))
            .count()
    };
    let counted = |world: &World| world.fake.graph().iter().filter(|r| listing(r)).count();
    // Two 429s with a one second wait, then the answer: the wait is the server's, the rest is ours.
    let left = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(2));
    let remaining = std::sync::Arc::clone(&left);
    world.fake.hook(move |req| {
        (listing(req)
            && remaining
                .fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |n| n.checked_sub(1),
                )
                .is_ok())
        .then(|| Resp::json(429, json!({})).with("Retry-After", "1"))
    });
    let started = Instant::now();
    assert!(list(&world).await.is_ok());
    assert!(
        started.elapsed() >= Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(counted(&world), 3);
    // A wait longer than the bound is not waited out, and a throttle that goes on is given up on.
    let before = counted(&world);
    world
        .fake
        .hook(|req| listing(req).then(|| Resp::status(429).with("Retry-After", "6")));
    let started = Instant::now();
    assert_eq!(list(&world).await, Err("m365_throttled"));
    assert!(started.elapsed() < Duration::from_secs(1) && counted(&world) == before + 1);
    let before = counted(&world);
    world
        .fake
        .hook(|req| listing(req).then(|| Resp::json(503, json!({})).with("Retry-After", "1")));
    assert_eq!(list(&world).await, Err("m365_throttled"));
    assert_eq!(
        counted(&world),
        before + 3,
        "a read is asked three times at most"
    );
    // A write is repeated after a 429, which Microsoft sends instead of acting, and after nothing else.
    let before = count(&world, "PATCH");
    let first = std::sync::atomic::AtomicBool::new(true);
    world.fake.hook(move |req| {
        (req.method == "PATCH" && first.swap(false, std::sync::atomic::Ordering::SeqCst))
            .then(|| Resp::status(429).with("Retry-After", "1"))
    });
    let done = world
        .call(
            "m365.modify",
            json!({"ids": [super::oid(1)], "removeLabelIds": ["UNREAD"]}),
        )
        .await
        .unwrap();
    assert_eq!(done["succeededIds"], json!([super::oid(1)]));
    assert_eq!(count(&world, "PATCH"), before + 2);
    let before = count(&world, "PATCH");
    world
        .fake
        .hook(|req| (req.method == "PATCH").then(|| Resp::status(503).with("Retry-After", "1")));
    let done = world
        .call(
            "m365.modify",
            json!({"ids": [super::oid(2)], "removeLabelIds": ["UNREAD"]}),
        )
        .await
        .unwrap();
    assert_eq!(
        (done["failedIds"].clone(), done["error"].clone()),
        (json!([super::oid(2)]), json!("m365_throttled"))
    );
    assert_eq!(
        count(&world, "PATCH"),
        before + 1,
        "a write that may have been done was repeated"
    );
}

#[tokio::test]
async fn a_message_body_outlives_the_listing_deadline() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    // The listing clock is 1.5 seconds. The body waits longer than that and is still accepted,
    // because a 24 MiB message has a clock of its own.
    world.deadlines(1500, 8000);
    *super::super::graph::SHORT_MIME.lock().unwrap() = Some(Duration::from_secs(5));
    let mime = b"From: a@example.org\r\nTo: b@example.org\r\nSubject: Hi\r\n\nHello\r\n".to_vec();
    let size = mime.len();
    world.fake.hook(move |req| {
        let body = mime.clone();
        req.path.ends_with("/$value").then(move || {
            Resp::Wait(
                Duration::from_millis(2500),
                Box::new(Resp::Send(200, vec![], body)),
            )
        })
    });
    let started = Instant::now();
    let read = world
        .call("m365.read", json!({"id": super::oid(1), "full": true}))
        .await
        .unwrap();
    assert!(started.elapsed() >= Duration::from_millis(2500));
    assert!(started.elapsed() < Duration::from_secs(7));
    assert_eq!(read["id"], json!(super::oid(1)));
    assert_eq!(read["sizeEstimate"], json!(size));
}

#[tokio::test]
async fn a_call_ends_at_its_deadline_and_a_call_given_up_on_is_cancelled_where_it_stands() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    // A server that never answers: the operation's own deadline ends the request.
    world.deadlines(300, 5000);
    world.fake.hook(|req| listing(req).then_some(Resp::Stall));
    let started = Instant::now();
    assert_eq!(list(&world).await, Err("m365_timeout"));
    assert!(started.elapsed() < Duration::from_secs(3));
    // And the call's, which also covers what the operation does not (a keyring or token wait).
    world.deadlines(5000, 300);
    let started = Instant::now();
    assert_eq!(list(&world).await, Err("m365_timeout"));
    assert!(started.elapsed() < Duration::from_secs(3));
    // A caller that gives up cancels by the token it made the call with.
    world.deadlines(5000, 5000);
    let account = ACCOUNT.to_owned();
    let asked = world.fake.graph().iter().filter(|r| listing(r)).count();
    let running = tokio::spawn(async move {
        let params =
            json!({"accountId": account, "query": "role:inbox", "limit": 5, "requestToken": "r1"});
        crate::providers::m365::call("m365.list", &params).await
    });
    for _ in 0..200 {
        if world.fake.graph().iter().filter(|r| listing(r)).count() > asked {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let again = world
        .call(
            "m365.list",
            json!({"query": "role:inbox", "limit": 5, "requestToken": "r1"}),
        )
        .await;
    assert_eq!(
        again,
        Err("invalid_params"),
        "a token in use is not taken twice"
    );
    assert_eq!(
        world
            .call("m365.cancel", json!({"requestToken": "never-used"}))
            .await
            .unwrap(),
        json!({"cancelled": false})
    );
    assert_eq!(
        world
            .call("m365.cancel", json!({"requestToken": "r1"}))
            .await
            .unwrap(),
        json!({"cancelled": true})
    );
    assert_eq!(running.await.unwrap(), Err("m365_cancelled"));
    // The token is free again, and the account unharmed.
    world.fake.hook(|_| None);
    let params = json!({"query": "role:inbox", "limit": 5, "requestToken": "r1"});
    assert!(world.call("m365.list", params).await.is_ok());
}

#[tokio::test]
async fn confirmed_mutations_do_not_wait_for_or_fail_on_an_unused_response_body() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 2);
    world.warm_token().await;
    world.deadlines(200, 3000);
    for stall in [false, true] {
        world
            .fake
            .hook(move |req| (req.method == "PATCH").then(|| Resp::UnfinishedBody(200, stall)));
        let done = world
            .call(
                "m365.modify",
                json!({
                    "ids": [super::oid(1)], "removeLabelIds": ["UNREAD"]
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            done["succeededIds"],
            json!([super::oid(1)]),
            "confirmed PATCH, stall={stall}"
        );
        assert_eq!(done["failedIds"], json!([]));
    }
}

#[tokio::test]
async fn an_accepted_send_does_not_become_unknown_when_the_unused_body_stalls() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    isolated!();
    let world = World::new().await;
    world.warm_token().await;
    world.deadlines(200, 3000);
    for stall in [false, true] {
        world.fake.hook(move |req| {
            req.path
                .ends_with("/sendMail")
                .then(|| Resp::UnfinishedBody(202, stall))
        });
        let raw = URL_SAFE_NO_PAD.encode(super::plain_mime("Confirmed send"));
        let sent = world.call("m365.send", json!({"raw":raw})).await;
        assert!(sent.is_ok(), "confirmed 202, stall={stall}: {sent:?}");
        assert_eq!(sent.unwrap()["sent"], true);
    }
    assert_eq!(
        world
            .fake
            .graph()
            .iter()
            .filter(|req| req.path.ends_with("/sendMail"))
            .count(),
        2,
        "each user send is sent only once"
    );
}
