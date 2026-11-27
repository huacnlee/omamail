//! Omamail as the desktop's mail client (the Qt plugin's
//! `scripts/default-mail.sh`, ported). On Omarchy two things decide which
//! client handles mail, and a switch that moved only one would leave the other
//! opening HEY:
//!
//! - the `x-scheme-handler/mailto` default: the app's own hidden entry
//!   `dev.huacnlee.omamail.mailto.desktop` (Exec is this executable with
//!   `%u`; scripts/register-mailto.sh, ported), made the default with
//!   `xdg-mime` and `xdg-settings`;
//! - SUPER+SHIFT+E and SUPER+SHIFT+ALT+E, overridden by a managed block in
//!   `$XDG_CONFIG_HOME/hypr/bindings.lua` (`hl.unbind` + `o.bind`, Omarchy's
//!   documented pattern).
//!
//! Fixed programs and fixed arguments only, never a shell, and nothing from
//! the UI reaches a command line or the file: the UI says on, off or status.
//! Omarchy's own files are never touched. Off removes the block and leaves the
//! file byte-identical to what it was before on; the mailto default stays,
//! since Omarchy ships no handler to give it back to. Elsewhere than Linux the
//! status is `unsupported` and nothing is changed.

use nsh_core::prelude::*;

/// The desktop entry the app is installed under.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const DESKTOP_ID: &str = "dev.huacnlee.omamail";
/// The app's own entry for mailto: links (Qt's `omamail.desktop` from
/// scripts/register-mailto.sh): hidden from menus, it only claims the scheme
/// and hands the link to the running executable.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const MAILTO_ID: &str = "dev.huacnlee.omamail.mailto";
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const BLOCK_BEGIN: &str = "-- >>> omamail default mail client, do not edit by hand";
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const BLOCK_END: &str = "-- <<< omamail default mail client";

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn bindings_block() -> String {
    // Email opens the app; New email opens a mailto: link, which the mailto
    // default (this app, once on) answers with a new message.
    [
        BLOCK_BEGIN,
        "hl.unbind(\"SUPER + SHIFT + E\")",
        "hl.unbind(\"SUPER + SHIFT + ALT + E\")",
        &format!("o.bind(\"SUPER + SHIFT + E\", \"Email\", \"gtk-launch {DESKTOP_ID}\")"),
        "o.bind(\"SUPER + SHIFT + ALT + E\", \"New email\", \"xdg-open mailto:\")",
        BLOCK_END,
    ]
    .join("\n")
}

/// The file's text with the managed block (and the blank lines added above
/// it) taken out, so on then off round-trips it exactly.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn without_block(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let managed = managed_lines(&lines);
    let mut out: Vec<&str> = Vec::new();
    let mut blanks = 0usize;
    let trailing_newline = text.ends_with('\n');
    for (i, line) in lines.iter().copied().enumerate() {
        if managed[i] {
            blanks = 0;
            continue;
        }
        if line.is_empty() {
            blanks += 1;
            continue;
        }
        out.extend(std::iter::repeat_n("", blanks));
        blanks = 0;
        out.push(line);
    }
    let mut joined = out.join("\n");
    if trailing_newline && !joined.is_empty() {
        joined.push('\n');
    }
    joined
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn with_block(text: &str) -> String {
    let mut next = without_block(text);
    next.push('\n');
    next.push_str(&bindings_block());
    next.push('\n');
    next
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn has_block(text: &str) -> bool {
    managed_lines(&text.lines().collect::<Vec<_>>()).contains(&true)
}

/// Which lines belong to a managed block. Only a whole block counts: a begin
/// line, then its end with no other begin between. A stray marker the user
/// left (or a block they cut short) stays their text, with everything after.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn managed_lines(lines: &[&str]) -> Vec<bool> {
    let mut managed = vec![false; lines.len()];
    let mut open: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if *line == BLOCK_BEGIN {
            open = Some(i);
        } else if *line == BLOCK_END
            && let Some(start) = open.take()
        {
            managed[start..=i].fill(true);
        }
    }
    managed
}

