use super::*;
fn row(id: &str) -> Value {
    json!({"id":id,"unread":true,"starred":false,"inInbox":true,"labelIds":["INBOX","UNREAD"]})
}
fn view() -> Value {
    json!({"messages":[row("a"),row("b"),row("c")],"previewMessages":[row("a"),row("b"),row("c")],"memberSummaries":{},"selectedId":"a","selectedMessage":row("a"),"selectedThread":null,"inboxUnread":3})
}
fn begin(store: &IntentStore, view: Value, action: &str, ids: Value) -> Value {
    store.call(&json!({"operation":"begin","accountId":"one","query":"inbox|25","generation":1,"view":view,"action":action,"ids":ids,"mailboxKey":"inbox","hasLabels":true,"capabilities":{"archive":true,"star":true,"move":true,"spam":true}})).unwrap()
}
fn settle(store: &IntentStore, token: &Value, failed: Value) -> Value {
    store.call(&json!({"operation":"settle","accountId":"one","query":"inbox|25","generation":1,"token":token,"failedIds":failed})).unwrap()
}
#[test]
fn failures_restore_original_order_without_erasing_newer_edits() {
    let store = IntentStore::default();
    let first = begin(&store, view(), "archive", json!(["a"]));
    let second = begin(&store, first["view"].clone(), "archive", json!(["b"]));
    let third = begin(&store, second["view"].clone(), "star", json!(["c"]));
    let after = settle(&store, &first["token"], json!(["a"]));
    assert_eq!(
        list(&after["view"]["messages"])
            .iter()
            .map(|v| id(&v["id"]))
            .collect::<Vec<_>>(),
        vec!["a", "c"]
    );
    assert_eq!(after["view"]["messages"][1]["starred"], true);
    let restored = settle(&store, &second["token"], json!(["b"]));
    assert_eq!(
        list(&restored["view"]["messages"])
            .iter()
            .map(|v| id(&v["id"]))
            .collect::<Vec<_>>(),
        vec!["a", "b", "c"]
    );
    settle(&store, &third["token"], json!([]));
    assert!(store.state.lock().unwrap().contexts.is_empty());
}
#[test]
fn out_of_order_success_survives_earlier_failure() {
    let store = IntentStore::default();
    let first = begin(&store, view(), "star", json!(["a"]));
    let second = begin(&store, first["view"].clone(), "markRead", json!(["a"]));
    settle(&store, &second["token"], json!([]));
    let end = settle(&store, &first["token"], json!(["a"]));
    assert_eq!(end["view"]["messages"][0]["starred"], false);
    assert_eq!(end["view"]["messages"][0]["unread"], false);
    assert_eq!(end["view"]["inboxUnread"], 2);
}
#[test]
fn partial_failure_is_per_row_and_selection_is_not_reopened() {
    let store = IntentStore::default();
    let first = begin(&store, view(), "archive", json!(["a", "b"]));
    assert_eq!(first["view"]["selectedId"], "");
    let after = settle(&store, &first["token"], json!(["a"]));
    assert_eq!(
        list(&after["view"]["messages"])
            .iter()
            .map(|v| id(&v["id"]))
            .collect::<Vec<_>>(),
        vec!["a", "c"]
    );
    assert_eq!(after["view"]["selectedId"], "");
}
#[test]
fn query_account_generation_and_capability_boundaries() {
    let store = IntentStore::default();
    let first = begin(&store, view(), "star", json!(["a"]));
    for (account, query, generation) in [
        ("other", "inbox|25", 1),
        ("one", "other|25", 1),
        ("one", "inbox|25", 0),
    ] {
        assert!(store.call(&json!({"operation":"settle","accountId":account,"query":query,"generation":generation,"token":first["token"],"failedIds":[]})).is_err());
    }
    let refused=store.call(&json!({"operation":"begin","accountId":"one","query":"inbox|25","generation":1,"view":first["view"],"action":"archive","ids":["a"],"capabilities":{}})).unwrap();
    assert_eq!(refused["refused"], true);
    assert_eq!(store.state.lock().unwrap().contexts.len(), 1);
    store
        .call(&json!({"operation":"reset","accountId":"one"}))
        .unwrap();
    assert!(store.call(&json!({"operation":"settle","accountId":"one","query":"inbox|25","generation":1,"token":first["token"],"failedIds":[]})).is_err());
}
#[test]
fn member_only_and_conversation_targets_replay_thread_flags() {
    let store = IntentStore::default();
    let mut initial = view();
    initial["messages"][0]["thread"] =
        json!({"id":"thread","count":2,"memberIds":["a","member"],"unread":true,"flagged":false});
    initial["previewMessages"] = initial["messages"].clone();
    initial["memberSummaries"] = json!({"a":row("a"),"member":row("member")});
    initial["selectedId"] = json!("member");
    initial["selectedMessage"] = row("member");
    let first = begin(&store, initial, "markRead", json!(["a"]));
    assert_eq!(first["targets"], json!(["a", "member"]));
    assert_eq!(first["expanded"], true);
    assert_eq!(first["view"]["memberSummaries"]["member"]["unread"], false);
    assert_eq!(first["view"]["selectedMessage"]["unread"], false);
    let back = settle(&store, &first["token"], json!(["a"]));
    assert_eq!(back["view"]["messages"][0]["unread"], true);
    assert_eq!(back["view"]["memberSummaries"]["member"]["unread"], true);
}
#[test]
fn detached_reader_edit_never_creates_a_list_row() {
    let store = IntentStore::default();
    let mut initial = view();
    initial["selectedId"] = json!("member");
    initial["selectedMessage"] = row("member");
    initial["selectedThread"] = json!({"id":"thread","memberIds":["missing","member"]});
    initial["memberSummaries"] = json!({"member":row("member")});
    let first = begin(&store, initial, "star", json!(["member"]));
    assert_eq!(first["targets"], json!(["member"]));
    assert_eq!(list(&first["view"]["messages"]).len(), 3);
    assert_eq!(first["view"]["selectedMessage"]["starred"], true);
    let end = settle(&store, &first["token"], json!(["member"]));
    assert_eq!(end["view"]["selectedMessage"]["starred"], false);
}

