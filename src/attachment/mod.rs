//! Attachment bytes never pass through a shell. Caller-selected reads are bounded;
//! sender-selected filenames are reduced to basenames and created exclusively.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;
pub const MAX_BYTES: usize = 20 * 1024 * 1024;

pub fn safe_filename(raw: &str) -> String {
    let basename = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let name: String = basename
        .chars()
        .map(|c| if c.is_control() { '_' } else { c })
        .collect();
    let name = name.trim();
    if ["", ".", ".."].contains(&name) {
        return "attachment".into();
    }
    if name.len() <= 240 {
        return name.into();
    }
    let (stem, suffix) = name
        .rsplit_once('.')
        .filter(|(s, e)| !s.is_empty() && e.len() < 32)
        .map(|(s, e)| (s, format!(".{e}")))
        .unwrap_or((name, String::new()));
    let mut end = (240 - suffix.len()).min(stem.len());
    while !stem.is_char_boundary(end) {
        end -= 1
    }
    format!("{}{suffix}", &stem[..end])
}
fn mime(bytes: &[u8], path: &Path) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.starts_with(b"%PDF-") {
        "application/pdf"
    } else if path
        .extension()
        .is_some_and(|s| s.eq_ignore_ascii_case("txt"))
        && std::str::from_utf8(bytes).is_ok()
    {
        "text/plain"
    } else {
        "application/octet-stream"
    }
}
pub fn read(params: &Value) -> Result<Value, &'static str> {
    let raw = params["path"].as_str().ok_or("invalid_params")?;
    if raw.chars().any(char::is_control) || !Path::new(raw).is_absolute() {
        return Err("attachment_path_invalid");
    }
    let path = Path::new(raw);
    #[cfg(unix)]
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "attachment_unreadable")?;
    #[cfg(windows)]
    let file =
        crate::platform::private_fs::open_external(path).map_err(|_| "attachment_unreadable")?;
    let metadata = file.metadata().map_err(|_| "attachment_unreadable")?;
    if !metadata.is_file() {
        return Err("attachment_not_regular");
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err("attachment_too_large");
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "attachment_unreadable")?;
    if bytes.len() > MAX_BYTES {
        return Err("attachment_too_large");
    }
    Ok(
        json!({"ok":true,"filename":safe_filename(raw),"path":raw,"mimeType":mime(&bytes,path),"size":bytes.len(),"data":STANDARD.encode(bytes)}),
    )
}
pub fn decode(data: &str) -> Result<Vec<u8>, &'static str> {
    if data.len() > MAX_BYTES.div_ceil(3) * 4 + 1024 {
        return Err("attachment_too_large");
    }
    let compact: String = data.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let config = base64::engine::GeneralPurposeConfig::new()
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent);
    let bytes = base64::engine::GeneralPurpose::new(&base64::alphabet::STANDARD, config)
        .decode(&compact)
        .or_else(|_| {
            base64::engine::GeneralPurpose::new(&base64::alphabet::URL_SAFE, config)
                .decode(&compact)
        })
        .map_err(|_| "attachment_data_invalid")?;
    if bytes.len() > MAX_BYTES {
        return Err("attachment_too_large");
    }
    Ok(bytes)
}
pub fn openable(name: &str, data: &[u8]) -> bool {
    // Ignore non-ASCII suffix disguises after compatibility normalization.
    // This deliberately errs toward refusing an open; saving remains available.
    let name: String = name
        .nfkc()
        .map(|c| if c == '\u{2024}' { '.' } else { c })
        .filter(|c| c.is_ascii() && !c.is_control())
        .collect();
    let name = name.trim_end_matches(['.', '_', ' ', '\t']).to_lowercase();
    if [
        "html", "htm", "xhtml", "shtml", "svg", "svgz", "xml", "desktop", "url", "lnk", "js",
        "mjs", "cjs", "hta", "exe", "bat", "cmd", "com", "msi", "scr", "sh", "bash", "zsh", "ps1",
        "vbs", "vbe", "wsf", "wsh",
    ]
    .iter()
    .any(|s| name.ends_with(&format!(".{s}")))
    {
        return false;
    }
    if [
        b"MZ".as_slice(),
        b"\x7fELF",
        b"\xfe\xed\xfa\xce",
        b"\xfe\xed\xfa\xcf",
        b"\xce\xfa\xed\xfe",
        b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe",
        b"\xbe\xba\xfe\xca",
        b"L\0\0\0\x01\x14\x02\0",
    ]
    .iter()
    .any(|p| data.starts_with(p))
    {
        return false;
    }
    let sample = &data[..data.len().min(65536)];
    let text = if sample.starts_with(b"\xff\xfe") || sample.starts_with(b"\xfe\xff") {
        let little = sample[0] == 255;
        let units: Vec<_> = sample[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| {
                if little {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect();
        let Ok(text) = String::from_utf16(&units) else {
            return false;
        };
        text
    } else {
        String::from_utf8_lossy(sample)
            .trim_start_matches('\u{feff}')
            .into()
    };
    let text = text.replace('\0', "").trim_start().to_lowercase();
    !text.starts_with("#!")
        && ![
            "<!doctype",
            "<html",
            "<head",
            "<body",
            "<script",
            "<iframe",
            "<meta",
            "<svg",
            "<?xml",
            "[desktop entry]",
        ]
        .iter()
        .any(|s| text.contains(s))
}
fn downloads() -> Result<PathBuf, &'static str> {
    Ok(crate::platform::dirs::AppDirs::discover()?.downloads)
}
#[cfg(unix)]
pub fn store(params: &Value, bytes: &[u8]) -> Result<Value, &'static str> {
    if bytes.len() > MAX_BYTES {
        return Err("attachment_too_large");
    }
    let filename = safe_filename(params["filename"].as_str().ok_or("invalid_params")?);
    let opening = params["open"].as_bool().unwrap_or(false);
    if opening && !openable(&filename, bytes) {
        return Err("attachment_open_refused");
    }
    let directory = if opening {
        let base = crate::platform::dirs::AppDirs::discover()?.runtime;
        let mut found = None;
        for n in 0..1000 {
            let path = base.join(format!("omamail-attachment-{}-{n}", std::process::id()));
            match fs::DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => {
                    found = Some(path);
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(_) => return Err("attachment_write_failed"),
            }
        }
        found.ok_or("attachment_write_failed")?
    } else {
        let p = downloads()?;
        fs::create_dir_all(&p).map_err(|_| "attachment_write_failed")?;
        p
    };
    let path = write_unique(&directory, &filename, bytes)?;
    Ok(json!({"ok":true,"path":path,"open":opening}))
}
#[cfg(unix)]
fn write_unique(directory: &Path, filename: &str, bytes: &[u8]) -> Result<PathBuf, &'static str> {
    let path = Path::new(filename);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let suffix = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..1000 {
        let path = directory.join(if n == 1 {
            filename.into()
        } else {
            format!("{stem} ({n}){suffix}")
        });
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(mut file) => {
                if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
                    let _ = fs::remove_file(&path);
                    return Err("attachment_write_failed");
                }
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("attachment_write_failed"),
        }
    }
    Err("attachment_write_failed")
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn refuses_special_files_and_never_overwrites_symlinks() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("omamail-attachment-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let victim = root.join("victim");
        fs::write(&victim, b"keep").unwrap();
        std::os::unix::fs::symlink(&victim, root.join("invoice.pdf")).unwrap();
        let saved = write_unique(&root, "invoice.pdf", b"%PDF-test").unwrap();
        assert_eq!(saved.file_name().unwrap(), "invoice (2).pdf");
        assert_eq!(fs::read(victim).unwrap(), b"keep");
        assert_eq!(read(&json!({"path":root})), Err("attachment_not_regular"));
        assert_eq!(
            read(&json!({"path":"/dev/null"})),
            Err("attachment_not_regular")
        );
        let value = read(&json!({"path":saved})).unwrap();
        assert_eq!(value["mimeType"], "application/pdf");
        assert_eq!(
            STANDARD.decode(value["data"].as_str().unwrap()).unwrap(),
            b"%PDF-test"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn sender_names_cannot_escape() {
        assert_eq!(safe_filename("../../x\\invoice.pdf"), "invoice.pdf");
        assert_eq!(safe_filename(".."), "attachment");
        assert_eq!(safe_filename("x\ny"), "x_y");
        let name = safe_filename(&format!("{}.pdf", "你".repeat(200)));
        assert!(name.len() <= 240);
        assert!(name.ends_with(".pdf"));
    }
    #[test]
    fn rejects_disguised_active_content() {
        for name in ["a.html", "a.ｓｖｇ", "a.svg\u{200b}", "a\u{2024}desktop"] {
            assert!(!openable(name, b"test"), "{name}")
        }
        for body in [
            b"<html>hello".as_slice(),
            b"MZ123",
            b"#!/bin/sh",
            b"\xff\xfe<\0s\0v\0g\0",
        ] {
            assert!(!openable("safe.txt", body))
        }
        assert!(openable("invoice.pdf", b"%PDF-1.7"));
    }
    #[test]
    fn malformed_base64_is_refused() {
        assert!(decode("Zm9v!").is_err());
        assert_eq!(decode("Zm9v").unwrap(), b"foo");
    }
}

/// Forget only files created by the application's clipboard staging helper.
/// A recovered draft's `owned` boolean is never authority for a filesystem path.
pub fn forget(params: &Value) -> Result<Value, &'static str> {
    let base = crate::platform::dirs::AppDirs::discover()?.cache;
    forget_in(
        &base.join("omamail/compose"),
        params["path"].as_str().ok_or("invalid_params")?,
    )
}
fn forget_in(directory: &Path, raw: &str) -> Result<Value, &'static str> {
    let path = Path::new(raw);
    if raw.chars().any(char::is_control)
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
        || path.parent() != Some(directory)
    {
        return Err("attachment_not_owned");
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("attachment_not_owned")?;
    static STAGED: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"^(?:screenshot|paste)-[0-9]{8}-[0-9]{6}-[0-9]+\.(?:png|jpg|webp|gif|bmp|pdf)$",
        )
        .unwrap()
    });
    if !STAGED.is_match(name) {
        return Err("attachment_not_owned");
    }
    let Some(folder) = crate::platform::private_fs::directories_readonly(directory, &[])
        .map_err(|_| "attachment_not_owned")?
    else {
        return Ok(json!({"ok":true}));
    };
    crate::platform::private_fs::remove_owned(&folder, name).map_err(|_| "attachment_not_owned")?;
    Ok(json!({"ok":true}))
}

