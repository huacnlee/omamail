use super::*;

#[tokio::test]
async fn resource_methods_validate_before_credentials() {
    let session = &Session::default();
    for method in [
        "gmail.labels",
        "gmail.labelCounts",
        "gmail.profile",
        "gmail.sendAs",
    ] {
        assert_eq!(
            session
                .call(
                    method,
                    &json!({"accountId":"a@example.org", "unexpected":true})
                )
                .await,
            Err("invalid_params")
        );
    }
    assert_eq!(
        session
            .call("gmail.labelCounts", &json!({"accountId":"a@example.org"}))
            .await,
        Err("invalid_params")
    );
}
use std::cell::Cell;

fn grant(value: &str) -> Result<Value, &'static str> {
    Ok(json!({"access_token":value,"expires_in":3600}))
}

#[tokio::test]
async fn unauthorized_reauthenticates_once_and_caches_replacement() {
    let session = &Session::default();
    let refreshes = &Cell::new(0);
    let gets = &Cell::new(0);
    let result = session
        .get_with(
            "one",
            || async {
                refreshes.set(refreshes.get() + 1);
                grant(if refreshes.get() == 1 { "old" } else { "new" })
            },
            |token| async move {
                gets.set(gets.get() + 1);
                if token == "old" {
                    Err("gmail_unauthorized")
                } else {
                    Ok(json!({"id":"mail"}))
                }
            },
        )
        .await;
    assert_eq!(result, Ok(json!({"id":"mail"})));
    assert_eq!(refreshes.get(), 2);
    assert_eq!(gets.get(), 2);
    assert_eq!(
        session
            .get_with(
                "one",
                || async { panic!("cached token lost") },
                |token| async move { Ok(json!(token)) }
            )
            .await,
        Ok(json!("new"))
    );
}

#[tokio::test]
async fn repeated_unauthorized_stops_after_one_retry() {
    let session = &Session::default();
    let refreshes = &Cell::new(0);
    let gets = &Cell::new(0);
    assert_eq!(
        session
            .get_with(
                "one",
                || async {
                    refreshes.set(refreshes.get() + 1);
                    grant("token")
                },
                |_| async {
                    gets.set(gets.get() + 1);
                    Err("gmail_unauthorized")
                }
            )
            .await,
        Err("gmail_unauthorized")
    );
    assert_eq!(refreshes.get(), 2);
    assert_eq!(gets.get(), 2);
}

#[tokio::test]
async fn non_authentication_errors_do_not_retry() {
    let session = &Session::default();
    let refreshes = &Cell::new(0);
    let gets = &Cell::new(0);
    assert_eq!(
        session
            .get_with(
                "one",
                || async {
                    refreshes.set(refreshes.get() + 1);
                    grant("token")
                },
                |_| async {
                    gets.set(gets.get() + 1);
                    Err("gmail_http_failed")
                }
            )
            .await,
        Err("gmail_http_failed")
    );
    assert_eq!(refreshes.get(), 1);
    assert_eq!(gets.get(), 1);
}

#[tokio::test]
async fn invalidation_stops_old_request_retry_but_allows_new_requests() {
    let session = &Session::default();
    let refreshes = &Cell::new(0);
    assert_eq!(
        session
            .get_with(
                "one",
                || async {
                    refreshes.set(refreshes.get() + 1);
                    grant("old")
                },
                |_| async {
                    session
                        .call("gmail.invalidate", &json!({"accountId":"one"}))
                        .await
                        .unwrap();
                    Err("gmail_unauthorized")
                }
            )
            .await,
        Err("gmail_session_invalidated")
    );
    assert_eq!(refreshes.get(), 1);
    assert_eq!(
        session
            .get_with(
                "one",
                || async { grant("new") },
                |token| async move { Ok(json!(token)) }
            )
            .await,
        Ok(json!("new"))
    );
}

