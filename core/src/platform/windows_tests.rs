//! Native Windows regressions. Cross-compilation proves signatures only; these
//! tests must execute on Windows/NTFS before a Windows asset is release eligible.
use super::{private_fs::*, windows_security as security};
use std::{
    fs::{self, File},
    io::Read,
    os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Path, PathBuf},
    ptr,
    sync::atomic::{AtomicU64, Ordering},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{IO::DeviceIoControl, Threading::GetCurrentThread},
};
static SERIAL: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "omamail-native-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        directories(&root, &[], true).unwrap().unwrap();
        Self(root)
    }
    fn private(&self) -> File {
        directories(&self.0, &["omamail"], true).unwrap().unwrap()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn set_acl(path: &Path, sddl: &str, protected: bool) {
    let file = fs::OpenOptions::new()
        .access_mode(READ_CONTROL | WRITE_DAC)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .unwrap();
    let descriptor = security::descriptor(sddl).unwrap();
    let mut dacl = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    assert_ne!(
        unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted) },
        0
    );
    assert_eq!(
        unsafe {
            SetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION
                    | if protected {
                        PROTECTED_DACL_SECURITY_INFORMATION
                    } else {
                        UNPROTECTED_DACL_SECURITY_INFORMATION
                    },
                ptr::null_mut(),
                ptr::null_mut(),
                dacl,
                ptr::null(),
            )
        },
        ERROR_SUCCESS
    );
}
fn own_acl(extra: &str) -> String {
    format!(
        "D:P(A;OICI;FA;;;{}){extra}",
        security::sid_text(&security::current_user().unwrap()).unwrap()
    )
}

