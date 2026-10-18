//! Hermes profile model. Values are untrusted until `validate_model` accepts them.
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

const LIMIT: u64 = 1024 * 1024;
pub(super) const MISSING: &str = "Hermes needs a provider and model. Set them in Settings → AI, or set model.provider and model.default in the Hermes config.";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Endpoint {
    pub provider: String,
    pub model: String,
}

pub(super) fn resolve(
    provider_override: &str,
    model_override: &str,
) -> Result<Endpoint, &'static str> {
    let configured = if provider_override.is_empty() || model_override.is_empty() {
        config_file(
            std::env::var_os("HERMES_HOME").as_deref(),
            std::env::var_os("HOME").as_deref(),
        )
        .as_deref()
        .map(read_config)
        .unwrap_or_default()
    } else {
        Endpoint::default()
    };
    merge(provider_override, model_override, configured)
}

pub(super) fn merge(
    provider_override: &str,
    model_override: &str,
    configured: Endpoint,
) -> Result<Endpoint, &'static str> {
    let provider = if provider_override.is_empty() {
        configured.provider
    } else {
        provider_override.to_owned()
    };
    let model = if model_override.is_empty() {
        configured.model
    } else {
        model_override.to_owned()
    };
    let provider = accepted(&provider);
    let model = accepted(&model);
    if provider.is_empty() || model.is_empty() {
        Err(MISSING)
    } else {
        Ok(Endpoint { provider, model })
    }
}

fn accepted(value: &str) -> String {
    if !value.is_empty() && super::provider::validate_model(value).is_ok() {
        value.to_owned()
    } else {
        String::new()
    }
}

pub(super) fn config_file(
    hermes_home: Option<&std::ffi::OsStr>,
    home: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    if let Some(root) = hermes_home.filter(|root| !root.is_empty()) {
        return Some(PathBuf::from(root).join("config.yaml"));
    }
    home.filter(|root| !root.is_empty())
        .map(|root| PathBuf::from(root).join(".hermes").join("config.yaml"))
}

pub(super) fn read_config(path: &Path) -> Endpoint {
    let Ok(file) = File::open(path) else {
        return Endpoint::default();
    };
    let mut bytes = Vec::new();
    if file.take(LIMIT + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > LIMIT {
        return Endpoint::default();
    }
    parse(&bytes)
}

pub(super) fn parse(bytes: &[u8]) -> Endpoint {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Endpoint::default();
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut provider = None;
    let mut model = None;
    let mut in_model = false;
    let mut model_indent = 0usize;
    let mut child_indent = None;
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        let indent = line
            .bytes()
            .take_while(|byte| *byte == b' ' || *byte == b'\t')
            .count();
        let body = line[indent..].trim_end();
        if body.is_empty() || body.starts_with('#') {
            continue;
        }
        if in_model && indent <= model_indent {
            in_model = false;
            child_indent = None;
        }
        if !in_model {
            if indent == 0
                && let Some((key, value)) = yaml_key(body)
                && key == "model"
                && (value.is_empty() || value.starts_with('#'))
            {
                in_model = true;
                model_indent = indent;
            }
            continue;
        }
        let child = *child_indent.get_or_insert(indent);
        if indent != child {
            continue;
        }
        let Some((key, value)) = yaml_key(body) else {
            continue;
        };
        let slot = match key {
            "provider" => &mut provider,
            "default" => &mut model,
            _ => continue,
        };
        if slot.is_some() {
            continue;
        }
        *slot = Some(yaml_scalar(value).unwrap_or_default());
    }
    Endpoint {
        provider: provider.unwrap_or_default(),
        model: model.unwrap_or_default(),
    }
}

fn yaml_key(body: &str) -> Option<(&str, &str)> {
    let (key, rest) = body.split_once(':')?;
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    Some((key, rest.trim()))
}

