//! Exercise the real dispatcher and native JMAP adapter against synthetic TLS.
use super::Session;
use crate::mail::tests::{account_fixture, fixture_tree, isolated};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::Arc,
};

const ACCOUNT: &str = "jmap:user@example.test";

struct Peer {
    child: Child,
    client: reqwest::Client,
    endpoint: String,
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Peer {
    async fn start(scenario: &str, learns_junk: bool) -> (Self, Session) {
        let mut child = Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/providers/jmap/mailbox_tls_test.py"
            ))
            .arg(scenario)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut port = String::new();
        output.read_line(&mut port).unwrap();
        let mut cert = String::new();
        output.read_line(&mut cert).unwrap();
        let cert = fs::read(cert.trim()).unwrap();
        let endpoint = format!("https://localhost:{}", port.trim().parse::<u16>().unwrap());
        let client = crate::test_net::localhost_loopback(reqwest::Client::builder())
            .no_proxy()
            .default_headers(reqwest::header::HeaderMap::from_iter([(
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_static("Basic c3ludGhldGlj"),
            )]))
            .add_root_certificate(reqwest::Certificate::from_pem(&cert).unwrap())
            .build()
            .unwrap();
        let jmap = Arc::new(crate::providers::jmap::Session::with_test_certificate(&cert).unwrap());
        let mut document = json!({
            "apiUrl":format!("{endpoint}/api"),
            "downloadUrl":format!("{endpoint}/blob/{{blobId}}"),
            "uploadUrl":format!("{endpoint}/upload"),
            "eventSourceUrl":format!("{endpoint}/events"),
            "state":"s1",
            "capabilities":{"urn:ietf:params:jmap:core":{"maxObjectsInGet":256},"urn:ietf:params:jmap:mail":{}},
            "accounts":{"account":{"accountCapabilities":{"urn:ietf:params:jmap:mail":{"emailQuerySortOptions":["receivedAt"]}}}},
            "primaryAccounts":{"urn:ietf:params:jmap:mail":"account"}
        });
        if learns_junk {
            document["capabilities"]["urn:stalwart:jmap"] = json!({});
        }
        if scenario == "action-unknown" {
            document["capabilities"]["urn:ietf:params:jmap:core"]["maxObjectsInSet"] = json!(1);
        }
        if scenario == "send-preview" {
            document["capabilities"]["urn:ietf:params:jmap:submission"] = json!({});
            document["accounts"]["account"]["accountCapabilities"]["urn:ietf:params:jmap:submission"] =
                json!({});
        }
        // Deliberately stale: production availability must read the live peer.
        let boxes = vec![
            json!({"id":"I","role":"inbox"}),
            json!({"id":"S","role":"sent"}),
            json!({"id":"T","role":"trash"}),
            json!({"id":"A","role":"archive"}),
            json!({"id":"J","role":"junk"}),
        ];
        jmap.install_snapshot_for_test(
            ACCOUNT,
            document,
            boxes,
            json!({"scheme":"basic","username":"user","secret":"synthetic"}),
            "user@example.test",
        )
        .await
        .unwrap();
        (
            Self {
                child,
                client,
                endpoint,
            },
            Session {
                jmap,
                ..Default::default()
            },
        )
    }

    async fn report(&self) -> Value {
        let bytes = self
            .client
            .get(format!("{}/report", self.endpoint))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
}

fn readonly_requests(report: &Value) -> bool {
    report.as_array().is_some_and(|requests| {
        requests.iter().all(|request| {
            request["method"] == "POST"
                && request["path"] == "/api"
                && request["authorization"] == true
                && request["calls"].as_array().is_some_and(|calls| {
                    !calls.is_empty()
                        && calls.iter().all(|call| {
                            matches!(
                                call[0].as_str(),
                                Some("Mailbox/get" | "Email/query" | "Email/get" | "Thread/get")
                            )
                        })
                })
        })
    })
}