// Mount-point reparses (junctions) do not require SeCreateSymbolicLinkPrivilege,
// unlike symlinks. Exercise the real filesystem without a privileged shell.
fn junction(path: &Path, target: &Path) {
    fs::create_dir(path).unwrap();
    let canonical = target.canonicalize().unwrap();
    let path_text = canonical.as_os_str().to_string_lossy();
    let substitute = path_text
        .strip_prefix(r"\\?\")
        .map(|path| format!(r"\??\{path}"))
        .unwrap_or_else(|| format!(r"\??\{path_text}"));
    let name: Vec<u16> = substitute.encode_utf16().collect();
    let mut data = Vec::new();
    data.extend(0xa0000003u32.to_le_bytes()); // IO_REPARSE_TAG_MOUNT_POINT
    data.extend(((8 + (name.len() + 2) * 2) as u16).to_le_bytes());
    data.extend(0u16.to_le_bytes());
    data.extend(0u16.to_le_bytes()); // SubstituteNameOffset
    data.extend(((name.len() * 2) as u16).to_le_bytes());
    data.extend((((name.len() + 1) * 2) as u16).to_le_bytes()); // Print name follows substitute NUL.
    data.extend(0u16.to_le_bytes());
    // The path buffer carries separately terminated substitute and print
    // names, even though the latter is empty.
    for unit in name.into_iter().chain([0, 0]) {
        data.extend(unit.to_le_bytes());
    }
    let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    assert_ne!(handle, INVALID_HANDLE_VALUE);
    let file = unsafe { File::from_raw_handle(handle) };
    let mut count = 0;
    assert_ne!(
        unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                589988, /* FSCTL_SET_REPARSE_POINT */
                data.as_ptr().cast(),
                data.len() as u32,
                ptr::null_mut(),
                0,
                &mut count,
                ptr::null_mut(),
            )
        },
        0,
        "{}",
        std::io::Error::last_os_error()
    );
}
#[test]
fn windows_rejects_traversal_dos_aliases_streams_junctions_and_hardlinks() {
    let temp = Temp::new();
    let dir = temp.private();
    let outside = temp.0.join("outside");
    fs::create_dir(&outside).unwrap();
    let victim = outside.join("victim");
    fs::write(&victim, b"keep").unwrap();
    for name in [
        "../outside/victim",
        "..\\outside\\victim",
        "\\victim",
        "x:y",
        "x\0y",
        "NUL",
        "con.txt",
        "LPT1",
        "x.",
        "x ",
    ] {
        assert!(open_private(&dir, name, true).is_err(), "{name}");
        assert!(atomic_replace(&dir, name, b"bad").is_err(), "{name}");
        assert!(remove_owned(&dir, name).is_err(), "{name}");
    }
    let linked = temp.0.join("omamail/linked");
    fs::hard_link(&victim, &linked).unwrap();
    assert!(regular(&dir, "linked", true).is_err());
    assert!(atomic_replace(&dir, "linked", b"bad").is_err());
    assert!(remove_owned(&dir, "linked").is_err());
    fs::remove_file(&linked).unwrap();
    junction(&linked, &outside);
    assert!(open_dir(&dir, "linked".as_ref(), true, true).is_err());
    assert!(directories(&linked, &["escaped"], true).is_err());
    assert!(open_external(&linked.join("victim")).is_err());
    assert!(remove_owned(&dir, "linked").is_err());
    assert!(!outside.join("escaped").exists());
    assert_eq!(fs::read(&victim).unwrap(), b"keep");
    fs::remove_dir(&linked).unwrap();
}
#[test]
fn windows_private_acl_is_protected_and_inherited_read_grants_are_refused() {
    let temp = Temp::new();
    // This ancestor ACL is readable but cannot be mutated by other users. Its
    // inheritable read grant must not reach a newly created private directory.
    set_acl(&temp.0, &own_acl("(A;OICI;GR;;;WD)"), true);
    let dir = temp.private();
    validate_owned_root(&dir).unwrap();
    atomic_replace(&dir, "record", b"private").unwrap();
    let file = regular_readonly(&dir, "record").unwrap().unwrap();
    security::validate(file.as_raw_handle(), true).unwrap();
    drop(file);
    let path = temp.0.join("omamail/record");
    set_acl(&path, &own_acl("(A;;GR;;;WD)"), true);
    assert!(regular_readonly(&dir, "record").is_err());
    assert!(atomic_replace(&dir, "record", b"bad").is_err());
    assert!(remove_owned(&dir, "record").is_err());
    assert_eq!(fs::read(&path).unwrap(), b"private");
    set_acl(&path, &own_acl(""), true);
    set_acl(&temp.0, &own_acl("(A;;FA;;;WD)"), true);
    assert!(directories(&temp.0, &["must-not-exist"], true).is_err());
    assert!(!temp.0.join("must-not-exist").exists());
    set_acl(&temp.0, &own_acl(""), true);
}
#[test]
fn windows_atomic_writers_preserve_records_and_handles_survive_rename() {
    let temp = Temp::new();
    let dir = temp.private();
    atomic_replace(&dir, "record", &[0; 8192]).unwrap();
    std::thread::scope(|scope| {
        for byte in 1..=4u8 {
            let dir = &dir;
            scope.spawn(move || {
                for _ in 0..20 {
                    atomic_replace(dir, "record", &[byte; 8192]).unwrap();
                }
            });
        }
        let dir = &dir;
        scope.spawn(move || {
            for _ in 0..100 {
                let Some(mut file) = regular_readonly(dir, "record").unwrap() else {
                    // A concurrently unlinked old inode is a cache miss.
                    continue;
                };
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).unwrap();
                assert_eq!(bytes.len(), 8192);
                assert!(bytes.iter().all(|b| *b == bytes[0]));
            }
        });
    });
    assert_eq!(names(&dir).unwrap(), ["record"]);
    let moved = temp.0.join("moved");
    fs::rename(temp.0.join("omamail"), &moved).unwrap();
    fs::create_dir(temp.0.join("omamail")).unwrap();
    atomic_replace(&dir, "record", b"anchored").unwrap();
    assert_eq!(fs::read(moved.join("record")).unwrap(), b"anchored");
    assert!(!temp.0.join("omamail/record").exists());
    remove_owned(&dir, "record").unwrap();
    assert!(!moved.join("record").exists());
}
#[test]
fn windows_exclusive_sharing_lease_blocks_write_rename_delete_and_releases() {
    let temp = Temp::new();
    let dir = temp.private();
    let lease = lock_exclusive(&dir, "lease").unwrap();
    assert!(matches!(
        lock_exclusive(&dir, "lease"),
        Err("private_fs_busy")
    ));
    let path = temp.0.join("omamail/lease");
    assert!(fs::write(&path, b"bad").is_err());
    assert!(fs::remove_file(&path).is_err());
    assert!(fs::rename(&path, path.with_extension("moved")).is_err());
    drop(lease);
    drop(lock_exclusive(&dir, "lease").unwrap());
}
#[test]
fn windows_long_unicode_paths_and_unique_exports_preserve_existing_bytes() {
    let temp = Temp::new();
    let long = temp.0.join("資料".repeat(55)).join("長い名前".repeat(35));
    let dir = directories(&long, &["omamail"], true).unwrap().unwrap();
    atomic_replace(&dir, "記録.json", b"private").unwrap();
    let mut file = regular_readonly(&dir, "記録.json").unwrap().unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"private");
    let first = write_unique(&dir, "invoice.pdf", b"first").unwrap();
    let second = write_unique(&dir, "invoice.pdf", b"second").unwrap();
    assert_ne!(first, second);
    assert_eq!(fs::read(first).unwrap(), b"first");
    assert_eq!(fs::read(second).unwrap(), b"second");
}
#[tokio::test]
async fn windows_pipe_authenticates_rejects_squatting_and_follows_renamed_directory() {
    use super::ipc::{LocalEndpoint, authenticate};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let temp = Temp::new();
    let dir = temp.private();
    let lease = lock_exclusive(&dir, "lease").unwrap();
    let endpoint = LocalEndpoint::outbox(&temp.0).unwrap();
    let listener = endpoint.listen().unwrap();
    assert!(endpoint.listen().is_err());
    let mut client = endpoint.connect().await.unwrap();
    let (mut server, _) = listener.accept().await.unwrap();
    authenticate(&mut server).await.unwrap();
    client.write_u32(42).await.unwrap();
    assert_eq!(server.read_u32().await.unwrap(), 42);
    server.write_u32(24).await.unwrap();
    assert_eq!(client.read_u32().await.unwrap(), 24);
    drop(server);
    drop(client);
    // A lease intentionally denies delete sharing, so release it before the
    // directory rename used to prove that the endpoint follows its pinned
    // directory handle rather than reopening the old path.
    drop(lease);
    fs::rename(temp.0.join("omamail"), temp.0.join("moved")).unwrap();
    let mut client = endpoint.connect().await.unwrap();
    let (mut server, _) = listener.accept().await.unwrap();
    authenticate(&mut server).await.unwrap();
    client.write_u32(7).await.unwrap();
    assert_eq!(server.read_u32().await.unwrap(), 7);
}
#[tokio::test]
async fn windows_pipe_dacl_refuses_anonymous_token_before_any_request() {
    use super::ipc::LocalEndpoint;
    use tokio::net::windows::named_pipe::ClientOptions;
    let temp = Temp::new();
    let dir = temp.private();
    let endpoint = LocalEndpoint::outbox(&temp.0).unwrap();
    let _listener = endpoint.listen().unwrap();
    let (volume, id, _) = file_id(&dir).unwrap();
    let sid = security::sid_text(&security::current_user().unwrap()).unwrap();
    let name = format!(r"\\.\pipe\omamail-{sid}-{volume:08x}-{id:016x}-outbox");
    assert_ne!(unsafe { ImpersonateAnonymousToken(GetCurrentThread()) }, 0);
    // Synchronous open only: never yield an impersonated executor thread.
    let denied = ClientOptions::new().open(name);
    assert_ne!(unsafe { RevertToSelf() }, 0);
    assert!(denied.is_err());
    assert_eq!(
        denied.unwrap_err().raw_os_error(),
        Some(ERROR_ACCESS_DENIED as i32)
    );
}