/// One argument of an Exec key, as the Desktop Entry Specification wants it:
/// quoted when it holds a reserved character (`"`, `` ` ``, `$` and `\`
/// escaped inside the quotes), `%` doubled, then every `\` doubled again
/// for the string value the key is. None for a character no entry can hold
/// (a control character, a newline): the path is refused, never mangled.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn exec_argument(arg: &str) -> Option<String> {
    if arg.is_empty() || arg.chars().any(|c| c.is_control()) {
        return None;
    }
    const RESERVED: &[char] = &[
        ' ', '\t', '"', '\'', '\\', '>', '<', '~', '|', '&', ';', '$', '*', '?', '#', '(', ')',
        '`', '=',
    ];
    let mut quoted = String::new();
    if arg.contains(RESERVED) {
        quoted.push('"');
        for c in arg.chars() {
            if matches!(c, '"' | '`' | '$' | '\\') {
                quoted.push('\\');
            }
            quoted.push(c);
        }
        quoted.push('"');
    } else {
        quoted.push_str(arg);
    }
    let fields = quoted.replace('%', "%%");
    Some(fields.replace('\\', "\\\\"))
}

/// The mailto entry for the app at `exe`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn mailto_entry(exe: &str) -> Option<String> {
    let exec = exec_argument(exe)?;
    Some(format!(
        "[Desktop Entry]\nType=Application\nName=Omamail\nComment=Email client for Omarchy\nExec={exec} %u\nIcon={DESKTOP_ID}\nTerminal=false\nStartupNotify=false\nNoDisplay=true\nMimeType=x-scheme-handler/mailto;\nCategories=Office;Network;Email;\n"
    ))
}

/// The Qt-era plugin's mail client name for its mailto: entry.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const LEGACY_MAILTO: &str = "omamail.desktop";

/// Whether the user made the Qt-era plugin their mail client and this app
/// has not taken over yet: its managed block still summons the plugin's
/// panel (which the NSH plugin no longer has), or mailto: still goes to its
/// entry (which the installer removes). Either leaves SUPER+SHIFT+E or
/// mailto: links opening nothing, so the app turns the switch on again.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn is_legacy_default(bindings: &str, mailto: &str) -> bool {
    mailto == LEGACY_MAILTO || (has_block(bindings) && !bindings.contains(&bindings_block()))
}

/// On, in the order that never leaves the switch half made: the bindings
/// block is written first (a failed write changes nothing else), then the
/// mailto default is made; if that fails, the bindings file gets its
/// original text back.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn turn_on(
    original: &str,
    write: &mut dyn FnMut(&str) -> Result<(), &'static str>,
    make_default: &mut dyn FnMut() -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    write(&with_block(original))?;
    if let Err(e) = make_default() {
        let _ = write(original);
        return Err(e);
    }
    Ok(())
}

