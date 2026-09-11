use super::*;
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn oracle(calls: &Value, unified: bool) -> Value {
    let script = r#"
const {load}=require('./ui/tests/load');
const input=JSON.parse(require('fs').readFileSync(0,'utf8'));
const M=load(input.unified?'account/Unified.js':'account/Model.js');
function hydrate(v) { if(!v||typeof v!=='object')return v; if(Array.isArray(v))return v.map(hydrate); for(const k of Object.keys(v)){if(k==='date'&&v[k])v[k]=new Date(v[k]);else v[k]=hydrate(v[k]);}return v; }
function descriptors(v) { if(!v||typeof v!=='object')return; for(const k of Object.keys(v))descriptors(v[k]); if(v.apply&&typeof v.apply==='object'){const d=v.apply;v.apply=function(row){return M.applyLabelChange(row,d.action,d.sourceLabelId,d.conversation?M.threadAfterAction(row,d.action):d.thread);};} }
const result=input.calls.map(c=>{const args=hydrate(c.args);descriptors(args);return M[c.operation].apply(null,args);});
process.stdout.write(JSON.stringify(result));
"#;
    let mut child = Command::new("node")
        .args(["-e", script])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"calls":calls,"unified":unified})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}
fn compare(calls: Value) {
    let expected = oracle(&calls, false);
    let actual = apply(&json!({"operation":"batch","calls":calls})).unwrap();
    assert_eq!(actual, expected);
}
fn row(id: &str, date: i64) -> Value {
    json!({"id":id,"date":format!("2026-09-12T10:{date:02}:00.000Z"),"subject":"subject","labelIds":["INBOX","UNREAD"],"unread":true,"inInbox":true})
}

#[test]
fn native_list_golden_order_detail_and_missing() {
    let old = row("a", 1);
    let b = row("b", 2);
    let mut live = old.clone();
    live["subject"] = json!("new");
    let list = json!([old, b]);
    let partial = json!({"id":"a","subject":"(no subject)","from":{},"snippet":"","date":null,"thread":{"count":0},"unread":false});
    compare(json!([
        {"operation":"mergeSearchResults","args":[list,[live]]},
        {"operation":"settledSearchResults","args":[[],list,[live],["b","a","missing"],false]},
        {"operation":"missingSearchSummaryIds","args":[[live],["a","b","missing"]]},
        {"operation":"detailSummary","args":[old,partial]},
        {"operation":"newestDate","args":[list]},
        {"operation":"newArrivals","args":[list,{"a":true},true,0]},
        {"operation":"restoreRow","args":[[b],old,list,0]},
        {"operation":"restoreRows","args":[[],list,["a","b"]]}
    ]));
}
#[test]
fn native_conversation_actions_golden() {
    let mut representative = row("a", 1);
    representative["thread"] =
        json!({"id":"t","count":9,"memberIds":["a","b"],"unread":true,"flagged":true});
    let members = json!({"a":{"labelIds":[]},"b":{"labelIds":["UNREAD"]}});
    let mut calls = Vec::new();
    for action in [
        "markRead",
        "markUnread",
        "star",
        "unstar",
        "archive",
        "unarchive",
        "spam",
        "trash",
        "label:Work",
    ] {
        calls.push(json!({"operation":"actionTargets","args":[representative,action]}));
        calls.push(json!({"operation":"actionTargets","args":[{"id":"hey:posting","thread":{"count":0,"memberIds":[]}},action]}));
        calls.push(json!({"operation":"applyLabelChange","args":[representative,action,"Label_Work",null]}));
        calls.push(json!({"operation":"threadAfterAction","args":[representative,action]}));
        for mailbox in ["inbox", "unread", "starred", "trash"] {
            calls.push(json!({"operation":"survivesAction","args":[mailbox,action,"",true,"",representative]}));
        }
    }
    calls.push(json!({"operation":"threadAfterMemberChange","args":[representative,members]}));
    compare(json!(calls));
}
#[test]
fn refused_capability_is_side_effect_free_and_quiet_read_stays_open() {
    let r = row("a", 1);
    let refused=apply(&json!({"operation":"action","action":"archive","capabilities":{"archive":false},"messages":[r],"messageId":"a"})).unwrap();
    assert_eq!(refused, json!({"refused":true,"capability":"archive"}));
    let result=apply(&json!({"operation":"action","action":"markRead","messages":[r],"messageId":"a","selectedId":"a","quiet":true,"mailboxKey":"unread"})).unwrap();
    assert_eq!(result["removed"], false);
    assert_eq!(result["messages"][0]["unread"], false);
}

#[test]
fn native_filter_and_watermark_match_js() {
    compare(json!([
      {"operation":"filterRows","args":[[{"name":"Work account","email":"a@example.org"},{"name":"World news"},{"name":"工作","label":"重要"}],"wk"]},
      {"operation":"fuzzyScore","args":["💌n","Mail 💌 news"]},
      {"operation":"railLabels","args":[[{"id":"b","name":"work"},{"id":"a","name":"Work"},{"id":"system","name":"Inbox","system":true}]]}
    ]));
    let sources = json!([
      {"id":"a","hasMore":true,"messages":[row("1",9),row("2",5)]},
      {"id":"b","hasMore":false,"messages":[row("1",7),row("2",1)]}
    ]);
    assert_eq!(
        json!(super::super::unified::merge(&sources)),
        oracle(
            &json!([{"operation":"mergeMessages","args":[sources]}]),
            true
        )[0]
    );
}

