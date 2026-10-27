//! The `exchange.*` methods end to end: a registry file, a keyring, and the scripted server of
//! `ews::tests`. Tests that change the process environment run isolated (see `mail::tests`).

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde_json::{Value, json};

use super::ews::tests::fake::{
    self, Fake, LOGIN, Offer, Out, PASSWORD, Soap, ews_id, ok, response,
};
use super::{call, ids, query::Query};
use crate::credentials::tests::{SingleCredential, StoreOverride, isolated_store};
use crate::credentials::{CredentialKey, CredentialKind, Secret};
use crate::mail::tests::{AccountFixture, account_fixture, isolated};

mod calendar;

const ACCOUNT: &str = "exchange:ada@example.org";

struct World {
    fake: Fake,
    _registry: AccountFixture,
    _store: StoreOverride,
}

/// A registry entry pointing at a scripted server, and a keyring holding the password (or not).
async fn world(
    offer: Offer,
    password: Option<&str>,
    script: impl Fn(&Soap) -> Out + Send + Sync + 'static,
) -> World {
    let fake = Fake::start(offer, move |soap| {
        // The mail folders; the calendar's own is the script's to answer.
        if soap.op == "GetFolder" && !soap.body.contains(r#"Id="calendar""#) {
            Out::Xml(fake::folders())
        } else {
            script(soap)
        }
    })
    .await;
    world_on(fake, password)
}

/// `world` for a server that answers the folder lookup itself.
fn world_on(fake: Fake, password: Option<&str>) -> World {
    let entry = json!({"provider": "exchange", "email": "Ada@Example.org", "exchange": {"ewsUrl": fake.url(), "username": LOGIN, "authScheme": "auto"}});
    let registry = account_fixture(json!({"version": 1, "activeId": ACCOUNT, "accounts": [entry]}));
    let key = CredentialKey {
        provider: "exchange".into(),
        account_id: ACCOUNT.into(),
        kind: CredentialKind::ExchangePassword,
    };
    let secret = Secret::new(password.unwrap_or("-").as_bytes().to_vec()).unwrap();
    let key = if password.is_some() {
        key
    } else {
        CredentialKey {
            account_id: "exchange:nobody@example.org".into(),
            ..key
        }
    };
    World {
        fake,
        _registry: registry,
        _store: isolated_store(SingleCredential { key, secret }),
    }
}

async fn rpc(method: &str, params: Value) -> Result<Value, &'static str> {
    call(&format!("exchange.{method}"), &params).await
}

fn id(seed: u8) -> String {
    ids::encode(&ews_id(seed)).unwrap()
}

#[tokio::test]
async fn requests_are_refused_before_any_account_credential_or_socket_is_touched() {
    let good = id(1);
    let raw = URL_SAFE_NO_PAD.encode("To: a@example.org\r\n\r\nx");
    let account = json!({"accountId": ACCOUNT});
    let with = |extra: Value| {
        let mut map = account.as_object().unwrap().clone();
        map.extend(extra.as_object().unwrap().clone());
        Value::Object(map)
    };
    let table: Vec<(&str, Value)> = vec![
        (
            "list",
            with(json!({"query": "role:inbox", "limit": 5, "pageToken": "", "unexpected": 1})),
        ),
        (
            "list",
            with(json!({"query": "role:inbox", "limit": 0, "pageToken": ""})),
        ),
        (
            "list",
            with(json!({"query": "role:inbox", "limit": 101, "pageToken": ""})),
        ),
        (
            "list",
            with(json!({"query": "role:archive", "limit": 5, "pageToken": ""})),
        ),
        (
            "list",
            with(json!({"query": "inbox", "limit": 5, "pageToken": ""})),
        ),
        (
            "list",
            json!({"accountId": "imap:ada@example.org", "query": "role:inbox", "limit": 5}),
        ),
        (
            "list",
            json!({"accountId": "exchange:ada\n@example.org", "query": "role:inbox", "limit": 5}),
        ),
        ("messages", with(json!({"ids": [], "full": false}))),
        ("messages", with(json!({"ids": ["MFRGG"], "full": false}))),
        ("messages", with(json!({"ids": [good], "full": "yes"}))),
        ("read", with(json!({"id": good, "full": false}))),
        (
            "attachment",
            with(json!({"messageId": good, "attachmentId": "../x"})),
        ),
        (
            "attachment",
            with(json!({"messageId": good, "attachmentId": "part:1."})),
        ),
        ("modify", with(json!({"ids": [good]}))),
        (
            "modify",
            with(json!({"ids": [good], "addLabelIds": ["UNREAD"], "removeLabelIds": ["UNREAD"]})),
        ),
        ("trash", with(json!({"ids": [good], "addLabelIds": ["X"]}))),
        ("send", with(json!({"raw": "not base64url!"}))),
        ("send", with(json!({"raw": format!("{raw}=")}))),
        ("send", with(json!({"raw": ""}))),
        ("saveDraft", with(json!({"raw": "not base64url!"}))),
        ("saveDraft", with(json!({"raw": raw, "draftId": "MFRGG"}))),
        ("saveDraft", with(json!({"raw": raw, "draftId": 7}))),
        ("saveDraft", with(json!({"raw": raw, "threadId": "x"}))),
        ("deleteDraft", with(json!({"id": "MFRGG"}))),
        ("deleteDraft", with(json!({"id": good, "draftId": good}))),
        ("cancel", account.clone()),
        (
            "verify",
            json!({"address": "ada@example.org", "settings": {"ewsUrl": "https://m.example.org/EWS/Exchange.asmx", "extra": 1}, "secret": "x"}),
        ),
    ];
    for (method, params) in table {
        assert_eq!(
            rpc(method, params.clone()).await.err(),
            Some("invalid_params"),
            "{method} {params}"
        );
    }
    assert_eq!(
        call("exchange.nonsense", &json!({})).await.err(),
        Some("method_not_found")
    );
    // Answered without a lookup: the sender identity is the account itself.
    assert_eq!(
        rpc("sendAs", account.clone()).await.unwrap()[0]["email"],
        "ada@example.org"
    );
    assert_eq!(
        rpc("cancel", with(json!({"requestToken": "nothing"})))
            .await
            .unwrap()["cancelled"],
        false
    );
    assert_eq!(
        rpc("invalidate", account).await.unwrap()["invalidated"],
        true
    );
}