fn yaml_scalar(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('#') {
        return None;
    }
    if let Some(quote) = value
        .chars()
        .next()
        .filter(|mark| *mark == '"' || *mark == '\'')
    {
        let rest = &value[quote.len_utf8()..];
        let end = rest.find(quote)?;
        let inner = &rest[..end];
        let after = rest[end + quote.len_utf8()..].trim();
        if (!after.is_empty() && !after.starts_with('#')) || inner.contains('\\') {
            return None;
        }
        return accepted_scalar(inner);
    }
    let bare = value
        .split_once(" #")
        .map(|(head, _)| head.trim())
        .unwrap_or(value);
    if bare.is_empty()
        || bare.bytes().any(|byte| byte.is_ascii_whitespace())
        || matches!(
            bare.as_bytes()[0],
            b'*' | b'!' | b'&' | b'{' | b'[' | b'|' | b'>' | b'?' | b'-'
        )
    {
        return None;
    }
    accepted_scalar(bare)
}

fn accepted_scalar(value: &str) -> Option<String> {
    if value.is_empty() || super::provider::validate_model(value).is_err() {
        None
    } else {
        Some(value.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_block_scalars_ignore_other_sections_quotes_and_unsafe_values() {
        let parsed = parse(
            b"\xef\xbb\xbf# comment\nmcp_servers:\n  provider: sendmail\nmodel: # profile\n  provider: \"xai-oauth\" # saved\n  default: grok-4.7\n  extra:\n    provider: ignored\n    default: also-ignored\nother:\n  provider: custom\n  default: nope\n",
        );
        assert_eq!(parsed.provider, "xai-oauth");
        assert_eq!(parsed.model, "grok-4.7");
        let hostile = parse(b"model:\n  provider: --bad\n  default: $(touch)\n");
        assert_eq!(hostile, Endpoint::default());
        assert!(!hostile.provider.contains("--bad"));
        let folded = parse(b"model:\n  provider: |\n    xai-oauth\n  default: grok-4.7\n");
        assert_eq!(folded.provider, "");
        assert_eq!(folded.model, "grok-4.7");
        let quoted = parse(b"model:\n  provider: 'openrouter'\n  default: \"llama-3\"\n");
        assert_eq!(quoted.provider, "openrouter");
        assert_eq!(quoted.model, "llama-3");
        assert_eq!(parse(b"\xffmodel:\n  provider: xai\n"), Endpoint::default());
    }

    #[test]
    fn overrides_win_per_field_and_a_gap_is_a_static_error() {
        let file = Endpoint {
            provider: "xai-oauth".into(),
            model: "grok-4.7".into(),
        };
        assert_eq!(merge("", "", file.clone()).unwrap(), file);
        assert_eq!(
            merge("openrouter", "", file.clone()).unwrap(),
            Endpoint {
                provider: "openrouter".into(),
                model: "grok-4.7".into(),
            }
        );
        assert_eq!(merge("", "llama-3", file.clone()).unwrap().model, "llama-3");
        assert_eq!(
            merge("openrouter", "llama-3", Endpoint::default())
                .unwrap()
                .provider,
            "openrouter"
        );
        assert_eq!(merge("", "", Endpoint::default()).unwrap_err(), MISSING);
        assert_eq!(
            merge("--bad", "grok-4.7", Endpoint::default()).unwrap_err(),
            MISSING
        );
        assert!(!MISSING.contains("xai-oauth"));
    }

    #[test]
    fn hermes_home_wins_and_oversized_files_are_ignored() {
        assert_eq!(
            config_file(
                Some(std::ffi::OsStr::new("/tmp/hermes")),
                Some(std::ffi::OsStr::new("/home/ada"))
            ),
            Some(PathBuf::from("/tmp/hermes/config.yaml"))
        );
        assert_eq!(
            config_file(
                Some(std::ffi::OsStr::new("")),
                Some(std::ffi::OsStr::new("/home/ada"))
            ),
            Some(PathBuf::from("/home/ada/.hermes/config.yaml"))
        );
        assert_eq!(config_file(None, None), None);
        let dir = std::env::temp_dir().join(format!("omamail-hermes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.yaml");
        std::fs::write(
            &path,
            "model:\n  provider: xai-oauth\n  default: grok-4.7\n",
        )
        .unwrap();
        assert_eq!(read_config(&path).model, "grok-4.7");
        let mut oversized = b"model:\n  provider: xai-oauth\n  default: grok-4.7\n".to_vec();
        oversized.resize((LIMIT + 1) as usize, b'\n');
        std::fs::write(&path, oversized).unwrap();
        assert_eq!(read_config(&path), Endpoint::default());
        assert_eq!(read_config(&dir.join("missing.yaml")), Endpoint::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