/// The file work, on macOS too so its tests run there; only Linux
/// calls it.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod files {
    use std::path::Path;

    /// At most this much of `bindings.lua` is read.
    pub const BINDINGS_LIMIT: usize = 1024 * 1024;

    /// The bindings file's text: empty when there is none, refused when it
    /// is larger than `BINDINGS_LIMIT` or not UTF-8 (then nothing is written).
    pub fn read(path: &Path) -> Result<String, &'static str> {
        match std::fs::read(path) {
            Ok(bytes) if bytes.len() <= BINDINGS_LIMIT => {
                String::from_utf8(bytes).map_err(|_| "bindings_unreadable")
            }
            Ok(_) => Err("bindings_too_large"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(_) => Err("bindings_unreadable"),
        }
    }

    /// Replaces the file through a sibling temporary file, keeping its mode.
    /// The temporary is always a new file (create_new, never through a
    /// link planted at its name); a new bindings file is 0644.
    pub fn write(path: &Path, text: &str) -> Result<(), &'static str> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let dir = path.parent().ok_or("bindings_unwritable")?;
        std::fs::create_dir_all(dir).map_err(|_| "bindings_unwritable")?;
        let tmp = dir.join(format!(".bindings.lua.omamail.{}", std::process::id()));
        let mode = std::fs::metadata(path).ok().map(|m| m.permissions());
        let _ = std::fs::remove_file(&tmp);
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o644)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)
            .and_then(|mut file| {
                if let Some(mode) = mode {
                    file.set_permissions(mode)?;
                }
                file.write_all(text.as_bytes())?;
                file.sync_all()
            });
        if written.is_err() || std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return Err("bindings_unwritable");
        }
        Ok(())
    }

    /// Writes `text` as the mailto entry in `dir`: a new temporary file
    /// (never an existing one, never through a link), mode 0644, renamed
    /// over the entry, which replaces a link in its place rather than
    /// writing through it.
    pub fn write_entry(dir: &Path, text: &str) -> Result<(), &'static str> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::create_dir_all(dir).map_err(|_| "mailto_entry_failed")?;
        let target = dir.join(format!("{}.desktop", super::MAILTO_ID));
        if std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_dir()) {
            return Err("mailto_entry_failed");
        }
        let tmp = dir.join(format!(
            ".{}.desktop.{}",
            super::MAILTO_ID,
            std::process::id()
        ));
        let _ = std::fs::remove_file(&tmp);
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o644)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)
            .and_then(|mut file| {
                file.write_all(text.as_bytes())?;
                file.sync_all()
            });
        if written.is_err() || std::fs::rename(&tmp, &target).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return Err("mailto_entry_failed");
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::files::{read, write};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    fn bindings_file() -> Option<PathBuf> {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|v| !v.is_empty())
                    .map(|h| PathBuf::from(h).join(".config"))
            })?;
        Some(config.join("hypr").join("bindings.lua"))
    }

    fn run(program: &str, args: &[&str]) -> Option<String> {
        let output = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    fn applications_dir() -> Option<PathBuf> {
        let data = std::env::var_os("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|v| !v.is_empty())
                    .map(|h| PathBuf::from(h).join(".local").join("share"))
            })?;
        Some(data.join("applications"))
    }

    /// Writes the mailto entry for this executable (see `files::write_entry`).
    fn write_mailto_entry() -> Result<PathBuf, &'static str> {
        let exe = std::env::current_exe().map_err(|_| "mailto_entry_failed")?;
        let text = super::mailto_entry(exe.to_str().ok_or("mailto_entry_failed")?)
            .ok_or("mailto_entry_failed")?;
        let dir = applications_dir().ok_or("mailto_entry_failed")?;
        super::files::write_entry(&dir, &text)?;
        Ok(dir)
    }

    fn reload_hyprland() {
        if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some_and(|v| !v.is_empty()) {
            let _ = run("hyprctl", &["reload"]);
        }
    }

    pub fn status() -> &'static str {
        let Some(path) = bindings_file() else {
            return "not-default";
        };
        let block = read(&path).map(|t| super::has_block(&t)).unwrap_or(false);
        let mailto =
            run("xdg-mime", &["query", "default", "x-scheme-handler/mailto"]).unwrap_or_default();
        if block && mailto == format!("{}.desktop", super::MAILTO_ID) {
            "default"
        } else {
            "not-default"
        }
    }

    /// Turns the switch on again for a user of the Qt-era plugin's switch
    /// (`super::is_legacy_default`); false when there was nothing to move
    /// or the move failed (Settings still shows the real state).
    pub fn migrate() -> bool {
        let Some(path) = bindings_file() else {
            return false;
        };
        let text = read(&path).unwrap_or_default();
        let mailto =
            run("xdg-mime", &["query", "default", "x-scheme-handler/mailto"]).unwrap_or_default();
        super::is_legacy_default(&text, &mailto) && set(true).is_ok()
    }

    pub fn set(enabled: bool) -> Result<String, &'static str> {
        let path = bindings_file().ok_or("bindings_unwritable")?;
        let text = read(&path)?;
        if enabled {
            let dir = write_mailto_entry()?;
            if let Some(dir) = dir.to_str() {
                let _ = run("update-desktop-database", &[dir]);
            }
            let desktop = format!("{}.desktop", super::MAILTO_ID);
            super::turn_on(&text, &mut |next| write(&path, next), &mut || {
                run(
                    "xdg-mime",
                    &["default", desktop.as_str(), "x-scheme-handler/mailto"],
                )
                .ok_or("mailto_default_failed")?;
                let _ = run(
                    "xdg-settings",
                    &[
                        "set",
                        "default-url-scheme-handler",
                        "mailto",
                        desktop.as_str(),
                    ],
                );
                Ok(())
            })?;
            reload_hyprland();
            Ok("Omamail is now the default mail client. SUPER+SHIFT+E opens Omamail; SUPER+SHIFT+ALT+E starts a new message.".into())
        } else {
            if super::has_block(&text) {
                write(&path, &super::without_block(&text))?;
            }
            reload_hyprland();
            Ok("SUPER+SHIFT+E is Omarchy's own email binding again.".into())
        }
    }
}

