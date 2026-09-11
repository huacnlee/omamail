use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

pub(super) struct Temp(pub(super) PathBuf);
impl Temp {
    pub(super) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "omamail-native-cache-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn account(&self) -> PathBuf {
        self.0.join("omamail/bodies/account-you_40example.org")
    }
    fn call(&self, method: &str, extra: Value) -> Result<Value> {
        let mut params = json!({"accountId":"you@example.org", "id":"message"});
        for (key, value) in extra.as_object().unwrap() {
            params[key] = value.clone();
        }
        call_at(&self.0, method, &params)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn legacy_names_preserve_case_rules_unicode_escapes_and_long_account_hashes() {
    assert_eq!(
        account_name("GMAIL:É+😀@Example.COM").unwrap(),
        "account-gmail_3a_c3_a9_2b_f0_9f_98_80_40example.com"
    );
    assert_eq!(
        account_name(&format!("{}@example.com", "a".repeat(160))).unwrap(),
        format!("account-{}-b561a31f", "a".repeat(120))
    );
    assert_eq!(
        body_name("  A/B:é😀\\!%  ").unwrap(),
        "_41_2f_42_3a_c3_a9_f0_9f_98_80_5c_21_25.json"
    );
    assert_eq!(body_name("..").unwrap(), "...json");
}

#[test]
fn legacy_read_normalizes_body_and_updates_lru_without_rewriting_content() {
    let temp = Temp::new();
    std::fs::create_dir_all(temp.account()).unwrap();
    let path = temp.account().join("message.json");
    let legacy = br#"{"text":"hello","html":"<b>world</b>","attachments":[{"name":"x"}],"images":"invalid","invite":{"title":"meeting"},"unsubscribe":[],"ignored":true}"#;
    std::fs::write(&path, legacy).unwrap();
    File::open(&path)
        .unwrap()
        .set_modified(SystemTime::UNIX_EPOCH)
        .unwrap();
    assert_eq!(
        temp.call("cache.bodyRead", json!({})).unwrap(),
        json!({"text":"hello","bodyDirection":"ltr","source":"","html":"<b>world</b>","attachments":[{"name":"x"}],"images":[],"invite":{"title":"meeting"},"unsubscribe":null})
    );
    assert_eq!(std::fs::read(&path).unwrap(), legacy);
    assert!(std::fs::metadata(&path).unwrap().modified().unwrap() > SystemTime::UNIX_EPOCH);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn put_touch_clear_are_private_and_preserve_other_accounts() {
    let temp = Temp::new();
    assert_eq!(temp.call("cache.bodyRead", json!({})).unwrap(), Value::Null);
    assert_eq!(
        temp.call("cache.bodyTouch", json!({})).unwrap(),
        json!({"touched":false})
    );
    assert_eq!(
        temp.call("cache.bodyPut", json!({"body":{"text":"é\nsecret"}}))
            .unwrap(),
        json!({"stored":true})
    );
    assert_eq!(
        std::fs::metadata(temp.account())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let path = temp.account().join("message.json");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    File::open(&path)
        .unwrap()
        .set_modified(SystemTime::UNIX_EPOCH)
        .unwrap();
    assert_eq!(
        temp.call("cache.bodyTouch", json!({})).unwrap(),
        json!({"touched":true})
    );
    assert!(std::fs::metadata(&path).unwrap().modified().unwrap() > SystemTime::UNIX_EPOCH);
    temp.call(
        "cache.bodyPut",
        json!({"accountId":"other@example.org","body":{"text":"other"}}),
    )
    .unwrap();
    assert_eq!(
        temp.call("cache.bodyClear", json!({})).unwrap(),
        json!({"cleared":true})
    );
    assert_eq!(temp.call("cache.bodyRead", json!({})).unwrap(), Value::Null);
    assert_eq!(
        temp.call("cache.bodyRead", json!({"accountId":"other@example.org"}))
            .unwrap()["text"],
        "other"
    );
}

#[test]
fn put_is_atomic_and_prunes_oldest_while_preserving_recently_touched_body() {
    let temp = Temp::new();
    std::fs::create_dir_all(temp.account()).unwrap();
    for index in 0..MAX_BODIES {
        let path = temp.account().join(format!("{index:04}.json"));
        std::fs::write(&path, b"{\"text\":\"old\"}").unwrap();
        File::open(&path)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(index as u64 + 1))
            .unwrap();
    }
    temp.call("cache.bodyTouch", json!({"id":"0000"})).unwrap();
    temp.call("cache.bodyPut", json!({"body":{"text":"new"}}))
        .unwrap();
    assert!(temp.account().join("0000.json").exists());
    assert!(!temp.account().join("0001.json").exists());
    assert_eq!(
        std::fs::read_dir(temp.account()).unwrap().count(),
        MAX_BODIES
    );
    let old_reader = File::open(temp.account().join("message.json")).unwrap();
    temp.call("cache.bodyPut", json!({"body":{"text":"replacement"}}))
        .unwrap();
    let old: Value = serde_json::from_reader(old_reader).unwrap();
    assert_eq!(old["text"], "new");
    assert_eq!(
        temp.call("cache.bodyRead", json!({})).unwrap()["text"],
        "replacement"
    );
    assert_eq!(
        std::fs::read_dir(temp.account()).unwrap().count(),
        MAX_BODIES
    );
}

#[test]
fn corrupt_and_oversize_reads_are_misses_and_oversize_puts_write_nothing() {
    let temp = Temp::new();
    std::fs::create_dir_all(temp.account()).unwrap();
    let path = temp.account().join("message.json");
    for bytes in [b"broken".as_slice(), b"[]", b"null", b"\xff"] {
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(temp.call("cache.bodyRead", json!({})).unwrap(), Value::Null);
    }
    File::create(&path)
        .unwrap()
        .set_len(MAX_BODY as u64 + 1)
        .unwrap();
    assert_eq!(temp.call("cache.bodyRead", json!({})).unwrap(), Value::Null);
    assert_eq!(
        temp.call(
            "cache.bodyPut",
            json!({"id":"new","body":{"text":"x".repeat(MAX_BODY)}})
        ),
        Err("cache_body_too_large")
    );
    assert!(!temp.account().join("new.json").exists());
}

#[test]
fn controls_and_invalid_params_produce_no_cache_directory() {
    let temp = Temp::new();
    for value in ["", "x\0", "x\r", "x\n", "x\r\n", "x\t", "x\u{7f}"] {
        for key in ["accountId", "id"] {
            let mut params = json!({"body":{"text":"secret"}});
            params[key] = json!(value);
            assert_eq!(
                temp.call("cache.bodyPut", params),
                Err("cache_invalid_input")
            );
        }
    }
    for invalid in [Value::Null, json!(42), json!([])] {
        assert_eq!(
            temp.call("cache.bodyPut", json!({"id":invalid,"body":{}})),
            Err("cache_invalid_input")
        );
    }
    assert_eq!(
        temp.call("cache.bodyPut", json!({"id":"A".repeat(100),"body":{}})),
        Err("cache_invalid_input")
    );
    assert!(!temp.0.join("omamail").exists());
}

#[test]
fn final_symlink_and_hardlink_refuse_read_write_touch_clear_without_target_effects() {
    for hardlink in [false, true] {
        let temp = Temp::new();
        std::fs::create_dir_all(temp.account()).unwrap();
        let outside = temp.0.join("outside");
        std::fs::write(&outside, b"{\"text\":\"secret-outside\"}").unwrap();
        File::open(&outside)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH)
            .unwrap();
        if hardlink {
            std::fs::hard_link(&outside, temp.account().join("message.json")).unwrap();
        } else {
            symlink(&outside, temp.account().join("message.json")).unwrap();
        }
        for method in [
            "cache.bodyRead",
            "cache.bodyPut",
            "cache.bodyTouch",
            "cache.bodyClear",
        ] {
            assert_eq!(
                temp.call(method, json!({"body":{"text":"overwrite"}})),
                Err("cache_unsafe_path")
            );
            assert_eq!(
                std::fs::read(&outside).unwrap(),
                b"{\"text\":\"secret-outside\"}"
            );
            assert_eq!(
                std::fs::metadata(&outside).unwrap().modified().unwrap(),
                SystemTime::UNIX_EPOCH
            );
            assert!(std::fs::symlink_metadata(temp.account().join("message.json")).is_ok());
        }
    }
}

#[test]
fn symlinked_directory_at_every_layer_never_reads_writes_or_clears_target() {
    for layer in ["root", "omamail", "bodies", "account"] {
        let temp = Temp::new();
        let outside = temp.0.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("sentinel"), b"untouched").unwrap();
        let root = temp.0.join("cache");
        let link = match layer {
            "root" => root.clone(),
            "omamail" => root.join("omamail"),
            "bodies" => root.join("omamail/bodies"),
            _ => root.join("omamail/bodies/account-you_40example.org"),
        };
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(&outside, &link).unwrap();
        for method in [
            "cache.bodyRead",
            "cache.bodyPut",
            "cache.bodyTouch",
            "cache.bodyClear",
        ] {
            assert_eq!(
                call_at(
                    &root,
                    method,
                    &json!({"accountId":"you@example.org","id":"message","body":{"text":"forbidden"}})
                ),
                Err("cache_unsafe_path")
            );
            assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
            assert_eq!(
                std::fs::read(outside.join("sentinel")).unwrap(),
                b"untouched"
            );
        }
    }
}

