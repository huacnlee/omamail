use super::*;
use std::io::Write;

/// Execute the original JS resource functions against synthetic fixtures, so
/// parity covers actual provider behavior rather than a second Rust expected value.
fn oracle(input: &Value) -> Value {
    let script = r#"
const {load}=require('./ui/tests/load');
const P=load('providers/JmapProtocol.js');
const T=load('providers/JmapThreads.js');
const f=JSON.parse(require('fs').readFileSync(0,'utf8'));
let v;
if(f.op==='get') v=P.emailGet(f.account,f.ids,f.full);
if(f.op==='message') v=P.toMessage(f.email,f.roles,f.full);
if(f.op==='part') v=P.toPart(f.part,f.values,f.depth||0);
if(f.op==='truncated') v=P.truncatedParts(f.email);
if(f.op==='substitute') {v={done:P.substitutePart(f.payload,f.part,f.data),payload:f.payload};}
if(f.op==='threads') v=T.threadBlocks(f.reps,f.threads,f.members,f.roles,f.query);
process.stdout.write(JSON.stringify(v));
"#;
    let mut child = std::process::Command::new("node")
        .arg("-e")
        .arg(script)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}

fn email() -> Value {
    json!({"id":" e1 ","threadId":"thread","receivedAt":"2026-09-11T09:10:11.123Z","size":501,
      "subject":" Hello ","preview":"<3 & >", "from":[{"email":"ada@example.org","name":"Ada, A."},{"email":"雪@example.org","name":"雪"}],
      "to":[{"email":"to@example.org"}],"cc":[],"messageId":["id@example.org","<wrapped>"],"references":["old"],
      "header:Date":" Fri, 11 Sep 2026 09:10:11 +0000", "header:List-Unsubscribe:asRaw":" <https://example.org/remove>",
      "headers":[{"name":"Subject","value":"wrong subject"},{"name":"Reply-To","value":" reply@example.org"},{"name":"","value":"ignored"}],
      "keywords":{"$flagged":true,"$draft":false},"mailboxIds":{"in":true,"sent":true,"trash":false},
      "bodyStructure":{"partId":"root","type":"multipart/mixed","subParts":[
        {"partId":"text","type":"text/plain","charset":"iso-8859-1","blobId":"textBlob","size":999},
        {"partId":"file","type":"text/plain","charset":"windows-1252","name":"notes.txt","blobId":"fileBlob","size":19,"cid":"cid","headers":[{"name":"Content-ID","value":" <cid>"}]}]},
      "bodyValues":{"text":{"value":"Hi 雪\nsecond","isTruncated":true,"isEncodingProblem":true}}})
}
fn roles() -> Value {
    json!({"inbox":"in","sent":"sent","trash":"trash","junk":"junk","drafts":"drafts"})
}
#[test]
fn real_js_message_and_part_golden_parity() {
    for full in [false, true] {
        let e = email();
        let roles = roles();
        assert_eq!(
            to_message(&e, &roles, full),
            oracle(&json!({"op":"message","email":e,"roles":roles,"full":full}))
        );
    }
    for e in [
        Value::Null,
        json!({}),
        json!({"receivedAt":"not a date","size":-2,"bodyStructure":{}}),
    ] {
        assert_eq!(
            to_message(&e, &roles(), true),
            oracle(&json!({"op":"message","email":e,"roles":roles(),"full":true}))
        );
    }
    let e = email();
    assert_eq!(
        to_part(&e["bodyStructure"], &e["bodyValues"], 0),
        oracle(&json!({"op":"part","part":e["bodyStructure"],"values":e["bodyValues"]}))
    );
}
#[test]
fn truncation_repair_retains_blob_charset_and_actual_octet_count() {
    let e = email();
    let parts = truncated_parts(&e);
    assert_eq!(json!(parts), oracle(&json!({"op":"truncated","email":e})));
    assert_eq!(parts.len(), 1);
    let mut payload = to_message(&e, &roles(), true)["payload"].clone();
    let expected =
        oracle(&json!({"op":"substitute","payload":payload,"part":parts[0],"data":"6Q=="}));
    let done = substitute_part(&mut payload, &parts[0], "6Q==");
    assert_eq!(json!({"done":done,"payload":payload}), expected);
    assert_eq!(payload["parts"][0]["body"]["size"], 1);
    assert_eq!(
        payload["parts"][0]["mimeType"],
        "text/plain; charset=iso-8859-1"
    );
    assert!(!substitute_part(
        &mut payload,
        &json!({"partId":"missing"}),
        "YQ"
    ));
}
#[test]
fn bounded_mime_depth_matches_js_and_never_walks_attacker_stack() {
    let mut part = json!({"partId":"deep","type":"text/plain","blobId":"deepBlob"});
    for _ in 0..40 {
        part = json!({"type":"multipart/mixed","subParts":[part]});
    }
    let values = json!({"deep":{"value":"hidden","isTruncated":true}});
    assert_eq!(
        to_part(&part, &values, 0),
        oracle(&json!({"op":"part","part":part,"values":values}))
    );
    assert!(truncated_parts(&json!({"bodyStructure":part,"bodyValues":values})).is_empty());
}
#[test]
fn conversation_members_match_js_in_inbox_and_trash() {
    let reps = json!([{"id":"one","threadId":"thread"}]);
    let threads = json!({"thread":["one","reply","trashed","missing","junked"]});
    let members = json!({"one":{"id":"one","mailboxIds":{"in":true},"keywords":{"$seen":true}},
      "reply":{"id":"reply","mailboxIds":{"sent":true},"keywords":{"$flagged":true}},
      "trashed":{"id":"trashed","mailboxIds":{"trash":true},"keywords":{}},
      "junked":{"id":"junked","mailboxIds":{"junk":true},"keywords":{}}});
    for (query, viewed) in [
        ("inbox", "in"),
        ("trash", "trash"),
        ("junk", "junk"),
        ("", ""),
    ] {
        assert_eq!(
            thread_blocks(&reps, &threads, &members, &roles(), viewed),
            oracle(
                &json!({"op":"threads","reps":reps,"threads":threads,"members":members,"roles":roles(),"query":{"role":query,"text":if query.is_empty() { "hello" } else { "" }}})
            ),
            "query {query}"
        );
    }
}