#[tokio::test]
async fn old_unauthorized_cannot_evict_concurrently_refreshed_token() {
    let session = &Session::default();
    let first = &Cell::new(true);
    let result = session
        .get_with(
            "one",
            || async { grant("old") },
            |token| async move {
                if first.replace(false) {
                    assert_eq!(
                        session
                            .get_with(
                                "one",
                                || async { grant("new") },
                                |inner| async move {
                                    if inner == "old" {
                                        Err("gmail_unauthorized")
                                    } else {
                                        Ok(json!(inner))
                                    }
                                }
                            )
                            .await,
                        Ok(json!("new"))
                    );
                    Err("gmail_unauthorized")
                } else {
                    Ok(json!(token))
                }
            },
        )
        .await;
    assert_eq!(result, Ok(json!("new")));
}

#[tokio::test]
async fn invalidation_during_refresh_cannot_publish_token_or_send_get() {
    let session = &Session::default();
    let started = tokio::sync::Notify::new();
    let done = tokio::sync::Notify::new();
    let request = session.get_with(
        "one",
        || async {
            started.notify_one();
            tokio::time::timeout(Duration::from_secs(2), done.notified())
                .await
                .expect("invalidate must not wait for remote refresh");
            grant("old")
        },
        |_| async { panic!("invalidated refresh must not send HTTP GET") },
    );
    let invalidate = async {
        started.notified().await;
        session
            .call("gmail.invalidate", &json!({"accountId":"one"}))
            .await
            .unwrap();
        done.notify_one();
    };
    let (result, ()) = tokio::join!(request, invalidate);
    assert_eq!(result, Err("gmail_session_invalidated"));
    assert_eq!(
        session
            .get_with(
                "one",
                || async { grant("new") },
                |token| async move { Ok(json!(token)) }
            )
            .await,
        Ok(json!("new"))
    );
}

#[tokio::test]
async fn slow_account_refresh_does_not_stall_another_account() {
    // A single-thread runtime proves the wait yields, rather than being hidden by workers.
    let session = &Session::default();
    let started = tokio::sync::Notify::new();
    let release = tokio::sync::Notify::new();
    let slow = session.get_with(
        "slow",
        || async {
            started.notify_one();
            release.notified().await;
            grant("slow-token")
        },
        |token| async move { Ok(json!(token)) },
    );
    let fast = async {
        started.notified().await;
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            session.get_with(
                "fast",
                || async { grant("fast-token") },
                |token| async move { Ok(json!(token)) },
            ),
        )
        .await
        .expect("fast account must finish before slow refresh is released");
        release.notify_one();
        result
    };
    let (slow, fast) = tokio::join!(slow, fast);
    assert_eq!(slow, Ok(json!("slow-token")));
    assert_eq!(fast, Ok(json!("fast-token")));
}

#[tokio::test]
async fn concurrent_requests_coalesce_refresh_for_one_account() {
    let session = &Session::default();
    let refreshes = &Cell::new(0);
    let refresh = || async {
        refreshes.set(refreshes.get() + 1);
        tokio::task::yield_now().await;
        grant("shared")
    };
    let (first, second) = tokio::join!(
        session.get_with("one", refresh, |token| async move { Ok(json!(token)) }),
        session.get_with("one", refresh, |token| async move { Ok(json!(token)) })
    );
    assert_eq!(first, Ok(json!("shared")));
    assert_eq!(second, first);
    assert_eq!(refreshes.get(), 1);
}

#[tokio::test]
async fn invalidate_is_idempotent_without_config_or_keyring() {
    let session = &Session::default();
    for _ in 0..2 {
        assert_eq!(
            session
                .call(
                    "gmail.invalidate",
                    &json!({"accountId":"synthetic@example.org"})
                )
                .await,
            Ok(json!({"invalidated":true}))
        );
    }
    assert_eq!(
        session
            .call(
                "gmail.invalidate",
                &json!({"accountId":"synthetic@example.org", "extra":true})
            )
            .await,
        Err("invalid_params")
    );
}