#[test]
fn account_store_roundtrip_bounds_and_legacy_compatibility() {
    let temp = Temp::new();
    let mut store = json!({"version":2,"account":"you@example.org","profile":{"email":"you@example.org"},"labels":[{"id":"INBOX"}],"session":{"url":"https://mail.example.org","session":{"apiUrl":"https://api.example.org"}},"queries":{}});
    for i in 0..15 {
        store["queries"][format!("{i}|25")] = json!({"at":i,"summaries":(0..105).map(|n| json!({"id":n,"dateMs":123,"unread":false})).collect::<Vec<_>>(),"nextPageToken":"would-skip","estimate":150});
    }
    temp.call("cache.storePut", json!({"store":store})).unwrap();
    let got = temp.call("cache.storeRead", json!({})).unwrap();
    assert_eq!(got["queries"].as_object().unwrap().len(), 12);
    assert!(got["queries"].get("0|25").is_none());
    assert_eq!(
        got["queries"]["14|25"]["summaries"]
            .as_array()
            .unwrap()
            .len(),
        100
    );
    assert_eq!(got["queries"]["14|25"]["nextPageToken"], "");
    assert_eq!(got["queries"]["14|25"]["summaries"][0]["unread"], false);
    assert_eq!(got["session"], store["session"]);
    let path = temp.0.join("omamail/account-you_40example.org.json");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    std::fs::write(&path, b"{broken").unwrap();
    assert_eq!(
        temp.call("cache.storeRead", json!({})).unwrap()["queries"],
        json!({})
    );
}

