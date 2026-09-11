//! Mail direction rules shared by summaries, rendering and outgoing MIME.
use regex::Regex;
use std::sync::LazyLock;
pub const AUTO: &str = "Auto";
pub const LTR: &str = "ltr";
pub const RTL: &str = "rtl";
pub fn normalize_mode(mode: &str) -> &str {
    match mode {
        "Right to left" | "Left to right" => mode,
        _ => AUTO,
    }
}
pub fn forced(mode: &str) -> &'static str {
    match mode {
        "Right to left" => RTL,
        "Left to right" => LTR,
        _ => "",
    }
}
fn neutral(code: u32) -> bool {
    (code <= 0x0040)
        || (0x005B..=0x0060).contains(&code)
        || (0x007B..=0x00BF).contains(&code)
        || (code == 0x00D7 || code == 0x00F7)
        || (0x0600..=0x0605).contains(&code)
        || (0x0660..=0x066C).contains(&code)
        || (code == 0x06DD || code == 0x08E2)
        || (0x06F0..=0x06F9).contains(&code)
        || (0x10E60..=0x10E7E).contains(&code)
        || (0x0300..=0x036F).contains(&code)
        || (0x2000..=0x2BFF).contains(&code)
        || (0x2E00..=0x2E7F).contains(&code)
        || (0x3000..=0x303F).contains(&code)
        || (0xFE00..=0xFE0F).contains(&code)
        || (0xFF01..=0xFF20).contains(&code)
        || (0xFF3B..=0xFF40).contains(&code)
        || (0xFF5B..=0xFF65).contains(&code)
        || (code == 0xFEFF)
        || (0x1F000..=0x1F0FF).contains(&code)
        || (0x1F1E6..=0x1F1FF).contains(&code)
        || (0x1F300..=0x1FAFF).contains(&code)
}
pub fn direction_of_code(code: u32) -> &'static str {
    if code == 0x200f || code == 0x061c {
        RTL
    } else if code == 0x200e {
        LTR
    } else if neutral(code) {
        ""
    } else if [
        (0x0590, 0x05FF),
        (0x0600, 0x07BF),
        (0x07C0, 0x085F),
        (0x0860, 0x08FF),
        (0xFB1D, 0xFB4F),
        (0xFB50, 0xFDFF),
        (0xFE70, 0xFEFC),
        (0x10800, 0x10CFF),
        (0x10D00, 0x10FFF),
        (0x1E800, 0x1EFFF),
    ]
    .iter()
    .any(|(a, b)| (*a..=*b).contains(&code))
    {
        RTL
    } else {
        LTR
    }
}
pub fn strong_direction(text: &str) -> &'static str {
    let mut depth = 0usize;
    for ch in text.chars() {
        let code = ch as u32;
        match code {
            0x2066..=0x2068 => {
                depth += 1;
                continue;
            }
            0x2069 => {
                depth = depth.saturating_sub(1);
                continue;
            }
            _ => (),
        }
        if depth > 0 {
            continue;
        }
        match code {
            0x202b | 0x202e => return RTL,
            0x202a | 0x202d => return LTR,
            _ => (),
        }
        let answer = direction_of_code(code);
        if !answer.is_empty() {
            return answer;
        }
    }
    ""
}
fn js_regex(pattern: &str) -> Regex {
    Regex::new(&pattern.replace(r"\s", r"[\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]")).unwrap()
}
static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"(?i)^[\s\x{200E}\x{200F}]*(?:(?:re|aw|sv|vs|vl|antw|antwort|fw|fwd|wg|tr|rv|rif|res|enc|encaminhado|doorst|odp|ynt|ilt|回复|回覆|转发|轉發)\s*(?:[\[\(]\s*[0-9]+\s*[\]\)])?\s*:|\[[^\]]{0,64}\]|\((?:fwd|fw)\))[\s\x{200E}\x{200F}]*",
    )
});
pub fn without_reply_prefixes(mut text: &str) -> &str {
    for _ in 0..12 {
        let Some(m) = PREFIX.find(text) else { break };
        let visible = text.trim_start_matches(|c: char| {
            c.is_whitespace() || matches!(c, '\u{feff}' | '\u{200e}' | '\u{200f}')
        });
        if visible.starts_with('[')
            && visible
                .split_once(']')
                .is_some_and(|(tag, _)| tag[1..].encode_utf16().count() > 64)
        {
            break;
        }
        text = &text[m.end()..];
    }
    text
}
pub fn resolve(text: &str, mode: &str) -> &'static str {
    let forced = forced(mode);
    if !forced.is_empty() {
        forced
    } else {
        strong_direction(text)
    }
}
pub fn resolve_subject(text: &str, mode: &str) -> &'static str {
    resolve(without_reply_prefixes(text), mode)
}
static IMAGES: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^(?:\s*\[image(?:\s+[0-9]+)?\])+"));
pub fn without_image_markers(text: &str) -> &str {
    IMAGES.find(text).map(|m| &text[m.end()..]).unwrap_or(text)
}
pub fn resolve_body(text: &str, mode: &str) -> &'static str {
    resolve(without_image_markers(text), mode)
}
pub fn attribute_for(direction: &str) -> &'static str {
    match direction {
        LTR => " dir=\"ltr\"",
        RTL => " dir=\"rtl\"",
        _ => "",
    }
}
pub fn start_edge(direction: &str) -> &'static str {
    if direction == RTL { "right" } else { "left" }
}
pub fn end_edge(direction: &str) -> &'static str {
    if direction == RTL { "left" } else { "right" }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    #[test]
    fn existing_direction_suite_is_a_live_golden_oracle() {
        let script = r#"const loader=require('./ui/tests/load');const load=loader.load;const rows=[];loader.load=function(p){const m=load(p);if(p==='message/Direction.js')for(const name of ['attributeFor','endEdge','forced','hasAnswer','isRightToLeft','normalizeMode','resolve','resolveBody','resolveSubject','startEdge','strongDirectionOf','subjectDirectionOf']){const f=m[name];m[name]=function(...args){const result=f(...args);rows.push({name,args,result});return result;};}return m;};console.log=()=>{};require('./ui/tests/test_direction');process.stdout.write(JSON.stringify(rows));"#;
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
            let first = row["args"][0].as_str().unwrap_or("");
            let second = row["args"][1].as_str().unwrap_or("");
            let value = match row["name"].as_str().unwrap() {
                "attributeFor" => json!(attribute_for(first)),
                "endEdge" => json!(end_edge(first)),
                "forced" => json!(forced(first)),
                "hasAnswer" => json!(matches!(first, LTR | RTL)),
                "isRightToLeft" => json!(first == RTL),
                "normalizeMode" => json!(normalize_mode(first)),
                "resolve" => json!(resolve(first, second)),
                "resolveBody" => json!(resolve_body(first, second)),
                "resolveSubject" => json!(resolve_subject(first, second)),
                "startEdge" => json!(start_edge(first)),
                "strongDirectionOf" => json!(strong_direction(first)),
                "subjectDirectionOf" => json!(resolve_subject(first, AUTO)),
                _ => unreachable!(),
            };
            assert_eq!(value, row["result"], "{} {first:?}", row["name"]);
        }
    }
    #[test]
    fn agrees_with_live_js_for_multilingual_prefixes_isolates_and_neutral_blocks() {
        let samples = [
            "مرحبا",
            "שלום",
            "سلام دنیا",
            "Re: مرحبا",
            "[team] Fwd: AW[2]: שלום",
            "回复: سلام",
            "Bug: שלום",
            "Re: 2024",
            "١٢٣ hello",
            "۱۲۳ hello",
            "\u{feff}hello",
            "\u{2066}hello\u{2069}سلام",
            "\u{2067}שלום\u{2069}hello",
            "\u{202e}hello",
            "[image 1][image 2] سلام",
            "🎉 שלום",
            "\u{1e900}",
            "",
            "Re: ".repeat(13).leak(),
        ];
        let cases: Vec<_> = samples
            .iter()
            .flat_map(|text| {
                ["Auto", "Left to right", "Right to left", "bad"]
                    .map(|mode| json!({"text":text,"mode":mode}))
            })
            .collect();
        let script = r#"const {load}=require('./ui/tests/load');const d=load('message/Direction.js');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).map(c=>[d.resolve(c.text,c.mode),d.resolveSubject(c.text,c.mode),d.resolveBody(c.text,c.mode),d.withoutReplyPrefixes(c.text)]))));"#;
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
            .write_all(serde_json::to_string(&cases).unwrap().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
        for (n, c) in cases.iter().enumerate() {
            let text = c["text"].as_str().unwrap();
            let mode = c["mode"].as_str().unwrap();
            assert_eq!(
                json!([
                    resolve(text, mode),
                    resolve_subject(text, mode),
                    resolve_body(text, mode),
                    without_reply_prefixes(text)
                ]),
                expected[n],
                "{text:?} {mode}"
            )
        }
    }
}