#[tokio::test]
async fn production_jmap_executes_all_planned_ids_and_reports_individual_failures() {
    if isolated() {
        return;
    }
    let _fixture = account_fixture(json!({"version":1,"activeId":ACCOUNT,
        "accounts":[{"provider":"jmap","email":"user@example.test"}]}));
    for operation in [
        "read", "unread", "star", "unstar", "archive", "trash", "spam",
    ] {
        let (peer, session) = Peer::start("matrix", true).await;
        let params = json!({"operation":operation,"ids":["e1"]});
        let preview = session.dispatch("mail.act", &params).await.unwrap();
        let mut params = params;
        params["execute"] = json!(true);
        let result = session.dispatch("mail.act", &params).await.unwrap();
        assert_eq!(result["succeededIds"], preview["targetIds"], "{operation}");
        assert_eq!(result["failedIds"], json!([]));
        let report = peer.report().await;
        let writes: Vec<_> = report
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|r| r["calls"].as_array().unwrap())
            .filter(|c| c[0] == "Email/set")
            .collect();
        assert_eq!(writes.len(), 1, "{operation}");
        let mut actual: Vec<_> = writes[0][1]["update"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        actual.sort();
        let mut expected: Vec<_> = preview["targetIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        expected.sort();
        assert_eq!(actual, expected);
    }
    let (peer, session) = Peer::start("partial-action", true).await;
    let result = session
        .dispatch(
            "mail.act",
            &json!({"operation":"read","ids":["e1"],"execute":true}),
        )
        .await
        .unwrap();
    assert_eq!(result["targetIds"], json!(["e1", "e2"]));
    assert_eq!(result["succeededIds"], json!(["e1"]));
    assert_eq!(result["failedIds"], json!(["e2"]));
    let report = peer.report().await;
    assert_eq!(
        report
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|r| r["calls"].as_array().unwrap())
            .filter(|c| c[0] == "Email/set")
            .count(),
        1
    );
}

#[tokio::test]
async fn native_jmap_execution_preserves_exact_id_bytes_and_ignores_cached_memberships() {
    let (peer, session) = Peer::start("matrix", true).await;
    // Populate the desktop's cache with e2 in Sent. An already reviewed plan
    // remains authoritative if that cached membership would now exclude e2.
    session
        .jmap
        .call(
            "jmap.messages",
            &json!({"accountId":ACCOUNT,"ids":["e1","e2"]}),
        )
        .await
        .unwrap();
    let opaque = format!(" quote\"slash\\世界{} ", "x".repeat(1100));
    let result = session
        .jmap
        .execute_planned_action(
            "jmap.batchModify",
            &json!({"accountId":ACCOUNT,
        "ids":["e2",opaque],"addLabelIds":[],"removeLabelIds":["INBOX"]}),
            &json!({"archive":"A","inbox":"I"}),
        )
        .await
        .unwrap();
    assert_eq!(result["succeededIds"], json!(["e2", opaque]));
    assert_eq!(result["failedIds"], json!([]));
    let report = peer.report().await;
    let writes: Vec<_> = report
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|r| r["calls"].as_array().unwrap())
        .filter(|c| c[0] == "Email/set")
        .collect();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0][1]["update"],
        json!({"e2":{"mailboxIds/A":true,"mailboxIds/I":null},opaque:{"mailboxIds/A":true,"mailboxIds/I":null}})
    );
}

#[tokio::test]
async fn execution_uses_the_fresh_destination_reviewed_during_planning() {
    if isolated() {
        return;
    }
    let _fixture = account_fixture(json!({"version":1,"activeId":ACCOUNT,
        "accounts":[{"provider":"jmap","email":"user@example.test"}]}));
    let (peer, session) = Peer::start("roles", true).await;
    let result = session
        .dispatch(
            "mail.act",
            &json!({"operation":"archive","ids":["e1"],"execute":true}),
        )
        .await
        .unwrap();
    assert_eq!(result["succeededIds"], json!(["e1"]));
    let report = peer.report().await;
    let writes: Vec<_> = report
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|r| r["calls"].as_array().unwrap())
        .filter(|c| c[0] == "Email/set")
        .collect();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0][1]["update"],
        json!({"e1":{"mailboxIds/A":true,"mailboxIds/NEW":null}})
    );
}

