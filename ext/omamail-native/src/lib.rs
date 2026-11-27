//! Omamail's Rust for the NSH app (`App.tsx` imports it as
//! `omamail-native`). The mail backend is the `omamail` library's
//! [`omamail::backend::Session`], the same one `omamail serve` runs: this
//! crate runs it in process on a worker thread and hands JSON-RPC frames and
//! notifications across, so the TSX speaks the exact protocol the Qt client
//! spoke and the UI thread never waits on the network.

mod diagnostics;
mod entry;
mod mail_client;
mod worker;

use nsh_core::JsonValue;
use nsh_core::prelude::*;

/// The app's Rust: what `App.tsx` imports from `omamail-native`.
#[native_module("omamail-native")]
fn native(registry: &mut Registry) {
    entry::keep();
    registry.module::<Backend>();
    registry.module::<diagnostics::Diagnostics>();
    registry.module::<mail_client::MailClient>();
}

/// The mail backend, in process: JSON-RPC requests and notifications.
#[module]
pub struct Backend;

#[module]
impl Backend {
    /// Sends one JSON-RPC 2.0 request and resolves with the backend's whole
    /// reply object (`{ result }` or `{ error: { code, message, data? } }`).
    /// Rejects only when the backend cannot run (`backend_unavailable`).
    pub async fn request(method: String, params: JsonValue) -> Result<JsonValue, String> {
        worker::request(method, params).await
    }

    /// The next backend notification (`{ method, params }`: `mail.updated`,
    /// outbox changes, `gmail.settled`), or null once the backend stops.
    /// One reader loops on it and fans the notifications out.
    pub async fn next_event() -> Option<JsonValue> {
        worker::next_event().await
    }

    /// Drains the backend: stops watches, sends what the outbox holds and
    /// flushes caches. Call once, when the app quits, after its own requests.
    pub async fn shutdown() -> Result<(), String> {
        worker::shutdown().await
    }

    /// One of the UI's private config files (`credentials.json`,
    /// `window.json`, `calendars.json`, and the read-only
    /// `plugin-settings.json` the Omarchy plugin hands over once), or null
    /// when absent. Other names are refused.
    pub fn read_config(name: String) -> Result<Option<String>, String> {
        omamail::platform::app_config::read(&name).map_err(str::to_owned)
    }

    /// Replaces one of the writable files (not `plugin-settings.json`), owner-only (0600) and atomically, in the
    /// directory the backend reads.
    pub fn write_config(name: String, text: String) -> Result<(), String> {
        omamail::platform::app_config::write(&name, &text).map_err(str::to_owned)
    }

    /// Opens a file the backend saved (an attachment saved to the downloads
    /// directory, or stored to open in this process's own private attachment
    /// folder) with the system's default app. Any other path, a link out of
    /// those folders, a non-file, or a type the desktop would run (a script,
    /// a launcher, a web page) is refused: the name and bytes came from a
    /// message, so only what the backend itself wrote, as a document, opens.
    pub fn open_download(path: String) -> Result<(), String> {
        open_download(&path).map_err(str::to_owned)
    }

    /// The Omarchy shell's font settings (`[font]` in
    /// `~/.config/omarchy/shell.toml`): `{ family?, baseSize? }`, each present
    /// only when usable, so `{}` off Omarchy. The UI scales its type from it.
    pub fn omarchy_font() -> JsonValue {
        omamail::platform::omarchy_font::read().into()
    }

    /// The `mailto:` link this process was launched with (the desktop
    /// entry's `%u`), or null. Only the first argument that is a `mailto:`
    /// link of at most 32 KiB is returned; every other argument stays out of
    /// the UI. The link is untrusted: the UI parses and checks it.
    pub fn launch_mailto() -> Option<String> {
        launch_mailto(std::env::args_os().skip(1))
    }

    /// Whether this is an Omarchy desktop: `omarchy` under the user's config
    /// directory (`$XDG_CONFIG_HOME` when absolute, else `$HOME/.config`) is
    /// a directory. Reads no file; the Theme setting's default follows it.
    pub fn is_omarchy() -> bool {
        is_omarchy(std::env::var_os("XDG_CONFIG_HOME"), std::env::var_os("HOME"))
    }

    /// The operating system the backend runs on: `macos`, `linux`,
    /// `windows`, `ios` or `android`.
    pub fn os() -> String {
        std::env::consts::OS.to_owned()
    }
}

const MAX_MAILTO: usize = 32 * 1024;

