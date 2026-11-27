//! "Diagnose with AI..." on Omarchy: hands a diagnostic report to the
//! system's agent the way the Qt plugin's `scripts/diagnostics.py` did.
//!
//! The report (already reduced by the TSX to known error identifiers) is
//! written owner-only to `$XDG_STATE_HOME/omamail/diagnostics/report.txt`,
//! and `omarchy-agent` is started with a fixed prompt that names that file.
//! Nothing from the report, mail, settings or the environment goes on the
//! command line, and no shell runs. Where `omarchy-agent` is not installed
//! (macOS, other Linux desktops) this reports "absent" and the app falls back
//! to copying the report.

use nsh_core::prelude::*;

const LIMIT: usize = 65536;

/// Diagnostics for the system AI agent.
#[module]
pub struct Diagnostics;

#[module]
impl Diagnostics {
    /// Saves `report` privately and opens it in Omarchy's system agent.
    /// Resolves to `"opened"`, or `"absent"` when this system has no
    /// `omarchy-agent` (then nothing is written). Rejects with
    /// `report_invalid`, `storage_unavailable` or `agent_failed`.
    pub async fn open_agent(report: String) -> Result<String, String> {
        imp::open_agent(report).await.map_err(str::to_owned)
    }
}

/// At most this many error lines (the TSX keeps the last 100).
const MAX_EVENTS: usize = 100;

/// The report holds printable ASCII lines only, in exactly the shape the
/// TSX writes (`diagnosticReport`): a fixed header, the app's version, API
/// revision and system, then one JSON line per error with a timestamp, a
/// method name, a numeric code and a known error identifier. Nothing in that
/// grammar can carry an address, a subject or message text (no `@`, no
/// spaces, no free text), so the promise Settings makes ("no addresses,
/// subjects or message text") holds here too, whatever the caller passes.
fn valid_report(report: &str) -> bool {
    !report.is_empty()
        && report.len() <= LIMIT
        && report.bytes().all(|b| b == b'\n' || (0x20..0x7f).contains(&b))
        && report_shape(report)
}

