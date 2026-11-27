//! The sign-in and the tokens behind it: the device flow, where the refresh token goes, rotation,
//! refusals and what never leaves Rust.

use std::time::Duration;

use serde_json::{Value, json};

use super::super::{call, signin};
use super::{ACCOUNT, ADDRESS, CLIENT, MemoryStore, Resp, World, inbox, isolated};
use crate::auth::m365::SCOPE;
use signin::INTERVAL;

async fn begin(world: &World) -> Value {
    let params = json!({"address": ADDRESS, "clientId": CLIENT});
    world.call("m365.signInBegin", params).await.unwrap()
}

async fn poll(request: &Value) -> Value {
    call(
        "m365.signInPoll",
        &json!({"requestId": request["requestId"]}),
    )
    .await
    .unwrap()
}

/// What the whole conversation leaves in an answer: no token, no device code.
fn assert_no_secret(answer: &Value) {
    let text = answer.to_string();
    for secret in ["refresh-", "access-", "synthetic-device-code", "id_token"] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
}

#[tokio::test]
async fn a_sign_in_keeps_the_refresh_token_in_the_keyring_and_nothing_in_the_answers() {
    isolated!();
    let world = World::signed_out().await;
    let started = begin(&world).await;
    assert_eq!(started["userCode"], "ABCD1234");
    assert_eq!(
        started["verificationUri"],
        "https://microsoft.com/devicelogin"
    );
    assert_eq!(
        (started["expiresIn"].clone(), started["interval"].clone()),
        (json!(900), json!(5))
    );
    assert_eq!(started["requestId"].as_str().unwrap().len(), 32);
    assert_no_secret(&started);
    // One code asks for Graph scopes only, for the application id the person gave, of the tenant the
    // address's domain names.
    let asked = &world.fake.login()[0];
    assert_eq!(asked.path, "/example.org/oauth2/v2.0/devicecode");
    assert_eq!(asked.field("client_id").as_deref(), Some(CLIENT));
    assert_eq!(asked.field("scope").as_deref(), Some(SCOPE));
    assert!(asked.field("client_secret").is_none());

    // Pending, then signed in; the refresh token is in the keyring under its kind.
    let grant = (200, world.fake.state().issue(Some(ADDRESS)));
    world
        .fake
        .state()
        .device
        .extend([(400, json!({"error": "authorization_pending"})), grant]);
    assert_eq!(poll(&started).await, json!({"state": "pending"}));
    let done = poll(&started).await;
    assert_eq!(done, json!({"state": "signedIn"}));
    assert_no_secret(&done);
    assert_eq!(world.store.token().as_deref(), Some("refresh-1"));
    assert_eq!(world.store.puts.lock().unwrap().len(), 1);
    let token_request = world.fake.login().pop().unwrap();
    assert_eq!(token_request.path, "/example.org/oauth2/v2.0/token");
    assert_eq!(
        token_request.field("device_code").as_deref(),
        Some("synthetic-device-code")
    );
    assert_eq!(token_request.field("client_id").as_deref(), Some(CLIENT));
    // The finished sign-in answers the same again, without asking Microsoft.
    let requests = world.fake.login().len();
    assert_eq!(poll(&started).await, done);
    assert_eq!(world.fake.login().len(), requests);
    // And the mailbox works with the token it made.
    inbox(&world, 1);
    assert_eq!(
        world.call("m365.verify", json!({})).await.unwrap()["ok"],
        true
    );
    // `slow_down` lengthens the interval: the next poll at once is answered without a request.
    let started = begin(&world).await;
    world
        .fake
        .state()
        .device
        .push_back((400, json!({"error": "slow_down"})));
    assert_eq!(poll(&started).await, json!({"state": "pending"}));
    let requests = world.fake.login().len();
    assert_eq!(poll(&started).await, json!({"state": "pending"}));
    assert_eq!(world.fake.login().len(), requests);
}

