use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

// The bare `fs` and the launched child belong to the `/proc` tests, which are
// Linux's; everything else here spells the module out where it uses it.
#[cfg(target_os = "linux")]
use std::{fs, process::Command};

#[cfg(target_os = "linux")]
use std::os::unix::fs::PermissionsExt;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use omamail::attachment_host::{AttachmentError, AttachmentHost, AttachmentLauncher};

#[derive(Default)]
struct Launcher(Mutex<Vec<PathBuf>>);
impl AttachmentLauncher for Launcher {
    fn launch(&self, path: &Path) -> Result<(), AttachmentError> {
        self.0.lock().unwrap().push(path.to_owned());
        Ok(())
    }
}

#[cfg(target_os = "linux")]
struct ExecLauncher {
    script: PathBuf,
    copied: PathBuf,
}

#[cfg(target_os = "linux")]
impl AttachmentLauncher for ExecLauncher {
    fn launch(&self, path: &Path) -> Result<(), AttachmentError> {
        Command::new(&self.script)
            .arg(path)
            .arg(&self.copied)
            .status()
            .ok()
            .filter(|status| status.success())
            .map(|_| ())
            .ok_or(AttachmentError)
    }
}

#[test]
fn writes_private_bounded_bytes_and_cleans_its_lifecycle() {
    let root = tempfile::tempdir().unwrap();
    let launcher = Arc::new(Launcher::default());
    let host = AttachmentHost::new(root.path().to_owned(), launcher.clone()).unwrap();
    let bytes = b"\0private attachment bytes";
    let request = serde_json::json!({
        "filename":"report.pdf",
        "data":URL_SAFE_NO_PAD.encode(bytes),
    });
    host.open_json(&request.to_string()).unwrap();
    let path = launcher.0.lock().unwrap()[0].clone();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    drop(host);
    assert!(!path.exists());
}

#[test]
fn rejects_paths_bad_base64_unknown_fields_and_oversize_without_launching() {
    let root = tempfile::tempdir().unwrap();
    let launcher = Arc::new(Launcher::default());
    let host = AttachmentHost::new(root.path().to_owned(), launcher.clone()).unwrap();
    for request in [
        serde_json::json!({"filename":"../secret","data":"QQ"}),
        serde_json::json!({"filename":"a/b","data":"QQ"}),
        serde_json::json!({"filename":"ok","data":"not*base64"}),
        serde_json::json!({"filename":"ok","data":"QQ","extra":true}),
        serde_json::json!({"filename":"ok","data":"A".repeat(1_398_105)}),
    ] {
        assert_eq!(
            host.open_json(&request.to_string())
                .unwrap_err()
                .to_string(),
            "attachment request failed"
        );
    }
    assert!(launcher.0.lock().unwrap().is_empty());
}

// Pinning the *opened* file to the descriptor is a `/proc` mechanism, so these
// two are Linux's. Elsewhere the write is still made through the descriptor and
// only the path handed to the opener is an ordinary one, which is what
// `the_opener_is_given_a_path_inside_the_private_directory` holds instead.
#[cfg(target_os = "linux")]
#[test]
fn pins_the_open_root_directory_when_its_path_is_replaced() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("runtime");
    std::fs::create_dir(&root).unwrap();
    let launcher = Arc::new(Launcher::default());
    let host = AttachmentHost::new(root.clone(), launcher.clone()).unwrap();
    let pinned = parent.path().join("pinned");
    std::fs::rename(&root, &pinned).unwrap();
    std::fs::create_dir(&root).unwrap();

    host.open_json(r#"{"filename":"safe.txt","data":"QQ"}"#)
        .unwrap();
    let opened = launcher.0.lock().unwrap()[0].clone();
    assert_eq!(std::fs::read(opened).unwrap(), b"A");
    assert!(std::fs::read_dir(&root).unwrap().next().is_none());
    assert!(std::fs::read_dir(&pinned).unwrap().next().is_some());
}

#[cfg(all(unix, not(target_os = "linux")))]
#[test]
fn the_opener_is_given_a_path_inside_the_private_directory() {
    let root = tempfile::tempdir().unwrap();
    let launcher = Arc::new(Launcher::default());
    let host = AttachmentHost::new(root.path().to_owned(), launcher.clone()).unwrap();

    host.open_json(r#"{"filename":"safe.txt","data":"QQ"}"#)
        .unwrap();

    let opened = launcher.0.lock().unwrap()[0].clone();
    assert!(opened.starts_with(root.path()), "{}", opened.display());
    assert!(
        opened
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("omamail-attachment-")),
        "{}",
        opened.display()
    );
    assert_eq!(std::fs::read(&opened).unwrap(), b"A");
}