#[test]
fn coalesced_repeat_shares_original_failure_and_releases_ledger() {
    let store = IntentStore::default();
    let first = begin(&store, view(), "star", json!(["a"]));
    let second = begin(&store, first["view"].clone(), "star", json!(["a"]));
    store.call(&json!({"operation":"coalesce","accountId":"one","query":"inbox|25","generation":1,"token":second["token"],"intoToken":first["token"]})).unwrap();
    assert_eq!(
        store
            .state
            .lock()
            .unwrap()
            .contexts
            .values()
            .next()
            .unwrap()
            .edits
            .len(),
        1
    );
    let rolled = settle(&store, &first["token"], json!(["a"]));
    assert_eq!(rolled["view"]["messages"][0]["starred"], false);
    assert!(store.state.lock().unwrap().contexts.is_empty());
}
#[test]
fn opposite_edit_between_repeats_cannot_coalesce() {
    let store = IntentStore::default();
    let first = begin(&store, view(), "markRead", json!(["a"]));
    let second = begin(&store, first["view"].clone(), "markUnread", json!(["a"]));
    let third = begin(&store, second["view"].clone(), "markRead", json!(["a"]));
    assert_eq!(store.call(&json!({"operation":"coalesce","accountId":"one","query":"inbox|25","generation":1,"token":third["token"],"intoToken":first["token"]})),Err("intent_coalesce_invalid"));
    settle(&store, &second["token"], json!([]));
    settle(&store, &first["token"], json!(["a"]));
    assert_eq!(
        settle(&store, &third["token"], json!([]))["view"]["messages"][0]["unread"],
        false
    );
    assert!(store.state.lock().unwrap().contexts.is_empty());
}
#[test]
fn bounded_context_and_pending_edits_refuse_without_discarding_held_state() {
    let store = IntentStore::default();
    let mut current = view();
    for _ in 0..MAX_EDITS {
        current = begin(&store, current, "star", json!(["a"]))["view"].clone();
    }
    assert_eq!(store.call(&json!({"operation":"begin","accountId":"one","query":"inbox|25","generation":1,"view":current,"action":"star","ids":["a"],"capabilities":{"star":true}})),Err("intent_limit"));
    assert_eq!(
        store
            .state
            .lock()
            .unwrap()
            .contexts
            .values()
            .next()
            .unwrap()
            .edits
            .len(),
        MAX_EDITS
    );
    store
        .call(&json!({"operation":"reset","accountId":"one"}))
        .unwrap();
    assert!(store.state.lock().unwrap().contexts.is_empty());
}