#[test]
fn account_store_links_never_read_or_overwrite_outside_target() {
    for hardlink in [false, true] {
        let temp = Temp::new();
        std::fs::create_dir(temp.0.join("omamail")).unwrap();
        let outside = temp.0.join("outside");
        std::fs::write(&outside, b"sentinel").unwrap();
        let path = temp.0.join("omamail/account-you_40example.org.json");
        if hardlink {
            std::fs::hard_link(&outside, &path).unwrap();
        } else {
            symlink(&outside, &path).unwrap();
        }
        for method in ["cache.storeRead", "cache.storePut"] {
            assert_eq!(
                temp.call(method, json!({"store":{"version":2}})),
                Err("cache_unsafe_path")
            );
            assert_eq!(std::fs::read(&outside).unwrap(), b"sentinel");
            assert_eq!(
                std::fs::read_dir(temp.0.join("omamail")).unwrap().count(),
                1
            );
        }
    }
}

#[test]
fn native_names_remain_distinct_for_legacy_adversarial_and_long_addresses() {
    let mut seen = std::collections::HashSet::new();
    for id in [
        "../../etc/passwd",
        "..",
        ".",
        "/",
        "a/b@example.com",
        "a\\b@example.com",
        "a_b@example.com",
        "a+b@example.com",
        "张伟@example.cn",
        "مثال@example.eg",
        "emoji🙂@example.com",
        "%2e%2e@example.com",
        "a'b@example.com",
        "a*b@example.com",
    ] {
        let name = account_name(id).unwrap();
        assert!(!name.contains('/'));
        assert!(name.len() < 250);
        assert!(seen.insert(name));
    }
    for i in 0..5000 {
        assert!(
            seen.insert(account_name(&format!("{}{}@example.org", "a".repeat(200), i)).unwrap())
        );
    }
    assert_eq!(account_name("A@Example.COM"), account_name("a@example.com"));
}

