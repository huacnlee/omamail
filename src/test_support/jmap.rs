//! A JMAP HTTPS peer with scripted sessions for the native adapter tests.

use crate::test_support::{http, tls};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

/// How long the peer waits for a client that never finishes its handshake.
const HANDSHAKE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

pub(crate) struct JmapPeer {
    pub(crate) port: u16,
    task: JoinHandle<()>,
}

impl JmapPeer {
    pub(crate) async fn start(scenario: &str) -> Self {
        let (listener, port) = tls::bind().await;
        let acceptor = TlsAcceptor::from(tls::localhost_config());
        let state = Arc::new(Mutex::new(State {
            scenario: scenario.to_string(),
            mode: "success",
            email_gets: 0,
            requests: Vec::new(),
        }));
        let shared = state.clone();
        let task = tokio::spawn(async move {
            loop {
                let mut stream = match tokio::time::timeout(
                    HANDSHAKE_DEADLINE,
                    tls::accept(&acceptor, &listener),
                )
                .await
                {
                    Ok(Ok(stream)) => stream,
                    _ => continue,
                };
                let Ok(Some(request)) = http::read_request(&mut stream).await else {
                    continue;
                };
                if request.path == "/report" {
                    let body = serde_json::to_vec(&shared.lock().unwrap().requests).unwrap();
                    let _ = http::respond(&mut stream, 200, Some("application/json"), &body).await;
                    continue;
                }
                if request.method == "GET" {
                    get(&mut stream, &request, &shared).await;
                } else if request.method == "POST" {
                    if !post(&mut stream, &request, &shared).await {
                        continue;
                    }
                } else {
                    shared.lock().unwrap().record(&request);
                    let _ = http::respond(&mut stream, 404, None, b"{}").await;
                }
            }
        });
        Self { port, task }
    }
}

impl Drop for JmapPeer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct State {
    scenario: String,
    mode: &'static str,
    email_gets: u64,
    requests: Vec<Value>,
}

impl State {
    fn record(&mut self, request: &http::Request) -> usize {
        self.requests.push(json!({
            "method": request.method,
            "path": request.path,
            "authorization": request.header("authorization").is_some(),
        }));
        self.requests.len() - 1
    }
}

async fn get<S: tokio::io::AsyncWrite + Unpin>(
    stream: &mut S,
    request: &http::Request,
    state: &Arc<Mutex<State>>,
) {
    state.lock().unwrap().record(request);
    if request.path == "/events" {
        let payload =
            b"event: state\r\ndata: {\"changed\":{\"account\":{\"Email\":\"e2\",\"Mailbox\":\"m2\"}}}\r\n\r\n";
        let _ = http::respond(stream, 200, Some("text/event-stream"), payload).await;
    } else if request.path.starts_with("/blob/") {
        let _ = http::respond(stream, 200, None, b"complete body").await;
    } else {
        let _ = http::respond(stream, 404, None, b"{}").await;
    }
}