#[tokio::test]
async fn an_application_id_typed_in_capitals_is_the_same_application_after_the_sign_in() {
    isolated!();
    let world = World::signed_out().await;
    let upper = "ABCDEF00-1111-2222-3333-44444444444F";
    let lower = upper.to_ascii_lowercase();
    world.save_client(upper);
    let params = json!({"address": ADDRESS, "clientId": upper});
    let started = world.call("m365.signInBegin", params).await.unwrap();
    assert_eq!(
        world.fake.login()[0].field("client_id"),
        Some(lower.clone())
    );
    let grant = (200, world.fake.state().issue(Some(ADDRESS)));
    world.fake.state().device.push_back(grant);
    assert_eq!(poll(&started).await, json!({"state": "signedIn"}));
    // The first request after it refreshes from the saved entry, and finds the token it saved.
    inbox(&world, 1);
    assert_eq!(
        world.call("m365.verify", json!({})).await.unwrap()["ok"],
        true
    );
    let refresh = world.fake.login().pop().unwrap();
    assert_eq!(
        refresh.field("grant_type").as_deref(),
        Some("refresh_token")
    );
    assert_eq!(refresh.field("client_id"), Some(lower));
    // And a sign-out in capitals removes that same item.
    world
        .call("m365.signOut", json!({"clientId": upper}))
        .await
        .unwrap();
    assert_eq!(
        world.call("m365.verify", json!({})).await,
        Err("m365_signed_out")
    );
}

#[tokio::test]
async fn a_sign_in_ends_as_the_person_and_microsoft_decide_and_a_wrong_account_keeps_nothing() {
    isolated!();
    let world = World::signed_out().await;
    for (answer, state, error) in [
        (
            (400, json!({"error": "authorization_declined"})),
            "declined",
            None,
        ),
        ((400, json!({"error": "expired_token"})), "expired", None),
        (
            (
                400,
                json!({"error": "invalid_grant", "error_codes": [65001]}),
            ),
            "failed",
            Some("m365_consent_required"),
        ),
        (
            (
                400,
                json!({"error": "invalid_grant", "error_description": "AADSTS90094: admin"}),
            ),
            "failed",
            Some("m365_consent_required"),
        ),
        (
            (
                400,
                json!({"error": "invalid_request", "error_codes": [900023]}),
            ),
            "failed",
            Some("m365_tenant_invalid"),
        ),
        (
            (400, json!({"error": "access_denied"})),
            "failed",
            Some("m365_access_denied"),
        ),
        (
            (400, json!({"error": "unauthorized_client"})),
            "failed",
            Some("m365_auth_failed"),
        ),
        // A grant that is not what was asked for is refused whole.
        (
            (
                200,
                json!({"access_token": "a", "scope": "Mail.Send openid"}),
            ),
            "failed",
            Some("m365_consent_required"),
        ),
        (
            (
                200,
                json!({"access_token": "a", "scope": "Mail.ReadWrite Mail.Send Calendars.ReadWrite", "refresh_token": ""}),
            ),
            "failed",
            Some("m365_invalid_response"),
        ),
        (
            (
                200,
                json!({"scope": "Mail.ReadWrite Mail.Send Calendars.ReadWrite", "refresh_token": "r"}),
            ),
            "failed",
            Some("m365_invalid_response"),
        ),
    ] {
        let started = begin(&world).await;
        world.fake.state().device.push_back(answer.clone());
        let done = poll(&started).await;
        assert_eq!(done["state"], state, "{answer:?}");
        assert_eq!(done["error"].as_str(), error, "{answer:?}");
        assert!(world.store.token().is_none(), "{answer:?} kept a token");
    }
    // Somebody else's code: the id token names another account, which is said and not kept.
    let started = begin(&world).await;
    let other = (200, world.fake.state().issue(Some("Mallory@Example.org")));
    world.fake.state().device.push_back(other);
    let done = poll(&started).await;
    assert_eq!(
        done,
        json!({"state": "failed", "error": "m365_wrong_account", "signedInAs": "mallory@example.org"})
    );
    assert!(world.store.token().is_none() && world.store.puts.lock().unwrap().is_empty());
    // Throttling and a server's own trouble keep the sign-in going; the warning says so.
    let started = begin(&world).await;
    world
        .fake
        .state()
        .device
        .extend([(429, json!({})), (503, json!({}))]);
    for code in ["m365_throttled", "m365_server_error"] {
        assert_eq!(
            poll(&started).await,
            json!({"state": "pending", "warning": code})
        );
    }
    // Nor is a grant whose id token names nobody: whose code it was cannot be told.
    let anonymous = (200, world.fake.state().issue(None));
    world.fake.state().device.push_back(anonymous);
    assert_eq!(
        poll(&started).await,
        json!({"state": "failed", "error": "m365_auth_failed"})
    );
    assert!(world.store.token().is_none());
}

