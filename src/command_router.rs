//! The one-instance door: how a `mailto:` link, or the bar, reaches the window
//! that is already up.
//!
//! The QML client never needed this. It ran inside the Omarchy shell, so
//! `scripts/mailto.sh` could say `omarchy-shell shell summon omamail {json}`
//! and the shell delivered the payload to the process it was already hosting.
//! The standalone client has no shell in front of it: the desktop file's `%u`
//! starts *this* binary, and a second start would be a second mailbox, a second
//! poll loop, and a draft in a window nobody was looking at.
//!
//! So the first instance listens on a Unix socket beside its status file, and
//! every later start hands its command down that socket and exits. What crosses
//! is a closed vocabulary — `open`, `refresh`, `compose-mailto` and a `mailto:`
//! URL — which is the same vocabulary `bar/Status.js` already builds an
//! argument vector for and `scripts/omamail-companion.sh` already validates.
//! Nothing else is accepted, in either direction: the socket is reachable by
//! anything running as this user, and a router that took a program name or a
//! file path would be a way to make the mail client run it.

use std::{
    collections::VecDeque,
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};

use serde::Deserialize;

/// The longest command line the socket will read.
///
/// A `mailto:` URL carrying a body is the largest thing that legitimately
/// crosses, and 8 KiB is far past any of them. The point is that a peer cannot
/// make the router hold an unbounded string in memory by never sending a
/// newline.
pub const MAX_COMMAND_LINE: usize = 8 * 1024;

/// The socket file, beside the status file the bar reads.
pub const SOCKET_NAME: &str = "command.sock";

/// What one instance may ask another to do.
///
/// Three verbs, because three are what the bar widget and the desktop handler
/// between them ask for. Adding a fourth is a deliberate act in three places —
/// here, `bar/Status.js`, and `scripts/omamail-companion.sh` — which is the
/// property that keeps this from becoming a remote-control channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    /// Bring the window forward. What a second launch with no arguments means.
    Open,
    /// Go and look for mail now.
    Refresh,
    /// Open the composer on a `mailto:` URL.
    ComposeMailto,
}

impl Verb {
    pub fn name(self) -> &'static str {
        match self {
            Verb::Open => "open",
            Verb::Refresh => "refresh",
            Verb::ComposeMailto => "compose-mailto",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "open" => Some(Verb::Open),
            "refresh" => Some(Verb::Refresh),
            "compose-mailto" => Some(Verb::ComposeMailto),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub verb: Verb,
    /// Only ever a `mailto:` URL, and only ever on `compose-mailto`.
    pub payload: String,
}

impl Command {
    pub fn open() -> Self {
        Self {
            verb: Verb::Open,
            payload: String::new(),
        }
    }

    pub fn refresh() -> Self {
        Self {
            verb: Verb::Refresh,
            payload: String::new(),
        }
    }

    /// A `mailto:` URL, or nothing if it is not one.
    ///
    /// The scheme is the whole check. Everything after it is a draft's own
    /// text, parsed by `message/Mailto.js` on the window side — the same parser
    /// the QML uses, and the place that already knows a subject may not carry a
    /// newline into a header.
    pub fn compose(url: &str) -> Option<Self> {
        if !is_mailto(url) || url.len() > MAX_COMMAND_LINE {
            return None;
        }
        Some(Self {
            verb: Verb::ComposeMailto,
            payload: url.to_owned(),
        })
    }

    pub fn to_json(&self) -> String {
        // A hand-rolled object would have to escape the URL itself, and a
        // `mailto:` body legitimately carries quotes and newlines.
        serde_json::json!({ "verb": self.verb.name(), "payload": self.payload }).to_string()
    }

