//! The Omarchy shell's font settings, which the Qt plugin followed through
//! `Style.font`: `[font]` in `$XDG_CONFIG_HOME/omarchy/shell.toml`
//! (`~/.config/omarchy/shell.toml`). Only `family` and `base-size` are read.
//!
//! The file is the user's, but it is still untrusted input to this process:
//! it is size-capped, parsed as TOML, and each value is checked before it
//! reaches the UI. Anything unusable reads as absent, and the UI keeps its
//! defaults.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

const MAX_BYTES: u64 = 256 * 1024;
const MIN_BASE: f64 = 8.0;
const MAX_BASE: f64 = 32.0;
const MAX_FAMILY: usize = 128;

/// `{ family?, baseSize? }` from the user's Omarchy shell config, or `{}`
/// when there is none (not Omarchy, no `[font]`, or values out of range).
pub fn read() -> Value {
    match path() {
        Some(path) => read_from(&path),
        None => Value::Object(Map::new()),
    }
}

fn path() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(config.join("omarchy").join("shell.toml"))
}

fn read_from(path: &Path) -> Value {
    let text = std::fs::metadata(path)
        .ok()
        .filter(|m| m.is_file() && m.len() <= MAX_BYTES)
        .and_then(|_| std::fs::read_to_string(path).ok());
    match text {
        Some(text) => parse(&text),
        None => Value::Object(Map::new()),
    }
}

fn parse(text: &str) -> Value {
    let mut out = Map::new();
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else {
        return Value::Object(out);
    };
    let Some(font) = doc.get("font").and_then(|item| item.as_table_like()) else {
        return Value::Object(out);
    };
    if let Some(family) = font.get("family").and_then(|v| v.as_str()) {
        let family = family.trim();
        if !family.is_empty()
            && family.chars().count() <= MAX_FAMILY
            && !family.chars().any(|c| c.is_control())
        {
            out.insert("family".into(), Value::String(family.to_owned()));
        }
    }
    let base = font.get("base-size").and_then(|v| {
        v.as_float()
            .or_else(|| v.as_integer().map(|i| i as f64))
    });
    if let Some(base) = base.filter(|b| b.is_finite() && (MIN_BASE..=MAX_BASE).contains(b)) {
        if let Some(n) = serde_json::Number::from_f64(base) {
            out.insert("baseSize".into(), Value::Number(n));
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::parse;
    use serde_json::json;

    #[test]
    fn reads_family_and_base_size() {
        let v = parse("[font]\nfamily = \"JetBrainsMono Nerd Font\"\nbase-size = 15\n");
        assert_eq!(v, json!({ "family": "JetBrainsMono Nerd Font", "baseSize": 15.0 }));
    }

    #[test]
    fn drops_unusable_values() {
        assert_eq!(parse("[font]\nbase-size = 400\nfamily = \"\"\n"), json!({}));
        assert_eq!(parse("[font]\nfamily = \"a\\nb\"\n"), json!({}));
        assert_eq!(parse("not toml ["), json!({}));
        assert_eq!(parse("[other]\nbase-size = 14\n"), json!({}));
    }
}