#[test]
fn requested_properties_match_js_without_inlining_text_attachments() {
    for full in [false, true] {
        let ids = vec!["one".to_owned(), "two".to_owned()];
        let result = email_get(" account ", &ids, full);
        assert_eq!(
            result,
            oracle(&json!({"op":"get","account":" account ","ids":ids,"full":full}))
        );
        assert!(result.get("fetchAllBodyValues").is_none());
        assert!(result.get("maxBodyValueBytes").is_none());
    }
}

#[test]
fn refuses_duplicate_body_value_amplification_before_building_mime() {
    let leaves = vec![json!({"partId":"same","type":"text/plain"}); 512];
    let email = json!({"bodyStructure":{"type":"multipart/mixed","subParts":leaves},"bodyValues":{"same":{"value":"x".repeat(65536)}}});
    assert!(serde_json::to_vec(&email).unwrap().len() < 100_000);
    // Were construction allowed, the same small source would emit over44MiB
    // of base64 strings. Reject from sizes alone before encoding any of them.
    assert_eq!(
        validate_budget(&email, true),
        Err("jmap_response_too_large")
    );
    assert_eq!(validate_budget(&email, false), Ok(()));
    let numeric = json!({"bodyStructure":{"type":"text/plain","partId":1},"bodyValues":{"1":{"value":"x".repeat(25*1024*1024)}}});
    assert_eq!(
        validate_budget(&numeric, true),
        Err("jmap_response_too_large")
    );
}

#[test]
fn bounds_nodes_and_structural_expansion_but_allows_realistic_bodies() {
    let many = json!({"bodyStructure":{"type":"multipart/mixed","subParts":vec![json!({});4096]}});
    assert_eq!(validate_budget(&many, true), Err("jmap_response_too_large"));
    let large = json!({"bodyStructure":{"partId":"text","type":"text/plain"},"bodyValues":{"text":{"value":"x".repeat(12*1024*1024)}}});
    assert_eq!(validate_budget(&large, true), Ok(()));
    let preview = json!({"preview":"&".repeat(6*1024*1024)});
    assert_eq!(
        validate_budget(&preview, false),
        Err("jmap_response_too_large")
    );
    assert_eq!(validate_budget(&email(), true), Ok(()));
}