#[test]
fn windows_lease_child_helper() {
    let Some(root) = std::env::var_os("OMAMAIL_WINDOWS_LEASE_CHILD") else {
        return;
    };
    let root = PathBuf::from(root);
    let dir = directories_readonly(&root, &["omamail"]).unwrap().unwrap();
    let _lease = lock_exclusive(&dir, "lease").unwrap();
    fs::write(root.join("child-ready"), b"ready").unwrap();
    loop {
        std::thread::park();
    }
}
#[test]
fn windows_lease_owner_death_releases_kernel_lease() {
    let temp = Temp::new();
    let dir = temp.private();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "platform::windows_tests::windows_lease_child_helper",
        ])
        .env("OMAMAIL_WINDOWS_LEASE_CHILD", &temp.0)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !temp.0.join("child-ready").exists() {
        if child.try_wait().unwrap().is_some() || std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("lease child failed to start");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let blocked = matches!(lock_exclusive(&dir, "lease"), Err("private_fs_busy"));
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(blocked);
    drop(lock_exclusive(&dir, "lease").unwrap());
}
#[tokio::test]
async fn windows_pipe_refuses_default_acl_squatter_before_sending_bytes() {
    use super::ipc::LocalEndpoint;
    use tokio::net::windows::named_pipe::ServerOptions;
    let temp = Temp::new();
    let dir = temp.private();
    let endpoint = LocalEndpoint::outbox(&temp.0).unwrap();
    let (volume, id, _) = file_id(&dir).unwrap();
    let sid = security::sid_text(&security::current_user().unwrap()).unwrap();
    let name = format!(r"\\.\pipe\omamail-{sid}-{volume:08x}-{id:016x}-outbox");
    let squatter = ServerOptions::new()
        .first_pipe_instance(true)
        .create(name)
        .unwrap();
    assert!(endpoint.listen().is_err());
    assert!(endpoint.connect().await.is_err());
    // Even a same-user squatter with an unsafe DACL never receives a preamble or
    // request. A closed client can report EOF or ERROR_BROKEN_PIPE; neither is data.
    let mut bytes = [0u8; 8];
    assert!(!matches!(squatter.try_read(&mut bytes), Ok(n) if n > 0));
    drop(squatter);
    drop(endpoint.listen().unwrap());
}