#[test]
fn reader_detail_survives_actions_and_navigation_during_settlement() {
    let store = IntentStore::default();
    let mut initial = view();
    initial["selectedMessage"]["body"] = json!("Keep full message body");
    initial["selectedMessage"]["headers"] = json!([{"name":"X-Test","value":"present"}]);
    let first = begin(&store, initial, "star", json!(["a"]));
    assert_eq!(
        first["view"]["selectedMessage"]["body"],
        "Keep full message body"
    );
    assert_eq!(
        first["view"]["selectedMessage"]["headers"][0]["value"],
        "present"
    );
    let mut moved = row("b");
    moved["body"] = json!("New reader body");
    let end=store.call(&json!({"operation":"settle","accountId":"one","query":"inbox|25","generation":1,"token":first["token"],"failedIds":["a"],"view":{"selectedId":"b","selectedMessage":moved}})).unwrap();
    assert_eq!(end["view"]["selectedId"], "b");
    assert_eq!(end["view"]["selectedMessage"]["body"], "New reader body");
}

#[test]
fn recreated_object_uses_allocated_generation_and_stale_clear_cannot_erase_it() {
    let store = IntentStore::default();
    assert_eq!(
        store
            .call(&json!({"operation":"reset","accountId":"one"}))
            .unwrap()["generation"],
        1
    );
    let first = begin(&store, view(), "star", json!(["a"]));
    assert_eq!(
        store
            .call(&json!({"operation":"reset","accountId":"one"}))
            .unwrap()["generation"],
        2
    );
    let new = store.call(&json!({"operation":"begin","accountId":"one","query":"inbox|25","generation":2,"view":view(),"action":"markRead","ids":["a"]})).unwrap();
    assert_eq!(
        store.call(&json!({"operation":"clear","accountId":"one","generation":1})),
        Err("intent_stale")
    );
    assert_eq!(store.call(&json!({"operation":"settle","accountId":"one","query":"inbox|25","generation":1,"token":first["token"],"failedIds":[]})),Err("intent_stale"));
    assert_eq!(store.call(&json!({"operation":"settle","accountId":"one","query":"inbox|25","generation":2,"token":new["token"],"failedIds":[]})).unwrap()["view"]["messages"][0]["unread"],false);
}
#[test]
fn newly_loaded_detached_member_rolls_back_without_losing_prior_action() {
    let store = IntentStore::default();
    let first = begin(&store, view(), "star", json!(["a"]));
    let mut moved = first["view"].clone();
    moved["selectedId"] = json!("member");
    moved["selectedMessage"] = row("member");
    moved["selectedMessage"]["body"] = json!("detached full body");
    moved["selectedThread"] = json!({"memberIds":["member"]});
    moved["memberSummaries"]["member"] = row("member");
    let second = begin(&store, moved, "star", json!(["member"]));
    assert_eq!(second["targets"], json!(["member"]));
    let end = settle(&store, &second["token"], json!(["member"]));
    assert_eq!(end["view"]["selectedMessage"]["starred"], false);
    assert_eq!(end["view"]["selectedMessage"]["body"], "detached full body");
    assert_eq!(end["view"]["messages"][0]["starred"], true);
    settle(&store, &first["token"], json!([]));
    assert!(store.state.lock().unwrap().contexts.is_empty());
}