#[cfg(all(test, unix))]
mod forget_tests {
    use super::*;
    #[test]
    fn recovered_owned_flag_cannot_delete_outside_staging() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("omamail-forget-test-{}", std::process::id()));
        let staging = root.join("compose");
        fs::create_dir_all(&staging).unwrap();
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staging, fs::Permissions::from_mode(0o700)).unwrap();
        let victim = root.join("victim");
        fs::write(&victim, b"keep").unwrap();
        for path in [
            victim.clone(),
            staging.join("../victim"),
            staging.join("ordinary.pdf"),
        ] {
            assert!(forget_in(&staging, path.to_str().unwrap()).is_err())
        }
        let rejected = std::process::Command::new("sh")
            .args(["scripts/attachment.sh", "forget"])
            .arg(&staging)
            .arg(staging.join("../victim"))
            .output()
            .unwrap();
        let result: Value = serde_json::from_slice(&rejected.stdout).unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(fs::read(&victim).unwrap(), b"keep");
        let staged = staging.join("paste-20260912-123456-42.pdf");
        std::os::unix::fs::symlink(&victim, &staged).unwrap();
        assert!(forget_in(&staging, staged.to_str().unwrap()).is_err());
        assert_eq!(fs::read(&victim).unwrap(), b"keep");
        fs::remove_file(&staged).unwrap();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&staged)
            .unwrap();
        file.write_all(b"ours").unwrap();
        drop(file);
        assert!(forget_in(&staging, staged.to_str().unwrap()).is_ok());
        assert!(!staged.exists());
        assert_eq!(fs::read(&victim).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(windows)]
pub fn store(params: &Value, bytes: &[u8]) -> Result<Value, &'static str> {
    if bytes.len() > MAX_BYTES {
        return Err("attachment_too_large");
    }
    let filename = safe_filename(params["filename"].as_str().ok_or("invalid_params")?);
    let opening = params["open"].as_bool().unwrap_or(false);
    if opening && !openable(&filename, bytes) {
        return Err("attachment_open_refused");
    }
    let dirs = crate::platform::dirs::AppDirs::discover()?;
    let directory = if opening {
        crate::platform::private_fs::directories(&dirs.runtime, &["omamail", "attachments"], true)
    } else {
        crate::platform::private_fs::directories(&dirs.downloads, &[], true)
    }
    .map_err(|_| "attachment_write_failed")?
    .ok_or("attachment_write_failed")?;
    let path = crate::platform::private_fs::write_unique(&directory, &filename, bytes)
        .map_err(|_| "attachment_write_failed")?;
    Ok(json!({"ok":true,"path":path,"open":opening}))
}