#[tokio::test]
async fn credentials_failure_prevents_refresh_and_mail_network_requests() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let transport = reqwest::Client::builder().no_proxy().build().unwrap();
    let session = Session::default();
    let client = gmail_credentials::Client {
        client_id: "123-synthetic.apps.googleusercontent.com".into(),
        client_secret: "synthetic-client-secret".into(),
    };
    gmail_http::with_test_transport(transport, origin, async {
        for (failure, expected) in [
            (crate::credentials::Error::Missing, "gmail_token_missing"),
            (
                crate::credentials::Error::Unavailable,
                "gmail_keyring_failed",
            ),
        ] {
            let result = session
                .get_with(
                    "synthetic@example.org",
                    || async {
                        let refresh = gmail_credentials::lookup_with(
                            &client,
                            "synthetic@example.org",
                            |_| Err(failure),
                        )?;
                        gmail_http::refresh(&client.client_id, &client.client_secret, &refresh)
                            .await
                    },
                    |token| async move { gmail_http::get(&["profile"], &[], &token).await },
                )
                .await;
            assert_eq!(result, Err(expected));
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err(),
                "failed credential lookup opened a network connection"
            );
        }
    })
    .await;
}

// Gmail meters each user at 250 quota units per second and answers a burst
// past that with 403 rateLimitExceeded. Trashing a screen of conversations
// fires one 5-unit call per message, so the session paces every account
// below that line instead of letting the burst reach Google.
#[tokio::test(start_paused = true)]
async fn quota_pacing_lets_a_page_through_and_spreads_a_bulk_trash() {
    let session = Session::default();
    let account = session.account("one").unwrap();
    let started = tokio::time::Instant::now();
    // A page load: one list plus 25 metadata reads, well inside one second.
    for _ in 0..26 {
        account.pace(5).await.unwrap();
    }
    assert_eq!(started.elapsed(), Duration::ZERO);
    // 100 concurrent trash calls are 500 units: at most a burst now, the rest
    // released at the sustained rate rather than all at once.
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..100 {
        let account = Arc::clone(&account);
        tasks.spawn(async move {
            account.pace(5).await.unwrap();
            tokio::time::Instant::now()
        });
    }
    let mut finished = Vec::new();
    while let Some(at) = tasks.join_next().await {
        finished.push(at.unwrap());
    }
    finished.sort();
    let immediate = finished.iter().filter(|at| **at == started).count();
    assert!(
        immediate <= 40,
        "{immediate} calls burst past the quota line"
    );
    let last = finished.last().unwrap().duration_since(started);
    assert!(
        last >= Duration::from_millis(1500),
        "bulk trash finished in {last:?}"
    );
    assert!(
        last <= Duration::from_millis(3500),
        "bulk trash took {last:?}"
    );

    // A cost above the burst size still runs, after the bucket has filled.
    account.pace(u32::MAX).await.unwrap();
    let after = tokio::time::Instant::now();
    account.pace(5).await.unwrap();
    assert!(tokio::time::Instant::now() > after);

    // Accounts do not share a bucket.
    let other = session.account("two").unwrap();
    let before = tokio::time::Instant::now();
    other.pace(5).await.unwrap();
    assert_eq!(tokio::time::Instant::now(), before);

    // A queue deeper than the IPC deadline fails its tail now, not after a
    // timeout that would read as a mutation of unknown outcome.
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..1000 {
        let other = Arc::clone(&other);
        tasks.spawn(async move { other.pace(5).await });
    }
    let mut refused = 0;
    while let Some(result) = tasks.join_next().await {
        refused += usize::from(result.unwrap() == Err("gmail_rate_limited"));
    }
    assert!(
        refused > 0,
        "5000 units at 200/s all waited past the deadline"
    );
    assert!(
        tokio::time::Instant::now().duration_since(before)
            <= QUOTA_MAX_WAIT + Duration::from_secs(1),
        "refused calls waited anyway"
    );
}
