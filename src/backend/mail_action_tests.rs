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
        let client = reqwest::Client::builder()
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
async fn production_jmap_dispatch_previews_all_actions_and_refuses_execution_without_local_writes()
{
    if isolated() {
        return;
    }
    let fixture = account_fixture(json!({"version":1,"activeId":ACCOUNT,
        "accounts":[{"provider":"jmap","email":"user@example.test"}]}));
    // Existing account, outbox and compose bytes are protected alongside absent
    // cache, lock and upload destinations. Directory metadata detects creation.
    for directory in ["state", "home"] {
        fs::create_dir(fixture.root.join(directory)).unwrap();
        fs::write(
            fixture.root.join(directory).join("sentinel"),
            b"unchanged synthetic state",
        )
        .unwrap();
    }
    fs::create_dir(fixture.root.join("state/omamail")).unwrap();
    fs::write(fixture.root.join("state/omamail/outbox.json"), b"[]\n").unwrap();
    fs::write(
        fixture.root.join("omamail/compose.json"),
        b"{\"version\":1,\"active\":false}\n",
    )
    .unwrap();
    let before = fixture_tree(&fixture.root);
    let (peer, session) = Peer::start("matrix", true).await;
    for operation in [
        "read", "unread", "star", "unstar", "archive", "trash", "spam",
    ] {
        for execute in [None, Some(false), Some(true)] {
            let mut params = json!({"operation":operation,"ids":["e1"]});
            if let Some(execute) = execute {
                params["execute"] = json!(execute);
            }
            let result = session.dispatch("mail.act", &params).await;
            if execute == Some(true) {
                assert_eq!(result, Err("mail_action_execute_unsupported"));
            } else {
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
    // Each accepted preview: availability, representatives, threads, members.
    // Invalid batches and execute=true must cause no extra provider request.
    assert_eq!(calls.len(), 7 * 2 * 4, "{report}");
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
                .call(
                    "jmap.actionRows",
                    &json!({"accountId":ACCOUNT,"operation":"read","ids":ids,
            "roles":{"inbox":"I","sent":"S","trash":"T","junk":"J"}})
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
    let result = session
        .jmap
        .call(
            "jmap.actionRows",
            &json!({"accountId":ACCOUNT,"operation":"read","ids":["e1","e2"],"roles":{}}),
        )
        .await
        .unwrap();
    let rows = result["data"]["rows"].as_array().unwrap();
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
                .call(
                    "jmap.actionRows",
                    &json!({"accountId":ACCOUNT,"operation":"read","ids":["e1"],"roles":{}})
                )
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
