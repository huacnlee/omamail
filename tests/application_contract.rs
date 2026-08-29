use std::{fs, path::PathBuf, process::Command};

use omamail::{APP_ID, ApplicationPaths, application_dir, omarchy_palette_path};

fn app_fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().expect("application fixture");
    fs::write(root.path().join("gpui-shell.json"), "{}").expect("fixture manifest");
    root
}

fn repository_app() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("app")
}

#[test]
fn application_identity_is_stable() {
    assert_eq!(APP_ID, "com.omarchy.omamail");
}

#[test]
fn explicit_application_directory_wins() {
    let explicit = app_fixture();
    let paths = ApplicationPaths {
        explicit: Some(explicit.path().to_path_buf()),
        executable: PathBuf::from("/opt/Omamail/bin/omamail"),
        manifest_dir: PathBuf::from("/checkout"),
    };

    assert_eq!(application_dir(&paths).unwrap(), explicit.path());
}

#[test]
fn invalid_explicit_application_directory_is_an_error() {
    let explicit = tempfile::tempdir().expect("invalid application fixture");
    let paths = ApplicationPaths {
        explicit: Some(explicit.path().to_path_buf()),
        executable: PathBuf::from("/opt/Omamail/bin/omamail"),
        manifest_dir: PathBuf::from("/checkout"),
    };

    let error = application_dir(&paths).unwrap_err();
    assert!(error.contains("OMAMAIL_APP_DIR"), "{error}");
}

#[test]
fn checkout_application_is_the_development_fallback() {
    let checkout = tempfile::tempdir().expect("checkout fixture");
    let app = checkout.path().join("app");
    fs::create_dir(&app).expect("application directory");
    fs::write(app.join("gpui-shell.json"), "{}").expect("fixture manifest");
    let paths = ApplicationPaths {
        explicit: None,
        executable: checkout.path().join("target/debug/omamail"),
        manifest_dir: checkout.path().to_path_buf(),
    };

    assert_eq!(application_dir(&paths).unwrap(), app);
}

#[test]
fn script_manifest_starts_with_no_mail_or_process_authority() {
    let root = repository_app();
    let manifest = gpui_shell::plugin::PluginManifest::read(&root).expect("application manifest");
    let capabilities = manifest.capabilities(&root, &std::env::temp_dir());

    assert!(capabilities.has_storage());
    assert!(!capabilities.may_run("curl"));
    assert!(!capabilities.may_run("hey"));
    assert!(!capabilities.may_reach("gmail.googleapis.com"));
    assert!(!capabilities.may_reach("127.0.0.1"));
}

#[test]
fn packaged_resource_probe_reports_the_application_directory() {
    let output = Command::new(env!("CARGO_BIN_EXE_omamail"))
        .arg("--check-resources")
        .output()
        .expect("run Omamail resource probe");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        repository_app().display().to_string()
    );
}

#[test]
fn omarchy_palette_is_a_linux_only_narrow_file_capability() {
    let home = PathBuf::from("/home/alice");
    assert_eq!(
        omarchy_palette_path(Some(&home), "linux"),
        Some(home.join(".local/state/omarchy/current/theme/colors.toml"))
    );
    assert_eq!(omarchy_palette_path(Some(&home), "macos"), None);
    assert_eq!(omarchy_palette_path(Some(&home), "windows"), None);
    assert_eq!(omarchy_palette_path(None, "linux"), None);
}

#[test]
fn every_host_quit_path_stops_the_companion_before_quitting() {
    let source = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"))
        .expect("read host source");
    for (name, start, end) in [
        (
            "exit request",
            "gpui_shell::on_exit_request",
            "let closed_path",
        ),
        ("window close", "cx.on_window_closed", "cx.activate"),
        ("Quit action", "fn install_quit", "if cfg!(target_os"),
    ] {
        let begin = source.find(start).expect(name);
        let finish = source[begin..]
            .find(end)
            .map(|offset| begin + offset)
            .expect(name);
        assert!(
            source[begin..finish].contains("request_quit("),
            "{name} must use request_quit"
        );
    }
}