#[tokio::test]
async fn jmap_unknown_delivery_stops_later_chunks_and_keeps_prior_acknowledgements() {
    let (peer, session) = Peer::start("action-unknown", true).await;
    let result = session
        .jmap
        .execute_planned_action(
            "jmap.batchModify",
            &json!({"accountId":ACCOUNT,
        "ids":["e1","e2","e3"],"addLabelIds":[],"removeLabelIds":["UNREAD"]}),
            &json!({}),
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"succeededIds":["e1"],"failedIds":["e2","e3"]})
    );
    let report = peer.report().await;
    let writes: Vec<_> = report
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|r| r["calls"].as_array().unwrap())
        .filter(|c| c[0] == "Email/set")
        .collect();
    assert_eq!(writes.len(), 2);
    assert_eq!(
        writes[0][1]["update"],
        json!({"e1":{"keywords/$seen":true}})
    );
    assert_eq!(
        writes[1][1]["update"],
        json!({"e2":{"keywords/$seen":true}})
    );
}

#[tokio::test]
async fn mail_action_cache_invalidation_requires_confirmed_success() {
    if isolated() {
        return;
    }
    let fixture = account_fixture(json!({"version":1,"activeId":ACCOUNT,
        "accounts":[{"provider":"jmap","email":"user@example.test"}]}));
    for scenario in ["action-failed", "matrix"] {
        crate::cache::call("cache.storePut",&json!({"accountId":ACCOUNT,"store":{"version":2,"account":"user@example.test",
            "queries":{"page":{"at":1,"summaries":[{"id":"e1"}],"nextPageToken":"","estimate":1}}}})).unwrap();
        crate::cache::call(
            "cache.resourcePut",
            &json!({"accountId":ACCOUNT,"id":"e1",
            "resource":{"id":"e1","payload":{"headers":[],"body":{"data":"YQ"}}}}),
        )
        .unwrap();
        let before = fixture_tree(&fixture.root);
        let (_peer, session) = Peer::start(scenario, true).await;
        let result = session
            .dispatch(
                "mail.act",
                &json!({"operation":"star","ids":["e1"],"execute":true}),
            )
            .await
            .unwrap();
        if scenario == "action-failed" {
            assert_eq!(result["failedIds"], json!(["e1"]));
            assert_eq!(fixture_tree(&fixture.root), before);
        } else {
            assert_eq!(result["succeededIds"], json!(["e1"]));
            assert_eq!(
                crate::cache::call(
                    "cache.resourceRead",
                    &json!({"accountId":ACCOUNT,"id":"e1"})
                )
                .unwrap(),
                Value::Null
            );
            assert_eq!(
                crate::cache::call("cache.storeRead", &json!({"accountId":ACCOUNT})).unwrap()["queries"],
                json!({})
            );
        }
    }
}

#[tokio::test]
async fn production_jmap_star_ignores_oversized_conversations_but_unstar_does_not() {
    if isolated() {
        return;
    }
    let fixture = account_fixture(json!({"version":1,"activeId":ACCOUNT,
        "accounts":[{"provider":"jmap","email":"user@example.test"}]}));
    let before = fixture_tree(&fixture.root);
    for operation in ["star", "unstar"] {
        let (peer, session) = Peer::start("oversized-thread", true).await;
        let result = session
            .dispatch("mail.act", &json!({"operation":operation,"ids":["e1"]}))
            .await;
        if operation == "star" {
            assert_eq!(
                result,
                Ok(json!({"dryRun":true,"executed":false,"operation":"star",
                "accountId":ACCOUNT,"requestedIds":["e1"],"targetIds":["e1"]}))
            );
        } else {
            assert_eq!(result, Err("mail_action_target_limit"));
        }
        let report = peer.report().await;
        assert!(readonly_requests(&report), "{report}");
        let methods: Vec<_> = report
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|request| request["calls"].as_array().unwrap())
            .map(|call| call[0].as_str().unwrap())
            .collect();
        assert_eq!(
            methods,
            if operation == "star" {
                vec!["Mailbox/get", "Email/get"]
            } else {
                vec!["Mailbox/get", "Email/get", "Thread/get"]
            }
        );
        assert_eq!(fixture_tree(&fixture.root), before);
    }
}