/// `<config>/omarchy` is a directory, config being `xdg` when absolute, else
/// `home/.config` when `home` is absolute. Only `metadata` is asked (the
/// path's own symlinks resolve as any open would); nothing is read.
fn is_omarchy(xdg: Option<std::ffi::OsString>, home: Option<std::ffi::OsString>) -> bool {
    use std::path::PathBuf;
    let config = xdg
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home.map(PathBuf::from).filter(|p| p.is_absolute()).map(|h| h.join(".config")));
    config.is_some_and(|c| std::fs::metadata(c.join("omarchy")).is_ok_and(|m| m.is_dir()))
}

fn launch_mailto(args: impl Iterator<Item = std::ffi::OsString>) -> Option<String> {
    args.filter_map(|arg| arg.into_string().ok())
        .map(|arg| arg.trim().to_owned())
        .find(|arg| arg.len() >= 7 && arg[..7].eq_ignore_ascii_case("mailto:"))
        .filter(|arg| arg.len() <= MAX_MAILTO && !arg.chars().any(|c| c.is_control()))
}

#[cfg(test)]
mod tests {
    use super::{is_omarchy, launch_mailto};

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("omamail-is-omarchy-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn omarchy_is_a_directory_under_the_config_dir() {
        let xdg = scratch("xdg");
        assert!(!is_omarchy(Some(xdg.clone().into()), None), "absent");
        std::fs::write(xdg.join("omarchy"), "").unwrap();
        assert!(!is_omarchy(Some(xdg.clone().into()), None), "a file is not");
        std::fs::remove_file(xdg.join("omarchy")).unwrap();
        std::fs::create_dir(xdg.join("omarchy")).unwrap();
        assert!(is_omarchy(Some(xdg.clone().into()), None), "a directory is");
        let _ = std::fs::remove_dir_all(&xdg);
    }

    #[test]
    fn a_relative_xdg_is_ignored_for_home() {
        let home = scratch("home");
        std::fs::create_dir_all(home.join(".config/omarchy")).unwrap();
        assert!(is_omarchy(Some("relative/config".into()), Some(home.clone().into())));
        assert!(!is_omarchy(Some("relative/config".into()), Some("relative/home".into())));
        assert!(!is_omarchy(None, None));
        let _ = std::fs::remove_dir_all(&home);
    }

    fn args(list: &[&str]) -> impl Iterator<Item = std::ffi::OsString> {
        list.iter().map(|a| a.into()).collect::<Vec<std::ffi::OsString>>().into_iter()
    }

    #[test]
    fn picks_the_first_mailto_link_only() {
        assert_eq!(
            launch_mailto(args(&["--flag", "MAILTO:a@example.com", "mailto:b@example.com"])),
            Some("MAILTO:a@example.com".into())
        );
        assert_eq!(launch_mailto(args(&["https://example.com", "agent-worker"])), None);
    }

    #[test]
    fn refuses_long_or_control_bearing_links() {
        let long = format!("mailto:{}", "a".repeat(40 * 1024));
        assert_eq!(launch_mailto(args(&[&long])), None);
        assert_eq!(launch_mailto(args(&["mailto:a@example.com\r\nBcc:x"])), None);
    }
}

fn open_download(path: &str) -> Result<(), &'static str> {
    let dirs = omamail::platform::dirs::AppDirs::discover()?;
    let roots = Roots { downloads: dirs.downloads, runtime: dirs.runtime, pid: std::process::id() };
    open_saved(path, &roots, &mut |file| {
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else if cfg!(target_os = "windows") {
            "explorer"
        } else {
            "xdg-open"
        };
        std::process::Command::new(opener)
            .arg(file)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(drop)
            .map_err(|_| "open_failed")
    })
}

/// Where the backend saves attachments: the downloads directory (Save), and
/// `<runtime>/omamail-attachment-<pid>-<n>/` (Open, core's
/// `attachment::store` with `open: true`).
struct Roots {
    downloads: std::path::PathBuf,
    runtime: std::path::PathBuf,
    pid: u32,
}

/// Types the desktop would run rather than show, beyond core's `openable`
/// list: macOS's Terminal scripts, bundles and installers, and launchers.
const ACTIVE_SUFFIXES: &[&str] = &[
    "command", "tool", "terminal", "app", "pkg", "mpkg", "workflow", "scpt", "applescript", "jar",
    "appimage", "run", "webloc", "inetloc", "fileloc", "py", "pl", "rb", "php", "csh", "ksh", "fish",
];

