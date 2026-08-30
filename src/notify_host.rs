//! The desktop notification new mail earns, when `notifyNewMail` is on.
//!
//! `MailAccount.notify` reaches `notify-send` through `Quickshell.execDetached`,
//! which takes an argument vector. This host has no such helper, so it owns the
//! vector itself and the window sends it two strings — which is the point: a
//! display name of `-u` handed to a shell would be read as an option, and the
//! `--` this always writes is what stops that from being anybody's problem
//! twice.
//!
//! Two desktops, two programs, one rule. Linux has `notify-send`; macOS has no
//! such command and reaches Notification Center through `osascript`, where the
//! same stranger-written strings would be *AppleScript source* if they were
//! pasted into the script. They are not: the script is a fixed `on run argv`
//! that reads its title and its text out of the argument vector, so a subject
//! containing a quotation mark is a subject there too. A platform with neither
//! program has no notifier at all and [`system_notifier`] answers `None`, which
//! is what keeps `omamail-notify` from being exported as a promise nothing can
//! keep.

use std::{
    fmt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    thread,
};

use serde::Deserialize;

/// The application name every notification is grouped under, which is what
/// lets a desktop replace one of ours rather than stacking them.
const APPLICATION_NAME: &str = "Omamail";

/// `/usr/bin`, absolute, for the same reason the attachment host names
/// `xdg-open` there: a `PATH` this process inherited is not a decision this
/// process should be making.
const NOTIFY_SEND: &str = "/usr/bin/notify-send";

/// macOS ships this at a fixed path and always has. Absolute for the same
/// reason.
const OSASCRIPT: &str = "/usr/bin/osascript";

/// The whole of the AppleScript, and it never grows a value in it.
///
/// `on run argv` is what makes that possible: the summary and the body arrive
/// as arguments the way they do for `notify-send`, so the three lines below are
/// the same three lines for every message ever notified.
const OSASCRIPT_PROGRAM: [&str; 3] = [
    "on run argv",
    "display notification (item 2 of argv) with title (item 1 of argv) subtitle \"Omamail\"",
    "end run",
];

/// The longest either field may be. A subject is a stranger's sentence and a
/// snippet is a stranger's paragraph, and both are already trimmed by
/// `Model.notificationBody` — this is the ceiling on a request that did not
/// come through it.
const MAX_FIELD: usize = 2048;
const MAX_REQUEST: usize = 8192;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct NotifyError;
impl fmt::Debug for NotifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NotifyError")
    }
}
impl fmt::Display for NotifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("notification request failed")
    }
}
impl std::error::Error for NotifyError {}

pub trait NotificationSender: Send + Sync {
    fn send(&self, arguments: &[String]) -> Result<(), NotifyError>;
    /// The vector this sender's own program takes.
    ///
    /// The host builds it rather than the sender running the program directly,
    /// because what a sender-written string may never become is decided here
    /// once: `notify-send`'s is [`notify_send_arguments`] and `osascript`'s is
    /// [`osascript_arguments`], and the tests read both.
    fn arguments(&self, summary: &str, body: &str, icon: Option<&Path>) -> Vec<String> {
        notify_send_arguments(summary, body, icon)
    }
}
impl<T: NotificationSender + ?Sized> NotificationSender for Arc<T> {
    fn send(&self, arguments: &[String]) -> Result<(), NotifyError> {
        (**self).send(arguments)
    }
    fn arguments(&self, summary: &str, body: &str, icon: Option<&Path>) -> Vec<String> {
        (**self).arguments(summary, body, icon)
    }
}

/// The program this desktop raises a notification with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemNotifier {
    NotifySend,
    Osascript,
}