#[test]
fn detail_fallback_recomputes_subject_direction_from_preserved_subject() {
    let merged = apply(&json!({"operation":"detailSummary","args":[
        {"subject":"Re: مرحبا","subjectDirection":"rtl"},
        {"subject":"(no subject)","subjectDirection":"ltr"}
    ]}))
    .unwrap();
    assert_eq!(merged["subject"], "Re: مرحبا");
    assert_eq!(merged["subjectDirection"], "rtl");
}

#[test]
fn unified_rejects_identifier_amplification_before_composition() {
    let source = json!({"id":"a".repeat(8192),"messages":[{"id":"one","thread":{"memberIds":vec!["x";3000]}}]});
    assert_eq!(
        super::super::unified::apply(&json!({"sources":[source]})),
        Err("model_output_too_large")
    );
}

#[test]
fn malformed_account_identifier_cannot_collide_with_another_source() {
    for account in [json!("a\u{1f}b"), json!("a\n"), json!("a\0"), json!(123)] {
        let sources = json!([{ "id":account,"messages":[{"id":"c"}] },
          {"id":"a","messages":[{"id":"b\u{1f}c"}]}]);
        assert_eq!(
            super::super::unified::apply(&json!({"sources":sources})),
            Err("model_account_invalid")
        );
    }
}

#[test]
fn declarative_rebase_rejects_snapshot_amplification_before_replay() {
    let mut entries = vec![json!({"token":0,"before":{"id":"x","snippet":"a".repeat(1024*1024)}})];
    entries.extend((1..64).map(|n| json!({"token":n,"apply":{"action":"star"}})));
    assert_eq!(
        apply(&json!({"operation":"rebaseIntents","args":[entries,0]})),
        Err("model_output_too_large")
    );
}

#[test]
fn repeated_authoritative_ids_cannot_amplify_one_cached_summary() {
    let args = json!([[],[{"id":"x","snippet":"a".repeat(512*1024)}],[],vec!["x";1000],false]);
    for operation in ["settledSearchResults", "searchFinish"] {
        assert_eq!(
            apply(&json!({"operation":operation,"args":args})),
            Err("model_output_too_large")
        );
    }
}
#[test]
fn rollback_replays_later_intent_and_restores_settled_order() {
    let r = row("a", 1);
    let starred = label_change(&r, "star", "", &Value::Null);
    let entries = json!([{"token":1,"before":r,"apply":{"action":"star"}},{"token":2,"before":starred,"apply":{"action":"markRead"}}]);
    let result = apply(&json!({"operation":"rebaseIntents","args":[entries,1]})).unwrap();
    let oracle_value = oracle(
        &json!([{"operation":"rebaseIntents","args":[entries,1]}]),
        false,
    );
    // Function descriptors deliberately survive native replay, unlike JSON's function omission.
    assert_eq!(result["summary"], oracle_value[0]["summary"]);
    assert_eq!(
        result["entries"][0]["before"],
        oracle_value[0]["entries"][0]["before"]
    );
    assert_eq!(result["summary"]["starred"], false);
    assert_eq!(result["summary"]["unread"], false);
    compare(json!([{"operation":"listAfterRestore","args":[[],r,true,true,[r],0]}]));
}
#[test]
fn unified_large_list_account_collision_watermark_and_capabilities() {
    let messages:Vec<_>=(0..4000).map(|i|json!({"id":format!("{i}:Sent Items"),"date":chrono::DateTime::from_timestamp_millis(1_000_000+i).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"thread":{"memberIds":["a","b"],"count":2}})).collect();
    let sources = json!([{"id":"imap:a@example.org","messages":messages},{"id":"imap:b@example.org","messages":messages}]);
    let merged = super::super::unified::merge(&sources);
    assert_eq!(
        json!(merged),
        oracle(
            &json!([{"operation":"mergeMessages","args":[sources]}]),
            true
        )[0]
    );
    assert_eq!(merged.len(), 8000);
    assert_ne!(merged[0]["id"], merged[1]["id"]);
    let snapshot=super::super::unified::apply(&json!({"sources":[],"abilities":[{"archive":true,"mailboxes":[{"key":"inbox"},{"key":"archive"}]},{"archive":false,"mailboxes":[{"key":"inbox"}]}],"states":[{"loaded":true},{"error":"offline","loading":false}],"summaries":[{"unread":3},{"unread":4}]})).unwrap();
    assert_eq!(snapshot["capabilities"]["archive"], false);
    assert_eq!(snapshot["mailboxes"], json!([{"key":"inbox"}]));
    assert_eq!(snapshot["loaded"], true);
    assert_eq!(snapshot["totalUnread"], 7);
}