/// Opens `path` with `open` when it is a regular file the backend saved:
/// under the downloads directory, or directly in one of this process's own
/// attachment folders. Its type must be one that is shown, not run (core's
/// `openable` on its name and first bytes, and `ACTIVE_SUFFIXES`). Anything
/// else is refused and nothing is started.
fn open_saved(
    path: &str,
    roots: &Roots,
    open: &mut dyn FnMut(&std::path::Path) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    use std::io::Read;
    let file = std::fs::canonicalize(path).map_err(|_| "file_missing")?;
    if !std::fs::symlink_metadata(&file).is_ok_and(|m| m.is_file()) {
        return Err("path_refused");
    }
    let in_downloads = std::fs::canonicalize(&roots.downloads).is_ok_and(|root| file.starts_with(&root) && file != root);
    if !in_downloads && !in_attachment_folder(&file, &roots.runtime, roots.pid) {
        return Err("path_refused");
    }
    let name = file.file_name().and_then(|n| n.to_str()).ok_or("open_refused")?;
    let mut head = Vec::new();
    std::fs::File::open(&file)
        .and_then(|f| f.take(65536).read_to_end(&mut head))
        .map_err(|_| "file_missing")?;
    let lower = name.to_ascii_lowercase();
    let active = ACTIVE_SUFFIXES.iter().any(|s| lower.trim_end_matches(['.', ' ']).ends_with(&format!(".{s}")));
    if active || !omamail::attachment::openable(name, &head) {
        return Err("open_refused");
    }
    open(&file)
}