#[tokio::test]
async fn any_name_the_id_token_gives_may_be_the_address_and_otherwise_the_browser_is_named() {
    isolated!();
    let world = World::signed_out().await;
    for (claims, signed_in_as) in [
        // The sign-in name differs from the mail address (an alias or a hybrid account): the
        // address is in another claim, in any case.
        (
            json!({"preferred_username": "asmith@corp.example", "email": "Alice@Example.ORG"}),
            None,
        ),
        (json!({"preferred_username": "ALICE@EXAMPLE.ORG"}), None),
        (
            json!({"preferred_username": "x@y.example", "upn": " alice@example.org "}),
            None,
        ),
        // Not one of the names is the address: the browser was signed in as another account, and
        // the sign-in name is the one said.
        (
            json!({"preferred_username": "Asmith@corp.example", "email": "bob@example.org", "upn": "c@d.example"}),
            Some("asmith@corp.example"),
        ),
        (json!({"email": "bob@example.org"}), Some("bob@example.org")),
    ] {
        let started = begin(&world).await;
        let grant = (200, world.fake.state().issue_claims(Some(claims.clone())));
        world.fake.state().device.push_back(grant);
        let done = poll(&started).await;
        match signed_in_as {
            None => {
                assert_eq!(done, json!({"state": "signedIn"}), "{claims}");
                assert!(world.store.token().is_some());
                world
                    .call("m365.signOut", json!({"clientId": CLIENT}))
                    .await
                    .unwrap();
            }
            Some(name) => {
                assert_eq!(
                    done,
                    json!({"state": "failed", "error": "m365_wrong_account", "signedInAs": name}),
                    "{claims}"
                );
                assert!(world.store.token().is_none(), "{claims}");
            }
        }
    }
}

#[tokio::test]
async fn a_sign_in_refuses_what_microsoft_should_not_say() {
    isolated!();
    let world = World::signed_out().await;
    for bad in [
        json!({"device_code": "d", "user_code": "ABCD", "verification_uri": "https://evil.test/login", "expires_in": 900}),
        json!({"device_code": "d", "user_code": "AB CD", "verification_uri": "https://microsoft.com/devicelogin"}),
        json!({"device_code": "", "user_code": "ABCD", "verification_uri": "https://microsoft.com/devicelogin"}),
        json!({"user_code": "ABCD", "verification_uri": "https://microsoft.com/devicelogin"}),
        json!({"device_code": "d d", "user_code": "ABCD", "verification_uri": "https://microsoft.com/devicelogin"}),
    ] {
        world.fake.hook(move |req| {
            req.path
                .ends_with("devicecode")
                .then(|| Resp::json(200, bad.clone()))
        });
        let params = json!({"address": ADDRESS, "clientId": CLIENT});
        assert_eq!(
            world.call("m365.signInBegin", params).await,
            Err("m365_invalid_response")
        );
    }
    // The login host failing in transit or answering something else is a code, never its words.
    world
        .fake
        .hook(|_| Some(Resp::Send(200, vec![], b"<html>not json</html>".to_vec())));
    let params = json!({"address": ADDRESS, "clientId": CLIENT});
    assert_eq!(
        world.call("m365.signInBegin", params).await,
        Err("m365_invalid_response")
    );
    world
        .fake
        .hook(|_| Some(Resp::Lying(300_000, vec![b'x'; 300_000])));
    let params = json!({"address": ADDRESS, "clientId": CLIENT});
    assert_eq!(
        world.call("m365.signInBegin", params).await,
        Err("m365_invalid_response")
    );
}

