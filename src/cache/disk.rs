//! Shared byte budget for disposable body and resource caches only.
use super::*;
pub(super) const MAX_DISK_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DISK_ENTRIES: usize = 4096;
/// Caller holds OPERATIONS. Reserve temporary-file bytes before writing, so a
/// successful operation never temporarily doubles the configured disk ceiling.
pub(super) fn reserve(
    root: &Path,
    incoming: u64,
    protected: Option<(&str, &str, &str)>,
) -> Result<()> {
    reserve_limit(root, incoming, protected, MAX_DISK_BYTES)
}
fn reserve_limit(
    root: &Path,
    incoming: u64,
    protected: Option<(&str, &str, &str)>,
    limit: u64,
) -> Result<()> {
    if incoming > limit {
        return Err("cache_body_too_large");
    }
    let mut files = Vec::new();
    let mut bytes = incoming;
    for kind in ["bodies", "resources"] {
        let Some(base) = directories(root, &["omamail", kind], false)? else {
            continue;
        };
        for account in names(&base)? {
            if !account.starts_with("account-") {
                continue;
            }
            let Some(dir) = open_dir(&base, account.as_ref(), false, true)? else {
                continue;
            };
            let dir = std::sync::Arc::new(dir);
            for name in names(&dir)?
                .into_iter()
                .filter(|name| name.ends_with(".json") || name.starts_with(".tmp."))
            {
                let Some(file) = regular(&dir, &name, false)? else {
                    continue;
                };
                let metadata = file.metadata().map_err(|_| "cache_unavailable")?;
                let size = metadata.len();
                let at = metadata.modified().map_err(|_| "cache_unavailable")?;
                bytes = bytes.checked_add(size).ok_or("cache_unavailable")?;
                let keep = protected == Some((kind, account.as_str(), name.as_str()));
                files.push((at, dir.clone(), name, size, keep));
                if files.len() > 20_000 {
                    return Err("cache_too_many_files");
                }
            }
        }
    }
    files.sort_by_key(|file| file.0);
    let mut count = files.len() + usize::from(incoming > 0);
    for (_, dir, name, size, keep) in files {
        if bytes <= limit && count <= MAX_DISK_ENTRIES {
            break;
        }
        if keep {
            continue;
        }
        unlink(&dir, &name)?;
        bytes = bytes.saturating_sub(size);
        count -= 1;
    }
    if bytes > limit || count > MAX_DISK_ENTRIES {
        return Err("cache_body_too_large");
    }
    Ok(())
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn abandoned_temporary_bytes_count_toward_the_same_budget() {
        let temp = super::super::tests::Temp::new();
        directories(&temp.0, &["omamail", "resources", "account-one"], true).unwrap();
        let path = temp.0.join("omamail/resources/account-one/.tmp.123.1");
        std::fs::write(&path, vec![0; 90]).unwrap();
        reserve_limit(&temp.0, 20, None, 100).unwrap();
        assert!(!path.exists());
    }
    #[test]
    fn production_budget_evicts_old_body_on_resource_write_and_rejects_links_before_deletion() {
        let temp = super::super::tests::Temp::new();
        let dir = directories(&temp.0, &["omamail", "bodies", "account-old"], true)
            .unwrap()
            .unwrap();
        let path = temp.0.join("omamail/bodies/account-old/huge.json");
        File::create(&path)
            .unwrap()
            .set_len(MAX_DISK_BYTES)
            .unwrap();
        let params = json!({"accountId":"new@example.org","id":"id","resource":{"id":"id","payload":{"headers":[]}}});
        super::super::resource::call_at(&temp.0, "cache.resourcePut", &params).unwrap();
        assert!(!path.exists());
        std::fs::write(&path, b"old body").unwrap();
        let outside = temp.0.join("outside");
        std::fs::write(&outside, b"outside content").unwrap();
        std::os::unix::fs::symlink(
            &outside,
            temp.0.join("omamail/bodies/account-old/link.json"),
        )
        .unwrap();
        assert_eq!(
            reserve_limit(&temp.0, 100, None, 1),
            Err("cache_body_too_large")
        );
        assert_eq!(reserve_limit(&temp.0, 0, None, 1), Err("cache_unsafe_path"));
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside content");
        assert_eq!(std::fs::read(&path).unwrap(), b"old body");
        assert!(regular(&dir, "huge.json", false).unwrap().is_some());
    }
    #[test]
    fn aggregate_budget_obeys_access_time_and_never_touches_other_storage() {
        let temp = super::super::tests::Temp::new();
        for (kind, account, name, stamp) in [
            ("bodies", "account-one", "old.json", 1),
            ("resources", "account-two", "recent.json", 20),
        ] {
            let dir = directories(&temp.0, &["omamail", kind, account], true)
                .unwrap()
                .unwrap();
            let path = temp.0.join("omamail").join(kind).join(account).join(name);
            std::fs::write(path, vec![b'x'; 60]).unwrap();
            regular(&dir, name, false)
                .unwrap()
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(stamp))
                .unwrap();
        }
        let untouched = temp.0.join("omamail/outbox");
        std::fs::create_dir_all(&untouched).unwrap();
        std::fs::write(untouched.join("job.json"), b"must survive").unwrap();
        reserve_limit(&temp.0, 40, None, 100).unwrap();
        assert!(!temp.0.join("omamail/bodies/account-one/old.json").exists());
        assert!(
            temp.0
                .join("omamail/resources/account-two/recent.json")
                .exists()
        );
        assert_eq!(
            std::fs::read(untouched.join("job.json")).unwrap(),
            b"must survive"
        );
    }
}