#[tokio::test]
async fn a_sign_in_names_the_mailbox_and_refuses_what_the_form_must_explain() {
    let fake = Fake::start(Offer::Ntlm, |_| Out::Xml(fake::folders_without("sent"))).await;
    let settings =
        |url: &str, scheme: &str| json!({"ewsUrl": url, "username": LOGIN, "authScheme": scheme});
    let sign_in = |settings: Value, secret: &str| {
        rpc(
            "verify",
            json!({"address": "Ada@Example.org", "settings": settings, "secret": secret}),
        )
    };
    let answer = sign_in(settings(&fake.url(), "auto"), PASSWORD)
        .await
        .unwrap();
    assert_eq!(
        (
            answer["ok"].clone(),
            answer["email"].clone(),
            answer["scheme"].clone()
        ),
        (json!(true), json!("ada@example.org"), json!("ntlm"))
    );
    assert_eq!(answer["serverVersion"], "15.2.2562");
    assert!(answer.get("learned").is_none(), "`scheme` says it once");
    assert_eq!(answer["roles"]["inbox"], json!({"total": 120, "unread": 7}));
    assert_eq!(answer["roles"]["sent"], Value::Null);
    assert!(
        answer["refusals"]["send"].is_string(),
        "no Sent folder: sending is withdrawn"
    );
    assert_eq!(answer["refusals"].as_object().unwrap().len(), 1);
    // The password went to the server and the server only: nothing named it in an error.
    assert_eq!(
        sign_in(settings(&fake.url(), "auto"), "wrong").await.err(),
        Some("exchange_unauthorized")
    );
    assert_eq!(
        sign_in(
            settings("http://mail.example.org/EWS/Exchange.asmx", "auto"),
            PASSWORD
        )
        .await
        .err(),
        Some("exchange_url_invalid")
    );
    assert_eq!(
        sign_in(settings(&fake.url(), "kerberos"), PASSWORD)
            .await
            .err(),
        Some("invalid_params")
    );
    assert_eq!(
        sign_in(settings(&fake.url(), "basic"), PASSWORD)
            .await
            .err(),
        Some("exchange_auth_scheme_unsupported")
    );
}

fn mime(subject: &str) -> Vec<u8> {
    format!(
        "From: Ada <ada@example.org>\r\nTo: me@example.org\r\nSubject: {subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"a.bin\"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC\r\n--b--\r\n"
    )
    .into_bytes()
}

