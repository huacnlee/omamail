//! Drafts on the server: `m365.saveDraft` creates one from MIME and then removes the copy it replaces,
//! `m365.deleteDraft` removes only what is a draft.

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use std::time::Duration;

use serde_json::json;

use super::{Resp, Role, World, err, inbox, isolated, oid, ok};

fn mime() -> Vec<u8> {
    b"From: alice@example.org\r\nTo: bob@example.org\r\nBcc: blind@example.org\r\nSubject: Plan\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nNot yet\r\n".to_vec()
}

/// The Graph requests that were not listings or folder lookups, as `METHOD path`.
fn writes(world: &World) -> Vec<String> {
    world
        .fake
        .graph()
        .iter()
        .filter(|r| !r.path.contains("/mailFolders/"))
        .map(|r| format!("{} {}", r.method, r.path))
        .collect()
}

#[tokio::test]
async fn a_draft_is_saved_as_mime_and_the_copy_it_replaces_goes_only_once_it_exists() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    world.fake.state().add(5, Role::Drafts, "Old draft");
    let raw = URL_SAFE_NO_PAD.encode(mime());
    let saved = ok!(world, "m365.saveDraft", {"raw": raw, "draftId": oid(5)});
    let new = world
        .fake
        .state()
        .msgs
        .iter()
        .find(|m| m.subject == "Draft")
        .map(|m| (m.id.clone(), m.folder, m.mime.clone()))
        .unwrap();
    assert_eq!(
        saved,
        json!({"saved": true, "warning": "", "id": super::super::ids::encode(&new.0).unwrap()})
    );
    // Graph is given the MIME as composed, as base64 text, and the new draft is in Drafts.
    let create = world
        .fake
        .graph()
        .into_iter()
        .find(|r| r.method == "POST" && r.path == "/v1.0/me/messages")
        .unwrap();
    assert_eq!(create.header("content-type"), Some("text/plain"));
    assert_eq!(create.header("prefer"), Some("IdType=\"ImmutableId\""));
    assert_eq!(STANDARD.decode(&create.body).unwrap(), mime());
    assert_eq!((new.1, new.2), (Role::Drafts, mime()));
    // The old copy is asked whether it is a draft, then deleted, after the new one exists.
    let old = format!("/v1.0/me/messages/{}", super::gid(5));
    assert_eq!(
        writes(&world),
        [
            "POST /v1.0/me/messages".to_owned(),
            format!("GET {old}"),
            format!("DELETE {old}")
        ]
    );
    let check = world
        .fake
        .graph()
        .into_iter()
        .find(|r| r.path == old)
        .unwrap();
    assert_eq!(check.param("$select"), Some("isDraft,parentFolderId"));
    assert!(
        !world
            .fake
            .state()
            .msgs
            .iter()
            .any(|m| m.subject == "Old draft")
    );
    // With nothing to replace, nothing else is asked.
    let before = writes(&world).len();
    let saved = ok!(world, "m365.saveDraft", {"raw": raw});
    assert_eq!(saved["warning"], "");
    assert_eq!(
        writes(&world)[before..],
        ["POST /v1.0/me/messages".to_owned()]
    );
}

#[tokio::test]
async fn a_saved_draft_whose_old_copy_stays_is_a_warning_and_a_failed_save_removes_nothing() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    world.fake.state().add(5, Role::Drafts, "Old draft");
    let raw = URL_SAFE_NO_PAD.encode(mime());
    // The id names a received message: it is not a draft, so it stays, and the save is still a save.
    let saved = ok!(world, "m365.saveDraft", {"raw": raw, "draftId": oid(1)});
    assert_eq!(saved["saved"], true);
    assert_eq!(
        saved["warning"],
        "The updated draft was saved, but the old copy could not be removed"
    );
    assert!(!writes(&world).iter().any(|w| w.starts_with("DELETE")));
    assert_eq!(world.fake.state().msg(1).folder, Role::Inbox);
    // Graph refuses to delete the old copy: a warning again.
    world
        .fake
        .hook(|req| (req.method == "DELETE").then(|| Resp::status(403)));
    let saved = ok!(world, "m365.saveDraft", {"raw": raw, "draftId": oid(5)});
    assert_eq!(
        (saved["saved"].clone(), saved["warning"] != ""),
        (json!(true), true)
    );
    // A save Graph refuses is a failure, and the draft it would have replaced is left alone.
    world.fake.hook(|req| {
        (req.method == "POST" && req.path == "/v1.0/me/messages").then(|| Resp::status(400))
    });
    let before = writes(&world).len();
    assert_eq!(
        err!(world, "m365.saveDraft", {"raw": raw, "draftId": oid(5)}),
        "m365_invalid_request"
    );
    assert_eq!(
        writes(&world)[before..],
        ["POST /v1.0/me/messages".to_owned()]
    );
    assert!(
        world
            .fake
            .state()
            .msgs
            .iter()
            .any(|m| m.subject == "Old draft")
    );
}