fn report_shape(report: &str) -> bool {
    let Some(body) = report.strip_suffix('\n') else { return false };
    let lines: Vec<&str> = body.split('\n').collect();
    if lines.len() < 7 {
        return false;
    }
    let fixed = lines[0] == "Omamail diagnostics"
        && lines[1].strip_prefix("app: ").is_some_and(version)
        && lines[2].strip_prefix("API revision: ").is_some_and(|n| (1..=6).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
        && lines[3].strip_prefix("system: ").is_some_and(|os| os.len() <= 16 && os.bytes().all(|b| b.is_ascii_lowercase()))
        && lines[4].is_empty()
        && lines[5] == "Recent backend errors (known identifiers only; no raw provider text):";
    if !fixed {
        return false;
    }
    let events = &lines[6..];
    if events == ["(none recorded)"] {
        return true;
    }
    events.len() <= MAX_EVENTS && events.iter().all(|line| event(line))
}

/// An app version: `0.12.0`, `1.0.0-beta.2+build.5`, or `unknown`.
fn version(v: &str) -> bool {
    (1..=40).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
}

/// `{"time":"2026-11-27T10:00:00Z","method":"mail.send","code":-32000,"message":"smtp_delivery_unknown"}`
fn event(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("{\"time\":\"") else { return false };
    let Some((time, rest)) = rest.split_once("\",\"method\":\"") else { return false };
    let Some((method_name, rest)) = rest.split_once("\",\"code\":") else { return false };
    let Some((code_text, rest)) = rest.split_once(",\"message\":\"") else { return false };
    let Some(message) = rest.strip_suffix("\"}") else { return false };
    timestamp(time) && method(method_name) && code(code_text) && identifier(message)
}

/// `YYYY-MM-DDTHH:MM:SSZ`.
fn timestamp(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 20
        && b.iter().enumerate().all(|(i, &c)| match i {
            4 | 7 => c == b'-',
            10 => c == b'T',
            13 | 16 => c == b':',
            19 => c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

/// The TSX's `METHOD`: a lower-case first letter, then two to four dotted
/// segments of letters (`mail.send`, `agent.jobsProjection`).
fn method(m: &str) -> bool {
    let parts: Vec<&str> = m.split('.').collect();
    m.len() <= 80
        && (2..=4).contains(&parts.len())
        && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphabetic()))
        && m.as_bytes()[0].is_ascii_lowercase()
}

/// `null` or a JSON-RPC code in an i16's range.
fn code(c: &str) -> bool {
    c == "null"
        || (c.len() <= 6
            && c.strip_prefix('-').unwrap_or(c).bytes().all(|b| b.is_ascii_digit())
            && c.parse::<i32>().is_ok_and(|n| (-32768..=32767).contains(&n)))
}

/// The client's own fixed sentences in the TSX vocabulary (its
/// `KNOWN_ERRORS`), the only identifiers with spaces.
const CLIENT_ERRORS: &[&str] = &[
    "Backend unavailable",
    "Backend stopped",
    "Backend response timed out",
    "Backend request timed out",
    "Request cancelled",
    "Too many pending requests",
    "Incompatible backend",
    "Invalid backend response",
    "Backend is shutting down",
    "Backend is not ready",
    "Invalid params",
    "Method not found",
];

/// A known error identifier's shape (`smtp_delivery_unknown`), or one of
/// the client's fixed sentences.
fn identifier(id: &str) -> bool {
    CLIENT_ERRORS.contains(&id)
        || ((1..=64).contains(&id.len())
            && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
}

/// The fixed instructions, as diagnostics.py gave them, naming the file.
fn prompt(path: &str) -> String {
    format!(
        "Diagnose an Omamail error using the local report at {path}. Start with read-only investigation. \
         Explain the cause and propose a fix. Do not send mail, retry failed operations, change settings, \
         delete or move AI history, or read mail bodies, credentials or conversation files without explicit \
         user approval. An unknown error means the original text was omitted for privacy. \
         agent_invalid_state can indicate AI history written by an incompatible backend version."
    )
}

/// The file and process work, on macOS too so its tests run there; only
/// Linux calls it (where `omarchy-agent` lives).
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod unix {
    use super::prompt;
    use std::fs::{self, DirBuilder, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    pub const AGENT: &str = "omarchy-agent";

    /// The first executable `AGENT` in `path` (a PATH value), as a full path;
    /// relative entries are skipped.
    pub fn find_agent(path: &std::ffi::OsStr) -> Option<PathBuf> {
        std::env::split_paths(path)
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(AGENT))
            .find(|file| {
                fs::metadata(file)
                    .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                    .unwrap_or(false)
            })
    }

    /// A directory of ours, 0700, not a link.
    pub fn private_dir(path: &Path) -> Result<(), &'static str> {
        match DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("storage_unavailable"),
        }
        let meta = fs::symlink_metadata(path).map_err(|_| "storage_unavailable")?;
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
            return Err("storage_unavailable");
        }
        Ok(())
    }

    /// Replaces `<state>/omamail/diagnostics/report.txt` owner-only and
    /// atomically.
    pub fn save_in(state: &Path, report: &str) -> Result<PathBuf, &'static str> {
        let base = state.join("omamail");
        let folder = base.join("diagnostics");
        fs::create_dir_all(state).map_err(|_| "storage_unavailable")?;
        private_dir(&base)?;
        private_dir(&folder)?;
        let target = folder.join("report.txt");
        let temp = folder.join(format!(".write-{}", std::process::id()));
        let _ = fs::remove_file(&temp);
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temp)?;
            file.write_all(report.as_bytes())?;
            file.sync_all()?;
            fs::rename(&temp, &target)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
            return Err("storage_unavailable");
        }
        Ok(target)
    }

    /// Starts `agent --prompt <fixed text naming report>`: no shell, no
    /// stdin, no output, its own process group.
    pub fn spawn(agent: &Path, report: &Path) -> Result<Child, &'static str> {
        let path = report.to_str().ok_or("storage_unavailable")?;
        Command::new(agent)
            .arg("--prompt")
            .arg(prompt(path))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|_| "agent_failed")
    }

    /// omarchy-agent may stay in the foreground for its whole terminal
    /// session: a quick failure is an error, a running agent is success,
    /// and it is reaped whenever it ends.
    pub fn settle(mut child: Child, grace: Duration) -> Result<(), &'static str> {
        let started = Instant::now();
        while started.elapsed() < grace {
            match child.try_wait() {
                Ok(Some(status)) => return if status.success() { Ok(()) } else { Err("agent_failed") },
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => return Err("agent_failed"),
            }
        }
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }

    /// Saves the report under `state` and opens it in `agent`.
    pub fn open_with(agent: &Path, state: &Path, report: &str) -> Result<(), &'static str> {
        let path = save_in(state, report)?;
        settle(spawn(agent, &path)?, Duration::from_secs(2))
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{unix, valid_report};

    pub async fn open_agent(report: String) -> Result<String, &'static str> {
        if !valid_report(&report) {
            return Err("report_invalid");
        }
        let Some(agent) = std::env::var_os("PATH").and_then(|p| unix::find_agent(&p)) else {
            return Ok("absent".to_owned());
        };
        let state = omamail::platform::dirs::AppDirs::discover()?.state;
        let (tx, rx) = tokio::sync::oneshot::channel();
        // Files and a child process: off the UI thread.
        std::thread::spawn(move || {
            let _ = tx.send(unix::open_with(&agent, &state, &report));
        });
        rx.await.map_err(|_| "agent_failed")??;
        Ok("opened".to_owned())
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::valid_report;

    pub async fn open_agent(report: String) -> Result<String, &'static str> {
        if !valid_report(&report) {
            return Err("report_invalid");
        }
        let _ = super::prompt;
        Ok("absent".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A report exactly as the TSX's `diagnosticReport` writes it.
    fn report(events: &[&str]) -> String {
        let mut lines = vec![
            "Omamail diagnostics".to_owned(),
            "app: 0.12.0".to_owned(),
            "API revision: 10".to_owned(),
            "system: linux".to_owned(),
            String::new(),
            "Recent backend errors (known identifiers only; no raw provider text):".to_owned(),
        ];
        if events.is_empty() {
            lines.push("(none recorded)".to_owned());
        }
        lines.extend(events.iter().map(|e| (*e).to_owned()));
        lines.join("\n") + "\n"
    }

    const SEND: &str = r#"{"time":"2026-11-27T10:00:00Z","method":"mail.send","code":-32000,"message":"smtp_delivery_unknown"}"#;
    const NULL_CODE: &str = r#"{"time":"2026-11-27T10:00:00Z","method":"backend.request","code":null,"message":"Backend is not ready"}"#;

    /// Synthetic private values: addresses, subjects, message text, names,
    /// URLs and a credential, as a leaking caller might pass them.
    const PRIVATE: &[&str] = &[
        "alice@example.com",
        "Bob <bob@example.org>",
        "Re: Quarterly numbers",
        "Subject: Lunch on Friday?",
        "Hi Bob, the wire details are below.",
        "https://mail.example.com/inbox?id=42",
        "password hunter2",
        "550 5.1.1 carol@example.net: user unknown",
        "Message-ID: <abc123@mx.example.com>",
    ];

    #[test]
    fn the_reports_the_tsx_writes_are_taken() {
        assert!(valid_report(&report(&[])));
        assert!(valid_report(&report(&[SEND])));
        assert!(valid_report(&report(&[SEND, NULL_CODE])));
        let full: Vec<&str> = std::iter::repeat_n(SEND, MAX_EVENTS).collect();
        assert!(valid_report(&report(&full)));
        let unknown = report(&[SEND]).replace("app: 0.12.0", "app: unknown").replace("system: linux", "system: unknown");
        assert!(valid_report(&unknown));
        let prerelease = report(&[SEND]).replace("app: 0.12.0", "app: 1.0.0-beta.2+build.5");
        assert!(valid_report(&prerelease));
    }

    #[test]
    fn controls_non_ascii_and_oversize_are_refused() {
        assert!(!valid_report(""));
        assert!(!valid_report(&(report(&[SEND]) + "\u{1b}[31m")));
        assert!(!valid_report(&report(&[SEND]).replace("linux", "lin\u{0}ux")));
        assert!(!valid_report(&report(&[SEND]).replace('\n', "\r\n")));
        assert!(!valid_report(&report(&[SEND]).replace("mail.send", "mail.s\u{e9}nd")));
        assert!(!valid_report(&report(&[SEND]).replace("linux", "l\u{4e2d}")));
        assert!(!valid_report(&"x".repeat(LIMIT + 1)));
        // One event over the cap, or a missing final newline.
        let over: Vec<&str> = std::iter::repeat_n(SEND, MAX_EVENTS + 1).collect();
        assert!(!valid_report(&report(&over)));
        assert!(!valid_report(report(&[SEND]).trim_end()));
    }

    /// The promise of the Settings "Diagnose" row: no addresses, subjects or
    /// message text. Every place a value could be smuggled into the report
    /// is tried with each private value, and every one is refused.
    #[test]
    fn no_address_subject_or_message_text_is_taken_anywhere() {
        for value in PRIVATE {
            let json = value.replace('"', "\\\"");
            let attempts = [
                // As the error message, as the method, in the code.
                SEND.replace("smtp_delivery_unknown", &json),
                SEND.replace("mail.send", &json),
                SEND.replace("-32000", &json),
                SEND.replace("2026-11-27T10:00:00Z", &json),
                // An extra field, a trailing line, a line of its own.
                SEND.replace("}", &format!(",\"subject\":\"{json}\"}}")),
                format!("{SEND} {value}"),
                value.to_string(),
            ];
            for event in &attempts {
                assert!(!valid_report(&report(&[event])), "took {event:?}");
            }
            // In the header lines.
            for (from, to) in [
                ("app: 0.12.0", format!("app: {value}")),
                ("system: linux", format!("system: {value}")),
                ("API revision: 10", format!("API revision: {value}")),
                ("Omamail diagnostics", format!("Omamail diagnostics {value}")),
            ] {
                assert!(!valid_report(&report(&[SEND]).replace(from, &to)), "took {to:?}");
            }
            // In the blank line, or after "(none recorded)".
            assert!(!valid_report(&report(&[SEND]).replacen("\n\n", &format!("\n{value}\n"), 1)));
            assert!(!valid_report(&(report(&[]) + value + "\n")));
        }
    }

    #[test]
    fn the_fields_keep_their_tsx_shapes() {
        for bad in [
            SEND.replace("-32000", "32768"),
            SEND.replace("-32000", "-32769"),
            SEND.replace("-32000", "1.5"),
            SEND.replace("-32000", "\"x\""),
            SEND.replace("mail.send", "mail"),
            SEND.replace("mail.send", "Mail.send"),
            SEND.replace("mail.send", "a.b.c.d.e"),
            SEND.replace("mail.send", "mail.send; rm -rf"),
            SEND.replace("2026-11-27T10:00:00Z", "2026-11-27T10:00:00.123Z"),
            SEND.replace("smtp_delivery_unknown", "Backend exploded"),
            SEND.replace("smtp_delivery_unknown", &"a".repeat(65)),
        ] {
            assert!(!valid_report(&report(&[&bad])), "took {bad:?}");
        }
        assert!(valid_report(&report(&[&SEND.replace("-32000", "32767")])));
        assert!(valid_report(&report(&[&SEND.replace("mail.send", "agent.jobs.projection")])));
    }

    #[test]
    fn the_prompt_is_fixed_text_and_the_path() {
        let path = "/home/u/.local/state/omamail/diagnostics/report.txt";
        let text = prompt(path);
        assert_eq!(text.matches(path).count(), 1);
        assert!(text.starts_with("Diagnose an Omamail error using the local report at /home/u/"));
        assert!(text.contains("Do not send mail"));
        // The text around the path never changes, whatever the path.
        assert_eq!(text.replace(path, "P"), prompt("/x").replace("/x", "P"));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn elsewhere_nothing_is_written_or_started() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        assert_eq!(rt.block_on(imp::open_agent(report(&[SEND]))), Ok("absent".to_owned()));
        assert_eq!(rt.block_on(imp::open_agent("alice@example.com\n".into())), Err("report_invalid"));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    mod files {
        use super::super::unix;
        use super::{report, SEND};
        use std::fs;
        use std::os::unix::fs::{PermissionsExt, symlink};
        use std::path::{Path, PathBuf};
        use std::time::Duration;

        /// A fresh private folder under the system temp dir.
        fn scratch(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("omamail-diag-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
            dir
        }

        fn mode(path: &Path) -> u32 {
            fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
        }

        /// A stand-in agent: a script that writes its argv, one per line, to
        /// `log`, and exits with `status`.
        fn fake_agent(dir: &Path, log: &Path, status: i32) -> PathBuf {
            let agent = dir.join(unix::AGENT);
            fs::write(
                &agent,
                format!("#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > '{}'\nexit {status}\n", log.display()),
            )
            .unwrap();
            fs::set_permissions(&agent, fs::Permissions::from_mode(0o755)).unwrap();
            agent
        }

        #[test]
        fn the_report_is_written_owner_only() {
            let dir = scratch("save");
            let state = dir.join("state");
            let body = report(&[SEND]);
            let path = unix::save_in(&state, &body).unwrap();
            assert_eq!(path, state.join("omamail/diagnostics/report.txt"));
            assert_eq!(fs::read_to_string(&path).unwrap(), body);
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(&state.join("omamail")), 0o700);
            assert_eq!(mode(&state.join("omamail/diagnostics")), 0o700);
            // Written again: replaced, still 0600, no temporary left behind.
            let again = report(&[]);
            unix::save_in(&state, &again).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), again);
            assert_eq!(mode(&path), 0o600);
            let names: Vec<_> = fs::read_dir(state.join("omamail/diagnostics")).unwrap().map(|e| e.unwrap().file_name()).collect();
            assert_eq!(names, ["report.txt"]);
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn a_shared_or_linked_folder_is_refused_and_nothing_written() {
            let dir = scratch("links");
            // A folder others can read.
            let state = dir.join("open");
            fs::create_dir_all(state.join("omamail")).unwrap();
            fs::set_permissions(state.join("omamail"), fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(unix::save_in(&state, &report(&[SEND])), Err("storage_unavailable"));
            assert!(!state.join("omamail/diagnostics").exists());
            // The folder a link to somewhere else: nothing lands there.
            let elsewhere = dir.join("elsewhere");
            fs::create_dir_all(&elsewhere).unwrap();
            fs::set_permissions(&elsewhere, fs::Permissions::from_mode(0o700)).unwrap();
            let linked = dir.join("linked");
            fs::create_dir_all(linked.join("omamail")).unwrap();
            fs::set_permissions(linked.join("omamail"), fs::Permissions::from_mode(0o700)).unwrap();
            symlink(&elsewhere, linked.join("omamail/diagnostics")).unwrap();
            assert_eq!(unix::save_in(&linked, &report(&[SEND])), Err("storage_unavailable"));
            assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn the_agent_is_found_by_full_path_only() {
            let dir = scratch("find");
            let bin = dir.join("bin");
            fs::create_dir_all(&bin).unwrap();
            let log = dir.join("argv");
            let agent = fake_agent(&bin, &log, 0);
            let path = std::env::join_paths([Path::new("relative/bin"), &bin]).unwrap();
            assert_eq!(unix::find_agent(&path), Some(agent.clone()));
            // Not executable, or only on a relative entry: absent.
            fs::set_permissions(&agent, fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(unix::find_agent(&path), None);
            assert_eq!(unix::find_agent(std::ffi::OsStr::new("bin:.")), None);
            fs::remove_dir_all(&dir).unwrap();
        }

        /// argv is exactly `--prompt` and the fixed prompt naming the file:
        /// nothing from the report reaches the command line.
        #[test]
        fn the_agent_gets_the_fixed_prompt_and_never_the_report() {
            let dir = scratch("spawn");
            let log = dir.join("argv");
            let agent = fake_agent(&dir, &log, 0);
            let state = dir.join("state");
            // Shapes a smuggled value would take, were validation bypassed.
            let body = report(&[SEND]) + "alice@example.com hunter2\n";
            unix::open_with(&agent, &state, &body).unwrap();
            let report_path = state.join("omamail/diagnostics/report.txt");
            let argv = fs::read_to_string(&log).unwrap();
            let expected = format!("--prompt\n{}\n", super::super::prompt(report_path.to_str().unwrap()));
            assert_eq!(argv, expected);
            for secret in ["alice@example.com", "hunter2", "smtp_delivery_unknown"] {
                assert!(!argv.contains(secret), "argv held {secret}");
            }
            assert_eq!(fs::read_to_string(&report_path).unwrap(), body);
            assert_eq!(mode(&report_path), 0o600);
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn a_failing_agent_is_an_error_and_a_running_one_success() {
            let dir = scratch("settle");
            let log = dir.join("argv");
            let failing = fake_agent(&dir, &log, 3);
            let state = dir.join("state");
            assert_eq!(unix::open_with(&failing, &state, &report(&[])), Err("agent_failed"));
            let missing = dir.join("no-such-agent");
            assert_eq!(unix::spawn(&missing, &state.join("x")).err(), Some("agent_failed"));
            // Still running at the deadline: success, reaped later.
            let slow = dir.join("slow");
            fs::write(&slow, "#!/bin/sh\nsleep 1\n").unwrap();
            fs::set_permissions(&slow, fs::Permissions::from_mode(0o755)).unwrap();
            let child = unix::spawn(&slow, &state.join("x")).unwrap();
            assert_eq!(unix::settle(child, Duration::from_millis(100)), Ok(()));
            fs::remove_dir_all(&dir).unwrap();
        }
    }
}