#[tokio::test]
async fn mail_is_listed_read_and_its_attachment_fetched_as_the_shared_resource() {
    if isolated() {
        return;
    }
    let hostile = "x\" &lt;evil@example.org&gt;, \"y";
    let w = world(Offer::Ntlm, Some(PASSWORD), move |soap| {
        match soap.op.as_str() {
            "FindItem" => {
                let rows = [
                    fake::item_with(1, "inbox", 50, "Plain", "Ada", "ada@example.org"),
                    fake::item_with(
                        2,
                        "inbox",
                        40,
                        "=?utf-8?b?aGk=?= line\r&#13;&#10;Bcc: x@example.org",
                        hostile,
                        "ada@example.org",
                    ),
                    fake::item_with(3, "inbox", 30, "Third", "Doe, Jane", "not an address"),
                ];
                Out::Xml(fake::find(&rows, true, 3))
            }
            "GetItem" => {
                // One answer per requested id; the ninth message is gone.
                let mime = soap
                    .body
                    .contains("IncludeMimeContent")
                    .then(|| mime("Hello"));
                let asked = soap
                    .body
                    .split("<t:ItemId Id=\"")
                    .skip(1)
                    .filter_map(|rest| rest.split('"').next());
                let answers: Vec<String> = asked
                    .map(|asked| {
                        if asked == ews_id(9) {
                            fake::message("GetItem", "Error", "ErrorItemNotFound", "")
                        } else {
                            fake::item_message(1, mime.as_deref())
                        }
                    })
                    .collect();
                Out::Xml(response("GetItem", &answers))
            }
            _ => Out::Drop,
        }
    })
    .await;
    let listed = rpc(
        "list",
        json!({"accountId": ACCOUNT, "query": "role:inbox", "limit": 25, "pageToken": ""}),
    )
    .await
    .unwrap();
    let rows = listed["rows"].as_array().unwrap();
    assert_eq!(
        listed["page"]["ids"],
        json!(rows.iter().map(|row| row["id"].clone()).collect::<Vec<_>>())
    );
    assert_eq!(
        (
            listed["page"]["estimate"].clone(),
            listed["warning"].clone()
        ),
        (json!(120), Value::Null)
    );
    assert_eq!(rows[0]["labelIds"], json!(["UNREAD", "INBOX"]));
    // Whatever the server wrote, the shared summarizer sees one sender and no forged recipient or header.
    for row in rows {
        let summary = crate::message::content::summarize(row, 0).unwrap();
        assert_eq!(
            (
                summary["to"].clone(),
                summary["cc"].clone(),
                summary["bcc"].clone()
            ),
            (json!([]), json!([]), json!([]))
        );
    }
    // A sender with no usable address is shown by name; the address-looking text in a name is not one.
    let senders: Vec<String> = rows
        .iter()
        .map(|row| {
            crate::message::content::summarize(row, 0).unwrap()["from"]["email"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(senders, ["ada@example.org", "ada@example.org", "Doe  Jane"]);
    let second = crate::message::content::summarize(&rows[1], 0).unwrap();
    assert_eq!(
        second["subject"], "=?utf-8?b?aGk=?= line Bcc: x@example.org",
        "text that looks encoded is shown as written"
    );
    // One missing message leaves the others, and says so.
    let some = rpc(
        "messages",
        json!({"accountId": ACCOUNT, "ids": [id(1), id(9)], "full": false}),
    )
    .await
    .unwrap();
    assert_eq!(
        (
            some["messages"].as_array().unwrap().len(),
            some["warning"].clone()
        ),
        (1, json!("partial"))
    );
    let none = rpc(
        "messages",
        json!({"accountId": ACCOUNT, "ids": [id(9)], "full": true}),
    )
    .await
    .unwrap();
    assert_eq!(
        (none["messages"].clone(), none["warning"].clone()),
        (json!([]), json!("partial"))
    );
    let read = rpc(
        "read",
        json!({"accountId": ACCOUNT, "id": id(1), "full": true}),
    )
    .await
    .unwrap();
    assert_eq!(read["id"], id(1));
    assert_eq!(read["payload"]["parts"][1]["filename"], "a.bin");
    let attachment_id = read["payload"]["parts"][1]["body"]["attachmentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let data = rpc(
        "attachment",
        json!({"accountId": ACCOUNT, "messageId": id(1), "attachmentId": attachment_id}),
    )
    .await
    .unwrap();
    assert_eq!(
        URL_SAFE_NO_PAD
            .decode(data["data"].as_str().unwrap())
            .unwrap(),
        [0, 1, 2]
    );
    assert_eq!(
        rpc(
            "attachment",
            json!({"accountId": ACCOUNT, "messageId": id(1), "attachmentId": "part:7"})
        )
        .await
        .err(),
        Some("exchange_attachment_not_found")
    );
    // The whole session was one signed-in stream.
    assert_eq!(
        w.fake
            .log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

fn change_count(soap: &Soap) -> usize {
    soap.body
        .matches("<t:ItemChange>")
        .count()
        .max(soap.body.matches("<t:ItemId Id=").count())
}

#[tokio::test]
async fn labels_become_server_steps_and_the_answer_names_every_id_once() {
    if isolated() {
        return;
    }
    let moves = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log = moves.clone();
    let w = world(Offer::Basic, Some(PASSWORD), move |soap| {
        if soap.op == "MoveItem" {
            log.lock().unwrap().push(soap.body.clone());
        }
        match soap.op.as_str() {
            "GetItem" => Out::Xml(fake::items(
                &soap
                    .body
                    .split("<t:ItemId Id=\"")
                    .skip(1)
                    .map(|_| 1)
                    .collect::<Vec<u8>>(),
            )),
            "UpdateItem" => Out::Xml(fake::done("UpdateItem", change_count(soap))),
            "MoveItem" if soap.body.contains(&ews_id(2)) => Out::Xml(response(
                "MoveItem",
                &[
                    ok("MoveItem", ""),
                    fake::message("MoveItem", "Error", "ErrorItemNotFound", ""),
                ],
            )),
            "MoveItem" => Out::Xml(fake::done("MoveItem", change_count(soap))),
            _ => Out::Drop,
        }
    })
    .await;
    let ops = || {
        w.fake
            .log
            .ops()
            .into_iter()
            .filter(|op| op != "GetFolder")
            .collect::<Vec<_>>()
    };
    let answer = |value: Value| {
        (
            value["succeededIds"].clone(),
            value["failedIds"].clone(),
            value["error"].clone(),
        )
    };
    // Repeats are one request item; the answer still names each id once, in the order asked.
    let both = rpc(
        "modify",
        json!({"accountId": ACCOUNT, "ids": [id(1), id(3), id(1)], "removeLabelIds": ["UNREAD"]}),
    )
    .await
    .unwrap();
    assert_eq!(
        answer(both),
        (json!([id(1), id(3)]), json!([]), Value::Null)
    );
    assert_eq!(ops(), ["GetItem", "UpdateItem"]);
    // Read state first, then the flag, then a move (a move changes the id).
    rpc("modify", json!({"accountId": ACCOUNT, "ids": [id(1)], "addLabelIds": ["STARRED", "INBOX"], "removeLabelIds": ["UNREAD"]})).await.unwrap();
    assert_eq!(
        &ops()[2..],
        ["GetItem", "UpdateItem", "GetItem", "UpdateItem", "MoveItem"]
    );
    // Trash and untrash are moves to Deleted Items and the Inbox.
    for (method, folder) in [("trash", "deleteditems"), ("untrash", "inbox")] {
        rpc(method, json!({"accountId": ACCOUNT, "ids": [id(1)]}))
            .await
            .unwrap();
        let sent = moves.lock().unwrap().last().unwrap().clone();
        assert!(
            sent.contains(&format!(
                "<m:ToFolderId><t:DistinguishedFolderId Id=\"{folder}\"/>"
            )),
            "{method}"
        );
    }
    // A label with no meaning here (removing INBOX would be archiving) fails every id and sends nothing.
    let before = w.fake.log.ops().len();
    for labels in [
        json!({"removeLabelIds": ["INBOX"]}),
        json!({"addLabelIds": ["Newsletters"]}),
        json!({"addLabelIds": ["STARRED", "Foo"]}),
    ] {
        let mut params = json!({"accountId": ACCOUNT, "ids": [id(1), id(2)]});
        params
            .as_object_mut()
            .unwrap()
            .extend(labels.as_object().unwrap().clone());
        assert_eq!(
            answer(rpc("modify", params).await.unwrap()),
            (json!([]), json!([id(1), id(2)]), json!("invalid_params"))
        );
    }
    assert_eq!(w.fake.log.ops().len(), before);
    // One id the server no longer has fails alone, with the server's reason.
    let moved = rpc(
        "trash",
        json!({"accountId": ACCOUNT, "ids": [id(1), id(2)]}),
    )
    .await
    .unwrap();
    assert_eq!(
        answer(moved),
        (
            json!([id(1)]),
            json!([id(2)]),
            json!("exchange_message_not_found")
        )
    );
}

#[tokio::test]
async fn a_batch_goes_on_past_a_chunk_whose_messages_are_all_gone() {
    if isolated() {
        return;
    }
    let w = world(Offer::Basic, Some(PASSWORD), |soap| {
        // The first chunk of a hundred is gone from the server; the second is there.
        let count = change_count(soap);
        let code = if count == 100 {
            "ErrorItemNotFound"
        } else {
            "NoError"
        };
        let class = if count == 100 { "Error" } else { "Success" };
        Out::Xml(response(
            "MoveItem",
            &vec![fake::message("MoveItem", class, code, ""); count],
        ))
    })
    .await;
    let ids: Vec<String> = (0..=100).map(id).collect();
    let moved = rpc("trash", json!({"accountId": ACCOUNT, "ids": ids}))
        .await
        .unwrap();
    assert_eq!(moved["succeededIds"], json!([id(100)]));
    assert_eq!(moved["failedIds"].as_array().unwrap().len(), 100);
    assert_eq!(w.fake.log.count("MoveItem"), 2);
}

#[tokio::test]
async fn messages_too_large_to_read_together_are_read_one_at_a_time() {
    if isolated() {
        return;
    }
    // Two messages of 14 MiB are 37 MiB of base64 together, past the 36 MiB a response may be.
    let big = ("x".repeat(998) + "\r\n").repeat(14 * 1024);
    let message = format!("Subject: big\r\n\r\n{big}").into_bytes();
    let w = world(Offer::Basic, Some(PASSWORD), move |soap| {
        let asked: Vec<String> = [1, 2]
            .iter()
            .filter(|seed| soap.body.contains(&ews_id(**seed)))
            .map(|seed| fake::item_message(*seed, Some(&message)))
            .collect();
        Out::Xml(response("GetItem", &asked))
    })
    .await;
    let read = rpc(
        "messages",
        json!({"accountId": ACCOUNT, "ids": [id(1), id(2)], "full": true}),
    )
    .await
    .unwrap();
    let got: Vec<&Value> = read["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| &message["id"])
        .collect();
    assert_eq!(got, [&json!(id(1)), &json!(id(2))]);
    assert_eq!(read["warning"], Value::Null);
    assert_eq!(w.fake.log.count("GetItem"), 3);
}

#[tokio::test]
async fn an_invalidate_drops_the_client_and_its_password_once_the_mailbox_is_free() {
    if isolated() {
        return;
    }
    let w = world(Offer::Basic, Some(PASSWORD), |_| {
        Out::Xml(fake::find(&[], true, 0))
    })
    .await;
    let list = || {
        rpc(
            "list",
            json!({"accountId": ACCOUNT, "query": "role:inbox", "limit": 5, "pageToken": ""}),
        )
    };
    let invalidate = || rpc("invalidate", json!({"accountId": ACCOUNT}));
    list().await.unwrap();
    assert!(super::account::kept(ACCOUNT));
    // Not in use: gone at once.
    assert_eq!(invalidate().await.unwrap(), json!({"invalidated": true}));
    assert!(!super::account::kept(ACCOUNT));
    // In use: gone when the operation holding it ends, not at the next request.
    list().await.unwrap();
    let held = super::account::lease(ACCOUNT, later()).await.unwrap();
    invalidate().await.unwrap();
    drop(held);
    assert!(!super::account::kept(ACCOUNT));
    list().await.unwrap();
    assert_eq!(
        w.fake
            .log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst),
        3
    );
}

/// A request that read the password and then waited for the mailbox while it was signed out must
/// neither sign in with that password nor leave a client made from it behind.
#[tokio::test]
async fn a_request_that_waited_through_a_sign_out_uses_nothing_it_read_before() {
    if isolated() {
        return;
    }
    let w = world(Offer::Basic, Some(PASSWORD), |_| {
        Out::Xml(fake::find(&[], true, 0))
    })
    .await;
    let list = || {
        rpc(
            "list",
            json!({"accountId": ACCOUNT, "query": "role:inbox", "limit": 5, "pageToken": ""}),
        )
    };
    let connections = || {
        w.fake
            .log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst)
    };
    list().await.unwrap();
    assert_eq!(connections(), 1);
    // Another operation holds the mailbox; a request reads the password and waits for its turn.
    let held = super::account::lease(ACCOUNT, later()).await.unwrap();
    let (waited, ()) = tokio::join!(list(), async {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        rpc("invalidate", json!({"accountId": ACCOUNT}))
            .await
            .unwrap();
        drop(held);
    });
    assert_eq!(waited.err(), Some("auth_signed_out"));
    assert!(!super::account::kept(ACCOUNT), "a client was left behind");
    assert_eq!(
        connections(),
        1,
        "the password read before the sign-out was sent"
    );
}

/// A deadline far enough away not to matter.
fn later() -> tokio::time::Instant {
    tokio::time::Instant::now() + std::time::Duration::from_secs(3600)
}

/// Runs this process's deadlines twenty times faster: a call has 1.25 seconds, a request one, and a
/// write must begin within the first quarter second.
fn hurry() -> std::time::Duration {
    super::ews::tests::HURRY.store(20, std::sync::atomic::Ordering::Relaxed);
    super::ews::clock(super::account::TOTAL)
}

/// The deadline tests' calls: every `exchange.*` method that reaches the server. A call that leaves
/// the stream signed in comes before each write, so a write is not left too little time to begin
/// by a sign-in the call before it needed.
fn every_method() -> Vec<(&'static str, Value)> {
    let raw = URL_SAFE_NO_PAD.encode("To: a@example.org\r\n\r\nx");
    let check = ("verify", json!({"accountId": ACCOUNT}));
    vec![
        (
            "list",
            json!({"accountId": ACCOUNT, "query": "role:inbox", "limit": 5, "pageToken": ""}),
        ),
        (
            "messages",
            json!({"accountId": ACCOUNT, "ids": [id(1)], "full": false}),
        ),
        (
            "read",
            json!({"accountId": ACCOUNT, "id": id(1), "full": true}),
        ),
        (
            "attachment",
            json!({"accountId": ACCOUNT, "messageId": id(1), "attachmentId": "part:1"}),
        ),
        check.clone(),
        (
            "modify",
            json!({"accountId": ACCOUNT, "ids": [id(1)], "removeLabelIds": ["UNREAD"]}),
        ),
        check.clone(),
        ("trash", json!({"accountId": ACCOUNT, "ids": [id(1)]})),
        check.clone(),
        ("untrash", json!({"accountId": ACCOUNT, "ids": [id(1)]})),
        check.clone(),
        ("send", json!({"accountId": ACCOUNT, "raw": raw})),
        check.clone(),
        (
            "saveDraft",
            json!({"accountId": ACCOUNT, "raw": raw, "draftId": id(2)}),
        ),
        ("deleteDraft", json!({"accountId": ACCOUNT, "id": id(1)})),
        (
            "calendarEvents",
            json!({"accountId": ACCOUNT, "startMs": 0, "endMs": 86_400_000}),
        ),
        check.clone(),
        (
            "calendarCreate",
            json!({"accountId": ACCOUNT, "title": "x", "allDay": false, "startMs": 0, "endMs": 60_000}),
        ),
        (
            "calendarUpdate",
            json!({"accountId": ACCOUNT, "id": id(1), "changeKey": "K", "title": "x"}),
        ),
        (
            "calendarDelete",
            json!({"accountId": ACCOUNT, "id": id(1), "changeKey": "K"}),
        ),
    ]
}

/// `method`'s answer and how long it took, which must be less than the window's 30 seconds.
async fn timed(method: &str, params: Value) -> (Result<Value, &'static str>, std::time::Duration) {
    let started = std::time::Instant::now();
    let window = super::ews::clock(std::time::Duration::from_secs(30));
    let answer = tokio::time::timeout(window, rpc(method, params))
        .await
        .unwrap_or_else(|_| panic!("{method} outlived the window's deadline"));
    (answer, started.elapsed())
}

/// The code a call failed with: its error, or the one a change gave for its only id.
fn failed(answer: &Result<Value, &'static str>) -> Option<&'static str> {
    match answer {
        Err(code) => Some(code),
        Ok(value) if value["failedIds"] == json!([id(1)]) => match value["error"].as_str() {
            Some("exchange_timeout") => Some("exchange_timeout"),
            _ => Some("exchange_invalid_response"),
        },
        Ok(_) => None,
    }
}

/// A little time for the scheduler, well under the five seconds the window has left after a call's
/// own 25.
const SLACK: std::time::Duration = std::time::Duration::from_millis(150);

#[tokio::test]
async fn every_method_answers_inside_the_window_when_the_server_stops_answering() {
    if isolated() {
        return;
    }
    let total = hurry();
    // Signed in, then nothing is ever answered again.
    let w = world(Offer::Basic, Some(PASSWORD), |_| Out::Hang).await;
    for (method, params) in every_method() {
        let (answer, took) = timed(method, params).await;
        assert!(took <= total + SLACK, "{method} took {took:?}");
        let expected = match method {
            // Written, and never cut once written: what became of them is not known.
            "send" => Some("exchange_send_failed"),
            "saveDraft" => Some("exchange_draft_unconfirmed"),
            "calendarCreate" => Some("exchange_calendar_unconfirmed"),
            // The folder lookup is all a check of a signed-in mailbox asks.
            "verify" => None,
            _ => Some("exchange_timeout"),
        };
        assert_eq!(failed(&answer), expected, "{method}");
    }
    for op in ["MoveItem", "CreateItem"] {
        assert!(w.fake.log.count(op) > 0, "{op} was written");
    }
    // A sign-in whose server never answers.
    let silent = Fake::start(Offer::Basic, |_| Out::Hang).await;
    let (signing_in, took) = timed(
        "verify",
        json!({"address": "ada@example.org", "settings": {"ewsUrl": silent.url(), "username": LOGIN}, "secret": PASSWORD}),
    )
    .await;
    assert_eq!(signing_in.err(), Some("exchange_timeout"));
    assert!(took <= total + SLACK, "{took:?}");
}

#[tokio::test]
async fn a_mailbox_another_call_holds_makes_no_call_wait_past_its_deadline() {
    if isolated() {
        return;
    }
    let total = hurry();
    let w = world(Offer::Basic, Some(PASSWORD), |soap| {
        Out::Xml(fake::done(&soap.op, 1))
    })
    .await;
    let held = super::account::lease(ACCOUNT, later()).await.unwrap();
    // All at once: each waits for the mailbox on its own deadline.
    let calls = every_method()
        .into_iter()
        .map(|(method, params)| async move { (method, timed(method, params).await) });
    let started = std::time::Instant::now();
    let (answers, check) = tokio::join!(
        futures_util::future::join_all(calls),
        tokio::time::timeout(total + SLACK, super::check(ACCOUNT))
    );
    assert_eq!(
        check.expect("the check answers").err(),
        Some("exchange_timeout")
    );
    assert!(started.elapsed() <= total + SLACK);
    for (method, (answer, took)) in answers {
        if method == "send" {
            // Asked for directly, a send has a fifth of the call to begin in, so that its request
            // (20 seconds of 25) still ends inside the call.
            assert_eq!(answer.err(), Some("exchange_send_not_attempted"));
            assert!(took <= total / 5 + SLACK, "{took:?}");
        } else if [
            "modify",
            "trash",
            "untrash",
            "saveDraft",
            "deleteDraft",
            "calendarCreate",
            "calendarUpdate",
            "calendarDelete",
        ]
        .contains(&method)
        {
            // A change could write nothing after the same fifth, so it waits no longer.
            assert_eq!(answer.err(), Some("exchange_timeout"), "{method}");
            assert!(took <= total / 5 + SLACK, "{method} took {took:?}");
        } else {
            // Nothing was written: a bare error, never ids reported as tried.
            assert_eq!(answer.err(), Some("exchange_timeout"), "{method}");
            assert!(took <= total + SLACK, "{method} took {took:?}");
        }
    }
    // Nothing that gave up waiting goes on to reach the server once the mailbox is free.
    drop(held);
    tokio::time::sleep(total * 2).await;
    assert_eq!(
        w.fake
            .log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

/// The sign-in carries the credentials, and a cut one could be counted as a failed logon that the
/// latch never hears of. A call left less than a whole request's time sends no credentials at all;
/// one with the time signs in on a slow server and is not cut.
#[tokio::test]
async fn a_call_left_too_little_time_to_sign_in_sends_no_credentials() {
    if isolated() {
        return;
    }
    let total = hurry();
    // The server takes three fifths of a call to answer the sign-in.
    let slow = u64::try_from((total * 3 / 5).as_millis()).unwrap();
    let fake = Fake::start(Offer::Basic, move |soap| {
        if soap.op == "GetFolder" {
            Out::Later(slow, fake::folders())
        } else {
            Out::Xml(fake::find(&[], true, 0))
        }
    })
    .await;
    let w = world_on(fake, Some(PASSWORD));
    let list = json!({"accountId": ACCOUNT, "query": "role:inbox", "limit": 5, "pageToken": ""});
    let credentials = || {
        w.fake
            .log
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, scheme, _)| scheme.eq_ignore_ascii_case("basic"))
            .count()
    };
    // The mailbox is busy for two fifths of the call: a sign-in after that would end past it.
    let held = super::account::lease(ACCOUNT, later()).await.unwrap();
    let ((late, took), ()) = tokio::join!(timed("list", list.clone()), async {
        tokio::time::sleep(total * 2 / 5).await;
        drop(held);
    });
    assert_eq!(late.err(), Some("exchange_timeout"));
    assert!(took <= total + SLACK, "{took:?}");
    assert_eq!(
        credentials(),
        0,
        "a sign-in was begun without the time to finish"
    );
    assert_eq!(
        w.fake
            .log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    // The whole call ahead: the slow sign-in runs to its end and the listing follows it.
    let (answer, took) = timed("list", list).await;
    assert!(answer.is_ok(), "{answer:?}");
    assert!(took <= total + SLACK, "{took:?}");
    assert_eq!(credentials(), 2);
}

#[tokio::test]
async fn a_change_does_not_wait_out_a_back_off_that_ends_past_its_deadline() {
    if isolated() {
        return;
    }
    let total = hurry();
    // The server asks for five seconds before the change keys are read again.
    let w = world(Offer::Basic, Some(PASSWORD), |_| {
        Out::Status(503, vec![("Retry-After", "5".into())])
    })
    .await;
    let (answer, took) = timed(
        "modify",
        json!({"accountId": ACCOUNT, "ids": [id(1)], "addLabelIds": ["STARRED"]}),
    )
    .await;
    assert_eq!(answer.unwrap()["failedIds"], json!([id(1)]));
    assert!(took <= total + SLACK, "{took:?}");
    assert_eq!(w.fake.log.count("GetItem"), 1);
}

#[tokio::test]
async fn the_outbox_waits_longer_for_its_turn_than_a_send_from_the_window() {
    if isolated() {
        return;
    }
    let total = hurry();
    let w = world(Offer::Basic, Some(PASSWORD), |_| {
        Out::Xml(fake::done("CreateItem", 1))
    })
    .await;
    let raw = URL_SAFE_NO_PAD.encode("To: a@example.org\r\n\r\nx");
    // The mailbox is busy for twice the five seconds a send from the window may wait.
    let held = super::account::lease(ACCOUNT, later()).await.unwrap();
    let busy = tokio::spawn(async move {
        tokio::time::sleep(total * 2 / 5).await;
        drop(held);
    });
    let job = json!({"accountId": ACCOUNT, "provider": "exchange", "payload": {"raw": raw}});
    let (gmail, jmap) = (Default::default(), Default::default());
    let (direct, queued) = tokio::join!(
        rpc("send", json!({"accountId": ACCOUNT, "raw": raw})),
        crate::outbox::delivery::send(&job, &gmail, &jmap)
    );
    busy.await.unwrap();
    assert_eq!(direct.err(), Some("exchange_send_not_attempted"));
    assert_eq!(queued.unwrap()["sent"], true);
    assert_eq!(w.fake.log.count("CreateItem"), 1);
}

#[tokio::test]
async fn a_read_past_its_deadline_gives_the_mailbox_back_at_once() {
    if isolated() {
        return;
    }
    let total = hurry();
    // Two messages too large to read together; read one at a time, neither ever answers.
    let big = ("x".repeat(998) + "\r\n").repeat(14 * 1024);
    let message = format!("Subject: big\r\n\r\n{big}").into_bytes();
    let _w = world(Offer::Basic, Some(PASSWORD), move |soap| {
        let asked: Vec<String> = [1, 2]
            .iter()
            .filter(|seed| soap.body.contains(&ews_id(**seed)))
            .map(|seed| fake::item_message(*seed, Some(&message)))
            .collect();
        if asked.len() < 2 {
            return Out::Hang;
        }
        Out::Xml(response("GetItem", &asked))
    })
    .await;
    let (answer, took) = timed(
        "messages",
        json!({"accountId": ACCOUNT, "ids": [id(1), id(2)], "full": true}),
    )
    .await;
    assert_eq!(answer.err(), Some("exchange_timeout"));
    assert!(took <= total + SLACK, "{took:?}");
    // The reads it still owed were given up with it.
    let free = tokio::time::timeout(SLACK, super::account::lease(ACCOUNT, later())).await;
    assert!(free.is_ok(), "the read still holds the mailbox");
}

#[tokio::test]
async fn a_batch_out_of_time_reports_what_it_applied_and_stops_between_requests() {
    if isolated() {
        return;
    }
    let total = hurry();
    // Each request to change a hundred messages takes a tenth of a second: a write may begin only
    // within the first quarter, so three or fewer of the four begin.
    let w = world(Offer::Basic, Some(PASSWORD), |soap| {
        match soap.op.as_str() {
            "GetItem" => Out::Xml(fake::items(&vec![1; change_count(soap)])),
            _ => Out::Later(100, fake::done("UpdateItem", change_count(soap))),
        }
    })
    .await;
    let ids: Vec<String> = (0..350u16)
        .map(|n| {
            let mut bytes = [7u8; 40];
            bytes[..2].copy_from_slice(&n.to_be_bytes());
            ids::encode(&STANDARD.encode(bytes)).unwrap()
        })
        .collect();
    let (answer, took) = timed(
        "modify",
        json!({"accountId": ACCOUNT, "ids": ids, "removeLabelIds": ["UNREAD"]}),
    )
    .await;
    assert!(took <= total + SLACK, "{took:?}");
    let answer = answer.unwrap();
    // What was applied is reported applied, so the list keeps those rows as changed; the chunks
    // never written are the rows it puts back.
    let applied = w.fake.log.count("UpdateItem") * 100;
    assert!((100..=300).contains(&applied), "{applied}");
    assert_eq!(answer["succeededIds"], json!(ids[..applied]));
    assert_eq!(answer["failedIds"], json!(ids[applied..]));
    assert_eq!(answer["error"], "exchange_timeout");
}

#[tokio::test]
async fn a_draft_is_saved_on_the_server_and_replaces_the_one_it_was_opened_from() {
    if isolated() {
        return;
    }
    // Seed 1 is a draft, seed 2 an Inbox message, and the server will not delete seed 3.
    let w = world(Offer::Basic, Some(PASSWORD), |soap| {
        match soap.op.as_str() {
            "CreateItem" => Out::Xml(fake::done("CreateItem", 1)),
            "DeleteItem" if soap.body.contains(&ews_id(3)) => Out::Xml(response(
                "DeleteItem",
                &[fake::message(
                    "DeleteItem",
                    "Error",
                    "ErrorAccessDenied",
                    "",
                )],
            )),
            "DeleteItem" => Out::Xml(fake::done("DeleteItem", 1)),
            _ => {
                let folder = if soap.body.contains(&ews_id(2)) {
                    "inbox"
                } else {
                    "drafts"
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
    let ops = || -> Vec<String> {
        w.fake
            .log
            .ops()
            .into_iter()
            .filter(|op| op != "GetFolder")
            .collect()
    };
    let raw = URL_SAFE_NO_PAD.encode("To: a@example.org\r\nBcc: b@example.org\r\n\r\ndraft");
    let save = |draft: String| {
        rpc(
            "saveDraft",
            json!({"accountId": ACCOUNT, "raw": raw, "draftId": draft}),
        )
    };
    assert_eq!(
        save(String::new()).await.unwrap(),
        json!({"saved": true, "warning": ""})
    );
    assert_eq!(ops(), ["CreateItem"]);
    // The new draft first, then the one it replaces.
    assert_eq!(
        save(id(1)).await.unwrap(),
        json!({"saved": true, "warning": ""})
    );
    assert_eq!(&ops()[1..], ["CreateItem", "GetItem", "DeleteItem"]);
    // An old copy that is no draft, or that the server keeps, leaves the save a save.
    for old in [id(2), id(3)] {
        let saved = save(old).await.unwrap();
        assert_eq!(saved["saved"], true);
        assert_eq!(
            saved["warning"],
            "The updated draft was saved, but the old copy could not be removed"
        );
    }
    assert_eq!(
        w.fake.log.count("DeleteItem"),
        2,
        "never for the Inbox message"
    );
    // Deleting asks where the item is first; only a draft goes.
    assert_eq!(
        rpc("deleteDraft", json!({"accountId": ACCOUNT, "id": id(1)}))
            .await
            .unwrap(),
        json!({})
    );
    assert_eq!(
        rpc("deleteDraft", json!({"accountId": ACCOUNT, "id": id(2)}))
            .await
            .err(),
        Some("exchange_message_not_found")
    );
    assert_eq!(w.fake.log.count("DeleteItem"), 3);
    // A message sent from a draft takes the draft with it, through the outbox.
    let sent = crate::outbox::delivery::send(
        &json!({"accountId": ACCOUNT, "provider": "exchange", "payload": {"raw": raw, "draftId": id(1)}}),
        &Default::default(),
        &Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(sent["draftRemoved"], true);
    assert_eq!(w.fake.log.count("DeleteItem"), 4);
}

#[tokio::test]
async fn a_message_is_sent_as_written_bcc_included_and_failures_keep_their_meaning() {
    if isolated() {
        return;
    }
    let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log = bodies.clone();
    let w = world(Offer::Basic, Some(PASSWORD), move |soap| {
        log.lock().unwrap().push(soap.body.clone());
        if soap
            .body
            .contains(&STANDARD.encode("Subject: reject")[..12])
        {
            return Out::Xml(response(
                "CreateItem",
                &[fake::message(
                    "CreateItem",
                    "Error",
                    "ErrorInvalidRecipients",
                    "",
                )],
            ));
        }
        Out::Xml(fake::done("CreateItem", 1))
    })
    .await;
    let message = "To: a@example.org\r\nBcc: blind@example.org\r\nSubject: hi\r\n\r\nbody";
    let sent = rpc(
        "send",
        json!({"accountId": ACCOUNT, "raw": URL_SAFE_NO_PAD.encode(message)}),
    )
    .await
    .unwrap();
    assert_eq!(sent, json!({"sent": true, "warning": ""}));
    let create = bodies.lock().unwrap().last().unwrap().clone();
    let mime = create
        .split("<t:MimeContent CharacterSet=\"UTF-8\">")
        .nth(1)
        .unwrap()
        .split('<')
        .next()
        .unwrap();
    assert_eq!(
        STANDARD.decode(mime).unwrap(),
        message.as_bytes(),
        "the Bcc header goes out with the message"
    );
    let refused = rpc(
        "send",
        json!({"accountId": ACCOUNT, "raw": URL_SAFE_NO_PAD.encode("Subject: reject\r\n\r\nx")}),
    )
    .await;
    assert_eq!(refused.err(), Some("exchange_send_rejected"));
    assert_eq!(w.fake.log.count("CreateItem"), 2);
}

#[tokio::test]
async fn a_cancelled_read_ends_for_its_caller_and_leaves_the_signed_in_stream_alone() {
    if isolated() {
        return;
    }
    let w = world(Offer::Ntlm, Some(PASSWORD), |_| {
        Out::Later(300, fake::find(&[fake::item(1, "inbox", 5)], true, 1))
    })
    .await;
    let params = json!({"accountId": ACCOUNT, "query": "role:inbox", "limit": 25, "pageToken": "", "requestToken": "t1"});
    let list = tokio::spawn(rpc("list", params));
    for _ in 0..500 {
        if w.fake.log.count("FindItem") > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        rpc(
            "cancel",
            json!({"accountId": ACCOUNT, "requestToken": "t1"})
        )
        .await
        .unwrap()["cancelled"],
        true
    );
    assert_eq!(list.await.unwrap().err(), Some("exchange_cancelled"));
    // The next request waits for the read that was cancelled and reuses its stream: one NTLM sign-in.
    rpc(
        "list",
        json!({"accountId": ACCOUNT, "query": "role:inbox", "limit": 25, "pageToken": ""}),
    )
    .await
    .unwrap();
    assert_eq!(
        w.fake
            .log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(w.fake.log.count("FindItem"), 2);
}

#[tokio::test]
async fn a_missing_or_refused_password_opens_no_second_logon() {
    if isolated() {
        return;
    }
    // No credential: signed out before a socket is opened.
    let none = world(Offer::Ntlm, None, |_| Out::Drop).await;
    let list = || {
        rpc(
            "list",
            json!({"accountId": ACCOUNT, "query": "role:inbox", "limit": 5, "pageToken": ""}),
        )
    };
    assert_eq!(list().await.err(), Some("auth_signed_out"));
    assert_eq!(
        rpc("verify", json!({"accountId": ACCOUNT})).await.err(),
        Some("auth_signed_out")
    );
    // A mailbox nobody registered names no credential at all.
    assert_eq!(
        rpc(
            "verify",
            json!({"accountId": "exchange:absent@example.org"})
        )
        .await
        .err(),
        Some("auth_account_missing")
    );
    assert_eq!(
        none.fake
            .log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[tokio::test]
async fn a_password_the_server_refused_is_not_tried_again_until_something_changes() {
    if isolated() {
        return;
    }
    let w = world(Offer::Ntlm, Some("not the password"), |_| Out::Drop).await;
    let list = || {
        rpc(
            "list",
            json!({"accountId": ACCOUNT, "query": "role:inbox", "limit": 5, "pageToken": ""}),
        )
    };
    assert_eq!(list().await.err(), Some("exchange_unauthorized"));
    let seen = w.fake.log.requests.lock().unwrap().len();
    // Every kind of request, and `invalidate`, which drops the connection but not the refusal.
    rpc("invalidate", json!({"accountId": ACCOUNT}))
        .await
        .unwrap();
    assert_eq!(list().await.err(), Some("exchange_unauthorized"));
    assert_eq!(
        rpc("trash", json!({"accountId": ACCOUNT, "ids": [id(1)]}))
            .await
            .err(),
        Some("exchange_unauthorized")
    );
    assert_eq!(
        rpc(
            "send",
            json!({"accountId": ACCOUNT, "raw": URL_SAFE_NO_PAD.encode("x")})
        )
        .await
        .err(),
        Some("exchange_send_not_attempted")
    );
    assert_eq!(
        super::check(ACCOUNT).await.err(),
        Some("exchange_unauthorized")
    );
    assert_eq!(w.fake.log.requests.lock().unwrap().len(), seen);
}

#[tokio::test]
async fn the_background_check_reports_unread_mail_and_a_fingerprint_that_follows_it() {
    if isolated() {
        return;
    }
    let state = std::sync::Arc::new(std::sync::Mutex::new(1u8));
    let seed = state.clone();
    let _w = world(Offer::Basic, Some(PASSWORD), move |_| {
        let at = *seed.lock().unwrap();
        Out::Xml(fake::find(&[fake::item(at, "inbox", 5)], true, 1))
    })
    .await;
    let first = super::check(ACCOUNT).await.unwrap();
    assert_eq!(
        (
            first["estimate"].clone(),
            first["messages"].as_array().unwrap().len()
        ),
        (json!(7), 1)
    );
    assert_eq!(
        super::check(ACCOUNT).await.unwrap()["fingerprint"],
        first["fingerprint"]
    );
    *state.lock().unwrap() = 2;
    assert_ne!(
        super::check(ACCOUNT).await.unwrap()["fingerprint"],
        first["fingerprint"]
    );
}

#[test]
fn message_ids_are_one_canonical_spelling_that_fits_the_cache_file_name_limit() {
    for bytes in [8, 40, 150] {
        let ews = STANDARD.encode(vec![0xFFu8; bytes]);
        let id = ids::encode(&ews).unwrap();
        assert_eq!(ids::decode(&id).unwrap(), ews);
        assert!(
            id.bytes()
                .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
        );
    }
    // The cache spells each byte outside [a-z0-9.-] as `_xx` and refuses 255 bytes: 150 bytes fit.
    let longest = ids::encode(&STANDARD.encode(vec![0xFFu8; 150])).unwrap();
    assert!(
        crate::cache::validate_params(&json!({"accountId": ACCOUNT, "id": longest}), true).is_ok()
    );
    assert!(
        crate::cache::validate_params(
            &json!({"accountId": ACCOUNT, "id": STANDARD.encode(vec![0xFFu8; 150])}),
            true
        )
        .is_err()
    );
    // Only the canonical spelling of 8 to 150 bytes is an id, so no validator is looser than the codec.
    let id = ids::encode(&STANDARD.encode([7u8; 8])).unwrap();
    let last = id.len() - 1;
    let spellings = b"abcdefghijklmnopqrstuvwxyz234567"
        .iter()
        .filter(|c| ids::validate(&format!("{}{}", &id[..last], **c as char)).is_ok())
        .count();
    assert_eq!(
        spellings, 16,
        "the padding bit of the last character must be zero"
    );
    for bad in [
        String::new(),
        id.to_uppercase(),
        format!("{id}="),
        id[..id.len() - 1].to_owned(),
        ids::encode(&STANDARD.encode([7u8; 8]))
            .unwrap()
            .replace('a', "1"),
    ] {
        assert!(ids::validate(&bad).is_err() || bad == id, "{bad}");
    }
    for ews in [
        String::new(),
        "not base64!".into(),
        STANDARD.encode([1u8; 7]),
        STANDARD.encode([1u8; 151]),
    ] {
        assert_eq!(ids::encode(&ews), Err("exchange_invalid_response"), "{ews}");
    }
}

#[test]
fn queries_are_the_small_language_and_search_text_cannot_add_syntax() {
    for (text, canonical) in [
        ("role:inbox", "role:inbox"),
        ("role:inbox unseen", "role:inbox unseen"),
        (" role:trash flagged unseen ", "role:trash unseen flagged"),
        ("text: invoice  2026 ", "text:invoice  2026"),
    ] {
        let parsed = Query::parse(text).unwrap();
        assert_eq!(parsed.canonical(), canonical);
        assert_eq!(Query::parse(&parsed.canonical()).unwrap(), parsed);
    }
    for bad in [
        "",
        "inbox",
        "role:",
        "role:archive",
        "role:inbox unseen unseen",
        "role:inbox important",
        "text:",
        "text:\"",
        "text: ***",
        "text:a\nb",
        "role:inbox\r\n",
    ] {
        assert_eq!(Query::parse(bad), Err("invalid_params"), "{bad:?}");
    }
    // One quoted phrase: no field, connector, second phrase or wildcard can come out of user text.
    for (text, phrase) in [
        ("invoice", "\"invoice\"*"),
        ("a\" OR from:x", "\"a or from x\"*"),
        ("(secret) -foo +bar", "\"secret foo bar\"*"),
        ("ＮＯＴ ＡＮＤ", "\"not and\"*"),
        ("x* \"y\" z~", "\"x y z\"*"),
    ] {
        assert_eq!(super::query::phrase(text), phrase, "{text}");
    }
}