#[tokio::test]
async fn a_sign_in_goes_to_the_domains_tenant_and_once_more_to_organizations_when_there_is_none() {
    isolated!();
    let world = World::signed_out().await;
    let paths = |world: &World| -> Vec<String> {
        let all = world.fake.login();
        all.iter().map(|request| request.path.clone()).collect()
    };
    // Nobody has the domain: Microsoft says so, the request is made again to `organizations`, and
    // the rest of that sign-in (its polls) stays there.
    world
        .fake
        .hook(move |req| req.path.starts_with("/example.org/").then(unknown_tenant));
    let started = begin(&world).await;
    assert_eq!(
        paths(&world),
        [
            "/example.org/oauth2/v2.0/devicecode",
            "/organizations/oauth2/v2.0/devicecode"
        ]
    );
    let grant = (200, world.fake.state().issue(Some(ADDRESS)));
    world.fake.state().device.push_back(grant);
    assert_eq!(poll(&started).await, json!({"state": "signedIn"}));
    assert_eq!(
        paths(&world).last().unwrap(),
        "/organizations/oauth2/v2.0/token"
    );
    // A refresh asks as the sign-in did, and every one of them: nothing is remembered between them.
    inbox(&world, 1);
    assert_eq!(
        world.call("m365.verify", json!({})).await.unwrap()["ok"],
        true
    );
    assert_eq!(
        paths(&world)[paths(&world).len() - 2..],
        [
            "/example.org/oauth2/v2.0/token",
            "/organizations/oauth2/v2.0/token"
        ]
    );
    // Not a tenant anywhere: two requests and no more, and the code says so.
    world
        .fake
        .hook(|req| req.path.ends_with("devicecode").then(unknown_tenant));
    let before = paths(&world).len();
    let params = json!({"address": ADDRESS, "clientId": CLIENT});
    assert_eq!(
        world.call("m365.signInBegin", params.clone()).await,
        Err("m365_tenant_invalid")
    );
    assert_eq!(paths(&world).len() - before, 2);
    // Any other refusal from the domain's tenant is its answer: it is not asked again elsewhere.
    world.fake.hook(|req| {
        req.path
            .starts_with("/example.org/")
            .then(|| Resp::json(400, json!({"error_codes": [50194]})))
    });
    let before = paths(&world).len();
    assert_eq!(
        world.call("m365.signInBegin", params).await,
        Err("m365_auth_failed")
    );
    assert_eq!(paths(&world).len() - before, 1);
}

fn unknown_tenant() -> Resp {
    let words = "AADSTS90002: Tenant not found";
    Resp::json(
        400,
        json!({"error": "invalid_request", "error_codes": [90002], "error_description": words}),
    )
}

#[tokio::test]
async fn at_most_four_sign_ins_wait_and_a_request_asked_too_soon_costs_microsoft_nothing() {
    isolated!();
    let world = World::signed_out().await;
    *INTERVAL.lock().unwrap() = Some(Duration::from_secs(600));
    let mut started = Vec::new();
    for _ in 0..5 {
        started.push(begin(&world).await);
    }
    let requests = world.fake.login().len();
    for request in &started[1..] {
        assert_eq!(poll(request).await, json!({"state": "pending"}));
    }
    assert_eq!(
        world.fake.login().len(),
        requests,
        "an early poll reached Microsoft"
    );
    // The newest request wins: the oldest gave way and is unknown.
    assert_eq!(poll(&started[0]).await, json!({"state": "expired"}));
    assert_eq!(
        call("m365.signInPoll", &json!({"requestId": "0".repeat(32)}))
            .await
            .unwrap(),
        json!({"state": "expired"})
    );
}

