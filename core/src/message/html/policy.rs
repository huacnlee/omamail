use super::tree::*;
use base64::{Engine, engine::general_purpose::STANDARD};

pub fn decode(s: &str) -> String {
    re!(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);?")
        .replace_all(s, |c: &regex::Captures| {
            let v = &c[1];
            if let Some(num) = v.strip_prefix('#') {
                let parsed = if num.starts_with(['x', 'X']) {
                    u32::from_str_radix(&num[1..], 16)
                } else {
                    num.parse()
                };
                return parsed
                    .ok()
                    .and_then(char::from_u32)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| c[0].into());
            }
            match v.to_ascii_lowercase().as_str() {
                "amp" => "&",
                "quot" => "\"",
                "apos" => "'",
                "lt" => "<",
                "gt" => ">",
                "sol" => "/",
                "colon" => ":",
                "nbsp" | "ensp" | "emsp" | "thinsp" => " ",
                "mdash" => "—",
                "ndash" => "–",
                "hellip" => "…",
                "bull" => "•",
                "lsquo" => "‘",
                "rsquo" => "’",
                "ldquo" => "“",
                "rdquo" => "”",
                "middot" => "·",
                "copy" => "©",
                "reg" => "®",
                "trade" => "™",
                "deg" => "°",
                "times" => "×",
                "laquo" => "«",
                "raquo" => "»",
                "euro" => "€",
                "pound" => "£",
                "yen" => "¥",
                "cent" => "¢",
                "sect" => "§",
                _ => return c[0].into(),
            }
            .into()
        })
        .into_owned()
}
pub fn normalized(s: &str) -> String {
    decode(&decode(s))
        .replace(['\t', '\n', '\r'], "")
        .trim_matches(|c: char| c.is_whitespace() || c <= '\u{1f}')
        .into()
}
fn host(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let s = lower
        .strip_prefix("https:")
        .or_else(|| lower.strip_prefix("http:"))
        .unwrap_or(&lower);
    let Some(s) = s.strip_prefix("//") else {
        return String::new();
    };
    let s = s.split(['/', '?', '#']).next().unwrap_or("");
    let s = s.rsplit('@').next().unwrap_or("");
    if s.starts_with('[') {
        return s.split(']').next().unwrap_or("").to_owned() + "]";
    }
    s.split(':').next().unwrap_or("").into()
}
fn public_host(h: &str) -> bool {
    if let Ok(ip) = h.parse::<std::net::Ipv4Addr>() {
        return crate::public_http::is_public(ip.into());
    }
    if h.len() > 253 || h.contains("..") || !re!(r"^[a-z0-9.-]+$").is_match(h) {
        return false;
    }
    if re!(r"(?i)(^|\.)(localhost|home\.arpa)$|\.(local|localdomain|internal|intranet|lan|home|corp|test)$").is_match(h){return false}
    re!(r"\.(xn--[a-z0-9-]+|[a-z]{2,})$").is_match(h)
}
pub fn is_public_url(s: &str) -> bool {
    let once = decode(s);
    let twice = decode(&once);
    public_host(&host(&normalized(s)))
        && (once == twice || public_host(&host(&once.replace(['\t', '\n', '\r'], ""))))
}
pub fn raster(s: &str) -> bool {
    let Some((head, payload)) = s.split_once(',') else {
        return false;
    };
    let head = head.to_ascii_lowercase();
    let Some(kind) = head
        .strip_prefix("data:image/")
        .and_then(|s| s.strip_suffix(";base64"))
    else {
        return false;
    };
    if payload.len() > 8 * 1024 * 1024 {
        return false;
    }
    let Ok(data) = STANDARD.decode(payload) else {
        return false;
    };
    match kind {
        "png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => data.starts_with(b"\xff\xd8\xff"),
        "gif" => data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"),
        "webp" => data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP"),
        "bmp" => data.starts_with(b"BM"),
        _ => false,
    }
}
pub fn image_kind(s: &str) -> &'static str {
    let url = normalized(s);
    let lower = url.to_ascii_lowercase();
    if url.is_empty() {
        "none"
    } else if lower.starts_with("cid:") || raster(&url) {
        "inline"
    } else if re!(r"(?i)^(https?:)?//").is_match(&url) {
        if is_public_url(s) { "remote" } else { "unsafe" }
    } else if re!(r"(?i)^[a-z][a-z0-9+.-]*:").is_match(&url) {
        "unsafe"
    } else {
        "local"
    }
}
pub fn safe_href(s: &str) -> bool {
    re!(r"(?i)^\s*(https?:|mailto:)").is_match(s)
}
pub fn declarations(s: &str) -> Vec<(String, String)> {
    let mut value = decode(&decode(s));
    for _ in 0..8 {
        let old = value.clone();
        value = re!(r"(?s)/\*.*?(?:\*/|$)")
            .replace_all(&value, "")
            .into_owned();
        value = re!(r"\\([0-9a-fA-F]{1,6}[\t\n\r\x0c ]?|.)")
            .replace_all(&value, |c: &regex::Captures| {
                let v = &c[1];
                if v.as_bytes()[0].is_ascii_hexdigit() {
                    u32::from_str_radix(v.trim(), 16)
                        .ok()
                        .and_then(char::from_u32)
                        .map(|c| c.to_string())
                        .unwrap_or_default()
                } else {
                    v.into()
                }
            })
            .into_owned();
        if old == value {
            break;
        }
    }
    let mut parts = vec![];
    let mut start = 0;
    let mut quote = None;
    let mut depth = 0;
    for (i, c) in value.char_indices() {
        if let Some(q) = quote {
            if c == q {
                quote = None
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' => depth += 1,
            ')' => depth = std::cmp::max(0, depth - 1),
            ';' if depth == 0 => {
                parts.push(&value[start..i]);
                start = i + 1
            }
            _ => {}
        }
    }
    parts.push(&value[start..]);
    parts
        .into_iter()
        .filter_map(|p| p.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().into()))
        .collect()
}
pub fn set_style(n: &mut Node, styles: &[(String, String)]) {
    let value = styles
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(n, v)| format!("{n}:{v}"))
        .collect::<Vec<_>>()
        .join(";");
    if value.is_empty() {
        n.remove("style")
    } else {
        n.set("style", &value)
    }
}
pub fn hidden(styles: &[(String, String)]) -> bool {
    styles.iter().any(|(n, v)| {
        (n == "display" && re!(r"(?i)^none\b").is_match(v))
            || (n == "visibility" && re!(r"(?i)^hidden\b").is_match(v))
    })
}
pub fn tracking(n: &Node) -> bool {
    for a in ["width", "height"] {
        if !n.attr(a).is_empty() && n.attr(a).trim().parse::<f64>().is_ok_and(|v| v <= 2.0) {
            return true;
        }
    }
    declarations(n.attr("style")).iter().any(|(k, v)| {
        matches!(k.as_str(), "width" | "height") && re!(r"(?i)^[012](\.\d+)?px").is_match(v)
    })
}
pub fn undrawn(s: &str) -> String {
    re!(r"[\x{00ad}\x{034f}\x{061c}\x{180e}\x{200b}-\x{200f}\x{2060}-\x{2064}\x{feff}]")
        .replace_all(s, "")
        .into_owned()
}
pub fn source_space(s: &str) -> String {
    re!(r"[ \t\r\n\x0c]+").replace_all(s, " ").into_owned()
}