/// Returns false when the peer must drop the connection without an answer.
async fn post<S: tokio::io::AsyncWrite + Unpin>(
    stream: &mut S,
    request: &http::Request,
    state: &Arc<Mutex<State>>,
) -> bool {
    let index = state.lock().unwrap().record(request);
    if request.path == "/upload" {
        let mode = if find(&request.body, b"Subject: fail") {
            "fail"
        } else if find(&request.body, b"Subject: importfail") {
            "importfail"
        } else if find(&request.body, b"Subject: uncertain") {
            "uncertain"
        } else {
            "success"
        };
        {
            let mut shared = state.lock().unwrap();
            shared.mode = mode;
            shared.requests[index]["mode"] = json!(mode);
        }
        let _ = http::respond(stream, 200, None, br#"{"blobId":"uploaded"}"#).await;
        return true;
    }
    if request.path == "/refused" {
        let _ = http::respond(stream, 401, None, b"{}").await;
        return true;
    }
    let Some(body) = request.json() else {
        state.lock().unwrap().requests[index]["malformed"] = json!(true);
        let _ = http::respond(stream, 400, None, b"{}").await;
        return true;
    };
    let Some(calls) = body["methodCalls"].as_array().cloned() else {
        state.lock().unwrap().requests[index]["malformed"] = json!(true);
        let _ = http::respond(stream, 400, None, b"{}").await;
        return true;
    };
    if calls.iter().any(|call| {
        let call = call.as_array();
        call.is_none() || call.is_some_and(|call| call.len() != 3)
    }) {
        state.lock().unwrap().requests[index]["malformed"] = json!(true);
        let _ = http::respond(stream, 400, None, b"{}").await;
        return true;
    }
    state.lock().unwrap().requests[index]["calls"] = json!(calls);
    let mut replies = Vec::new();
    for call in &calls {
        let call = call.as_array().unwrap();
        let method = call[0].as_str().unwrap_or_default();
        let args = &call[1];
        let id = &call[2];
        let reply = match method {
            "Email/query" => {
                if args.get("anchor").is_some() {
                    Some(json!(["error", {"type": "anchorNotFound"}, id]))
                } else {
                    Some(
                        json!([method, {"ids": ["e1"], "position": 0, "total": 1, "queryState": "q1"}, id]),
                    )
                }
            }
            "Email/get" => {
                let mut state = state.lock().unwrap();
                state.email_gets += 1;
                let gets = state.email_gets;
                let scenario = state.scenario.clone();
                drop(state);
                if id.as_str() == Some("3") {
                    Some(json!(["error", {"type": "requestTooLarge"}, id]))
                } else {
                    let ids = args["ids"]
                        .as_array()
                        .cloned()
                        .unwrap_or_else(|| vec![json!("e1")]);
                    let mut list: Vec<Value> = ids
                        .iter()
                        .map(|id| email(&scenario, id.as_str().unwrap_or_default()))
                        .collect();
                    if scenario == "unsolicited-email" {
                        list.push(email(&scenario, "unrequested"));
                    }
                    if scenario == "missing-email" {
                        list.clear();
                    }
                    if scenario == "duplicate-email" {
                        let first = list[0].clone();
                        list.push(first);
                    }
                    if scenario == "bad-email" {
                        list[0]["threadId"] = json!(42);
                    }
                    if gets > 1 {
                        if scenario == "unsolicited-member" {
                            list.push(email(&scenario, "unrequested"));
                        }
                        if scenario == "missing-member" {
                            list.clear();
                        }
                        if scenario == "duplicate-member" {
                            let first = list[0].clone();
                            list.push(first);
                        }
                    }
                    Some(json!([method, {"list": list, "state": "e1"}, id]))
                }
            }
            "Thread/get" => {
                let scenario = state.lock().unwrap().scenario.clone();
                let ids = args["ids"]
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![json!("t1")]);
                let mut list: Vec<Value> = ids
                    .iter()
                    .map(|id| {
                        let thread = id.as_str().unwrap_or_default();
                        json!({"id": thread, "emailIds": members(&scenario, thread)})
                    })
                    .collect();
                if scenario == "unsolicited-thread" {
                    list.push(json!({"id": "unrequested", "emailIds": ["e1"]}));
                }
                if scenario == "missing-thread" {
                    list.clear();
                }
                if scenario == "duplicate-thread" {
                    let first = list[0].clone();
                    list.push(first);
                }
                Some(json!([method, {"list": list, "state": "t1"}, id]))
            }
            "Identity/get" => Some(json!([
                method,
                {"list": [{"id": "identity", "email": "user@example.test", "name": "User"}]},
                id
            ])),
            "Email/import" => {
                let mode = state.lock().unwrap().mode;
                Some(json!([
                    method,
                    if mode == "importfail" {
                        json!({"notCreated": {"draft": {"type": "invalidEmail"}}})
                    } else {
                        json!({"created": {"draft": {"id": "newdraft"}}})
                    },
                    id
                ]))
            }
            "EmailSubmission/set" => {
                let mode = state.lock().unwrap().mode;
                if mode == "uncertain" {
                    return false;
                }
                Some(json!([
                    method,
                    if mode == "fail" {
                        json!({"notCreated": {"send": {"type": "forbiddenToSend"}}})
                    } else {
                        json!({"created": {"send": {"id": "submitted"}}})
                    },
                    id
                ]))
            }
            "Email/set" => {
                let scenario = state.lock().unwrap().scenario.clone();
                let update = args["update"].as_object().cloned().unwrap_or_default();
                let result = if args["destroy"] == json!(["old-fail"]) {
                    json!({"notDestroyed": {"old-fail": {"type": "forbidden"}}})
                } else if scenario == "action-unknown" && update.contains_key("e2") {
                    json!({"updated": []})
                } else if scenario == "action-failed" {
                    json!({"notUpdated": update.keys().map(|key| (key.clone(), json!({"type": "forbidden", "description": "synthetic-secret"}))).collect::<serde_json::Map<_, _>>()})
                } else if scenario == "partial-action" {
                    json!({"updated": {"e1": null}, "notUpdated": {"e2": {"type": "notFound", "description": "synthetic-secret"}}})
                } else {
                    let updated: serde_json::Map<String, Value> = update
                        .keys()
                        .map(|key| (key.clone(), Value::Null))
                        .collect();
                    json!({
                        "updated": updated,
                        "destroyed": args.get("destroy").cloned().unwrap_or_else(|| json!([])),
                    })
                };
                Some(json!([method, result, id]))
            }
            "Mailbox/get" => {
                let scenario = state.lock().unwrap().scenario.clone();
                let mut list = vec![
                    json!({"id": "I", "role": "inbox"}),
                    json!({"id": "S", "role": "sent"}),
                    json!({"id": "T", "role": "trash"}),
                    json!({"id": "A", "role": "archive"}),
                    json!({"id": "D", "role": "drafts"}),
                ];
                if scenario != "default" {
                    list.push(json!({"id": "J", "role": "junk"}));
                }
                let missing = match scenario.as_str() {
                    "no-archive" => Some("archive"),
                    "no-trash" => Some("trash"),
                    "no-inbox" => Some("inbox"),
                    _ => None,
                };
                list.retain(|box_| Some(box_["role"].as_str().unwrap_or_default()) != missing);
                if scenario == "roles" {
                    list[0]["id"] = json!("NEW");
                }
                Some(json!([method, {"list": list}, id]))
            }
            _ => Some(json!(["error", {"type": "unknownMethod"}, id])),
        };
        replies.push(reply.unwrap());
    }
    let scenario = state.lock().unwrap().scenario.clone();
    let method_responses = if scenario == "bad-envelope" {
        Value::Null
    } else {
        Value::Array(replies)
    };
    let payload = serde_json::to_vec(&json!({
        "methodResponses": method_responses,
        "sessionState": "s1",
    }))
    .unwrap();
    let _ = http::respond(stream, 200, Some("application/json"), &payload).await;
    true
}

