//! Authoritative mail capability and query mappings; labels and icons stay in QML.
use serde_json::{Value, json};
use std::sync::LazyLock;
static QUERIES: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("domain_queries.json")).unwrap());
fn provider(value: &Value) -> &str {
    match value.as_str().unwrap_or("").trim() {
        id if QUERIES.get(id).is_some() => id,
        _ => "gmail",
    }
}
/// Canonical mailbox query shared by native background readers and UI snapshots.
pub fn mailbox_query(id: &str, mailbox: &str) -> Option<&'static str> {
    QUERIES.get(id)?.get(mailbox)?.as_str()
}
fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}
fn imap_search(text: &str) -> String {
    static TERMS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)(from|to|subject):\s*(?:"([^"]*)"|(\S*))|(\S+)"#).unwrap()
    });
    let mut words = Vec::new();
    let mut parts = Vec::new();
    for term in TERMS.captures_iter(text) {
        if let Some(field) = term.get(1) {
            let value = term
                .get(2)
                .or_else(|| term.get(3))
                .map(|v| v.as_str())
                .unwrap_or("")
                .replace('*', "");
            if value.is_empty() {
                words.push(term[0].to_owned());
            } else {
                parts.push(format!(
                    "{} {}",
                    field.as_str().to_uppercase(),
                    quoted(&value)
                ));
            }
        } else if let Some(word) = term.get(4) {
            words.push(word.as_str().into());
        }
    }
    let plain = words.join(" ");
    if !plain.trim().is_empty() {
        parts.push(format!("TEXT {}", quoted(plain.trim())));
    }
    if parts.is_empty() {
        parts.push(format!("TEXT {}", quoted(text)));
    }
    format!("folder:INBOX {}", parts.join(" "))
}
fn search(id: &str, text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    match id {
        "imap" | "outlook" => imap_search(text),
        "hey" => format!("search:{text}"),
        "jmap" => format!("text:{text}"),
        _ => text.into(),
    }
}
fn encode(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            use std::fmt::Write;
            write!(&mut out, "%{b:02X}").unwrap();
        }
    }
    out
}
pub fn snapshot() -> Value {
    let mut out = json!({});
    for p in super::list().as_array().unwrap() {
        let id = p["id"].as_str().unwrap();
        out[id] = json!({"capabilities":p["capabilities"],"queries":QUERIES[id],"nativeSync":true,"inheritedDefault":"in:inbox","addressSearch":matches!(id,"gmail"|"hey"|"imap"),"webHomeUrl":match id {"gmail"=>"https://mail.google.com/mail/u/0/","hey"=>"https://app.hey.com","outlook"=>"https://outlook.live.com/mail/",_=>""}});
    }
    out
}
pub fn resolve(p: &Value) -> Result<Value, &'static str> {
    if !p.is_object() {
        return Err("invalid_params");
    }
    let canonical = p["provider"].as_str().unwrap_or("").trim().to_lowercase();
    let id = provider(&Value::String(canonical)).to_owned();
    let value = p["value"].as_str().unwrap_or("");
    let text = value.trim();
    if ["value", "search", "defaultQuery"].iter().any(|key| {
        p[*key]
            .as_str()
            .is_some_and(|v| v.len() > 32768 || v.chars().any(|c| c.is_control()))
    }) {
        return Err("invalid_params");
    }
    let result = match p["operation"].as_str().unwrap_or("query") {
        "query" => {
            let search_text = p["search"].as_str().unwrap_or("").trim();
            let custom = p["defaultQuery"].as_str().unwrap_or("").trim();
            let mailbox = p["mailbox"].as_str().unwrap_or("inbox");
            if !search_text.is_empty() {
                search(&id, search_text)
            } else if mailbox == "inbox"
                && !custom.is_empty()
                && (id == "gmail" || custom != "in:inbox")
            {
                custom.into()
            } else {
                QUERIES[&id]
                    .get(mailbox)
                    .unwrap_or(&QUERIES[&id]["inbox"])
                    .as_str()
                    .unwrap_or("")
                    .into()
            }
        }
        "labelQuery" => {
            if text.is_empty() {
                String::new()
            } else {
                match id.as_str() {
                    "imap" | "outlook" => format!("folder:{}", quoted(text)),
                    "jmap" => format!("mailbox:{text}"),
                    _ => format!("label:{text}"),
                }
            }
        }
        "addressQuery" => {
            if text.is_empty() {
                String::new()
            } else {
                let to = p["field"] == "to";
                match id.as_str() {
                    "gmail" if !text.chars().any(|c| c.is_whitespace() || c == '"') => {
                        format!("{}:{text}", if to { "to" } else { "from" })
                    }
                    "imap" => format!(
                        "folder:INBOX {} {}",
                        if to { "TO" } else { "FROM" },
                        quoted(text)
                    ),
                    "hey" => format!("search:{text}"),
                    _ => String::new(),
                }
            }
        }
        "webMessageUrl" => match id.as_str() {
            "gmail" => format!("https://mail.google.com/mail/u/0/#all/{}", encode(value)),
            "hey" => {
                let topic = text.split(':').nth(1).unwrap_or("").trim();
                if topic.is_empty() {
                    "https://app.hey.com".into()
                } else {
                    format!("https://app.hey.com/topics/{topic}")
                }
            }
            _ => String::new(),
        },
        "webBoxUrl" => {
            if id == "gmail" {
                format!("https://mail.google.com/mail/u/0/#search/{}", encode(value))
            } else {
                String::new()
            }
        }
        _ => return Err("invalid_params"),
    };
    Ok(json!({"value":result}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_bytes_are_rejected_before_any_query_or_url_is_returned() {
        for id in ["gmail", "outlook", "hey", "jmap", "imap"] {
            for suffix in ["\r", "\n", "\r\n", "\0", "\t", "\u{7f}"] {
                for operation in ["labelQuery", "addressQuery", "webMessageUrl", "webBoxUrl"] {
                    assert_eq!(
                        resolve(
                            &json!({"provider":id,"operation":operation,"value":format!("valid{suffix}")})
                        ),
                        Err("invalid_params")
                    );
                }
                assert_eq!(
                    resolve(&json!({"provider":id,"search":format!("valid{suffix}")})),
                    Err("invalid_params")
                );
                assert_eq!(
                    resolve(&json!({"provider":id,"defaultQuery":format!("valid{suffix}")})),
                    Err("invalid_params")
                );
            }
        }
    }
    #[test]
    fn matches_legacy_provider_query_and_web_fixtures() {
        let cases: Value =
            serde_json::from_str(include_str!("../../tests/provider_domain_parity.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                resolve(&case["params"]).unwrap()["value"],
                case["expected"],
                "{}",
                case["params"]
            );
        }
    }
    #[test]
    fn generated_ui_descriptor_matches_native_authority() {
        let source = include_str!("../../ui/providers/NativeDomain.js");
        let value: Value =
            serde_json::from_str(source.split_once("var FACTS = ").unwrap().1.trim()).unwrap();
        assert_eq!(value, snapshot());
    }
}