#[tokio::test]
async fn sign_out_deletes_the_token_stops_a_sign_in_under_way_and_works_when_nothing_is_stored() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    assert_eq!(
        world.call("m365.verify", json!({})).await.unwrap()["ok"],
        true
    );
    let started = begin(&world).await;
    let out = || world.call("m365.signOut", json!({"clientId": CLIENT}));
    assert_eq!(out().await.unwrap(), json!({"signedOut": true}));
    assert_eq!(out().await.unwrap(), json!({"signedOut": true}));
    assert!(world.store.token().is_none());
    // What a sign-in under way would have kept is not kept after a sign-out.
    assert_eq!(poll(&started).await, json!({"state": "expired"}));
    // The in-memory access token went too: the mailbox is signed out at once.
    assert_eq!(
        world.call("m365.verify", json!({})).await,
        Err("m365_signed_out")
    );
    // A client id other than the stored one touches nothing.
    world.store.set("refresh-0");
    let other = world
        .call(
            "m365.signOut",
            json!({"clientId": "99999999-1111-2222-3333-444444444444"}),
        )
        .await;
    assert!(other.is_ok() && world.store.token().is_some());
}

#[tokio::test]
async fn a_sign_out_of_one_application_leaves_a_sign_in_of_another_under_way() {
    isolated!();
    let world = World::signed_out().await;
    let started = begin(&world).await;
    // The window signs out what a cancelled sign-in of the ID typed before may have saved, while the
    // sign-in with the ID typed now waits for its code: that one writes another keyring item.
    let before = "99999999-1111-2222-3333-444444444444";
    assert_eq!(
        world
            .call("m365.signOut", json!({"clientId": before}))
            .await
            .unwrap(),
        json!({"signedOut": true})
    );
    let grant = (200, world.fake.state().issue(Some(ADDRESS)));
    world.fake.state().device.push_back(grant);
    assert_eq!(poll(&started).await, json!({"state": "signedIn"}));
    assert_eq!(world.store.token().as_deref(), Some("refresh-1"));
}

#[tokio::test]
async fn a_sign_out_behind_a_refresh_waiting_on_the_keyring_says_it_was_not_done_in_time() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    *signin::SHORT_LANE_WAIT.lock().unwrap() = Some(Duration::from_millis(300));
    // A refresh rotates the token, and its keyring save waits for somebody to unlock the keyring:
    // the mailbox's refresh lane is held all that time.
    let saving = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let entered = std::sync::Arc::clone(&saving);
    let held = std::sync::Arc::new(move || {
        entered.store(true, std::sync::atomic::Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(1500));
    });
    *world.store.during_put.lock().unwrap() = Some(held);
    let refresh = world.call("m365.verify", json!({}));
    let behind = async {
        while !saving.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let started = std::time::Instant::now();
        let out = world
            .call("m365.signOut", json!({"clientId": CLIENT}))
            .await;
        let forgot = world.call("m365.invalidate", json!({})).await;
        (out, forgot, started.elapsed())
    };
    let (verified, (out, forgot, waited)) = tokio::join!(refresh, behind);
    assert_eq!(out, Err("m365_timeout"));
    assert_eq!(forgot, Err("m365_timeout"));
    assert!(
        waited < Duration::from_millis(1000),
        "answered after {waited:?}, with the lane"
    );
    // Not signed out: the rotated token was saved after all and the mailbox goes on working.
    assert_eq!(verified.unwrap()["ok"], true);
    assert_eq!(world.store.token().as_deref(), Some("refresh-1"));
    // With the lane free, the same sign-out is done.
    *world.store.during_put.lock().unwrap() = None;
    let out = world
        .call("m365.signOut", json!({"clientId": CLIENT}))
        .await;
    assert_eq!(out, Ok(json!({"signedOut": true})));
    assert!(world.store.token().is_none());
}

#[tokio::test]
async fn a_sign_out_that_lands_while_the_token_is_being_saved_leaves_nothing_saved() {
    isolated!();
    let world = World::signed_out().await;
    let started = begin(&world).await;
    let grant = (200, world.fake.state().issue(Some(ADDRESS)));
    world.fake.state().device.push_back(grant);
    // The sign-out comes after the grant was judged and before the keyring write has landed.
    let during = std::sync::Arc::new(|| signin::end_flows(ACCOUNT, CLIENT));
    *world.store.during_put.lock().unwrap() = Some(during);
    assert_eq!(poll(&started).await, json!({"state": "expired"}));
    assert!(world.store.token().is_none());
}

