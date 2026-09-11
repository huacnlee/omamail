use super::*;
fn row(id: &str, subject: &str, at: i64, labels: Value) -> Value {
    json!({"id":id,"subject":subject,"dateMs":at,"labelIds":labels,"from":{"email":"sender@example.org"}})
}
#[test]
fn conservative_search_terms_and_provider_scope() {
    let mut store = store::empty();
    store["queries"] = json!({"folder:INBOX|25":{"at":2,"summaries":[row("in","needle",10,json!([]))]},"folder:Sent|25":{"at":1,"summaries":[row("sent","needle",20,json!([]))]}});
    assert_eq!(search(&store, "needle", "imap").len(), 1);
    assert_eq!(search(&store, "needle", "hey").len(), 2);
    assert!(search(&store, "from:sender", "gmail").is_empty());
    store["queries"]["folder:INBOX|25"]["summaries"][0]["labelIds"] = json!(["TRASH"]);
    assert_eq!(search(&store, "needle", "gmail").len(), 1);
    assert_eq!(query_key("  in:inbox  ", 25), "in:inbox|25");
}
#[test]
fn newest_copy_owns_scope_and_older_copy_can_supply_search_fields() {
    let mut store = store::empty();
    store["queries"] = json!({"in:trash|25":{"at":20,"summaries":[row("id","",20,json!(["TRASH"]))]},"in:inbox|25":{"at":10,"summaries":[row("id","needle",10,json!([]))]}});
    assert!(search(&store, "needle", "gmail").is_empty());
    store["queries"]["in:trash|25"]["summaries"][0]["labelIds"] = json!([]);
    store["queries"]["new|25"] = store["queries"]["in:trash|25"].clone();
    store["queries"]
        .as_object_mut()
        .unwrap()
        .remove("in:trash|25");
    let found = search(&store, "needle", "gmail");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["dateMs"], 20);
}
#[test]
fn page_caps_close_pagination_and_prunes_old_queries() {
    let rows: Vec<_> = (0..101)
        .map(|id| row(&id.to_string(), "subject", id, json!([])))
        .collect();
    let page = page(
        &json!({"summaries":rows,"nextPageToken":"unsafe","estimate":101}),
        42,
    );
    assert_eq!(page["summaries"].as_array().unwrap().len(), 100);
    assert_eq!(page["nextPageToken"], "");
    let mut store = store::empty();
    for n in 0..13 {
        store["queries"][n.to_string()] = json!({"summaries":[],"at":n});
    }
    let store = store::normalize_store(&store);
    assert_eq!(store["queries"].as_object().unwrap().len(), 12);
    assert!(store["queries"].get("0").is_none());
}
#[tokio::test]
async fn stale_generation_cannot_mutate_or_read_new_session() {
    let cache = QueryCache::default();
    let shared = cache.account("imap:one@example.org").await.unwrap();
    {
        let mut state = shared.lock().await;
        state.loaded = true;
        state.generation = 2;
    }
    let stale = json!({"accountId":"imap:one@example.org","generation":1,"key":"q|25","page":{"summaries":[]}});
    assert_eq!(
        cache.call("cache.queryPut", &stale).await,
        Err("cache_stale_generation")
    );
    assert_eq!(
        cache.call("cache.queryGet", &stale).await,
        Err("cache_stale_generation")
    );
    assert!(
        shared.lock().await.store["queries"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    let other = cache.account("imap:two@example.org").await.unwrap();
    assert!(!other.lock().await.loaded);
}
#[test]
fn ttl_clock_reversal_and_quoted_imap_scope() {
    assert!(stale(0.0, 100.0, 10.0));
    assert!(!stale(100.0, 90.0, 10.0));
    assert!(!stale(100.0, 110.0, 10.0));
    assert!(stale(100.0, 111.0, 10.0));
    assert!(!eligible("imap", "folder:\"INBOX Sent\"", &json!({})));
    assert!(eligible("outlook", "folder:\"INBOX\" UNSEEN", &json!({})));
    assert!(!eligible("jmap", "role:junk", &json!({})));
    assert!(eligible("hey", "role:junk", &json!({})));
}
#[tokio::test]
async fn live_query_mutation_restore_disk_and_account_boundary() {
    let root = std::env::temp_dir().join(format!(
        "omamail-query-cache-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&root).unwrap();
    let cache = QueryCache {
        root: Some(root.clone()),
        ..Default::default()
    };
    let restored = cache
        .call(
            "cache.queryRestore",
            &json!({"accountId":"imap:one@example.org"}),
        )
        .await
        .unwrap();
    let generation = restored["generation"].clone();
    assert!(restored["store"].get("queries").is_none());
    let mut params = json!({"accountId":"imap:one@example.org","generation":generation,"query":"folder:INBOX","limit":25,"page":{"summaries":[row("id","needle",42,json!([]))],"estimate":1,"nextPageToken":"next"}});
    cache.call("cache.queryPut", &params).await.unwrap();
    params["search"] = json!("needle");
    let found = cache.call("cache.queryGet", &params).await.unwrap();
    assert_eq!(found["key"], "folder:INBOX|25");
    assert_eq!(found["summaries"].as_array().unwrap().len(), 1);
    assert_eq!(found["stale"], false);
    cache.call("cache.queryFlush", &params).await.unwrap();
    let other = cache
        .call(
            "cache.queryRestore",
            &json!({"accountId":"imap:two@example.org"}),
        )
        .await
        .unwrap();
    let wrong=cache.call("cache.queryGet",&json!({"accountId":"imap:two@example.org","generation":other["generation"],"query":"folder:INBOX","search":"needle"})).await.unwrap();
    assert!(wrong["summaries"].as_array().unwrap().is_empty());
    let second = QueryCache {
        root: Some(root.clone()),
        ..Default::default()
    };
    let loaded = second
        .call(
            "cache.queryRestore",
            &json!({"accountId":"imap:one@example.org"}),
        )
        .await
        .unwrap();
    params["generation"] = loaded["generation"].clone();
    assert_eq!(
        second.call("cache.queryGet", &params).await.unwrap()["summaries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    params["ids"] = json!(["id"]);
    second.call("cache.queryInvalidate", &params).await.unwrap();
    assert!(second.call("cache.queryGet", &params).await.unwrap()["entry"].is_null());
    second.call("cache.queryFlush", &params).await.unwrap();
    // No delayed writer has dirty state after the explicit flush.
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn account_limit_refuses_eviction_of_live_references() {
    let cache = QueryCache::default();
    let mut live = Vec::new();
    for n in 0..MAX_ACCOUNTS {
        live.push(cache.account(&format!("{n}@example.org")).await.unwrap());
    }
    assert!(matches!(
        cache.account("overflow@example.org").await,
        Err("cache_busy")
    ));
    drop(live);
    cache.account("overflow@example.org").await.unwrap();
    assert_eq!(cache.accounts.lock().await.len(), MAX_ACCOUNTS);
}

#[tokio::test]
async fn shutdown_flushes_debounced_writes_and_restores_legacy_direction() {
    let root = std::env::temp_dir().join(format!(
        "omamail-query-shutdown-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&root).unwrap();
    let cache = QueryCache {
        root: Some(root.clone()),
        ..Default::default()
    };
    for account in ["one@example.org", "imap:two@example.org"] {
        let restored = cache
            .call("cache.queryRestore", &json!({"accountId":account}))
            .await
            .unwrap();
        cache.call("cache.queryPut", &json!({"accountId":account,"generation":restored["generation"],"query":"q","page":{"summaries":[{"id":"id","subject":"Re: مرحبا"}]}})).await.unwrap();
    }
    cache.shutdown().await.unwrap();
    for account in ["one@example.org", "imap:two@example.org"] {
        let disk = disk(
            Some(root.clone()),
            "cache.storeRead",
            &json!({"accountId":account}),
        )
        .unwrap();
        assert_eq!(
            disk["queries"]["q|25"]["summaries"][0]["subjectDirection"],
            "rtl"
        );
        assert!(!cache.account(account).await.unwrap().lock().await.dirty);
    }
    // Old v2 rows receive the same metadata without a network refresh.
    let legacy = store::normalize_store(
        &json!({"version":2,"queries":{"q|25":{"summaries":[{"id":"old","subject":"Re: مرحبا"}],"at":1}}}),
    );
    assert_eq!(
        legacy["queries"]["q|25"]["summaries"][0]["subjectDirection"],
        "rtl"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn background_prefetch_preserves_ui_generation_and_cancelled_job_does_not_mutate() {
    let temp = super::super::tests::Temp::new();
    let cache = QueryCache::at(temp.0.clone());
    let account = "one@example.org";
    let restored = cache
        .call("cache.queryRestore", &json!({"accountId":account}))
        .await
        .unwrap();
    cache
        .prefetch(
            account,
            "in:inbox",
            25,
            &json!({"summaries":[{"id":"new","subject":"Re: مرحبا"}]}),
            Arc::new(Mutex::new(true)),
        )
        .await
        .unwrap();
    let got = cache.call("cache.queryGet",&json!({"accountId":account,"generation":restored["generation"],"query":"in:inbox","limit":25})).await.unwrap();
    assert_eq!(got["summaries"][0]["id"], "new");
    assert_eq!(
        cache
            .prefetch(
                account,
                "in:inbox",
                25,
                &json!({"summaries":[]}),
                Arc::new(Mutex::new(false))
            )
            .await,
        Err("cache_cancelled")
    );
    cache.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_prefetch_never_reaches_later_ui_flush() {
    let temp = super::super::tests::Temp::new();
    let cache = QueryCache::at(temp.0.clone());
    let account = "one@example.org";
    let restored = cache
        .call("cache.queryRestore", &json!({"accountId":account}))
        .await
        .unwrap();
    let live = Arc::new(Mutex::new(true));
    cache
        .prefetch(
            account,
            "in:inbox",
            25,
            &json!({"summaries":[{"id":"committed"}]}),
            live.clone(),
        )
        .await
        .unwrap();
    let before = disk(
        Some(temp.0.clone()),
        "cache.storeRead",
        &json!({"accountId":account}),
    )
    .unwrap();
    assert_eq!(
        before["queries"]["in:inbox|25"]["summaries"][0]["id"],
        "committed"
    );
    *live.lock().unwrap() = false;
    assert_eq!(
        cache
            .prefetch(
                account,
                "in:inbox",
                25,
                &json!({"summaries":[{"id":"cancelled"}]}),
                live
            )
            .await,
        Err("cache_cancelled")
    );
    cache
        .call(
            "cache.queryLabels",
            &json!({"accountId":account,"generation":restored["generation"],"labels":[]}),
        )
        .await
        .unwrap();
    cache.shutdown().await.unwrap();
    let after = disk(
        Some(temp.0.clone()),
        "cache.storeRead",
        &json!({"accountId":account}),
    )
    .unwrap();
    assert_eq!(after["queries"], before["queries"]);
}
