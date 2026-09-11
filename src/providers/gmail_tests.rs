use super::*;

#[test]
fn resource_methods_validate_before_credentials() {
    let session = Session::default();
    for method in [
        "gmail.labels",
        "gmail.labelCounts",
        "gmail.profile",
        "gmail.sendAs",
    ] {
        assert_eq!(
            session.call(
                method,
                &json!({"accountId":"a@example.org", "unexpected":true})
            ),
            Err("invalid_params")
        );
    }
    assert_eq!(
        session.call("gmail.labelCounts", &json!({"accountId":"a@example.org"})),
        Err("invalid_params")
    );
}
use std::cell::Cell;

fn grant(value: &str) -> Result<Value, &'static str> {
    Ok(json!({"access_token":value,"expires_in":3600}))
}

#[test]
fn unauthorized_reauthenticates_once_and_caches_replacement() {
    let session = Session::default();
    let refreshes = Cell::new(0);
    let gets = Cell::new(0);
    let result = session.get_with(
        "one",
        || {
            refreshes.set(refreshes.get() + 1);
            grant(if refreshes.get() == 1 { "old" } else { "new" })
        },
        |token| {
            gets.set(gets.get() + 1);
            if token == "old" {
                Err("gmail_unauthorized")
            } else {
                Ok(json!({"id":"mail"}))
            }
        },
    );
    assert_eq!(result, Ok(json!({"id":"mail"})));
    assert_eq!(refreshes.get(), 2);
    assert_eq!(gets.get(), 2);
    assert_eq!(
        session.get_with(
            "one",
            || panic!("cached token lost"),
            |token| Ok(json!(token))
        ),
        Ok(json!("new"))
    );
}

#[test]
fn repeated_unauthorized_stops_after_one_retry() {
    let session = Session::default();
    let refreshes = Cell::new(0);
    let gets = Cell::new(0);
    assert_eq!(
        session.get_with(
            "one",
            || {
                refreshes.set(refreshes.get() + 1);
                grant("token")
            },
            |_| {
                gets.set(gets.get() + 1);
                Err("gmail_unauthorized")
            }
        ),
        Err("gmail_unauthorized")
    );
    assert_eq!(refreshes.get(), 2);
    assert_eq!(gets.get(), 2);
}

#[test]
fn non_authentication_errors_do_not_retry() {
    let session = Session::default();
    let refreshes = Cell::new(0);
    let gets = Cell::new(0);
    assert_eq!(
        session.get_with(
            "one",
            || {
                refreshes.set(refreshes.get() + 1);
                grant("token")
            },
            |_| {
                gets.set(gets.get() + 1);
                Err("gmail_http_failed")
            }
        ),
        Err("gmail_http_failed")
    );
    assert_eq!(refreshes.get(), 1);
    assert_eq!(gets.get(), 1);
}

#[test]
fn invalidation_stops_old_request_retry_but_allows_new_requests() {
    let session = Session::default();
    let refreshes = Cell::new(0);
    assert_eq!(
        session.get_with(
            "one",
            || {
                refreshes.set(refreshes.get() + 1);
                grant("old")
            },
            |_| {
                session
                    .call("gmail.invalidate", &json!({"accountId":"one"}))
                    .unwrap();
                Err("gmail_unauthorized")
            }
        ),
        Err("gmail_session_invalidated")
    );
    assert_eq!(refreshes.get(), 1);
    assert_eq!(
        session.get_with("one", || grant("new"), |token| Ok(json!(token))),
        Ok(json!("new"))
    );
}

#[test]
fn old_unauthorized_cannot_evict_concurrently_refreshed_token() {
    let session = Session::default();
    let first = Cell::new(true);
    let result = session.get_with(
        "one",
        || grant("old"),
        |token| {
            if first.replace(false) {
                assert_eq!(
                    session.get_with(
                        "one",
                        || grant("new"),
                        |inner| {
                            if inner == "old" {
                                Err("gmail_unauthorized")
                            } else {
                                Ok(json!(inner))
                            }
                        }
                    ),
                    Ok(json!("new"))
                );
                Err("gmail_unauthorized")
            } else {
                Ok(json!(token))
            }
        },
    );
    assert_eq!(result, Ok(json!("new")));
}

#[test]
fn invalidation_during_refresh_cannot_publish_token_or_send_get() {
    use std::sync::mpsc;
    let session = Session::default();
    let (started, wait_start) = mpsc::channel();
    let (done, wait_done) = mpsc::channel();
    std::thread::scope(|scope| {
        let session = &session;
        scope.spawn(move || {
            wait_start.recv_timeout(Duration::from_secs(2)).unwrap();
            session
                .call("gmail.invalidate", &json!({"accountId":"one"}))
                .unwrap();
            done.send(()).unwrap();
        });
        assert_eq!(
            session.get_with(
                "one",
                || {
                    started.send(()).unwrap();
                    assert!(
                        wait_done.recv_timeout(Duration::from_secs(2)).is_ok(),
                        "invalidate must not wait for remote refresh"
                    );
                    grant("old")
                },
                |_| panic!("invalidated refresh must not send HTTP GET")
            ),
            Err("gmail_session_invalidated")
        );
    });
    assert_eq!(
        session.get_with("one", || grant("new"), |token| Ok(json!(token))),
        Ok(json!("new"))
    );
}

#[test]
fn invalidate_is_idempotent_without_config_or_keyring() {
    let session = Session::default();
    for _ in 0..2 {
        assert_eq!(
            session.call(
                "gmail.invalidate",
                &json!({"accountId":"synthetic@example.org"})
            ),
            Ok(json!({"invalidated":true}))
        );
    }
    assert_eq!(
        session.call(
            "gmail.invalidate",
            &json!({"accountId":"synthetic@example.org", "extra":true})
        ),
        Err("invalid_params")
    );
}