#[tokio::test]
async fn production_jmap_dispatch_previews_all_actions_without_local_writes() {
    if isolated() {
        return;
    }
    let fixture = account_fixture(json!({"version":1,"activeId":ACCOUNT,
        "accounts":[{"provider":"jmap","email":"user@example.test"}]}));
    // Existing account, outbox and compose bytes are protected alongside absent
    // cache, lock and upload destinations. Directory metadata detects creation.
    for directory in [&fixture.state, &fixture.home] {
        fs::create_dir_all(directory).unwrap();
        fs::write(directory.join("sentinel"), b"unchanged synthetic state").unwrap();
    }
    fs::create_dir_all(fixture.state.join("omamail")).unwrap();
    fs::write(fixture.state.join("omamail/outbox.json"), b"[]\n").unwrap();
    fs::write(
        fixture.config.join("omamail/compose.json"),
        b"{\"version\":1,\"active\":false}\n",
    )
    .unwrap();
    let before = fixture_tree(&fixture.root);
    let (peer, session) = Peer::start("matrix", true).await;
    for operation in [
        "read", "unread", "star", "unstar", "archive", "trash", "spam",
    ] {
        for execute in [None, Some(false)] {
            let mut params = json!({"operation":operation,"ids":["e1"]});
            if let Some(execute) = execute {
                params["execute"] = json!(execute);
            }
            let result = session.dispatch("mail.act", &params).await;
            {
                let targets = if matches!(operation, "archive" | "spam" | "star") {
                    json!(["e1"])
                } else {
                    json!(["e1", "e2"])
                };
                assert_eq!(
                    result.unwrap(),
                    json!({"dryRun":true,"executed":false,"operation":operation,
                    "accountId":ACCOUNT,"requestedIds":["e1"],"targetIds":targets})
                );
            }
            assert_eq!(
                fixture_tree(&fixture.root),
                before,
                "{operation} {execute:?}"
            );
        }
        for bad in ["bad\r", "bad\n", "bad\r\n", "bad\0", "bad\u{202e}"] {
            assert_eq!(
                session
                    .dispatch("mail.act", &json!({"operation":operation,"ids":["e1",bad]}))
                    .await,
                Err("invalid_params")
            );
            assert_eq!(fixture_tree(&fixture.root), before);
        }
    }
    let report = peer.report().await;
    assert!(readonly_requests(&report), "{report}");
    let calls: Vec<_> = report
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|request| request["calls"].as_array().unwrap())
        .collect();
    // Star reads only availability and representatives; the six conversation
    // actions also read threads and members.
    // Invalid batches must cause no extra provider request.
    assert_eq!(calls.len(), 6 * 2 * 4 + 2 * 2, "{report}");
    assert_eq!(fixture_tree(&fixture.root), before);
}

#[tokio::test]
async fn production_jmap_send_preview_only_reads_identity_and_preserves_storage() {
    if isolated() {
        return;
    }
    let fixture = account_fixture(json!({"version":1,"activeId":ACCOUNT,
        "accounts":[{"provider":"jmap","email":"user@example.test"}]}));
    let attachment = fixture.root.join("quote\\工\".txt");
    fs::write(&attachment, b"synthetic attachment").unwrap();
    fs::create_dir_all(fixture.state.join("omamail")).unwrap();
    fs::write(fixture.state.join("omamail/outbox.json"), b"[]\n").unwrap();
    let before = fixture_tree(&fixture.root);
    let (peer, session) = Peer::start("send-preview", true).await;
    let params = json!({"to":["工 <one@example.org>"],"subject":"Preview 工",
        "body":"line one\nline two\r\nمتن\tend",
        "attachments":[{"path":attachment,"name":"quote\\工\".txt","size":20}]});
    let result = session.dispatch("mail.send", &params).await.unwrap();
    assert_eq!(result["dryRun"], true);
    assert_eq!(result["executed"], false);
    assert_eq!(result["body"], params["body"]);
    assert_eq!(result["from"], "User <user@example.test>");
    assert_eq!(fixture_tree(&fixture.root), before);
    for bad in ["bad\r", "bad\n", "bad\r\n", "bad\0", "=?utf-8?b?YQ==?="] {
        let mut invalid = params.clone();
        invalid["subject"] = json!(bad);
        assert!(session.dispatch("mail.send", &invalid).await.is_err());
        assert_eq!(fixture_tree(&fixture.root), before);
    }
    let report = peer.report().await;
    assert_eq!(
        report.as_array().unwrap().len(),
        2,
        "one valid preview and one encoded-header rejection read identities; control characters are rejected before provider access"
    );
    assert!(
        report
            .as_array()
            .is_some_and(|requests| !requests.is_empty()
                && requests.iter().all(|request| request["method"] == "POST"
                    && request["path"] == "/api"
                    && request["authorization"] == true
                    && request["calls"].as_array().is_some_and(|calls| calls
                        == &vec![json!([
                            "Identity/get", {"accountId":"account","ids":null}, "0"
                        ])]))),
        "{report}"
    );
    assert_eq!(fixture_tree(&fixture.root), before);
}

