use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
};

#[cfg(unix)]
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

struct ExecLauncher {
    script: PathBuf,
    copied: PathBuf,
}

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

#[cfg(unix)]
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

#[cfg(unix)]
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
fn attachment_module_is_registered_separately_from_generic_effects() {
    let source = include_str!("../src/effects.rs");
    assert!(source.contains("HostModule::new(\"omamail-attachment\")"));
    assert!(source.contains(".async_function(\"open\""));
}