#[tokio::test]
async fn only_a_draft_is_deleted_and_bad_requests_reach_nobody() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    world.fake.state().add(5, Role::Drafts, "Old draft");
    assert_eq!(
        err!(world, "m365.deleteDraft", {"id": oid(1)}),
        "m365_not_a_draft"
    );
    assert_eq!(world.fake.state().msg(1).folder, Role::Inbox);
    assert!(!writes(&world).iter().any(|w| w.starts_with("DELETE")));
    assert_eq!(ok!(world, "m365.deleteDraft", {"id": oid(5)}), json!({}));
    assert_eq!(
        writes(&world)[1..],
        [
            format!("GET /v1.0/me/messages/{}", super::gid(5)),
            format!("DELETE /v1.0/me/messages/{}", super::gid(5))
        ]
    );
    assert!(
        !world
            .fake
            .state()
            .msgs
            .iter()
            .any(|m| m.subject == "Old draft")
    );
    // What cannot be a draft id or a message is refused before any request.
    let before = world.fake.graph().len();
    let raw = URL_SAFE_NO_PAD.encode(mime());
    for (method, params) in [
        ("m365.deleteDraft", json!({"id": "5:Drafts"})),
        ("m365.deleteDraft", json!({})),
        ("m365.deleteDraft", json!({"id": oid(5), "extra": 1})),
        ("m365.saveDraft", json!({"raw": raw, "draftId": "5:Drafts"})),
        ("m365.saveDraft", json!({"raw": raw, "draftId": 5})),
        ("m365.saveDraft", json!({"raw": "not base64!"})),
        ("m365.saveDraft", json!({"raw": raw, "threadId": "t"})),
    ] {
        assert_eq!(
            world.call(method, params.clone()).await,
            Err("invalid_params"),
            "{method} {params}"
        );
    }
    assert_eq!(world.fake.graph().len(), before);
}

#[tokio::test]
async fn a_save_with_no_answer_may_have_made_a_draft_and_is_never_repeated() {
    isolated!();
    let world = World::new().await;
    world.fake.state().add(5, Role::Drafts, "Old draft");
    world.warm_token().await;
    world.deadlines(300, 2000);
    let raw = URL_SAFE_NO_PAD.encode(mime());
    let posts = |world: &World| {
        world
            .fake
            .graph()
            .iter()
            .filter(|r| r.method == "POST" && r.path == "/v1.0/me/messages")
            .count()
    };
    // A 5xx, a lost answer: Graph may have filed the draft. Said so, sent once, the old copy kept.
    for resp in [|| Resp::status(500), || Resp::status(503), || Resp::Stall] {
        world
            .fake
            .hook(move |req| (req.method == "POST" && req.path == "/v1.0/me/messages").then(resp));
        let before = posts(&world);
        assert_eq!(
            err!(world, "m365.saveDraft", {"raw": raw, "draftId": oid(5)}),
            "m365_draft_unconfirmed"
        );
        assert_eq!(posts(&world), before + 1, "a save is never repeated");
        assert!(!writes(&world).iter().any(|w| w.starts_with("DELETE")));
    }
    // A refusal for its size is a refusal, not a doubt, whatever status carries it, as on a send.
    world.fake.hook(|req| {
        (req.method == "POST" && req.path == "/v1.0/me/messages").then(|| Resp::status(413))
    });
    assert_eq!(
        err!(world, "m365.saveDraft", {"raw": raw}),
        "m365_message_too_large"
    );
    world.fake.hook(|req| {
        (req.method == "POST" && req.path == "/v1.0/me/messages")
            .then(|| Resp::json(500, json!({"error": {"code": "ErrorMessageSizeExceeded"}})))
    });
    assert_eq!(
        err!(world, "m365.saveDraft", {"raw": raw}),
        "m365_message_too_large"
    );
}

#[tokio::test]
async fn a_large_draft_is_given_longer_to_upload_and_a_small_one_is_not() {
    isolated!();
    let world = World::new().await;
    inbox(&world, 1);
    world.warm_token().await;
    world.deadlines(300, 5000);
    let sized = |size: usize| {
        let mut message = mime();
        message.extend(std::iter::repeat_n(b'x', size));
        URL_SAFE_NO_PAD.encode(message)
    };
    // The token is fetched first, so what follows times only the upload.
    assert_eq!(
        ok!(world, "m365.saveDraft", {"raw": sized(10)})["saved"],
        true
    );
    world.fake.hook(|req| {
        (req.method == "POST" && req.path == "/v1.0/me/messages").then(|| {
            Resp::Wait(
                Duration::from_millis(900),
                Box::new(Resp::json(201, json!({"id": super::gid(77)}))),
            )
        })
    });
    assert_eq!(
        err!(world, "m365.saveDraft", {"raw": sized(10)}),
        "m365_draft_unconfirmed"
    );
    let saved = ok!(world, "m365.saveDraft", {"raw": sized(1024 * 1024)});
    assert_eq!(saved["id"], oid(77));
}