/// What this platform has, or `None` where it has neither program.
///
/// The caller exports `omamail-notify` only on `Some`. A window that cannot
/// raise a notification says so by not carrying the module: the setting stays
/// where it is and new mail simply arrives without one, rather than a request
/// failing every time an unread message lands.
pub fn system_notifier() -> Option<SystemNotifier> {
    #[cfg(target_os = "linux")]
    {
        Some(SystemNotifier::NotifySend)
    }
    #[cfg(target_os = "macos")]
    {
        Some(SystemNotifier::Osascript)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

/// Hands the vector to the program and does not wait for it.
///
/// The child is reaped on a thread of its own rather than waited for here.
/// `notify-send` returns as soon as the D-Bus call is answered — but on a
/// desktop with no notification daemon running there is nothing to answer it,
/// and a mail read must not be the thing that discovers that. `osascript` is
/// the same bargain against a busy Notification Center.
impl NotificationSender for SystemNotifier {
    fn arguments(&self, summary: &str, body: &str, icon: Option<&Path>) -> Vec<String> {
        match self {
            Self::NotifySend => notify_send_arguments(summary, body, icon),
            Self::Osascript => osascript_arguments(summary, body),
        }
    }
    fn send(&self, arguments: &[String]) -> Result<(), NotifyError> {
        let program = match self {
            Self::NotifySend => NOTIFY_SEND,
            Self::Osascript => OSASCRIPT,
        };
        let child = Command::new(program)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| NotifyError)?;
        thread::Builder::new()
            .name("omamail-notify".into())
            .spawn(move || {
                let mut child = child;
                let _ = child.wait();
            })
            .map(|_| ())
            .map_err(|_| NotifyError)
    }
}

pub struct NotifyHost<S> {
    icon: Option<PathBuf>,
    sender: S,
}

impl<S: NotificationSender> NotifyHost<S> {
    /// The icon is the application's own mark beside `gpui-shell.json`, and
    /// only when it is actually there: `notify-send -i` given a path that does
    /// not exist draws nothing where a themed fallback would have.
    pub fn new(app_root: &Path, sender: S) -> Self {
        let icon = app_root.join("assets").join("omamail.svg");
        Self {
            icon: icon.is_file().then_some(icon),
            sender,
        }
    }

    pub fn send_json(&self, input: &str) -> Result<(), NotifyError> {
        if input.len() > MAX_REQUEST {
            return Err(NotifyError);
        }
        let request: Request = serde_json::from_str(input).map_err(|_| NotifyError)?;
        let arguments = self.sender.arguments(
            checked_field(&request.summary)?,
            checked_field(&request.body)?,
            self.icon.as_deref(),
        );
        self.sender.send(&arguments)
    }
}

/// The vector, in `MailAccount.notify`'s own order.
///
/// `--` before the summary and the body and after everything else: both are
/// written by whoever sent the mail, and without it a display name beginning
/// with a dash is an option rather than a name. The body may legitimately be
/// empty — a message with no subject and no snippet — and is still passed, so
/// `notify-send` cannot read the following nothing as a positional argument.
pub fn notify_send_arguments(summary: &str, body: &str, icon: Option<&Path>) -> Vec<String> {
    let mut arguments = vec!["-a".to_owned(), APPLICATION_NAME.to_owned()];
    if let Some(icon) = icon {
        arguments.push("-i".to_owned());
        arguments.push(icon.to_string_lossy().into_owned());
    }
    arguments.push("--".to_owned());
    arguments.push(summary.to_owned());
    arguments.push(body.to_owned());
    arguments
}

/// The same two strings, for the desktop that has no `notify-send`.
///
/// Three `-e` lines of fixed script and then the strings, behind the same `--`:
/// the summary and the body are read out of `argv` by the script rather than
/// written into it, so no quotation mark, backslash or newline a sender chose
/// is ever AppleScript source. There is no icon — a notification raised through
/// `osascript` wears the icon of the program running the script, and the
/// subtitle is what names Omamail instead.
pub fn osascript_arguments(summary: &str, body: &str) -> Vec<String> {
    let mut arguments = Vec::with_capacity(9);
    for line in OSASCRIPT_PROGRAM {
        arguments.push("-e".to_owned());
        arguments.push(line.to_owned());
    }
    arguments.push("--".to_owned());
    arguments.push(summary.to_owned());
    arguments.push(body.to_owned());
    arguments
}

fn checked_field(value: &str) -> Result<&str, NotifyError> {
    if value.len() > MAX_FIELD {
        Err(NotifyError)
    } else {
        Ok(value)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    summary: String,
    #[serde(default)]
    body: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<Vec<String>>>);
    impl NotificationSender for Recorder {
        fn send(&self, arguments: &[String]) -> Result<(), NotifyError> {
            self.0.lock().unwrap().push(arguments.to_vec());
            Ok(())
        }
    }

    fn sent(recorder: &Recorder) -> Vec<String> {
        recorder.0.lock().unwrap().last().cloned().unwrap()
    }

    #[test]
    fn a_sender_written_dash_is_never_an_option() {
        let recorder = Arc::new(Recorder::default());
        let host = NotifyHost::new(Path::new("/nonexistent"), Arc::clone(&recorder));
        host.send_json(r#"{"summary":"-u","body":"--help"}"#)
            .unwrap();
        let arguments = sent(&recorder);
        assert_eq!(
            arguments,
            vec!["-a", "Omamail", "--", "-u", "--help"]
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        );
        // The separator comes before both stranger-written fields and after
        // everything this side chose.
        let separator = arguments.iter().position(|value| value == "--").unwrap();
        assert!(separator < arguments.len() - 2);
    }

    #[test]
    fn the_icon_is_only_passed_when_the_file_is_there() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("assets")).unwrap();
        std::fs::write(directory.path().join("assets/omamail.svg"), "<svg/>").unwrap();
        let recorder = Arc::new(Recorder::default());
        let host = NotifyHost::new(directory.path(), Arc::clone(&recorder));
        host.send_json(r#"{"summary":"Sender","body":"Subject"}"#)
            .unwrap();
        let arguments = sent(&recorder);
        assert_eq!(arguments[2], "-i");
        assert!(arguments[3].ends_with("assets/omamail.svg"));
    }

    #[test]
    fn a_malformed_or_oversized_request_is_refused() {
        let recorder = Arc::new(Recorder::default());
        let host = NotifyHost::new(Path::new("/nonexistent"), Arc::clone(&recorder));
        assert_eq!(host.send_json("not json"), Err(NotifyError));
        assert_eq!(host.send_json(r#"{"body":"no summary"}"#), Err(NotifyError));
        assert_eq!(
            host.send_json(&format!(r#"{{"summary":"{}"}}"#, "a".repeat(4096))),
            Err(NotifyError)
        );
        assert_eq!(
            host.send_json(&format!(
                r#"{{"summary":"a","body":"{}"}}"#,
                "b".repeat(9000)
            )),
            Err(NotifyError)
        );
        assert!(recorder.0.lock().unwrap().is_empty());
    }

    #[test]
    fn nothing_a_sender_wrote_becomes_applescript() {
        let subject = "\" & (do shell script \"echo pwned\") & \"";
        let arguments = osascript_arguments("Mallory\\", subject);
        let separator = arguments.iter().position(|value| value == "--").unwrap();
        // Every line of script is fixed, and both stranger-written fields are
        // arguments after the separator rather than text inside one of them.
        for line in &arguments[..separator] {
            assert!(!line.contains(subject), "{line}");
            assert!(!line.contains("Mallory"), "{line}");
        }
        assert_eq!(&arguments[separator + 1..], ["Mallory\\", subject]);
        assert_eq!(
            arguments[..separator]
                .iter()
                .filter(|value| *value == "-e")
                .count(),
            OSASCRIPT_PROGRAM.len()
        );
    }

    #[test]
    fn each_desktop_gets_the_vector_its_own_program_takes() {
        let icon = PathBuf::from("/tmp/omamail.svg");
        assert_eq!(
            SystemNotifier::NotifySend.arguments("Ada", "Hello", Some(&icon)),
            notify_send_arguments("Ada", "Hello", Some(&icon))
        );
        assert_eq!(
            SystemNotifier::Osascript.arguments("Ada", "Hello", Some(&icon)),
            osascript_arguments("Ada", "Hello")
        );
        // Every platform this ships for has one. The `None` arm is what stops
        // the module being exported anywhere else.
        assert!(system_notifier().is_some());
    }

    #[test]
    fn a_message_with_nothing_to_say_still_passes_both_fields() {
        let recorder = Arc::new(Recorder::default());
        let host = NotifyHost::new(Path::new("/nonexistent"), Arc::clone(&recorder));
        host.send_json(r#"{"summary":"New message"}"#).unwrap();
        assert_eq!(sent(&recorder).last().unwrap(), "");
    }
}