#[cfg(target_os = "linux")]
#[test]
fn launched_process_can_read_the_pinned_attachment_after_exec() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("runtime");
    fs::create_dir(&root).unwrap();
    let copied = parent.path().join("opened-by-child");
    let script = parent.path().join("launcher");
    fs::write(&script, "#!/bin/sh\nexec cp -- \"$1\" \"$2\"\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let host = AttachmentHost::new(
        root.clone(),
        ExecLauncher {
            script,
            copied: copied.clone(),
        },
    )
    .unwrap();
    let pinned = parent.path().join("pinned");
    fs::rename(&root, &pinned).unwrap();
    fs::create_dir(&root).unwrap();

    host.open_json(r#"{"filename":"safe.txt","data":"Y3Jvc3MtZXhlYw"}"#)
        .unwrap();

    assert_eq!(fs::read(copied).unwrap(), b"cross-exec");
    assert!(fs::read_dir(root).unwrap().next().is_none());
    assert!(fs::read_dir(pinned).unwrap().next().is_some());
}

#[test]
fn the_opener_is_the_one_this_desktop_has() {
    let opener = omamail::attachment_host::SystemOpener::current();
    let expected = if cfg!(target_os = "macos") {
        omamail::attachment_host::MACOS_OPEN
    } else {
        omamail::attachment_host::XDG_OPEN
    };
    assert_eq!(opener.program(), Path::new(expected));
    // Absolute, both of them: what opens a stranger's file is not a decision
    // an inherited PATH gets to make.
    assert!(opener.program().is_absolute());
}

#[test]
fn attachment_module_is_registered_separately_from_generic_effects() {
    let source = include_str!("../src/effects.rs");
    assert!(source.contains("HostModule::new(\"omamail-attachment\")"));
    assert!(source.contains(".async_function(\"open\""));
}

// ---------------------------------------------------------------- the picker

