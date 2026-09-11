//! Signature imports reuse the reader's sanitizer, followed by a stricter tree walk.
use super::html::{self, Node};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;
pub const MAX_HTML_BYTES: usize = 256 * 1024;
pub const MAX_IMAGE_BYTES: usize = 512 * 1024;
fn limit(options: &Value, key: &str, default: usize) -> usize {
    options[key]
        .as_f64()
        .filter(|v| v.is_finite() && *v != 0.0)
        .map(|v| v.floor().max(1.0) as usize)
        .unwrap_or(default)
}
fn clean(data: &str) -> String {
    data.chars()
        .filter(|c| c.is_ascii_alphanumeric() || "+/=".contains(*c))
        .collect()
}
fn prefix(data: &str, count: usize) -> Vec<u8> {
    let mut bits = 0;
    let mut value = 0u32;
    let mut bytes = Vec::new();
    for c in clean(data).bytes() {
        let digit = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => break,
        };
        value = value.wrapping_shl(6) | digit as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((value >> bits) as u8);
            if bytes.len() >= count {
                break;
            }
        }
    }
    bytes
}
pub fn raster_kind(data: &str) -> &'static str {
    let b = prefix(data, 16);
    if b.starts_with(b"\x89PNG") {
        "image/png"
    } else if b.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if b.starts_with(b"GIF8") {
        "image/gif"
    } else if b.len() >= 16 && b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        ""
    }
}
fn base64_bytes(data: &str) -> usize {
    let s = clean(data);
    (s.len() * 3 / 4).saturating_sub(if s.ends_with("==") {
        2
    } else {
        usize::from(s.ends_with('='))
    })
}
pub fn import_image(data: &str, options: &Value) -> Value {
    let mime = raster_kind(data);
    if mime.is_empty() {
        return json!({"html":"","plain":"","problem":"That file is not a PNG, JPEG, GIF or WebP image"});
    }
    let max = limit(options, "maxImageBytes", MAX_IMAGE_BYTES);
    if base64_bytes(data) > max {
        return json!({"html":"","plain":"","problem":format!("That image is larger than {} KB",(max as f64/1024.0).round() as usize)});
    }
    json!({"html":format!("<p><img src=\"data:{mime};base64,{}\"></p>",clean(data)),"plain":"","dropped":0,"images":1,"problem":""})
}
static DATA: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^data:(image/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$").unwrap()
});
pub fn data_image_ok(value: &str, max: usize) -> bool {
    let Some(c) = DATA.captures(value) else {
        return false;
    };
    let kind = raster_kind(&c[2]);
    base64_bytes(&c[2]) <= max
        && !kind.is_empty()
        && (kind == c[1].to_lowercase()
            || (kind == "image/jpeg" && c[1].eq_ignore_ascii_case("image/jpg")))
}
fn href_ok(value: &str) -> bool {
    let value = value.trim();
    if value.to_lowercase().starts_with("mailto:") {
        return value.len() > 7
            && !value[7..]
                .chars()
                .any(|c| c.is_whitespace() || "<>\"".contains(c));
    }
    html::is_public_url(value)
}
const FORBIDDEN: &[&str] = &[
    "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input",
    "button", "select", "textarea", "option", "svg", "math", "template", "link", "meta", "base",
    "video", "audio", "source", "track", "canvas", "noscript",
];
const ATTRS: &[&str] = &[
    "action",
    "formaction",
    "background",
    "srcset",
    "poster",
    "xlink:href",
    "data",
    "codebase",
    "usemap",
    "ping",
    "manifest",
    "longdesc",
    "profile",
];
static BAD_STYLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)url\s*\(|expression\s*\(|@import|behavior\s*:|javascript:|display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:[^.\d]|$)|font-size\s*:\s*0(?:[^.\d]|$)|font-size\s*:\s*0?\.\d|text-indent\s*:\s*-").unwrap()
});
struct Context {
    dropped: usize,
    images: usize,
    image_limit: usize,
}
fn prune(node: &mut Node, ctx: &mut Context) {
    node.children.retain_mut(|child| {
        if child.kind == "text" {
            return true;
        }
        if child.kind != "element" || FORBIDDEN.contains(&child.name.to_lowercase().as_str()) {
            ctx.dropped += 1;
            return false;
        }
        child.name = child.name.to_lowercase();
        let tag = child.name.clone();
        child.attrs.retain_mut(|attr| {
            attr.name = attr.name.to_lowercase();
            let name = attr.name.as_str();
            let value = attr.value.as_deref().unwrap_or("");
            if name.starts_with("on")
                || ATTRS.contains(&name)
                || (name == "href" && !href_ok(value))
                || (name == "style" && BAD_STYLE.is_match(value))
            {
                ctx.dropped += 1;
                return false;
            }
            if name == "src" {
                if tag != "img" || !data_image_ok(value, ctx.image_limit) || ctx.images >= 8 {
                    ctx.dropped += 1;
                    return false;
                }
                ctx.images += 1
            }
            true
        });
        if tag == "img" && !child.attrs.iter().any(|a| a.name == "src") {
            ctx.dropped += 1;
            return false;
        }
        prune(child, ctx);
        true
    });
}
fn source_removals(source: &str) -> usize {
    [
        r"(?i)<\s*(script|style|iframe|object|embed|form|input|svg|template|link|meta)\b",
        r"(?i)\son[a-z]+\s*=",
        r"(?i)javascript\s*:",
        r"(?i)url\s*\(",
        r"(?i)\sbackground\s*=",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap().find_iter(source).count())
    .sum()
}
pub fn import_html(source: &str, options: &Value) -> Result<Value, &'static str> {
    if source.encode_utf16().count() > limit(options, "maxHtmlBytes", MAX_HTML_BYTES) {
        return Ok(
            json!({"html":"","plain":"","dropped":0,"images":0,"problem":"That file is too large for a signature"}),
        );
    }
    let cleaned = html::sanitize(
        source,
        &json!({"allowRemoteImages":false,"keepColors":true}),
    )?;
    let mut ctx = Context {
        dropped: source_removals(source) + cleaned["blockedImages"].as_u64().unwrap_or(0) as usize,
        images: 0,
        image_limit: limit(options, "maxImageBytes", MAX_IMAGE_BYTES),
    };
    let mut document = html::parse(cleaned["html"].as_str().unwrap_or(""))?;
    prune(&mut document, &mut ctx);
    let rendered = html::serialize(&document)?;
    let read = html::read_plain(&document);
    let plain = Regex::new(r"[ \t]+\n")
        .unwrap()
        .replace_all(read["text"].as_str().unwrap_or(""), "\n")
        .trim()
        .to_string();
    if rendered.trim().is_empty() || (plain.is_empty() && ctx.images == 0) {
        return Ok(
            json!({"html":"","plain":"","dropped":ctx.dropped,"images":0,"problem":"Nothing in that file can be a signature"}),
        );
    }
    Ok(
        json!({"html":rendered,"plain":plain,"dropped":ctx.dropped,"images":ctx.images,"problem":""}),
    )
}
static INLINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)src="data:(image/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)""#).unwrap()
});
pub fn inline_parts(source: &str, prefix: &str) -> Value {
    let stem = if prefix.is_empty() { "sig" } else { prefix };
    let mut parts = Vec::new();
    let result = INLINE.replace_all(source, |c: &regex::Captures<'_>| {
        let id = format!("{stem}{}@omamail", parts.len() + 1);
        parts.push(json!({"cid":id,"mimeType":c[1].to_lowercase(),"data":&c[2]}));
        format!("src=\"cid:{id}\"")
    });
    json!({"html":result,"parts":parts})
}
pub fn import_note(result: &Value) -> String {
    if let Some(problem) = result["problem"].as_str().filter(|s| !s.is_empty()) {
        return problem.into();
    }
    let images = result["images"].as_u64().unwrap_or(0);
    let dropped = result["dropped"].as_u64().unwrap_or(0);
    let mut parts = Vec::new();
    if images > 0 {
        parts.push(format!(
            "{images} image{}",
            if images == 1 { "" } else { "s" }
        ))
    }
    if dropped > 0 {
        parts.push(format!(
            "{dropped} unsafe or unsupported part{} removed",
            if dropped == 1 { "" } else { "s" }
        ))
    }
    if parts.is_empty() {
        "Imported".into()
    } else {
        format!("Imported: {}", parts.join(", "))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_and_inline_match_live_js() {
        let cases = json!([{"data":"iVBORw0KGgoAAA==","html":"<p><img src=\"data:image/png;base64,iVBORw0KGgoAAA==\"></p>"},{"data":"PHN2Zz4=","html":"<b>سلام</b>"},{"data":"R0lGOA==","html":"<img src=\"data:image/gif;base64,R0lGOA==\">"}]);
        let script = r#"const {load}=require('./ui/tests/load');const s=load('message/Signature.js');let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(text).map(c=>[s.importImage(c.data),s.inlineParts(c.html,'sig')]))));"#;
        use std::io::Write;
        let mut child = std::process::Command::new("node")
            .args(["-e", script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(cases.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
        for (n, c) in cases.as_array().unwrap().iter().enumerate() {
            assert_eq!(
                json!([
                    import_image(c["data"].as_str().unwrap(), &Value::Null),
                    inline_parts(c["html"].as_str().unwrap(), "sig")
                ]),
                expected[n]
            );
        }
    }
    #[test]
    fn html_import_matches_live_js_for_plain_and_unsafe_inputs() {
        let cases = json!([
            "<p>Alice<br>Engineer</p>",
            "<p>سلام دنیا</p>",
            "<script>alert(1)</script><p>Alice</p>",
            "<p><img src=\"https://example.com/a.png\"></p>",
            "<p onclick=\"evil()\">Hello</p>"
        ]);
        let script = r#"const {load}=require('./ui/tests/load');const s=load('message/Signature.js');let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(text).map(c=>s.importHtml(c)))));"#;
        use std::io::Write;
        let mut child = std::process::Command::new("node")
            .args(["-e", script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(cases.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
        for (n, source) in cases.as_array().unwrap().iter().enumerate() {
            assert_eq!(
                import_html(source.as_str().unwrap(), &Value::Null).unwrap(),
                expected[n],
                "{source}"
            );
        }
    }
    #[test]
    fn existing_signature_suite_is_a_live_golden_oracle() {
        let script = r#"const loader=require('./ui/tests/load');const load=loader.load;const rows=[];loader.load=function(p){const m=load(p);if(p==='message/Signature.js')for(const name of ['rasterKind','importImage','importHtml','inlineParts','importNote']){const f=m[name];m[name]=function(...args){const result=f(...args);rows.push({name,args,result});return result;};}return m;};console.log=()=>{};require('./ui/tests/test_signature');process.stdout.write(JSON.stringify(rows));"#;
        let output = std::process::Command::new("node")
            .args(["-e", script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let rows: Value = serde_json::from_slice(&output.stdout).unwrap();
        for row in rows.as_array().unwrap() {
            let args = &row["args"];
            let first = args[0].as_str().unwrap_or("");
            let value = match row["name"].as_str().unwrap() {
                "rasterKind" => json!(raster_kind(first)),
                "importImage" => import_image(first, &args[1]),
                "importHtml" => import_html(first, &args[1]).unwrap(),
                "inlineParts" => inline_parts(first, args[1].as_str().unwrap_or("sig")),
                "importNote" => json!(import_note(&args[0])),
                _ => unreachable!(),
            };
            assert_eq!(
                value,
                row["result"],
                "{} input {}",
                row["name"],
                first.chars().take(100).collect::<String>()
            );
        }
    }
    #[test]
    fn rejects_non_raster_and_bounds_source() {
        assert!(!data_image_ok("data:image/png;base64,PHN2Zz4=", 512000));
        assert!(!data_image_ok("data:image/png;base64,iVBORw0KGgoAAA==", 1));
        assert_ne!(
            import_html(&"a".repeat(MAX_HTML_BYTES + 1), &Value::Null).unwrap()["problem"],
            ""
        );
    }
}