#[test]
fn store_oversize_and_directory_links_leave_existing_bytes_untouched() {
    let temp = Temp::new();
    temp.call(
        "cache.storePut",
        json!({"store":{"version":2,"account":"original"}}),
    )
    .unwrap();
    let path = temp.0.join("omamail/account-you_40example.org.json");
    let before = std::fs::read(&path).unwrap();
    assert_eq!(
        temp.call(
            "cache.storePut",
            json!({"store":{"version":2,"profile":{"text":"x".repeat(4*1024*1024)}}})
        ),
        Err("cache_store_too_large")
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let outside = temp.0.join("elsewhere");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("sentinel"), b"secret").unwrap();
    let linked = temp.0.join("linked");
    symlink(&outside, &linked).unwrap();
    for method in ["cache.storeRead", "cache.storePut"] {
        assert_eq!(
            call_at(
                &linked,
                method,
                &json!({"accountId":"you@example.org","store":{"version":2}})
            ),
            Err("cache_unsafe_path")
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
        assert_eq!(std::fs::read(outside.join("sentinel")).unwrap(), b"secret");
    }
    for content in ["", "[]", "null", "{\"version\":999,\"queries\":{\"x\":1}}"] {
        std::fs::write(&path, content).unwrap();
        assert_eq!(
            temp.call("cache.storeRead", json!({})).unwrap(),
            json!({"version":2,"account":"","profile":null,"labels":[],"queries":{},"session":null})
        );
    }
}

#[test]
fn calendar_cache_preserves_resources_and_refuses_arbitrary_paths() {
    let temp = Temp::new();
    let params = json!({"name":"calendar","store":{"version":3,"ranges":{"scope\n1:2":{"startMs":1,"endMs":2,"at":3,"events":[{"id":"event","resource":"BEGIN:VCALENDAR\r\nEND:VCALENDAR","href":"https://calendar.example.org/item"}]}}}});
    call_at(&temp.0, "cache.calendarPut", &params).unwrap();
    assert_eq!(
        call_at(&temp.0, "cache.calendarRead", &json!({"name":"calendar"})).unwrap(),
        params["store"]
    );
    assert_eq!(
        call_at(
            &temp.0,
            "cache.calendarPut",
            &json!({"name":"../../outside","store":{}})
        ),
        Err("cache_invalid_input")
    );
    assert_eq!(
        std::fs::read_dir(temp.0.join("omamail")).unwrap().count(),
        1
    );
    assert_eq!(
        call_at(
            &temp.0,
            "cache.calendarRead",
            &json!({"name":"calendar-bar"})
        )
        .unwrap(),
        json!({"version":3,"ranges":{}})
    );
}

#[test]
fn legacy_body_read_backfills_direction_without_rewriting_sender_content() {
    let temp = Temp::new();
    std::fs::create_dir_all(temp.account()).unwrap();
    let path = temp.account().join("message.json");
    let legacy =
        serde_json::to_vec(&json!({"text":"مرحبا بالعالم","html":"","source":"plain"})).unwrap();
    std::fs::write(&path, &legacy).unwrap();
    let body = temp.call("cache.bodyRead", json!({})).unwrap();
    assert_eq!(body["bodyDirection"], "rtl");
    assert_eq!(std::fs::read(path).unwrap(), legacy);
}

#[test]
fn clearing_message_cache_removes_resource_and_body_only_for_requested_account() {
    let temp = Temp::new();
    for account in ["you@example.org", "other@example.org"] {
        temp.call(
            "cache.bodyPut",
            json!({"accountId":account,"body":{"text":"body"}}),
        )
        .unwrap();
        temp.call(
            "cache.resourcePut",
            json!({"accountId":account,"resource":{"id":"message","payload":{"headers":[]}}}),
        )
        .unwrap();
    }
    temp.call("cache.bodyClear", json!({})).unwrap();
    assert!(temp.call("cache.bodyRead", json!({})).unwrap().is_null());
    assert!(
        temp.call("cache.resourceRead", json!({}))
            .unwrap()
            .is_null()
    );
    assert!(
        !temp
            .call("cache.bodyRead", json!({"accountId":"other@example.org"}))
            .unwrap()
            .is_null()
    );
    assert!(
        !temp
            .call(
                "cache.resourceRead",
                json!({"accountId":"other@example.org"})
            )
            .unwrap()
            .is_null()
    );
}
