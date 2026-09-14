#[cfg(unix)]
mod unix {
    use crate::platform::{dirs::AppDirs, private_fs::*};
    use std::{
        fs,
        io::Read,
        os::unix::fs::{PermissionsExt, symlink},
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "omamail-platform-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            Self(root)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn directories_are_absolute_and_follow_platform_layout() {
        let dirs = AppDirs::discover().unwrap();
        for root in [
            &dirs.config,
            &dirs.cache,
            &dirs.state,
            &dirs.runtime,
            &dirs.downloads,
        ] {
            assert!(root.is_absolute());
        }
        #[cfg(target_os = "macos")]
        {
            assert!(dirs.config.ends_with("Library/Application Support"));
            assert!(dirs.cache.ends_with("Library/Caches"));
        }
        assert!(
            AppDirs::from_roots(
                "relative".into(),
                dirs.cache.clone(),
                dirs.state.clone(),
                dirs.runtime.clone(),
                dirs.downloads.clone()
            )
            .is_err()
        );
        assert!(
            AppDirs::from_roots(
                "/a/../b".into(),
                dirs.cache,
                dirs.state,
                dirs.runtime,
                dirs.downloads
            )
            .is_err()
        );
    }
    #[test]
    fn operations_refuse_traversal_symlinks_hardlinks_and_unsafe_ancestors() {
        let temp = Temp::new();
        let dir = directories(&temp.0, &["omamail"], true).unwrap().unwrap();
        let victim = temp.0.join("victim");
        fs::write(&victim, b"outside").unwrap();
        for name in ["../victim", "/victim", "a/b", ".", "..", "nul\0name"] {
            assert!(open_private(&dir, name, false).is_err());
            assert!(atomic_replace(&dir, name, b"changed").is_err());
            assert!(remove_owned(&dir, name).is_err());
        }
        for hard in [false, true] {
            let path = temp.0.join("omamail/linked");
            if hard {
                fs::hard_link(&victim, &path).unwrap();
            } else {
                symlink(&victim, &path).unwrap();
            }
            assert!(open_private(&dir, "linked", true).is_err());
            assert!(atomic_replace(&dir, "linked", b"changed").is_err());
            assert!(remove_owned(&dir, "linked").is_err());
            assert_eq!(fs::read(&victim).unwrap(), b"outside");
            fs::remove_file(path).unwrap();
        }
        let link = temp.0.join("alias");
        symlink(temp.0.join("omamail"), &link).unwrap();
        assert!(directories(&link, &["escape"], true).is_err());
        assert!(!temp.0.join("omamail/escape").exists());
        let unsafe_root = temp.0.join("unsafe");
        fs::create_dir(&unsafe_root).unwrap();
        fs::set_permissions(&unsafe_root, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(directories(&unsafe_root, &["escape"], true).is_err());
        assert!(!unsafe_root.join("escape").exists());
    }
    #[test]
    fn atomic_writers_keep_whole_records_and_pinned_roots_survive_rename() {
        let temp = Temp::new();
        let dir = directories(&temp.0, &["omamail"], true).unwrap().unwrap();
        std::thread::scope(|scope| {
            for byte in 0..8 {
                let dir = &dir;
                scope.spawn(move || {
                    for _ in 0..8 {
                        atomic_replace(dir, "資料.json", &vec![byte; 8192]).unwrap();
                    }
                });
            }
        });
        let mut bytes = Vec::new();
        open_private(&dir, "資料.json", false)
            .unwrap()
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes.len(), 8192);
        assert!(bytes.iter().all(|byte| *byte == bytes[0]));
        fs::rename(temp.0.join("omamail"), temp.0.join("moved")).unwrap();
        let outside = temp.0.join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, temp.0.join("omamail")).unwrap();
        atomic_replace(&dir, "資料.json", b"anchored").unwrap();
        remove_owned(&dir, "資料.json").unwrap();
        assert!(!outside.join("資料.json").exists());
        assert!(!temp.0.join("moved/資料.json").exists());
        assert!(names(&dir).unwrap().is_empty());
    }
    #[test]
    fn exclusive_lock_releases_while_duplicate_descriptor_is_alive() {
        use std::os::fd::AsRawFd;
        let temp = Temp::new();
        let dir = directories(&temp.0, &["omamail"], true).unwrap().unwrap();
        let lock = lock_exclusive(&dir, "lease").unwrap();
        assert!(matches!(
            lock_exclusive(&dir, "lease"),
            Err("private_fs_busy")
        ));
        let duplicate = unsafe { libc::dup(lock.as_raw_fd()) };
        assert!(duplicate >= 0);
        drop(lock);
        let successor = lock_exclusive(&dir, "lease").unwrap();
        unsafe {
            libc::close(duplicate);
        }
        drop(successor);
        assert_eq!(
            fs::metadata(temp.0.join("omamail/lease"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    #[tokio::test]
    async fn ipc_is_anchored_handles_long_unicode_roots_and_reclaims_stale_sockets() {
        use crate::platform::ipc::{LocalEndpoint, check_peer};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let temp = Temp::new();
        let long = temp.0.join("資料".repeat(25));
        let dir = directories(&long, &["omamail"], true).unwrap().unwrap();
        let _lease = lock_exclusive(&dir, "lease").unwrap();
        let endpoint = LocalEndpoint::outbox(&long).unwrap();
        let cwd = std::env::current_dir().unwrap();
        let listener = endpoint.listen().unwrap();
        assert_eq!(std::env::current_dir().unwrap(), cwd);
        let mut client = endpoint.connect().await.unwrap();
        let (mut server, _) = listener.accept().await.unwrap();
        check_peer(&server).unwrap();
        client.write_u32(42).await.unwrap();
        assert_eq!(server.read_u32().await.unwrap(), 42);
        drop(listener);
        drop(endpoint.listen().unwrap());
        let moved = temp.0.join("moved");
        fs::rename(&long, &moved).unwrap();
        fs::create_dir(&long).unwrap();
        drop(endpoint.listen().unwrap());
        assert!(!long.join("omamail/outbox.sock").exists());
        assert!(moved.join("omamail/outbox.sock").exists());
        assert_eq!(std::env::current_dir().unwrap(), cwd);
    }
    #[tokio::test]
    async fn ipc_never_removes_foreign_entries_or_nonprivate_sockets() {
        use crate::platform::ipc::LocalEndpoint;
        let temp = Temp::new();
        directories(&temp.0, &["omamail"], true).unwrap();
        let endpoint = LocalEndpoint::outbox(&temp.0).unwrap();
        let socket = temp.0.join("omamail/outbox.sock");
        let victim = temp.0.join("outside");
        fs::write(&victim, b"keep").unwrap();
        symlink(&victim, &socket).unwrap();
        assert!(endpoint.listen().is_err());
        assert!(endpoint.connect().await.is_err());
        assert_eq!(fs::read(&victim).unwrap(), b"keep");
        assert!(
            fs::symlink_metadata(&socket)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        fs::remove_file(&socket).unwrap();
        let listener = endpoint.listen().unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(endpoint.listen().is_err());
        assert!(endpoint.connect().await.is_err());
        drop(listener);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_inherited_acl_cannot_expose_private_data_or_authorize_mutation() {
        use std::process::Command;
        let temp = Temp::new();
        let dir = directories(&temp.0, &["omamail"], true).unwrap().unwrap();
        atomic_replace(&dir, "record", b"private").unwrap();
        let path = temp.0.join("omamail/record");
        drop(lock_exclusive(&dir, "lease").unwrap());
        let lease_path = temp.0.join("omamail/lease");
        assert!(
            Command::new("/bin/chmod")
                .args(["+a", "everyone allow read,write"])
                .arg(&lease_path)
                .status()
                .unwrap()
                .success()
        );
        assert!(lock_exclusive(&dir, "lease").is_err());
        assert!(
            Command::new("/bin/chmod")
                .arg("-N")
                .arg(&lease_path)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("/bin/chmod")
                .args(["+a", "everyone allow read"])
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(regular_readonly(&dir, "record").is_err());
        assert!(atomic_replace(&dir, "record", b"bad").is_err());
        assert!(remove_owned(&dir, "record").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"private");
        assert!(
            Command::new("/bin/chmod")
                .arg("-N")
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("/bin/chmod")
                .args(["+a", "everyone allow read,file_inherit,directory_inherit"])
                .arg(&temp.0)
                .status()
                .unwrap()
                .success()
        );
        let inherited = temp.0.join("inherited");
        fs::create_dir(&inherited).unwrap();
        fs::set_permissions(&inherited, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(directories_readonly(&temp.0, &["inherited"]).is_err());
        assert!(directories(&temp.0, &["inherited"], true).is_err());
        assert!(!inherited.join("record").exists());
        assert!(
            Command::new("/bin/chmod")
                .arg("-N")
                .arg(&temp.0)
                .status()
                .unwrap()
                .success()
        );
        assert!(Command::new("/bin/chmod").args(["+a", "everyone allow read,write,delete,add_file,add_subdirectory,delete_child,file_inherit,directory_inherit"]).arg(&temp.0).status().unwrap().success());
        assert!(directories(&temp.0, &["outside"], true).is_err());
        assert!(!temp.0.join("outside").exists());
        assert!(
            Command::new("/bin/chmod")
                .arg("-N")
                .arg(&temp.0)
                .status()
                .unwrap()
                .success()
        );
    }
}
