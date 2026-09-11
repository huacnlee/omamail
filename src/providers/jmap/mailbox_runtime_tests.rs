use super::*;
use std::io::{BufRead, BufReader};
struct Peer(std::process::Child);
impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[tokio::test]
async fn native_mailbox_read_thread_actions_and_submission_preserve_workflow() {
    let mut peer = Peer(
        std::process::Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/providers/jmap/mailbox_tls_test.py"
            ))
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut output = BufReader::new(peer.0.stdout.take().unwrap());
    let mut port = String::new();
    output.read_line(&mut port).unwrap();
    let port: u16 = port.trim().parse().unwrap();
    let mut cert = String::new();
    output.read_line(&mut cert).unwrap();
    let client = client_builder()
        .add_root_certificate(
            reqwest::Certificate::from_pem(&std::fs::read(cert.trim()).unwrap()).unwrap(),
        )
        .build()
        .unwrap();
    let session = Session {
        client: Ok(client.clone()),
        ..Default::default()
    };
    let context = session.context("jmap:user@example.test").unwrap();
    let boxes = vec![
        json!({"id":"I","role":"inbox"}),
        json!({"id":"S","role":"sent"}),
        json!({"id":"T","role":"trash"}),
        json!({"id":"A","role":"archive"}),
        json!({"id":"D","role":"drafts"}),
    ];
    let document = json!({"apiUrl":format!("https://localhost:{port}/api"),"downloadUrl":format!("https://localhost:{port}/blob/{{blobId}}"),"uploadUrl":format!("https://localhost:{port}/upload"),"eventSourceUrl":format!("https://localhost:{port}/events"),"state":"s1","capabilities":{CORE:{"maxObjectsInGet":2,"maxObjectsInSet":2},MAIL:{},SUBMISSION:{}},"accounts":{"account":{"accountCapabilities":{MAIL:{"emailQuerySortOptions":["receivedAt"]},SUBMISSION:{}}}},"primaryAccounts":{MAIL:"account"}});
    *context.snapshot.lock().await = Some(Snapshot {
        document,
        roles: query::roles(&boxes),
        boxes,
        credential: json!({"scheme":"basic","username":"user","secret":"synthetic"}),
        address: "user@example.test".into(),
        account: "account".into(),
        slots: Arc::new(Semaphore::new(4)),
        uploads: Arc::new(Semaphore::new(2)),
    });
    let call = |method: &'static str, mut params: Value| {
        params["accountId"] = json!("jmap:user@example.test");
        let session = &session;
        async move { session.native(method, &params).await }
    };
    let page = call(
        "jmap.list",
        json!({"query":"role:inbox unseen","maxResults":25,"pageToken":"25|gone"}),
    )
    .await
    .unwrap();
    assert_eq!(page["data"]["ids"], json!(["e1"]));
    let messages = call("jmap.messages", json!({"ids":["e1"]})).await.unwrap();
    assert_eq!(
        messages["data"][0]["thread"]["memberIds"],
        json!(["e1", "e2"])
    );
    assert_eq!(messages["data"][0]["snippet"], "&lt;3 native");
    let read = call("jmap.read", json!({"id":"e1","full":true}))
        .await
        .unwrap();
    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(string(&read["data"]["payload"]["body"]["data"]))
        .unwrap();
    assert_eq!(body, b"complete body");
    call(
        "jmap.batchModify",
        json!({"ids":["e1","e2"],"addLabelIds":[],"removeLabelIds":["INBOX"]}),
    )
    .await
    .unwrap();
    for (subject, expect) in [
        ("importfail", Err("jmap_import_failed")),
        ("fail", Err("jmap_submission_failed")),
        ("success", Ok(())),
        ("uncertain", Err("jmap_submission_unconfirmed")),
    ] {
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(
            "From: user@example.test\r\nTo: a@example.test\r\nSubject: {subject}\r\n\r\nBody\r\n"
        ));
        let result = call("jmap.send", json!({"raw":raw,"draftId":"original"})).await;
        if subject == "success" {
            assert_eq!(result.as_ref().unwrap()["data"]["draftRemoved"], true);
        }
        assert_eq!(result.map(|_| ()), expect);
    }
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode("From: user@example.test\r\nTo: a@example.test\r\nSubject: draft\r\n\r\nBody");
    let saved = call("jmap.saveDraft", json!({"raw":raw,"draftId":"old-fail"}))
        .await
        .unwrap();
    assert_eq!(saved["data"]["saved"], true);
    assert_eq!(saved["data"]["draftId"], "newdraft");
    assert!(!string(&saved["data"]["warning"]).is_empty());
    call("jmap.watch", json!({"streamId":"native-watch"}))
        .await
        .unwrap();
    let mut changed = false;
    for _ in 0..3 {
        let events = session
            .call("jmap.stream.poll", &json!({"streamId":"native-watch"}))
            .await
            .unwrap();
        for event in events["events"].as_array().unwrap() {
            if event["kind"] == "change" {
                assert_eq!(event["plan"], json!({"mail":true,"mailboxes":true}));
                changed = true;
            }
        }
        if changed {
            break;
        }
    }
    assert!(
        changed,
        "native SSE must deliver account-scoped invalidations"
    );
    session
        .call("jmap.stream.close", &json!({"streamId":"native-watch"}))
        .await
        .unwrap();
    context.snapshot.lock().await.as_mut().unwrap().document["apiUrl"] =
        json!(format!("https://localhost:{port}/refused"));
    for id in ["not-cached-1", "not-cached-2"] {
        assert_eq!(
            call("jmap.messages", json!({"ids":[id]})).await,
            Err("jmap_unauthorized")
        );
    }
    let retired_snapshot = context.snapshot.lock().await.clone().unwrap();
    call("jmap.invalidate", json!({})).await.unwrap();
    assert_eq!(
        session
            .api(
                &context,
                &retired_snapshot,
                json!([["Mailbox/get",{"accountId":"account","ids":null},"0"]]),
                false
            )
            .await,
        Err("jmap_cancelled")
    );
    let report: Value = serde_json::from_slice(
        &client
            .get(format!("https://localhost:{port}/report"))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        report
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["path"] == "/refused")
            .count(),
        1,
        "revoked credentials must never be retried"
    );
    let calls: Vec<_> = report
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|request| request["calls"].as_array().into_iter().flatten())
        .collect();
    let update = calls
        .iter()
        .find(|call| call[0] == "Email/set" && call[1]["update"].is_object())
        .unwrap();
    assert_eq!(
        update[1]["update"],
        json!({"e1":{"mailboxIds/A":true,"mailboxIds/I":null}})
    );
    let destroyed: Vec<_> = calls
        .iter()
        .filter(|call| call[0] == "Email/set")
        .flat_map(|call| call[1]["destroy"].as_array().into_iter().flatten().cloned())
        .collect();
    assert_eq!(
        destroyed,
        json!(["newdraft", "original", "old-fail"])
            .as_array()
            .unwrap()
            .clone()
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call[0] == "EmailSubmission/set")
            .count(),
        3
    );
    assert!(
        calls
            .iter()
            .any(|call| call[0] == "Email/get" && call[1]["ids"] == json!(["e1", "e2"]))
    );
    assert!(
        report
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["authorization"] == true)
    );
    assert!(peer.0.wait().unwrap().success());
}

#[test]
fn retained_caches_evict_by_bytes_and_skip_oversized_entries() {
    let mut cache = Cache::default();
    for n in 0..100 {
        cache.insert(n.to_string(), json!("x".repeat(100_000)));
        assert!(cache.bytes <= CACHE_BYTES);
    }
    assert!(cache.len() < 100);
    cache.insert("oversized".into(), json!("x".repeat(CACHE_BYTES)));
    assert!(cache.get("oversized").is_none());
    assert!(cache.bytes <= CACHE_BYTES);
    cache.clear();
    assert_eq!(cache.bytes, 0);
}