#[tokio::test]
async fn a_refreshed_token_that_rotates_is_saved_before_it_is_used() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    assert_eq!(
        world.call("m365.verify", json!({})).await.unwrap()["ok"],
        true
    );
    let refresh = world.fake.login();
    assert_eq!(refresh.len(), 1);
    assert_eq!(refresh[0].path, "/example.org/oauth2/v2.0/token");
    assert_eq!(
        refresh[0].field("grant_type").as_deref(),
        Some("refresh_token")
    );
    assert_eq!(
        refresh[0].field("refresh_token").as_deref(),
        Some("refresh-0")
    );
    assert_eq!(refresh[0].field("scope").as_deref(), Some(SCOPE));
    assert_eq!(refresh[0].field("client_id").as_deref(), Some(CLIENT));
    assert_eq!(world.store.token().as_deref(), Some("refresh-1"));
    // The access token is reused until it nears its expiry: no second refresh, no second token.
    world
        .call("m365.list", json!({"query": "role:inbox", "limit": 5}))
        .await
        .unwrap();
    assert_eq!(world.fake.login().len(), 1);
    // The next refresh presents the rotated token, and its own rotation is saved in turn.
    world.call("m365.invalidate", json!({})).await.unwrap();
    world
        .call("m365.list", json!({"query": "role:inbox", "limit": 5}))
        .await
        .unwrap();
    assert_eq!(
        world.fake.login()[1].field("refresh_token").as_deref(),
        Some("refresh-1")
    );
    let saved: Vec<String> = world
        .store
        .puts
        .lock()
        .unwrap()
        .iter()
        .map(|(_, token)| token.clone())
        .collect();
    assert_eq!(saved, ["refresh-1", "refresh-2"]);
    assert!(
        world
            .store
            .puts
            .lock()
            .unwrap()
            .iter()
            .all(|(name, _)| name.contains("M365RefreshToken"))
    );
}

#[tokio::test]
async fn a_burst_of_requests_makes_one_refresh_and_a_revoked_token_is_refreshed_once() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    let list = |_| world.call("m365.list", json!({"query": "role:inbox", "limit": 5}));
    let answers = futures_util::future::join_all((0..6).map(list)).await;
    assert!(answers.iter().all(Result::is_ok));
    assert_eq!(world.fake.login().len(), 1, "one refresh serves the burst");
    // Graph refuses the token (revoked): one fresh token and the request again, no more.
    world.fake.state().access = "revoked".into();
    let listed = world
        .call("m365.list", json!({"query": "role:inbox", "limit": 5}))
        .await;
    assert!(listed.is_ok(), "{listed:?}");
    assert_eq!(world.fake.login().len(), 2);
}