#[tokio::test]
async fn production_jmap_capability_and_destination_refusals_stop_before_email_reads() {
    if isolated() {
        return;
    }
    let fixture = account_fixture(json!({"version":1,"activeId":ACCOUNT,
        "accounts":[{"provider":"jmap","email":"user@example.test"}]}));
    let before = fixture_tree(&fixture.root);
    for (scenario, learns, operation, error) in [
        ("no-archive", true, "archive", "mail_action_unavailable"),
        (
            "no-trash",
            true,
            "trash",
            "mail_action_destination_unavailable",
        ),
        ("matrix", false, "spam", "mail_action_unavailable"),
        ("default", true, "spam", "mail_action_unavailable"),
    ] {
        let (peer, session) = Peer::start(scenario, learns).await;
        assert_eq!(
            session
                .dispatch("mail.act", &json!({"operation":operation,"ids":["e1"]}))
                .await,
            Err(error)
        );
        let report = peer.report().await;
        assert!(readonly_requests(&report), "{report}");
        assert_eq!(report.as_array().unwrap().len(), 1);
        assert_eq!(report[0]["calls"][0][0], "Mailbox/get");
        assert_eq!(fixture_tree(&fixture.root), before);
    }
}

#[tokio::test]
async fn recorder_observes_unsupported_methods_malformed_posts_and_mutation_verbs() {
    let (peer, _session) = Peer::start("matrix", true).await;
    for method in [
        "GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "WAT",
    ] {
        peer.client
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
                format!("{}/forbidden", peer.endpoint),
            )
            .send()
            .await
            .unwrap();
    }
    peer.client
        .post(format!("{}/api", peer.endpoint))
        .body("{invalid")
        .send()
        .await
        .unwrap();
    peer.client
        .post(format!("{}/api", peer.endpoint))
        .body(json!({"methodCalls":[["Email/set",{"update":{}},"0"]]}).to_string())
        .send()
        .await
        .unwrap();
    peer.client
        .post(format!("{}/upload", peer.endpoint))
        .body("synthetic upload")
        .send()
        .await
        .unwrap();
    peer.client
        .post(format!("{}/api", peer.endpoint))
        .body(json!({"methodCalls":[["Mailbox/get",{},"0"]]}).to_string())
        .send()
        .await
        .unwrap();
    let report = peer.report().await;
    assert_eq!(report.as_array().unwrap().len(), 13, "{report}");
    for (index, method) in [
        "GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "WAT", "POST",
        "POST", "POST",
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(report[index]["method"], *method);
        assert!(
            !readonly_requests(&json!([report[index].clone()])),
            "recorder allowed {method}: {}",
            report[index]
        );
    }
    assert_eq!(report[9]["malformed"], true);
    assert_eq!(report[10]["calls"][0][0], "Email/set");
    assert_eq!(report[11]["path"], "/upload");
    assert!(readonly_requests(&json!([report[12].clone()])));
}