/// Whether mailto: links and Omarchy's SUPER+SHIFT+E open Omamail.
#[module]
pub struct MailClient;

#[module]
impl MailClient {
    /// `default`, `not-default`, or `unsupported` where the desktop has no
    /// such setting this app can change (anything but Linux).
    pub fn status() -> String {
        #[cfg(target_os = "linux")]
        {
            linux::status().to_owned()
        }
        #[cfg(not(target_os = "linux"))]
        {
            "unsupported".to_owned()
        }
    }

    /// Moves a Qt-era plugin user's mail client switch to this app, once, at
    /// launch: true when it did. Nothing changes for anyone else.
    pub fn migrate_legacy() -> bool {
        #[cfg(target_os = "linux")]
        {
            linux::migrate()
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }

    /// Makes Omamail the mail client (true) or hands SUPER+SHIFT+E back
    /// (false). Returns the sentence to show; fails with a code
    /// (`mailto_entry_failed`, `mailto_default_failed`, `bindings_unreadable`, `bindings_unwritable`,
    /// `bindings_too_large`, `unsupported`).
    pub fn set_default(enabled: bool) -> Result<String, String> {
        #[cfg(target_os = "linux")]
        {
            linux::set(enabled).map_err(str::to_owned)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = enabled;
            Err("unsupported".to_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_qt_plugin_switch_is_moved_and_nothing_else() {
        let qt_block = format!(
            "{BLOCK_BEGIN}\nhl.unbind(\"SUPER + SHIFT + E\")\no.bind(\"SUPER + SHIFT + E\", \"Email\", \"omarchy-shell shell summon omamail '{{}}'\")\n{BLOCK_END}\n"
        );
        let ours = with_block("-- mine\n");
        let mailto = format!("{MAILTO_ID}.desktop");
        assert!(is_legacy_default(&qt_block, &mailto), "the Qt block");
        assert!(is_legacy_default("", LEGACY_MAILTO), "the Qt mailto entry");
        assert!(
            is_legacy_default(&ours, LEGACY_MAILTO),
            "ours, mailto still Qt's"
        );
        assert!(!is_legacy_default(&ours, &mailto), "already moved");
        assert!(
            !is_legacy_default("-- mine\n", "hey.desktop"),
            "never chosen"
        );
        assert!(!is_legacy_default("-- mine\n", ""), "no mailto default");
    }

    #[test]
    fn exec_paths_are_quoted_as_the_desktop_spec_says() {
        assert_eq!(
            exec_argument("/usr/bin/omamail").unwrap(),
            "/usr/bin/omamail"
        );
        assert_eq!(
            exec_argument("/opt/My Apps/omamail").unwrap(),
            "\"/opt/My Apps/omamail\""
        );
        // A quote, a dollar and a backtick are escaped inside the quotes, and
        // the backslash doubled again for the string value.
        assert_eq!(exec_argument("/a\"b").unwrap(), "\"/a\\\\\"b\"");
        assert_eq!(exec_argument("/a$b").unwrap(), "\"/a\\\\$b\"");
        assert_eq!(exec_argument("/a`b").unwrap(), "\"/a\\\\`b\"");
        assert_eq!(exec_argument("/a\\b").unwrap(), "\"/a\\\\\\\\b\"");
        assert_eq!(exec_argument("/it's/omamail").unwrap(), "\"/it's/omamail\"");
        // % is a field code: doubled, inside or outside quotes.
        assert_eq!(exec_argument("/a%u").unwrap(), "/a%%u");
        assert_eq!(exec_argument("/a b%u").unwrap(), "\"/a b%%u\"");
        // What no entry can hold is refused.
        assert_eq!(exec_argument("/a\nb"), None);
        assert_eq!(exec_argument(""), None);
    }

    #[test]
    fn the_mailto_entry_claims_only_the_scheme() {
        let entry = mailto_entry("/opt/My Apps/omamail").unwrap();
        assert!(entry.contains("\nExec=\"/opt/My Apps/omamail\" %u\n"));
        assert!(entry.contains("\nMimeType=x-scheme-handler/mailto;\n"));
        assert!(entry.contains("\nNoDisplay=true\n"));
        assert!(entry.starts_with("[Desktop Entry]\nType=Application\n"));
        assert_eq!(mailto_entry("/a\nExec=evil"), None);
    }

    #[test]
    fn on_then_off_round_trips_the_file() {
        for original in ["", "bind = A\n", "bind = A\n\n\nbind = B\n"] {
            let on = with_block(original);
            assert!(has_block(&on));
            assert!(on.contains("hl.unbind(\"SUPER + SHIFT + E\")"));
            assert_eq!(without_block(&on), original, "for {original:?}");
            // On twice keeps one block.
            assert_eq!(with_block(&on).matches(BLOCK_BEGIN).count(), 1);
        }
    }

    /// The block's lines, so a test can say which of them reached a file.
    fn block_lines() -> Vec<String> {
        bindings_block().lines().map(str::to_owned).collect()
    }

    #[test]
    fn the_block_is_fixed_text() {
        // Nothing but constants: the app id, Omarchy's two keys, fixed
        // programs. No value from the UI, the environment or the file.
        let block = bindings_block();
        assert_eq!(block.lines().count(), 6);
        assert!(block.contains("gtk-launch dev.huacnlee.omamail\")"));
        assert!(block.contains("\"xdg-open mailto:\")"));
        assert!(
            block
                .lines()
                .all(|l| l.is_ascii() && !l.contains('$') && !l.contains('`'))
        );
        // The text around it never leaks into it.
        let on = with_block("evil = \"$(rm -rf ~)\"\n");
        let managed: Vec<&str> = on.lines().skip_while(|l| *l != BLOCK_BEGIN).collect();
        assert_eq!(managed, block_lines());
    }

    #[test]
    fn a_stray_marker_never_costs_the_user_their_lines() {
        // A begin line with no end (a block cut short by hand): off keeps
        // every line, and on adds one whole block after them.
        let stray = format!("bind = A\n{BLOCK_BEGIN}\nbind = B\nbind = C\n");
        assert!(!has_block(&stray));
        assert_eq!(without_block(&stray), stray);
        let on = with_block(&stray);
        assert!(on.starts_with(&stray), "{on:?}");
        assert!(has_block(&on));
        assert_eq!(without_block(&on), stray);
        // An end line alone, or end before begin, is the user's too.
        let lone_end = format!("bind = A\n{BLOCK_END}\nbind = B\n");
        assert!(!has_block(&lone_end));
        assert_eq!(without_block(&lone_end), lone_end);
        // Two begins: only the one closest to the end is ours.
        let two = format!("{BLOCK_BEGIN}\nbind = mine\n{}\n", bindings_block());
        assert_eq!(without_block(&two), format!("{BLOCK_BEGIN}\nbind = mine\n"));
    }

    #[test]
    fn markers_must_be_whole_lines() {
        // A marker inside a longer line, or indented, is not one.
        for text in [
            format!("x = 1 {BLOCK_BEGIN}\nbind = A\n{BLOCK_END}\n"),
            format!("  {BLOCK_BEGIN}\nbind = A\n  {BLOCK_END}\n"),
        ] {
            assert!(!has_block(&text));
            assert_eq!(without_block(&text), text);
        }
    }

    #[test]
    fn untrusted_file_text_round_trips() {
        // Unicode, quotes, backslashes, tabs and long lines are the
        // user's and come back unchanged.
        let original = "-- 中文 注释\nbind = \"a\\\\b\"\t# ok\nhl.bind(\"SUPER + Q\", \"x\")\n"
            .to_owned()
            + &"y".repeat(10_000)
            + "\n";
        let on = with_block(&original);
        assert!(on.starts_with(&original));
        assert_eq!(without_block(&on), original);
    }

    #[test]
    fn a_failed_bindings_write_never_switches_the_default() {
        let mut defaults = 0;
        let result = turn_on(
            "bind = A\n",
            &mut |_| Err("bindings_unwritable"),
            &mut || {
                defaults += 1;
                Ok(())
            },
        );
        assert_eq!(result, Err("bindings_unwritable"));
        assert_eq!(defaults, 0, "xdg-mime ran after a failed bindings write");
    }

    #[test]
    fn a_failed_default_puts_the_bindings_back() {
        let mut file = "bind = A\n".to_owned();
        let mut writes = Vec::new();
        let result = turn_on(
            &file.clone(),
            &mut |next| {
                writes.push(next.to_owned());
                file = next.to_owned();
                Ok(())
            },
            &mut || Err("mailto_default_failed"),
        );
        assert_eq!(result, Err("mailto_default_failed"));
        assert_eq!(file, "bind = A\n");
        assert_eq!(writes, [with_block("bind = A\n"), "bind = A\n".to_owned()]);
        // Success: one write, the block, then the default.
        let order = std::cell::RefCell::new(Vec::new());
        let ok = turn_on(
            "",
            &mut |next| {
                order
                    .borrow_mut()
                    .push(if has_block(next) { "block" } else { "other" });
                Ok(())
            },
            &mut || {
                order.borrow_mut().push("default");
                Ok(())
            },
        );
        assert_eq!(ok, Ok(()));
        assert_eq!(order.into_inner(), ["block", "default"]);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    mod files {
        use super::super::files::{BINDINGS_LIMIT, read, write, write_entry};
        use super::super::{MAILTO_ID, mailto_entry, with_block};
        use std::fs;
        use std::os::unix::fs::{PermissionsExt, symlink};
        use std::path::{Path, PathBuf};

        fn scratch(name: &str) -> PathBuf {
            let dir =
                std::env::temp_dir().join(format!("omamail-mc-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn mode(path: &Path) -> u32 {
            fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
        }

        fn names(dir: &Path) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort();
            names
        }

        #[test]
        fn the_bindings_file_is_size_capped_and_must_be_utf8() {
            let dir = scratch("read");
            let path = dir.join("bindings.lua");
            assert_eq!(read(&path), Ok(String::new()));
            fs::write(&path, "y".repeat(BINDINGS_LIMIT)).unwrap();
            assert_eq!(read(&path).map(|t| t.len()), Ok(BINDINGS_LIMIT));
            fs::write(&path, "y".repeat(BINDINGS_LIMIT + 1)).unwrap();
            assert_eq!(read(&path), Err("bindings_too_large"));
            fs::write(&path, b"bind = \xff\xfe\n").unwrap();
            assert_eq!(read(&path), Err("bindings_unreadable"));
            // A folder where the file should be.
            fs::remove_file(&path).unwrap();
            fs::create_dir(&path).unwrap();
            assert_eq!(read(&path), Err("bindings_unreadable"));
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn a_refused_file_is_left_byte_identical() {
            // `set` reads before anything is written: a file it cannot take
            // is never replaced.
            let dir = scratch("refused");
            let path = dir.join("bindings.lua");
            let bytes = [b"bind = A\n".as_slice(), b"\xff\n"].concat();
            fs::write(&path, &bytes).unwrap();
            assert!(read(&path).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(names(&dir), ["bindings.lua"]);
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn writing_keeps_the_mode_and_leaves_no_temporary() {
            let dir = scratch("write");
            let path = dir.join("hypr").join("bindings.lua");
            // A new file in a new folder.
            write(&path, &with_block("")).unwrap();
            assert_eq!(read(&path).unwrap(), with_block(""));
            // A private file stays private.
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            write(&path, "bind = A\n").unwrap();
            assert_eq!(mode(&path), 0o600);
            assert_eq!(fs::read_to_string(&path).unwrap(), "bind = A\n");
            assert_eq!(names(&dir.join("hypr")), ["bindings.lua"]);
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn a_link_planted_at_the_temporary_is_never_written_through() {
            let dir = scratch("tmp-link");
            let victim = dir.join("victim");
            fs::write(&victim, "keep\n").unwrap();
            let path = dir.join("bindings.lua");
            fs::write(&path, "bind = A\n").unwrap();
            let tmp = dir.join(format!(".bindings.lua.omamail.{}", std::process::id()));
            symlink(&victim, &tmp).unwrap();
            write(&path, "bind = B\n").unwrap();
            assert_eq!(fs::read_to_string(&victim).unwrap(), "keep\n");
            assert_eq!(fs::read_to_string(&path).unwrap(), "bind = B\n");
            assert_eq!(names(&dir), ["bindings.lua", "victim"]);
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn a_new_bindings_file_is_0644() {
            let dir = scratch("new-mode");
            let path = dir.join("bindings.lua");
            write(&path, "bind = A\n").unwrap();
            assert_eq!(mode(&path), 0o644);
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn a_linked_bindings_file_is_replaced_not_written_through() {
            let dir = scratch("link");
            let target = dir.join("dotfiles.lua");
            fs::write(&target, "bind = A\n").unwrap();
            let path = dir.join("bindings.lua");
            symlink(&target, &path).unwrap();
            write(&path, &with_block("bind = A\n")).unwrap();
            assert_eq!(fs::read_to_string(&target).unwrap(), "bind = A\n");
            assert!(
                !fs::symlink_metadata(&path)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn the_mailto_entry_is_written_0644_never_through_a_link() {
            let dir = scratch("entry");
            let apps = dir.join("applications");
            let entry = apps.join(format!("{MAILTO_ID}.desktop"));
            let text = mailto_entry("/usr/bin/omamail").unwrap();
            write_entry(&apps, &text).unwrap();
            assert_eq!(fs::read_to_string(&entry).unwrap(), text);
            assert_eq!(mode(&entry), 0o644);
            assert_eq!(names(&apps), [format!("{MAILTO_ID}.desktop")]);
            // A link in its place: replaced, and what it named untouched.
            let victim = dir.join("victim.desktop");
            fs::write(&victim, "[Desktop Entry]\nName=Other\n").unwrap();
            fs::remove_file(&entry).unwrap();
            symlink(&victim, &entry).unwrap();
            write_entry(&apps, &text).unwrap();
            assert_eq!(
                fs::read_to_string(&victim).unwrap(),
                "[Desktop Entry]\nName=Other\n"
            );
            assert!(
                !fs::symlink_metadata(&entry)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert_eq!(fs::read_to_string(&entry).unwrap(), text);
            // A link planted at the temporary's name: it is removed, and
            // a fresh file is made (create_new, O_NOFOLLOW), so nothing
            // reaches what it names.
            let tmp = apps.join(format!(".{MAILTO_ID}.desktop.{}", std::process::id()));
            symlink(&victim, &tmp).unwrap();
            write_entry(&apps, &text).unwrap();
            assert_eq!(
                fs::read_to_string(&victim).unwrap(),
                "[Desktop Entry]\nName=Other\n"
            );
            assert_eq!(names(&apps), [format!("{MAILTO_ID}.desktop")]);
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn a_folder_at_the_entry_is_refused() {
            let dir = scratch("entry-dir");
            let apps = dir.join("applications");
            fs::create_dir_all(apps.join(format!("{MAILTO_ID}.desktop"))).unwrap();
            assert_eq!(write_entry(&apps, "x"), Err("mailto_entry_failed"));
            assert_eq!(names(&apps), [format!("{MAILTO_ID}.desktop")]);
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn an_executable_path_no_entry_can_hold_writes_nothing() {
            // `mailto_entry` refuses before any file is opened.
            for exe in [
                "/opt/a\nExec=/bin/sh",
                "/opt/a\rb",
                "/opt/a\u{0}b",
                "/opt/a\u{1b}b",
                "",
            ] {
                assert_eq!(mailto_entry(exe), None, "{exe:?}");
            }
        }
    }
}
