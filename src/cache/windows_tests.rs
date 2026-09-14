//! Real cache operations against a caller-injected private root. In particular,
//! writes/clears must return success after their directory flush, and reads and
//! touches need the timestamp-write rights promised by `regular`.
use super::*;
#[test]
fn windows_cache_put_read_touch_clear_complete_their_filesystem_operations() {
    let root = std::env::temp_dir().join(format!(
        "omamail-cache-native-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    directories(&root, &[], true).unwrap().unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    let _cleanup = Cleanup(root.clone());
    let body = json!({"accountId":"one@example.org","id":"mail-one","body":{"text":"body bytes"}});
    let resource = json!({"accountId":"one@example.org","id":"mail-one","resource":{"id":"mail-one","payload":{"headers":[],"body":{"data":"Ym9keQ"}}}});
    assert_eq!(
        call_at(&root, "cache.bodyPut", &body).unwrap(),
        json!({"stored":true})
    );
    assert_eq!(
        call_at(&root, "cache.resourcePut", &resource).unwrap(),
        json!({"stored":true})
    );
    assert_eq!(
        call_at(&root, "cache.bodyRead", &body).unwrap()["text"],
        "body bytes"
    );
    assert_eq!(
        call_at(&root, "cache.bodyTouch", &body).unwrap(),
        json!({"touched":true})
    );
    assert_eq!(
        call_at(&root, "cache.resourceRead", &resource).unwrap(),
        resource["resource"]
    );
    let readonly_dir =
        directories_readonly(&root, &["omamail", "bodies", "account-one_40example.org"])
            .unwrap()
            .unwrap();
    let readonly_file = regular_readonly(&readonly_dir, "mail-one.json")
        .unwrap()
        .unwrap();
    assert!(readonly_file.set_modified(SystemTime::UNIX_EPOCH).is_err());
    drop(readonly_file);
    drop(readonly_dir);
    assert_eq!(
        call_at(&root, "cache.resourceClear", &resource).unwrap(),
        json!({"cleared":true})
    );
    assert!(
        call_at(&root, "cache.resourceRead", &resource)
            .unwrap()
            .is_null()
    );
    call_at(&root, "cache.resourcePut", &resource).unwrap();
    assert_eq!(
        call_at(&root, "cache.bodyClear", &body).unwrap(),
        json!({"cleared":true})
    );
    assert!(call_at(&root, "cache.bodyRead", &body).unwrap().is_null());
    assert!(
        call_at(&root, "cache.resourceRead", &resource)
            .unwrap()
            .is_null()
    );
    for kind in ["bodies", "resources"] {
        let dir = directories_readonly(&root, &["omamail", kind, "account-one_40example.org"])
            .unwrap()
            .unwrap();
        assert!(names(&dir).unwrap().is_empty());
    }
}