#[tokio::test]
async fn native_action_rows_bound_aggregate_members_and_projection_before_retention() {
    for (scenario, ids, error, expected_gets) in [
        (
            "occurrences",
            json!(["e1", "e2"]),
            "mail_action_target_limit",
            1,
        ),
        (
            "member-bytes",
            json!(["e1", "e2"]),
            "jmap_response_too_large",
            1,
        ),
        (
            "projection-bytes",
            json!(["e1", "e2"]),
            "jmap_response_too_large",
            3,
        ),
        (
            "projection-count",
            json!(["e1", "e2", "e4"]),
            "mail_action_target_limit",
            4,
        ),
    ] {
        let (peer, session) = Peer::start(scenario, true).await;
        assert_eq!(
            session
                .jmap
                .planned_action_rows(
                    ACCOUNT,
                    &ids.as_array()
                        .unwrap()
                        .iter()
                        .map(|id| id.as_str().unwrap().to_owned())
                        .collect::<Vec<_>>(),
                    &json!({"inbox":"I","sent":"S","trash":"T","junk":"J"}),
                    "read",
                )
                .await,
            Err(error),
            "{scenario}"
        );
        let report = peer.report().await;
        assert!(readonly_requests(&report), "{report}");
        let calls: Vec<_> = report
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|request| request["calls"].as_array().unwrap())
            .collect();
        assert_eq!(
            calls.iter().filter(|call| call[0] == "Email/get").count(),
            expected_gets,
            "{scenario}"
        );
    }
    let (peer, session) = Peer::start("projection-at-limit", true).await;
    let rows = session
        .jmap
        .planned_action_rows(ACCOUNT, &["e1".into(), "e2".into()], &json!({}), "read")
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0]["thread"]["memberIds"].as_array().unwrap().len(),
        1000
    );
    assert_eq!(rows[0]["thread"], rows[1]["thread"]);
    assert!(readonly_requests(&peer.report().await));
}

#[tokio::test]
async fn native_action_rows_reject_malformed_missing_and_unsolicited_responses() {
    for (scenario, error) in [
        ("unsolicited-email", "mail_action_invalid_target"),
        ("duplicate-email", "mail_action_invalid_target"),
        ("missing-email", "mail_action_target_unknown"),
        ("bad-email", "mail_action_invalid_target"),
        ("unsolicited-thread", "mail_action_invalid_target"),
        ("duplicate-thread", "mail_action_invalid_target"),
        ("missing-thread", "mail_action_target_unknown"),
        ("bad-member", "mail_action_invalid_target"),
        ("bad-membership", "mail_action_invalid_target"),
        ("unsolicited-member", "mail_action_invalid_target"),
        ("duplicate-member", "mail_action_invalid_target"),
        ("missing-member", "mail_action_target_unknown"),
        ("bad-envelope", "jmap_invalid_response"),
    ] {
        let (peer, session) = Peer::start(scenario, true).await;
        assert_eq!(
            session
                .jmap
                .planned_action_rows(ACCOUNT, &["e1".into()], &json!({}), "read",)
                .await,
            Err(error),
            "{scenario}"
        );
        let report = peer.report().await;
        assert!(readonly_requests(&report), "{report}");
    }
}

#[tokio::test]
async fn production_jmap_uses_fresh_roles_and_preserves_empty_and_repeated_expansions() {
    if isolated() {
        return;
    }
    let fixture = account_fixture(json!({"version":1,"activeId":ACCOUNT,
        "accounts":[{"provider":"jmap","email":"user@example.test"}]}));
    let before = fixture_tree(&fixture.root);
    for (scenario, operation, expected) in [
        ("roles", "archive", Ok(json!(["e1"]))),
        ("no-inbox", "archive", Ok(json!(["e1", "e2"]))),
        ("empty", "archive", Err("mail_action_target_unknown")),
        ("empty", "spam", Err("mail_action_target_unknown")),
        ("repeated", "read", Ok(json!(["e1", "e2"]))),
    ] {
        let (peer, session) = Peer::start(scenario, true).await;
        let ids = if scenario == "repeated" {
            json!(["e1", "e2", "e1"])
        } else {
            json!(["e1"])
        };
        let result = session
            .dispatch("mail.act", &json!({"operation":operation,"ids":ids}))
            .await;
        assert_eq!(
            result.map(|value| value["targetIds"].clone()),
            expected,
            "{scenario} {operation}"
        );
        let report = peer.report().await;
        assert!(readonly_requests(&report), "{report}");
        let calls: Vec<_> = report
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|request| request["calls"].as_array().unwrap())
            .collect();
        assert_eq!(
            calls.iter().filter(|call| call[0] == "Thread/get").count(),
            1
        );
        assert_eq!(
            calls.iter().find(|call| call[0] == "Thread/get").unwrap()[1]["ids"],
            json!(["t1"])
        );
        assert_eq!(fixture_tree(&fixture.root), before);
    }
}