#[tokio::test]
async fn a_refused_grant_a_withdrawn_consent_and_an_empty_keyring_each_say_so_and_ask_no_further() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    let verify = || async {
        let result = world.call("m365.verify", json!({})).await;
        // A failed folder lookup drops its siblings, but an admitted refresh finishes under its
        // lane guard. Drain it before changing the next scenario's hook or counting its requests.
        tokio::time::timeout(Duration::from_secs(30), crate::auth::invalidate(ACCOUNT))
            .await
            .expect("previous refresh did not finish")
            .unwrap();
        result
    };
    world.store.set("stale");
    assert_eq!(verify().await, Err("m365_signed_out"));
    world.store.set("refresh-0");
    world.fake.hook(|req| {
        req.path.ends_with("/token").then(|| {
            Resp::json(
                400,
                json!({"error": "invalid_grant", "error_codes": [65001]}),
            )
        })
    });
    assert_eq!(verify().await, Err("m365_consent_required"));
    // Consent withdrawn for one permission: the token Microsoft gives lacks it.
    world.fake.hook(|req| req.path.ends_with("/token").then(|| Resp::json(200, json!({"access_token": "a", "scope": "Mail.ReadWrite Mail.Send", "expires_in": 3600}))));
    assert_eq!(verify().await, Err("m365_consent_required"));
    world.fake.hook(|req| {
        req.path
            .ends_with("/token")
            .then(|| Resp::json(503, json!({})))
    });
    assert_eq!(verify().await, Err("m365_auth_failed"));
    // A batch whose grant is refused does not send it fifty times: the rest fail without asking.
    world.fake.hook(|_| None);
    world.store.set("stale");
    inbox(&world, 12);
    let before = world.fake.login().len();
    let ids: Vec<String> = (1..=12).map(super::oid).collect();
    let changed = world
        .call(
            "m365.modify",
            json!({"ids": ids, "removeLabelIds": ["UNREAD"]}),
        )
        .await
        .unwrap();
    assert_eq!(
        (
            changed["failedIds"].as_array().unwrap().len(),
            &changed["error"]
        ),
        (12, &json!("m365_signed_out"))
    );
    assert!(
        world.fake.login().len() - before <= 4,
        "{} refresh requests",
        world.fake.login().len() - before
    );
    world.store.set("refresh-0");
    // Nothing in the keyring: signed out, and the login host is not asked.
    let requests = world.fake.login().len();
    world.fake.hook(|_| None);
    world
        .call("m365.signOut", json!({"clientId": CLIENT}))
        .await
        .unwrap();
    assert_eq!(verify().await, Err("m365_signed_out"));
    assert_eq!(world.fake.login().len(), requests);
}

#[tokio::test]
async fn a_mailbox_that_is_not_in_the_registry_asks_nothing_of_the_keyring_or_the_network() {
    isolated!();
    let world = World::new().await;
    let gets = |store: &MemoryStore| store.gets.load(std::sync::atomic::Ordering::SeqCst);
    let before = gets(&world.store);
    let stranger = "m365:stranger@example.org";
    for (method, params) in [
        ("m365.verify", json!({"accountId": stranger})),
        (
            "m365.list",
            json!({"accountId": stranger, "query": "role:inbox", "limit": 5}),
        ),
        (
            "m365.read",
            json!({"accountId": stranger, "id": super::oid(1), "full": true}),
        ),
    ] {
        assert_eq!(
            call(method, &params).await,
            Err("auth_account_missing"),
            "{method}"
        );
    }
    assert_eq!(gets(&world.store), before);
    assert!(world.fake.state().seen.is_empty());
    // An Outlook mailbox of the same address is another account: its token is not this one's.
    assert_eq!(
        crate::auth::graph_token("outlook:bob@example.org").await,
        Err("auth_signed_out")
    );
    assert!(world.fake.login().is_empty());
    // The calendar takes the Graph token of an m365 account from this sign-in, with the same scope.
    assert_eq!(crate::auth::graph_token(ACCOUNT).await.unwrap(), "access-1");
    assert_eq!(world.fake.login()[0].field("scope").as_deref(), Some(SCOPE));
    assert_eq!(world.store.token().as_deref(), Some("refresh-1"));
}

#[tokio::test]
async fn a_poll_that_outwaits_its_exchange_says_pending_and_a_later_one_has_the_outcome() {
    isolated!();
    let world = World::signed_out().await;
    *signin::SHORT_POLL_WAIT.lock().unwrap() = Some(Duration::from_millis(200));
    let started = begin(&world).await;
    let grant = (200, world.fake.state().issue(Some(ADDRESS)));
    world.fake.state().device.push_back(grant);
    // The keyring asks somebody to unlock it, and that takes longer than a poll waits.
    let slow = std::sync::Arc::new(|| std::thread::sleep(Duration::from_millis(800)));
    *world.store.during_put.lock().unwrap() = Some(slow);
    // A warning of its own: a token request that timed out (`m365_timeout`) is over and saved nothing,
    // while this exchange may still save a grant.
    assert_eq!(
        poll(&started).await,
        json!({"state": "pending", "warning": "m365_exchange_running"})
    );
    assert_eq!(
        poll(&started).await,
        json!({"state": "pending"}),
        "asked again while it saves"
    );
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert_eq!(poll(&started).await, json!({"state": "signedIn"}));
    assert_eq!(world.store.token().as_deref(), Some("refresh-1"));
    let grants = world
        .fake
        .login()
        .iter()
        .filter(|r| r.field("grant_type").as_deref() == Some(signin_grant()))
        .count();
    assert_eq!(grants, 1, "Microsoft was asked once for the code");
}