#[test]
fn oversized_settlement_is_transactional_and_can_be_retried() {
    let store = IntentStore::default();
    let mut initial = view();
    initial["padding"] = json!("x".repeat(MAX_VIEW / 2 + 1024));
    let first = begin(&store, initial, "star", json!(["a"]));
    let mut detail = row("b");
    detail["body"] = json!("y".repeat(MAX_VIEW / 2 + 1024));
    assert_eq!(store.call(&json!({"operation":"settle","accountId":"one","query":"inbox|25","generation":1,"token":first["token"],"failedIds":["a"],"view":{"selectedId":"b","selectedMessage":detail}})),Err("intent_limit"));
    {
        let state = store.state.lock().unwrap();
        let held = state.contexts.values().next().unwrap();
        assert!(!held.edits[0].settled);
        assert!(!held.edits[0].items[0].failed);
        assert_eq!(held.view, first["view"]);
    }
    assert_eq!(
        settle(&store, &first["token"], json!(["a"]))["view"]["messages"][0]["starred"],
        false
    );
}
#[test]
fn settlement_cannot_exceed_aggregate_retention_budget() {
    let store = IntentStore::default();
    for n in 0..10 {
        let mut initial = view();
        initial["padding"] = json!("x".repeat(1536 * 1024));
        store.call(&json!({"operation":"begin","accountId":format!("other{n}"),"query":"inbox","generation":1,"view":initial,"action":"markRead","ids":["a"]})).unwrap();
    }
    let mut initial = view();
    initial["padding"] = json!("x".repeat(768 * 1024));
    let first = begin(&store, initial, "star", json!(["a"]));
    let mut detail = row("b");
    detail["body"] = json!("y".repeat(1024 * 1024));
    assert_eq!(store.call(&json!({"operation":"settle","accountId":"one","query":"inbox|25","generation":1,"token":first["token"],"failedIds":[],"view":{"selectedId":"b","selectedMessage":detail}})),Err("intent_limit"));
    assert!(
        !store.state.lock().unwrap().contexts[&("one".into(), "inbox|25".into())].edits[0].settled
    );
    settle(&store, &first["token"], json!([]));
}
#[test]
fn malformed_clear_never_discards_pending_ledger() {
    let store = IntentStore::default();
    let first = begin(&store, view(), "star", json!(["a"]));
    for generation in [Value::Null, json!("1"), json!(-1)] {
        assert_eq!(
            store.call(&json!({"operation":"clear","accountId":"one","generation":generation})),
            Err("intent_invalid")
        );
    }
    assert_eq!(
        settle(&store, &first["token"], json!(["a"]))["view"]["messages"][0]["starred"],
        false
    );
}

#[test]
fn future_generation_begin_cannot_discard_existing_intents() {
    let store = IntentStore::default();
    let first = begin(&store, view(), "star", json!(["a"]));
    assert_eq!(store.call(&json!({"operation":"begin","accountId":"one","query":"inbox|25","generation":2,"view":view(),"action":"archive","ids":["a"],"capabilities":{}})),Err("intent_stale"));
    assert_eq!(
        settle(&store, &first["token"], json!(["a"]))["view"]["messages"][0]["starred"],
        false
    );
}

#[test]
fn gmail_trash_keeps_captured_id_when_reader_and_list_selection_change() {
    let store = IntentStore::default();
    let mut moved = view();
    moved["selectedId"] = json!("b");
    moved["selectedMessage"] = row("b");
    moved["messages"] = json!([row("c"), row("b"), row("a")]);
    let prepared = begin(&store, moved, "trash", json!(["a"]));
    assert_eq!(prepared["targets"], json!(["a"]));
    assert_eq!(prepared["rows"], json!(["a"]));
    assert_eq!(prepared["targetsOf"]["a"], json!(["a"]));
    assert_eq!(prepared["view"]["selectedId"], "b");
    assert_eq!(prepared["view"]["selectedMessage"]["id"], "b");
    assert_eq!(prepared["view"]["messages"], json!([row("c"), row("b")]));
    let settled = settle(&store, &prepared["token"], json!([]));
    assert_eq!(settled["targets"], json!(["a"]));
    assert_eq!(settled["view"]["selectedId"], "b");
}