    /// Reads one back, refusing anything the vocabulary does not cover.
    pub fn from_json(text: &str) -> Option<Self> {
        if text.len() > MAX_COMMAND_LINE {
            return None;
        }
        let wire: Wire = serde_json::from_str(text).ok()?;
        match Verb::parse(&wire.verb)? {
            // A payload on a verb that has no use for one is dropped rather
            // than carried: it can only be something the sender expected to
            // matter, and pretending it did would be the lie.
            Verb::Open => Some(Self::open()),
            Verb::Refresh => Some(Self::refresh()),
            Verb::ComposeMailto => Self::compose(&wire.payload),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    verb: String,
    #[serde(default)]
    payload: String,
}

fn is_mailto(url: &str) -> bool {
    url.len() >= 7 && url[..7].eq_ignore_ascii_case("mailto:")
}

/// What the argument vector asked this process to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    /// `--check-resources`: print where the application tree is and exit.
    CheckResources,
    /// Open the window, or hand this command to the one already open.
    Run(Command),
}

/// Reads the argument vector, without the program name.
///
/// Two shapes, because two callers exist. The desktop file's `%u` arrives as a
/// bare `mailto:` URL — that is what xdg-open hands a scheme handler — and
/// `bar/Status.js` builds `--command <verb> [--payload <url>]`, which is the
/// vector `scripts/omamail-companion.sh` runs.
///
/// Anything else is refused rather than ignored. A launcher that passed an
/// argument this does not know is a launcher whose intent is unknown, and
/// starting an ordinary window while silently dropping it is the outcome
/// hardest to notice.
pub fn parse_arguments<I>(arguments: I) -> Result<Launch, String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut command = Command::open();
    let mut verb_given = false;
    let mut payload = String::new();
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        let Some(argument) = argument.to_str() else {
            return Err("omamail: arguments must be valid UTF-8".to_owned());
        };
        match argument {
            "--check-resources" => return Ok(Launch::CheckResources),
            "--command" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| "omamail: --command needs a verb".to_owned())?;
                let value = value
                    .to_str()
                    .ok_or_else(|| "omamail: --command needs a verb".to_owned())?;
                let verb = Verb::parse(value)
                    .ok_or_else(|| format!("omamail: unknown command `{value}`"))?;
                command = Command {
                    verb,
                    payload: String::new(),
                };
                verb_given = true;
            }
            "--payload" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| "omamail: --payload needs a value".to_owned())?;
                payload = value
                    .to_str()
                    .ok_or_else(|| "omamail: --payload needs a value".to_owned())?
                    .to_owned();
            }
            url if is_mailto(url) => {
                command = Command::compose(url)
                    .ok_or_else(|| "omamail: that mailto: link is too long".to_owned())?;
                verb_given = true;
            }
            other => return Err(format!("omamail: unexpected argument `{other}`")),
        }
    }
    if !payload.is_empty() {
        if !verb_given || command.verb != Verb::ComposeMailto {
            return Err("omamail: --payload belongs to --command compose-mailto".to_owned());
        }
        command = Command::compose(&payload)
            .ok_or_else(|| "omamail: --payload must be a mailto: URL".to_owned())?;
    } else if command.verb == Verb::ComposeMailto && command.payload.is_empty() {
        // `--command compose-mailto` with nothing to compose is a blank draft,
        // which is what `Mailto.parse("mailto:")` already means.
        command = Command::compose("mailto:").expect("mailto: is a mailto URL");
    }
    Ok(Launch::Run(command))
}

/// Where the socket lives.
///
/// `XDG_RUNTIME_DIR` when there is one: it is per-user, mode 0700, and cleared
/// on logout, which is exactly the lifetime of "an instance is running". The
/// state directory is the fallback, beside `status.json`, because a machine
/// without a runtime directory still has to be able to reach its own window.
pub fn command_socket_path(
    runtime_dir: Option<&Path>,
    state_home: Option<&Path>,
    home: Option<&Path>,
    platform: &str,
) -> Option<PathBuf> {
    if platform != "linux" {
        return None;
    }
    if let Some(runtime) = runtime_dir.filter(|root| !root.as_os_str().is_empty()) {
        return Some(runtime.join("omamail").join(SOCKET_NAME));
    }
    crate::companion_status_path(state_home, home, platform)
        .map(|status| status.with_file_name(SOCKET_NAME))
}

/// Commands that have arrived and not yet been drawn.
///
/// A queue rather than a slot, because the launch command is already in it
/// before the window exists and a second link may arrive while the first is
/// still being opened.
///
/// One waker, because there is one reader: the window awaits [`Self::next`] one
/// command at a time. A second concurrent waiter would replace the first's
/// waker and leave it parked, so the module keeps that a single-consumer
/// contract rather than pretending otherwise.
#[derive(Clone, Default)]
pub struct CommandQueue(Arc<Mutex<Pending>>);

#[derive(Default)]
struct Pending {
    commands: VecDeque<Command>,
    waker: Option<Waker>,
}