fn find(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn email(scenario: &str, id: &str) -> Value {
    let folder = match id {
        "e2" => "S",
        "e3" => "T",
        _ => "I",
    };
    let keywords = match id {
        "e1" => json!({"$seen": true}),
        "e2" => json!({"$flagged": true}),
        _ => json!({}),
    };
    let mut mailbox = serde_json::Map::new();
    mailbox.insert(folder.to_string(), json!(true));
    let mut result = json!({
        "id": id,
        "threadId": "t1",
        "mailboxIds": mailbox,
        "keywords": keywords,
        "from": [{"email": "a@example.test", "name": "Ada"}],
        "to": [{"email": "user@example.test"}],
        "subject": "Native test",
        "preview": "<3 native",
        "receivedAt": "2026-09-11T00:00:00Z",
        "bodyStructure": {"partId": "1", "blobId": "tail", "type": "text/plain", "charset": "utf-8", "size": 13},
        "bodyValues": {"1": {"value": "short", "isTruncated": true}},
    });
    if (scenario == "occurrences" || scenario == "member-bytes") && id == "e2" {
        result["threadId"] = json!("t2");
    }
    if scenario == "roles" {
        let mut mailbox = serde_json::Map::new();
        mailbox.insert(
            if id == "e1" { "NEW" } else { "I" }.to_string(),
            json!(true),
        );
        result["mailboxIds"] = Value::Object(mailbox);
    }
    if scenario == "empty" {
        result["mailboxIds"] = json!({"S": true});
    }
    if scenario == "bad-membership" {
        result["mailboxIds"] = json!({"I": "true"});
    }
    result
}

fn members(scenario: &str, thread: &str) -> Value {
    match scenario {
        "oversized-thread" => {
            let mut ids = vec![json!("e1")];
            ids.extend((0..2000).map(|i| json!(format!("m{i}"))));
            json!(ids)
        }
        "occurrences" => {
            let count = if thread == "t1" { 1000 } else { 1001 };
            json!(vec![json!("e1"); count])
        }
        "member-bytes" => json!(
            (0..400)
                .map(|i| json!(format!("{}{thread}{i}", "x".repeat(5990))))
                .collect::<Vec<_>>()
        ),
        "projection-bytes" => json!(
            (0..400)
                .map(|i| json!(format!("{}{i}", "x".repeat(5990))))
                .collect::<Vec<_>>()
        ),
        "projection-count" => {
            let mut ids = vec![json!("e1"), json!("e2"), json!("e4")];
            ids.extend((0..664).map(|i| json!(format!("m{i}"))));
            json!(ids)
        }
        "projection-at-limit" => {
            let mut ids = vec![json!("e1"), json!("e2")];
            ids.extend((0..998).map(|i| json!(format!("m{i}"))));
            json!(ids)
        }
        "repeated" => json!(["e1", "e2"]),
        "bad-member" => json!(["e1", 123]),
        _ => json!(["e1", "e2", "e3"]),
    }
}