struct Chooser(&'static str);
impl omamail::attachment_host::FileChooser for Chooser {
    fn choose(&self) -> Result<String, AttachmentError> {
        Ok(self.0.to_owned())
    }
}
struct BrokenChooser;
impl omamail::attachment_host::FileChooser for BrokenChooser {
    fn choose(&self) -> Result<String, AttachmentError> {
        Err(AttachmentError)
    }
}

fn chosen(answer: &'static str) -> serde_json::Value {
    serde_json::from_str(&omamail::attachment_host::choose_files(&Chooser(answer))).unwrap()
}

#[test]
fn a_chosen_file_crosses_as_metadata_and_never_as_bytes() {
    let answer = chosen(
        r#"{"ok":true,"files":[{"path":"/home/person/report.pdf","filename":"report.pdf","mimeType":"application/pdf","size":2048}]}"#,
    );
    assert_eq!(answer["ok"], serde_json::Value::Bool(true));
    assert_eq!(answer["files"][0]["path"], "/home/person/report.pdf");
    assert_eq!(answer["files"][0]["filename"], "report.pdf");
    assert_eq!(answer["files"][0]["mimeType"], "application/pdf");
    assert_eq!(answer["files"][0]["size"], 2048);
    assert!(answer["files"][0].get("data").is_none());
}

#[test]
fn cancelling_is_an_answer_rather_than_a_failure() {
    // Opening a file dialog and closing it again is what the ordinary user does
    // half the time. A rejected promise would have the composer report it as a
    // failure to attach.
    let answer = chosen(r#"{"ok":false,"error":"cancelled"}"#);
    assert_eq!(answer["ok"], serde_json::Value::Bool(false));
    assert_eq!(answer["error"], "cancelled");

    let broken: serde_json::Value =
        serde_json::from_str(&omamail::attachment_host::choose_files(&BrokenChooser)).unwrap();
    assert_eq!(broken["ok"], serde_json::Value::Bool(false));
    assert!(broken["error"].as_str().unwrap().len() < 128);
}

#[test]
fn a_chosen_file_that_could_forge_a_header_or_a_path_is_refused_at_the_picker() {
    // The same rules the send path holds — `main.js`'s `composeAttachments` and
    // `imap_host::validate_attachments` — applied while the user is still
    // looking at the dialog, rather than after they press Send.
    for answer in [
        r#"{"ok":true,"files":[{"path":"report.pdf","filename":"report.pdf","mimeType":"application/pdf","size":1}]}"#,
        r#"{"ok":true,"files":[{"path":"/home/person/../../etc/passwd","filename":"passwd","mimeType":"text/plain","size":1}]}"#,
        r#"{"ok":true,"files":[{"path":"/home/a\nb.pdf","filename":"a.pdf","mimeType":"application/pdf","size":1}]}"#,
        r#"{"ok":true,"files":[{"path":"/home/a.pdf","filename":"a\".pdf","mimeType":"application/pdf","size":1}]}"#,
        r#"{"ok":true,"files":[{"path":"/home/a.pdf","filename":"a.pdf; x=1","mimeType":"application/pdf","size":1}]}"#,
        r#"{"ok":true,"files":[{"path":"/home/a.pdf","filename":"../a.pdf","mimeType":"application/pdf","size":1}]}"#,
        r#"{"ok":true,"files":[{"path":"/home/a.pdf","filename":"a.pdf","mimeType":"application/pdf; x=1","size":1}]}"#,
        r#"{"ok":true,"files":[{"path":"/home/a.pdf","filename":"a.pdf","mimeType":"application/pdf","size":20971521}]}"#,
        r#"{"ok":true,"files":[]}"#,
        r#"not json at all"#,
    ] {
        let refused = chosen(answer);
        assert_eq!(
            refused["ok"],
            serde_json::Value::Bool(false),
            "accepted {answer}"
        );
    }
}

#[test]
fn the_picker_is_registered_beside_the_opener() {
    let source = include_str!("../src/effects.rs");
    assert!(source.contains(".async_function(\"pick\""));
    assert!(source.contains("scripts/attachment.sh"));
}

// ------------------------------------------------------------------ the store

// A forwarded file and a saved draft's file arrive from the mail server as
// bytes, and the send path opens a path. `store` is where the two meet.

#[cfg(unix)]
fn store(host: &AttachmentHost<Arc<Launcher>>, value: serde_json::Value) -> serde_json::Value {
    serde_json::from_str(&host.store_json(&value.to_string())).unwrap()
}

#[cfg(unix)]
#[test]
fn a_kept_file_is_answered_as_a_path_the_send_path_can_open() {
    let root = tempfile::tempdir().unwrap();
    let launcher = Arc::new(Launcher::default());
    let host = AttachmentHost::new(root.path().to_owned(), launcher.clone()).unwrap();
    let bytes = b"\0forwarded attachment bytes";
    let answer = store(
        &host,
        serde_json::json!({
            "filename": "report.pdf",
            "mimeType": "application/pdf",
            "data": URL_SAFE_NO_PAD.encode(bytes),
        }),
    );
    assert_eq!(answer["ok"], serde_json::json!(true));
    assert_eq!(answer["filename"], serde_json::json!("report.pdf"));
    assert_eq!(answer["mimeType"], serde_json::json!("application/pdf"));
    assert_eq!(answer["size"], serde_json::json!(bytes.len()));
    let path = PathBuf::from(answer["path"].as_str().unwrap());
    // An ordinary path, not this process's own view of a descriptor: it
    // crosses to the window and comes back on a draft, and the host opens it.
    assert!(path.is_absolute());
    assert!(path.starts_with(root.path()));
    assert!(
        !path
            .components()
            .any(|part| part.as_os_str() == "." || part.as_os_str() == ".."),
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let directory = std::fs::metadata(path.parent().unwrap()).unwrap();
        assert_eq!(directory.permissions().mode() & 0o777, 0o700);
    }
    // Nothing was opened: keeping a file is not showing it to anybody.
    assert!(launcher.0.lock().unwrap().is_empty());
    drop(host);
    assert!(!path.exists(), "the file goes when the window does");
}

#[cfg(unix)]
#[test]
fn a_name_or_a_type_the_send_path_would_refuse_is_refused_here() {
    let root = tempfile::tempdir().unwrap();
    let host = AttachmentHost::new(root.path().to_owned(), Arc::new(Launcher::default())).unwrap();
    let data = URL_SAFE_NO_PAD.encode(b"bytes");
    for (name, request) in [
        (
            "a name that could forge a header parameter",
            serde_json::json!({"filename":"a\";b.pdf","data":data}),
        ),
        (
            "a name that is a path",
            serde_json::json!({"filename":"../escape.pdf","data":data}),
        ),
        (
            "a media type that is not two tokens",
            serde_json::json!({"filename":"a.pdf","mimeType":"application/pdf; x=1","data":data}),
        ),
        (
            "bytes that are not base64",
            serde_json::json!({"filename":"a.pdf","data":"not base64!"}),
        ),
        (
            "a field nothing here reads",
            serde_json::json!({"filename":"a.pdf","data":data,"path":"/etc/passwd"}),
        ),
    ] {
        let answer = store(&host, request);
        assert_eq!(answer["ok"], serde_json::json!(false), "{name}");
        assert!(answer["path"].is_null(), "{name}");
    }
}

#[test]
fn the_store_is_registered_beside_the_opener() {
    let source = include_str!("../src/effects.rs");
    assert!(source.contains(".async_function(\"store\""));
}