impl CommandQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&self, command: Command) {
        let waker = {
            let mut pending = self.0.lock().expect("command queue lock");
            pending.commands.push_back(command);
            pending.waker.take()
        };
        // Woken outside the lock: the waker may run the reader inline, and it
        // would deadlock the moment it looked at the queue it was woken for.
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    pub fn take(&self) -> Option<Command> {
        self.0
            .lock()
            .expect("command queue lock")
            .commands
            .pop_front()
    }

    /// The next command, whenever it arrives.
    pub fn next(&self) -> NextCommand {
        NextCommand(self.clone())
    }
}

pub struct NextCommand(CommandQueue);

impl Future for NextCommand {
    type Output = Command;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Command> {
        let mut pending = self.0.0.lock().expect("command queue lock");
        if let Some(command) = pending.commands.pop_front() {
            return Poll::Ready(command);
        }
        pending.waker = Some(context.waker().clone());
        Poll::Pending
    }
}

/// Hand a command to the instance already running, if there is one.
///
/// True means another process took it and this one has nothing left to do.
/// False covers every way there is no listener — no socket file, a socket left
/// behind by a process that died, a refused connection — and the caller goes on
/// to open a window and become the listener itself.
#[cfg(unix)]
pub fn deliver(path: &Path, command: &Command) -> bool {
    use std::{io::Write as _, os::unix::net::UnixStream};

    let Ok(mut stream) = UnixStream::connect(path) else {
        return false;
    };
    let mut line = command.to_json();
    line.push('\n');
    stream.write_all(line.as_bytes()).is_ok() && stream.flush().is_ok()
}

#[cfg(not(unix))]
pub fn deliver(_path: &Path, _command: &Command) -> bool {
    false
}

/// Become the instance others reach.
///
/// Only called once [`deliver`] has found nobody home, which is what makes
/// removing the existing socket file safe: it is either absent or the remains
/// of a process that is gone. Failing to listen is not fatal — the window is
/// still a working mail client, it just cannot be reached by a link — so this
/// reports rather than panics.
#[cfg(unix)]
pub fn listen(path: &Path, queue: CommandQueue) -> Result<(), String> {
    use std::{
        fs,
        io::{BufRead as _, BufReader, Read as _},
        os::unix::{fs::PermissionsExt as _, net::UnixListener},
    };

    let parent = path
        .parent()
        .ok_or_else(|| "the command socket path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create command socket directory: {error}"))?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("protect command socket directory: {error}"))?;
    let _ = fs::remove_file(path);
    let listener =
        UnixListener::bind(path).map_err(|error| format!("bind command socket: {error}"))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("protect command socket: {error}"))?;
    std::thread::Builder::new()
        .name("omamail-command-router".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let mut line = String::new();
                // Bounded before the read rather than checked after it: a peer
                // that never sends a newline must not be able to grow this.
                let mut reader = BufReader::new(stream.take(MAX_COMMAND_LINE as u64));
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                if let Some(command) = Command::from_json(line.trim()) {
                    queue.push(command);
                }
            }
        })
        .map_err(|error| format!("start the command router: {error}"))?;
    Ok(())
}

