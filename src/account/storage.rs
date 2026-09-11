//! Private account registry storage with optimistic revisions and a cross-process lock.
use super::*;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    ffi::CString,
    fs::File,
    io::Write,
    os::fd::{AsRawFd, FromRawFd},
};
static SERIAL: AtomicU64 = AtomicU64::new(0);
type Result<T> = std::result::Result<T, &'static str>;
struct RegistryLock(File);
impl Drop for RegistryLock {
    fn drop(&mut self) {
        // A concurrently forked process can inherit the open file description.
        // Unlock explicitly rather than waiting for its final inherited fd to close.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
fn home() -> Result<PathBuf> {
    env::var_os("XDG_CONFIG_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
        .filter(|p| p.is_absolute())
        .ok_or("config_home_invalid")
}
pub fn call(method: &str, params: &Value) -> Result<Value> {
    call_at(&home()?, method, params)
}
pub(crate) fn raw_registry() -> Result<Value> {
    Ok(call("accounts.read", &json!({}))?["registry"].clone())
}
fn read(dir: &File) -> Result<Vec<u8>> {
    let Some(file) = crate::cache::regular(dir, "accounts.json", false)? else {
        return Ok(Vec::new());
    };
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "accounts_unreadable")?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err("accounts_too_large");
    }
    Ok(bytes)
}
fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn registry(bytes: &[u8]) -> Result<Value> {
    if bytes.is_empty() {
        return Ok(json!({"version":1,"accounts":[],"activeId":""}));
    }
    summarize(bytes)?;
    serde_json::from_slice(bytes).map_err(|_| "accounts_invalid")
}
fn call_at(root: &std::path::Path, method: &str, params: &Value) -> Result<Value> {
    if !matches!(method, "accounts.read" | "accounts.save") {
        return Err("unknown_method");
    }
    let writing = method == "accounts.save";
    let bytes = if writing {
        let bytes = serde_json::to_vec(&params["registry"]).map_err(|_| "accounts_invalid")?;
        if bytes.len() as u64 > MAX_CONFIG {
            return Err("accounts_too_large");
        }
        let summary = summarize(&bytes)?;
        if !summary["accounts"]
            .as_array()
            .is_some_and(|v| v.iter().any(|a| a["id"] != ""))
        {
            return Err("accounts_setup_replacement");
        }
        if params["revision"].as_str().is_none() {
            return Err("invalid_params");
        }
        bytes
    } else {
        Vec::new()
    };
    let Some(dir) = crate::cache::directories(root, &["omamail"], writing)? else {
        return Ok(json!({"registry":registry(&[])?,"revision":revision(&[])}));
    };
    // The lock inode remains stable while accounts.json is atomically replaced.
    let lock = if writing {
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                c".accounts.lock".as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err("accounts_unsafe_path");
        }
        let file = unsafe { File::from_raw_fd(fd) };
        use std::os::unix::fs::MetadataExt;
        let m = file.metadata().map_err(|_| "accounts_unreadable")?;
        if !m.is_file() || m.nlink() != 1 || m.uid() != unsafe { libc::geteuid() } {
            return Err("accounts_unsafe_path");
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("accounts_busy");
        }
        Some(RegistryLock(file))
    } else {
        None
    };
    let old = read(&dir)?;
    if !writing {
        return Ok(json!({"registry":registry(&old)?,"revision":revision(&old)}));
    }
    if params["revision"] != revision(&old) {
        return Err("accounts_conflict");
    }
    if params["allowDrop"] != true && !old.is_empty() {
        let before = summarize(&old)?;
        let after = summarize(&bytes)?;
        for account in before["accounts"].as_array().unwrap() {
            if account["id"] != ""
                && !params["releasedIds"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&account["id"]))
                && !after["accounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|a| a["id"] == account["id"])
            {
                return Err("accounts_unexpected_removal");
            }
        }
    }
    let name = format!(
        ".accounts.{}.{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    );
    let temp = CString::new(name).unwrap();
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            temp.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err("accounts_write_failed");
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|_| "accounts_write_failed")?;
        file.sync_all().map_err(|_| "accounts_write_failed")?;
        if unsafe {
            libc::renameat(
                dir.as_raw_fd(),
                temp.as_ptr(),
                dir.as_raw_fd(),
                c"accounts.json".as_ptr(),
            )
        } != 0
        {
            return Err("accounts_write_failed");
        }
        dir.sync_all().map_err(|_| "accounts_write_failed")?;
        Ok(json!({"revision":revision(&bytes)}))
    })();
    if result.is_err() {
        unsafe { libc::unlinkat(dir.as_raw_fd(), temp.as_ptr(), 0) };
    }
    drop(lock);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn saved(email: &str) -> Value {
        json!({"version":1,"activeId":email,"accounts":[{"email":email,"provider":"gmail","clientSecret":"synthetic secret"}]})
    }
    #[test]
    fn revisions_prevent_stale_overwrites_and_missing_accounts() {
        let root = std::env::temp_dir().join(format!(
            "omamail-registry-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let initial = call_at(&root, "accounts.read", &json!({})).unwrap();
        let first = call_at(
            &root,
            "accounts.save",
            &json!({"registry":saved("a@example.org"),"revision":initial["revision"]}),
        )
        .unwrap();
        assert_eq!(
            call_at(
                &root,
                "accounts.save",
                &json!({"registry":saved("b@example.org"),"revision":initial["revision"]})
            ),
            Err("accounts_conflict")
        );
        assert_eq!(
            call_at(
                &root,
                "accounts.save",
                &json!({"registry":saved("b@example.org"),"revision":first["revision"]})
            ),
            Err("accounts_unexpected_removal")
        );
        assert_eq!(
            call_at(
                &root,
                "accounts.save",
                &json!({"registry":{"version":1,"accounts":[]},"revision":first["revision"],"allowDrop":true})
            ),
            Err("accounts_setup_replacement")
        );
        let got = call_at(&root, "accounts.read", &json!({})).unwrap();
        assert_eq!(got["registry"], saved("a@example.org"));
        call_at(&root,"accounts.save",&json!({"registry":saved("b@example.org"),"revision":first["revision"],"allowDrop":true})).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn links_at_registry_lock_and_config_directory_never_change_targets() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        for link_name in ["accounts.json", ".accounts.lock", "omamail"] {
            let root = std::env::temp_dir().join(format!(
                "omamail-registry-security-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            let outside = root.join("outside");
            if link_name == "omamail" {
                std::fs::create_dir(&outside).unwrap();
                std::fs::write(outside.join("sentinel"), b"secret").unwrap();
                symlink(&outside, root.join("omamail")).unwrap();
            } else {
                std::fs::create_dir(root.join("omamail")).unwrap();
                std::fs::write(&outside, b"secret").unwrap();
                std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o644)).unwrap();
                symlink(&outside, root.join("omamail").join(link_name)).unwrap();
            }
            let result = call_at(
                &root,
                "accounts.save",
                &json!({"registry":saved("a@example.org"),"revision":revision(&[])}),
            );
            assert!(result.is_err());
            if outside.is_file() {
                assert_eq!(std::fs::read(&outside).unwrap(), b"secret");
                assert_eq!(
                    std::fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
                    0o644
                );
            } else {
                assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn released_identity_never_authorizes_an_unrelated_removal_or_stale_write() {
        let root = std::env::temp_dir().join(format!(
            "omamail-registry-release-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let mut original = saved("alias@example.org");
        original["accounts"]
            .as_array_mut()
            .unwrap()
            .push(saved("other@example.org")["accounts"][0].clone());
        let first = call_at(
            &root,
            "accounts.save",
            &json!({"registry":original,"revision":revision(&[])}),
        )
        .unwrap();
        let mut corrected = saved("canonical@example.org");
        corrected["accounts"]
            .as_array_mut()
            .unwrap()
            .push(saved("other@example.org")["accounts"][0].clone());
        for released in [
            json!([]),
            json!(["wrong@example.org"]),
            json!(["other@example.org"]),
        ] {
            assert_eq!(
                call_at(
                    &root,
                    "accounts.save",
                    &json!({"registry":corrected,"revision":first["revision"],"releasedIds":released})
                ),
                Err("accounts_unexpected_removal")
            );
        }
        assert_eq!(
            call_at(
                &root,
                "accounts.save",
                &json!({"registry":saved("canonical@example.org"),"revision":first["revision"],"releasedIds":["alias@example.org"]})
            ),
            Err("accounts_unexpected_removal")
        );
        let next=call_at(&root,"accounts.save",&json!({"registry":corrected,"revision":first["revision"],"releasedIds":["alias@example.org"]})).unwrap();
        assert_eq!(
            call_at(
                &root,
                "accounts.save",
                &json!({"registry":saved("new@example.org"),"revision":first["revision"],"releasedIds":["canonical@example.org","other@example.org"],"allowDrop":true})
            ),
            Err("accounts_conflict")
        );
        assert_eq!(
            call_at(&root, "accounts.read", &json!({})).unwrap()["revision"],
            next["revision"]
        );
        assert_eq!(
            call_at(&root, "accounts.read", &json!({})).unwrap()["registry"],
            corrected
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod lock_tests {
    use super::*;
    #[test]
    fn guard_unlocks_even_while_duplicate_description_is_alive() {
        let dir = std::env::temp_dir().join(format!(
            "omamail-lock-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("lock");
        let first = File::create(&path).unwrap();
        assert_eq!(
            unsafe { libc::flock(first.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let inherited = first.try_clone().unwrap();
        let guard = RegistryLock(first);
        let contender = File::open(&path).unwrap();
        assert_ne!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        drop(guard);
        assert_eq!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        drop(inherited);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
