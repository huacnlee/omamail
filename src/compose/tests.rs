use super::*;
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "omamail-compose-test-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn saved(body: &str) -> Value {
    json!({"version":1,"active":true,"returnView":"reader","draft":{"body":body,"accountId":"one@example.org"}})
}
#[test]
fn meaningful_body_history_and_parked_identity_survive() {
    assert!(
        !normalize(&saved("  ")).unwrap()["active"]
            .as_bool()
            .unwrap()
    );
    let mut value = saved("\n\nSignature");
    value["draft"]["placedBody"] = json!("\n\nSignature");
    assert_eq!(normalize(&value).unwrap(), empty());
    value["draft"]["bodyWasEdited"] = json!(true);
    value["parked"] =
        json!([{"body":"other draft","accountId":"imap:two@example.org"},{"body":"  "}]);
    let record = normalize(&value).unwrap();
    assert_eq!(record["draft"]["body"], "\n\nSignature");
    assert_eq!(record["parked"].as_array().unwrap().len(), 1);
    assert_eq!(record["parked"][0]["accountId"], "imap:two@example.org");
}
#[test]
fn snapshots_are_private_atomic_and_stale_clear_cannot_erase_newer_draft() {
    use std::os::unix::fs::PermissionsExt;
    let temp = Temp::new();
    let initial = call_at(&temp.0, "compose.recoveryRead", &json!({})).unwrap();
    let first = call_at(
        &temp.0,
        "compose.recoverySave",
        &json!({"record":saved("first"),"expectedRevision":initial["revision"]}),
    )
    .unwrap();
    let second = call_at(
        &temp.0,
        "compose.recoverySave",
        &json!({"record":saved("second"),"expectedRevision":first["revision"]}),
    )
    .unwrap();
    assert_eq!(
        call_at(
            &temp.0,
            "compose.recoverySave",
            &json!({"record":{"version":1,"active":false},"expectedRevision":first["revision"]})
        ),
        Err("recovery_conflict")
    );
    assert_eq!(
        call_at(&temp.0, "compose.recoveryRead", &json!({})).unwrap(),
        second
    );
    assert_eq!(
        std::fs::metadata(temp.0.join("omamail/compose.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let cleared = call_at(
        &temp.0,
        "compose.recoverySave",
        &json!({"record":{"version":1,"active":false},"expectedRevision":second["revision"]}),
    )
    .unwrap();
    assert_eq!(cleared["record"], empty());
}
#[test]
fn links_never_read_write_or_modify_outside_target() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    for name in ["compose.json", ".compose.lock"] {
        for hard in [false, true] {
            let temp = Temp::new();
            std::fs::create_dir(temp.0.join("omamail")).unwrap();
            let outside = temp.0.join("outside");
            std::fs::write(&outside, b"secret").unwrap();
            std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o644)).unwrap();
            let path = temp.0.join("omamail").join(name);
            if hard {
                std::fs::hard_link(&outside, path).unwrap();
            } else {
                symlink(&outside, path).unwrap();
            }
            assert!(
                call_at(
                    &temp.0,
                    "compose.recoverySave",
                    &json!({"record":saved("draft"),"expectedRevision":revision(&[])})
                )
                .is_err()
            );
            assert_eq!(std::fs::read(&outside).unwrap(), b"secret");
            assert_eq!(
                std::fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
                0o644
            );
        }
    }
}
#[test]
fn attachment_metadata_never_opens_paths_and_invalid_paths_write_nothing() {
    let temp = Temp::new();
    let outside = temp.0.join("sentinel");
    std::fs::write(&outside, b"untouched").unwrap();
    let mut value = saved("draft");
    value["draft"]["draftAttachments"] =
        json!([{"path":outside,"owned":true,"data":"ignored","filename":"file"}]);
    let answer = normalize(&value).unwrap();
    assert_eq!(answer["draft"]["draftAttachments"][0]["data"], "");
    assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
    for path in [
        "../secret",
        "relative",
        "/tmp/a\0",
        "/tmp/a\n",
        "/tmp/x/../../outside",
        "/tmp/./a",
    ] {
        value["draft"]["draftAttachments"][0]["path"] = json!(path);
        assert_eq!(
            call_at(
                &temp.0,
                "compose.recoverySave",
                &json!({"record":value,"expectedRevision":revision(&[])})
            ),
            Err("recovery_attachment_path_invalid")
        );
    }
    assert!(!temp.0.join("omamail").exists());
}
#[test]
fn js_oracle_parity_for_normalized_drafts() {
    let fixtures = json!([saved("hello"),saved(" "),{"version":1,"active":true,"returnView":"calendar","draft":{"to":"a@example.org","draftAttachments":[{"path":"/tmp/synthetic","data":"discard","filename":"a","size":12}],"replyRecipients":[{"email":"a@example.org"}]},"parked":[{"subject":"parked","accountId":"other"},{}]}, {"version":1,"active":false}, {"version":2,"active":true}]);
    let script = r#"const fs=require('fs'),vm=require('vm');const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync('ui/tests/oracles/Recovery.js','utf8').replace(/^\.pragma library\s*/,''),ctx);const fixtures=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(fixtures.map(v=>ctx.parse(JSON.stringify(v)))));"#;
    use std::process::{Command, Stdio};
    let mut child = Command::new("node")
        .args(["-e", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(fixtures.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
    for (input, expected) in fixtures
        .as_array()
        .unwrap()
        .iter()
        .zip(expected.as_array().unwrap())
    {
        assert_eq!(normalize(input).unwrap(), *expected);
    }
}

#[test]
fn malformed_or_oversize_save_does_not_replace_existing_snapshot() {
    let temp = Temp::new();
    let first = call_at(
        &temp.0,
        "compose.recoverySave",
        &json!({"record":saved("retain me"),"expectedRevision":revision(&[])}),
    )
    .unwrap();
    for value in [
        json!(null),
        json!({}),
        json!({"version":2,"active":false}),
        saved(&"x".repeat(MAX_BYTES)),
    ] {
        assert!(
            call_at(
                &temp.0,
                "compose.recoverySave",
                &json!({"record":value,"expectedRevision":first["revision"]})
            )
            .is_err()
        );
        assert_eq!(
            call_at(&temp.0, "compose.recoveryRead", &json!({})).unwrap(),
            first
        );
    }
}

#[test]
fn delivery_receipts_survive_recovery_without_changing_legacy_empty_fields() {
    let mut value = saved("pending");
    assert!(
        normalize(&value).unwrap()["draft"]
            .get("pendingSendId")
            .is_none()
    );
    value["draft"]["pendingSendId"] = json!("send-one");
    value["draft"]["deliveryUnknown"] = json!(true);
    let record = normalize(&value).unwrap();
    assert_eq!(record["draft"]["pendingSendId"], "send-one");
    assert_eq!(record["draft"]["deliveryUnknown"], true);
    value["draft"]["pendingSendId"] = json!("send-one\n");
    assert!(normalize(&value).is_err());
}

#[test]
fn recovery_lock_releases_even_with_an_inherited_file_description() {
    let temp = Temp::new();
    let path = temp.0.join("lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    assert_eq!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let inherited = file.try_clone().unwrap();
    drop(RecoveryLock(file));
    let contender = File::open(&path).unwrap();
    assert_eq!(
        unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    drop(inherited);
}