#[cfg(not(unix))]
pub fn listen(_path: &Path, _queue: CommandQueue) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn a_bare_mailto_url_is_what_the_desktop_file_hands_over() {
        assert_eq!(
            parse_arguments(arguments(&["mailto:jane@example.com?subject=Hi"])),
            Ok(Launch::Run(
                Command::compose("mailto:jane@example.com?subject=Hi").unwrap()
            ))
        );
        // xdg-open does not normalise the scheme, and neither does a link in a
        // message body.
        assert_eq!(
            parse_arguments(arguments(&["MAILTO:jane@example.com"])),
            Ok(Launch::Run(
                Command::compose("MAILTO:jane@example.com").unwrap()
            ))
        );
    }

    #[test]
    fn the_bar_widgets_vector_is_the_other_shape() {
        assert_eq!(
            parse_arguments(arguments(&["--command", "refresh"])),
            Ok(Launch::Run(Command::refresh()))
        );
        assert_eq!(
            parse_arguments(arguments(&["--command", "open"])),
            Ok(Launch::Run(Command::open()))
        );
        assert_eq!(
            parse_arguments(arguments(&[
                "--command",
                "compose-mailto",
                "--payload",
                "mailto:a@example.com",
            ])),
            Ok(Launch::Run(
                Command::compose("mailto:a@example.com").unwrap()
            ))
        );
    }

    #[test]
    fn no_arguments_asks_for_a_window() {
        assert_eq!(
            parse_arguments(arguments(&[])),
            Ok(Launch::Run(Command::open()))
        );
        assert_eq!(
            parse_arguments(arguments(&["--check-resources"])),
            Ok(Launch::CheckResources)
        );
    }

    #[test]
    fn a_compose_with_nothing_to_compose_is_still_a_blank_draft() {
        assert_eq!(
            parse_arguments(arguments(&["--command", "compose-mailto"])),
            Ok(Launch::Run(Command::compose("mailto:").unwrap()))
        );
    }

    #[test]
    fn nothing_outside_the_vocabulary_starts_a_window() {
        for vector in [
            vec!["--command"],
            vec!["--command", "quit"],
            vec!["--payload"],
            vec!["--payload", "mailto:a@example.com"],
            vec!["--command", "refresh", "--payload", "mailto:a@example.com"],
            vec![
                "--command",
                "compose-mailto",
                "--payload",
                "https://example.com",
            ],
            vec!["https://example.com"],
            vec!["--verbose"],
        ] {
            assert!(
                parse_arguments(arguments(&vector)).is_err(),
                "{vector:?} must be refused"
            );
        }
    }

    #[test]
    fn a_url_survives_the_wire_and_a_stranger_cannot_widen_it() {
        let command = Command::compose("mailto:jane@example.com?subject=Say \"hi\"\nnow").unwrap();
        assert_eq!(Command::from_json(&command.to_json()), Some(command));

        assert_eq!(
            Command::from_json(r#"{"verb":"open","payload":"mailto:a@example.com"}"#),
            Some(Command::open()),
            "a payload on a verb that has no use for one is dropped"
        );
        assert_eq!(Command::from_json("not json"), None);
        assert_eq!(Command::from_json(r#"{"verb":"quit"}"#), None);
        assert_eq!(
            Command::from_json(r#"{"verb":"compose-mailto","payload":"file:///etc/passwd"}"#),
            None
        );
        assert_eq!(
            Command::from_json(r#"{"verb":"open","program":"/bin/sh"}"#),
            None,
            "an unknown field is a sender asking for something this does not do"
        );
        assert_eq!(
            Command::from_json(&format!(
                r#"{{"verb":"compose-mailto","payload":"mailto:a@b?body={}"}}"#,
                "x".repeat(MAX_COMMAND_LINE)
            )),
            None
        );
    }

    #[test]
    fn the_socket_sits_in_the_runtime_directory_when_there_is_one() {
        assert_eq!(
            command_socket_path(
                Some(Path::new("/run/user/1000")),
                Some(Path::new("/state")),
                Some(Path::new("/home/alice")),
                "linux"
            ),
            Some(PathBuf::from("/run/user/1000/omamail/command.sock"))
        );
        assert_eq!(
            command_socket_path(None, Some(Path::new("/state")), None, "linux"),
            Some(PathBuf::from("/state/omamail/command.sock"))
        );
        assert_eq!(
            command_socket_path(
                Some(Path::new("")),
                None,
                Some(Path::new("/home/alice")),
                "linux"
            ),
            Some(PathBuf::from(
                "/home/alice/.local/state/omamail/command.sock"
            ))
        );
        assert_eq!(
            command_socket_path(Some(Path::new("/run/user/1000")), None, None, "macos"),
            None
        );
    }

    #[test]
    fn a_queued_command_wakes_the_window_that_was_waiting_for_one() {
        let queue = CommandQueue::new();
        let mut next = Box::pin(queue.next());
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        assert!(next.as_mut().poll(&mut context).is_pending());
        queue.push(Command::refresh());
        assert_eq!(
            next.as_mut().poll(&mut context),
            Poll::Ready(Command::refresh())
        );
    }

    #[test]
    fn the_launch_command_is_waiting_before_anything_asks() {
        let queue = CommandQueue::new();
        queue.push(Command::compose("mailto:a@example.com").unwrap());
        queue.push(Command::refresh());
        assert_eq!(
            queue.take(),
            Some(Command::compose("mailto:a@example.com").unwrap())
        );
        assert_eq!(queue.take(), Some(Command::refresh()));
        assert_eq!(queue.take(), None);
    }
}