fn signin_grant() -> &'static str {
    "urn:ietf:params:oauth:grant-type:device_code"
}

#[tokio::test]
async fn cancelled_older_grant_must_not_delete_newer_same_app_grant() {
    isolated!();
    let world = World::signed_out().await;
    let first = begin(&world).await;
    let grant = (200, world.fake.state().issue(Some(ADDRESS)));
    world.fake.state().device.push_back(grant);
    let saving = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let release = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let entered = saving.clone();
    let released = release.clone();
    *world.store.during_put.lock().unwrap() = Some(std::sync::Arc::new(move || {
        if !entered.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !released.load(std::sync::atomic::Ordering::SeqCst)
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }));
    let next = async {
        while !saving.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let sign_out = tokio::spawn(async {
            call(
                "m365.signOut",
                &json!({"accountId": ACCOUNT, "clientId": CLIENT}),
            )
            .await
        });
        // The sign-out ends the old flow and queues its deletion behind the blocked save.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let second = begin(&world).await;
        let grant = (200, world.fake.state().issue(Some(ADDRESS)));
        world.fake.state().device.push_back(grant);
        let unblocking = async {
            // Queue the second grant's save before allowing the older one to finish.
            tokio::time::sleep(Duration::from_millis(100)).await;
            release.store(true, std::sync::atomic::Ordering::SeqCst);
        };
        let (newer, _) = tokio::join!(poll(&second), unblocking);
        let out = sign_out.await.unwrap();
        (newer, out)
    };
    let (older, (newer, out)) = tokio::join!(poll(&first), next);
    assert_eq!(older, json!({"state": "expired"}));
    assert_eq!(out, Ok(json!({"signedOut": true})));
    assert_eq!(newer, json!({"state": "signedIn"}));
    assert_eq!(
        world.store.token().as_deref(),
        Some("refresh-2"),
        "newer signed-in flow must keep its own token"
    );
}

#[tokio::test]
async fn a_cancelled_grant_with_reused_token_bytes_cannot_delete_its_replacement() {
    isolated!();
    let world = World::signed_out().await;
    let saving = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let release = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let current = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let entered = saving.clone();
    let released = release.clone();
    *world.store.during_put.lock().unwrap() = Some(std::sync::Arc::new(move || {
        if !entered.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !released.load(std::sync::atomic::Ordering::SeqCst)
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }));
    let live = current.clone();
    let older = crate::auth::m365::save_grant(ACCOUNT, CLIENT, "same-refresh", move || {
        live.load(std::sync::atomic::Ordering::SeqCst)
    });
    let replacement = async {
        while !saving.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        current.store(false, std::sync::atomic::Ordering::SeqCst);
        let newer = crate::auth::m365::save_grant(ACCOUNT, CLIENT, "same-refresh", || true);
        tokio::pin!(newer);
        // This future reaches the held lane before the old keyring write may finish.
        assert!(futures_util::poll!(newer.as_mut()).is_pending());
        release.store(true, std::sync::atomic::Ordering::SeqCst);
        newer.await
    };
    let (old, new) = tokio::join!(older, replacement);
    assert_eq!(old, Ok(false));
    assert_eq!(new, Ok(true));
    assert_eq!(world.store.token().as_deref(), Some("same-refresh"));
}

#[tokio::test]
async fn a_grant_cancelled_before_its_lane_is_admitted_keeps_no_token() {
    isolated!();
    let world = World::signed_out().await;
    assert_eq!(
        crate::auth::m365::save_grant(ACCOUNT, CLIENT, "cancelled-refresh", || false).await,
        Ok(false)
    );
    assert!(world.store.token().is_none());
    assert!(
        world.store.puts.lock().unwrap().is_empty(),
        "cancelled grant must never reach the keyring"
    );
}
