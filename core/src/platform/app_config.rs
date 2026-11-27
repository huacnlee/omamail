//! The UI's own private config files beside the backend's: the Gmail OAuth
//! client (`credentials.json`, which the backend reads), window preferences
//! and calendar choices. Only these names, only in `<config>/omamail`, only
//! owner-readable (0600), replaced atomically. The Qt client wrote them
//! through `platform.writeConfig`; the NSH app calls these through
//! `omamail-native`.

use std::io::Read;

use super::{dirs, private_fs};

/// The files the UI may read and write.
pub const NAMES: &[&str] = &["credentials.json", "window.json", "calendars.json"];
/// Files the UI may only read: the Omarchy plugin's settings, handed over
/// once by `omarchy/notice/omamail-app.sh export-settings` for the app to
/// import on its first launch. Never written from here.
pub const READ_ONLY_NAMES: &[&str] = &["plugin-settings.json"];
const MAX_BYTES: u64 = 1024 * 1024;

fn allowed(name: &str) -> Result<(), &'static str> {
    if NAMES.contains(&name) { Ok(()) } else { Err("config_name_refused") }
}

fn readable(name: &str) -> Result<(), &'static str> {
    if NAMES.contains(&name) || READ_ONLY_NAMES.contains(&name) { Ok(()) } else { Err("config_name_refused") }
}

/// The file's text, or `None` when it does not exist.
pub fn read(name: &str) -> Result<Option<String>, &'static str> {
    readable(name)?;
    let root = dirs::AppDirs::discover()?.config;
    let Some(dir) = private_fs::directories_readonly(&root, &[dirs::APP_DIRECTORY])? else {
        return Ok(None);
    };
    let Some(file) = private_fs::regular_readonly(&dir, name)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "config_unreadable")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("config_too_large");
    }
    String::from_utf8(bytes).map(Some).map_err(|_| "config_unreadable")
}

/// Replaces the file with `text`, owner-only, atomically.
pub fn write(name: &str, text: &str) -> Result<(), &'static str> {
    allowed(name)?;
    if text.len() as u64 > MAX_BYTES {
        return Err("config_too_large");
    }
    let root = dirs::AppDirs::discover()?.config;
    let dir = private_fs::directories(&root, &[dirs::APP_DIRECTORY], true)?
        .ok_or("config_unavailable")?;
    private_fs::atomic_replace(&dir, name, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_settings_are_read_only() {
        // Judged by name only: the test reads and writes no real config.
        assert_eq!(write("plugin-settings.json", "{}"), Err("config_name_refused"));
        assert_eq!(readable("plugin-settings.json"), Ok(()));
        assert_eq!(allowed("plugin-settings.json"), Err("config_name_refused"));
    }

    #[test]
    fn refuses_names_outside_the_allowlist() {
        for name in ["accounts.json", "../credentials.json", "credentials.json/x", ""] {
            assert_eq!(read(name), Err("config_name_refused"));
            assert_eq!(write(name, "{}"), Err("config_name_refused"));
        }
    }
}