/// `file` (canonical) sits directly in `<runtime>/omamail-attachment-<pid>-<n>`,
/// a real folder of ours with mode 0700. (macOS and Linux, where the
/// crate links libc for the owner check.)
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn in_attachment_folder(file: &std::path::Path, runtime: &std::path::Path, pid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(runtime) = std::fs::canonicalize(runtime) else { return false };
    let Some(folder) = file.parent() else { return false };
    if folder.parent() != Some(runtime.as_path()) {
        return false;
    }
    let prefix = format!("omamail-attachment-{pid}-");
    let named = folder
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix(&prefix))
        .is_some_and(|n| (1..=3).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()));
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    named
        && std::fs::symlink_metadata(folder)
            .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink() && m.uid() == uid && m.mode() & 0o777 == 0o700)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn in_attachment_folder(_: &std::path::Path, _: &std::path::Path, _: u32) -> bool {
    false
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod open_tests {
    use super::{Roots, open_saved};
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::{Path, PathBuf};

    const PID: u32 = 4242;

    /// downloads/ and runtime/ under a fresh scratch folder.
    fn roots(name: &str) -> (PathBuf, Roots) {
        let dir = std::env::temp_dir().join(format!("omamail-open-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("downloads")).unwrap();
        fs::create_dir_all(dir.join("runtime")).unwrap();
        let roots = Roots { downloads: dir.join("downloads"), runtime: dir.join("runtime"), pid: PID };
        (dir, roots)
    }

    /// A folder as core's `attachment::store` makes it: 0700.
    fn attachment_folder(roots: &Roots, name: &str) -> PathBuf {
        let folder = roots.runtime.join(name);
        fs::create_dir(&folder).unwrap();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
        folder
    }

    /// What was asked to open, with a stub opener: nothing is spawned.
    fn try_open(path: &Path, roots: &Roots) -> (Result<(), &'static str>, Vec<PathBuf>) {
        let mut opened = Vec::new();
        let result = open_saved(path.to_str().unwrap(), roots, &mut |file| {
            opened.push(file.to_owned());
            Ok(())
        });
        (result, opened)
    }

    const PDF: &[u8] = b"%PDF-1.7 test";

    #[test]
    fn an_attachment_stored_to_open_opens() {
        let (dir, roots) = roots("runtime");
        let file = attachment_folder(&roots, &format!("omamail-attachment-{PID}-0")).join("invoice.pdf");
        fs::write(&file, PDF).unwrap();
        let (result, opened) = try_open(&file, &roots);
        assert_eq!(result, Ok(()));
        assert_eq!(opened, [fs::canonicalize(&file).unwrap()]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_saved_download_still_opens() {
        let (dir, roots) = roots("downloads");
        let file = roots.downloads.join("photo.png");
        fs::write(&file, b"\x89PNG\r\n").unwrap();
        let (result, opened) = try_open(&file, &roots);
        assert_eq!(result, Ok(()));
        assert_eq!(opened.len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn other_folders_are_refused_and_nothing_starts() {
        let (dir, roots) = roots("refused");
        let mut refused = Vec::new();
        // Another process's folder, a folder others can read, a name that
        // only starts like ours, a nested folder, and the runtime dir itself.
        for (name, mode) in [
            (format!("omamail-attachment-{}-0", PID + 1), 0o700),
            (format!("omamail-attachment-{PID}-1"), 0o755),
            (format!("omamail-attachment-{PID}-x"), 0o700),
            (format!("omamail-attachment-{PID}-0000"), 0o700),
        ] {
            let folder = attachment_folder(&roots, &name);
            fs::set_permissions(&folder, fs::Permissions::from_mode(mode)).unwrap();
            refused.push(folder.join("a.pdf"));
        }
        let nested = attachment_folder(&roots, &format!("omamail-attachment-{PID}-2")).join("deeper");
        fs::create_dir(&nested).unwrap();
        refused.push(nested.join("a.pdf"));
        refused.push(roots.runtime.join("a.pdf"));
        refused.push(dir.join("a.pdf"));
        for file in &refused {
            fs::write(file, PDF).unwrap();
            let (result, opened) = try_open(file, &roots);
            assert_eq!(result, Err("path_refused"), "{file:?}");
            assert!(opened.is_empty(), "{file:?}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn links_out_of_the_folders_are_refused() {
        let (dir, roots) = roots("links");
        let outside = dir.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(outside.join("a.pdf"), PDF).unwrap();
        // A folder named like ours that is a link elsewhere.
        let linked = roots.runtime.join(format!("omamail-attachment-{PID}-5"));
        symlink(&outside, &linked).unwrap();
        // A file link in a real folder of ours, and one in downloads.
        let folder = attachment_folder(&roots, &format!("omamail-attachment-{PID}-6"));
        symlink(outside.join("a.pdf"), folder.join("b.pdf")).unwrap();
        symlink(outside.join("a.pdf"), roots.downloads.join("c.pdf")).unwrap();
        for file in [linked.join("a.pdf"), folder.join("b.pdf"), roots.downloads.join("c.pdf")] {
            let (result, opened) = try_open(&file, &roots);
            assert_eq!(result, Err("path_refused"), "{file:?}");
            assert!(opened.is_empty());
        }
        // A folder, not a file.
        let (result, opened) = try_open(&folder, &roots);
        assert_eq!(result, Err("path_refused"));
        assert!(opened.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn types_the_desktop_would_run_are_refused_in_both_places() {
        let (dir, roots) = roots("types");
        let folder = attachment_folder(&roots, &format!("omamail-attachment-{PID}-0"));
        let cases: &[(&str, &[u8])] = &[
            ("launcher.desktop", b"[Desktop Entry]\nExec=sh\n"),
            ("run.sh", b"echo hi\n"),
            ("run.command", b"echo hi\n"),
            ("page.html", b"<html></html>"),
            ("page.htm ", b"x"),
            ("Report.PDF.Command", b"x"),
            ("notes.txt", b"#!/bin/sh\nrm -rf ~\n"),
            ("notes.txt", b"<script>alert(1)</script>"),
            ("binary.pdf", b"\x7fELF\x02"),
            ("link.webloc", b"x"),
        ];
        for root in [roots.downloads.clone(), folder] {
            for (name, bytes) in cases {
                let file = root.join(name);
                fs::write(&file, bytes).unwrap();
                let (result, opened) = try_open(&file, &roots);
                assert_eq!(result, Err("open_refused"), "{file:?}");
                assert!(opened.is_empty(), "{file:?}");
                fs::remove_file(&file).unwrap();
            }
        }
        fs::remove_dir_all(dir).unwrap();
    }

    /// The naming contract between core and this crate: what core's real
    /// `attachment::store` writes to open, under the runtime directory the
    /// real `AppDirs::discover` names, is what `open_saved` accepts. No
    /// environment is changed (other tests run in parallel); the folder
    /// store makes is this process's own and is removed afterwards.
    #[test]
    fn what_core_stores_to_open_is_what_opens() {
        let dirs = omamail::platform::dirs::AppDirs::discover().unwrap();
        let stored = omamail::attachment::store(&serde_json::json!({"filename": "invoice.pdf", "open": true}), PDF).unwrap();
        let path = PathBuf::from(stored["path"].as_str().unwrap());
        let folder = path.parent().unwrap().to_owned();
        let roots = Roots { downloads: dirs.downloads, runtime: dirs.runtime, pid: std::process::id() };
        let (result, opened) = try_open(&path, &roots);
        let _ = fs::remove_dir_all(&folder);
        assert_eq!(result, Ok(()), "{path:?}");
        assert_eq!(opened.len(), 1);
        // And as another process, the same folder is refused.
        let other = Roots { pid: std::process::id() + 1, ..roots };
        let again = omamail::attachment::store(&serde_json::json!({"filename": "invoice.pdf", "open": true}), PDF).unwrap();
        let again = PathBuf::from(again["path"].as_str().unwrap());
        let (result, opened) = try_open(&again, &other);
        let _ = fs::remove_dir_all(again.parent().unwrap());
        assert_eq!(result, Err("path_refused"));
        assert!(opened.is_empty());
    }

    #[test]
    fn a_missing_file_is_refused() {
        let (dir, roots) = roots("missing");
        let (result, opened) = try_open(&roots.downloads.join("gone.pdf"), &roots);
        assert_eq!(result, Err("file_missing"));
        assert!(opened.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
