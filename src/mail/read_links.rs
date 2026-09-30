//! Data-only link projection. Never resolve, open or fetch sender destinations.
use serde_json::{Value, json};
use std::collections::HashSet;

fn attribute_value(value: &str) -> String {
    static ENTITIES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);?").unwrap()
    });
    ENTITIES
        .replace_all(value, |capture: &regex::Captures| {
            let entity = capture.get(0).unwrap();
            // In attributes, an unterminated named reference before '=' or an
            // alphanumeric is literal URL data (for example ?a=1&copy=2).
            if !entity.as_str().ends_with(';')
                && !entity.as_str().starts_with("&#")
                && value[entity.end()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c == '=' || c.is_ascii_alphanumeric())
            {
                entity.as_str().to_owned()
            } else {
                crate::message::html::decode_entities(entity.as_str())
            }
        })
        .into_owned()
}

pub(super) fn destination(value: &str) -> Option<&str> {
    if value.len() > 8192
        || value.contains('\\')
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    match url.scheme() {
        "http" | "https"
            if url.username().is_empty()
                && url.password().is_none()
                && crate::message::html::is_public_url(value)
                && crate::message::html::is_public_url(url.as_str()) =>
        {
            Some(value)
        }
        "mailto" if !url.path().is_empty() => Some(value),
        _ => None,
    }
}

pub(super) fn link(node: &Value, children: &[Value]) -> Option<Value> {
    let attrs = node["attrs"].as_array()?;
    let href = attrs.iter().find(|attr| attr["name"] == "href")?["value"].as_str()?;
    // Document attributes retain HTML entities for serialization. Decode once
    // before checking and exporting the exact destination a caller will use.
    let href = attribute_value(href);
    let href = destination(&href)?;
    fn text(node: &Value, out: &mut String) {
        // Malformed nested anchors have their own entry. Do not duplicate
        // their labels at every ancestor and amplify a bounded document.
        if node["name"] == "a" {
            return;
        }
        if node["type"] == "text" {
            out.push_str(node["text"].as_str().unwrap_or(""));
        } else if let Some(children) = node["children"].as_array() {
            for child in children {
                text(child, out);
            }
        }
    }
    let mut label = String::new();
    for child in children {
        text(child, &mut label);
    }
    Some(json!({"text":crate::message::html::decode_entities(&label),"url":href}))
}

pub(super) fn unsubscribe(headers: &Value) -> Value {
    let mut urls = Vec::new();
    let mut seen = HashSet::new();
    let mut one_click = false;
    if let Some(headers) = headers.as_array() {
        for header in headers {
            let name = header["name"].as_str().unwrap_or("");
            let value = header["value"].as_str().unwrap_or("");
            if name.eq_ignore_ascii_case("list-unsubscribe") {
                // RFC 2369 destinations are angle-bracket delimited. Do not
                // infer URLs from comments or reinterpret HTML entities here.
                for part in value.split('<').skip(1) {
                    if let Some((url, _)) = part.split_once('>')
                        && let Some(url) = destination(url)
                        && seen.insert(url)
                    {
                        urls.push(url.to_owned());
                    }
                }
            } else if name.eq_ignore_ascii_case("list-unsubscribe-post") {
                one_click |= value
                    .trim()
                    .eq_ignore_ascii_case("List-Unsubscribe=One-Click");
            }
        }
    }
    // This reports the sender's declaration, not authentication or permission
    // to POST. RFC 8058 applies only to HTTPS destinations.
    let one_click = one_click
        && urls
            .iter()
            .any(|url| url.to_ascii_lowercase().starts_with("https:"));
    json!({"urls":urls,"oneClick":one_click})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destinations_are_data_only_and_reject_unsafe_schemes_hosts_and_controls() {
        for url in [
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///etc/passwd",
            "/relative",
            "//example.org/path",
            "https:example.org/path",
            "https:////example.org/path",
            "https://localhost/path",
            "http://127.0.0.1/path",
            "http://2130706433/path",
            "http://[::1]/path",
            "https://private.local/path",
            "https://user:secret@example.org/path",
            "https://example.org/\r\ninjected",
            "https://example.org/\n",
            "https://example.org/\0",
            "https://example.org/\\evil",
            "mailto:",
        ] {
            assert_eq!(destination(url), None, "{url:?}");
        }
        for url in [
            "https://example.org/工?a=1&b=%22quoted%22",
            "mailto:leave@example.org?subject=unsubscribe",
        ] {
            assert_eq!(destination(url), Some(url));
        }
    }

    #[test]
    fn nested_anchor_labels_are_not_amplified() {
        let node = json!({"attrs":[{"name":"href","value":"https://example.org/"}]});
        let children = vec![
            json!({"type":"text","text":"outer"}),
            json!({"type":"element","name":"a","children":[{"type":"text","text":"inner"}]}),
        ];
        assert_eq!(link(&node, &children).unwrap()["text"], "outer");
    }

    #[test]
    fn html_entities_are_decoded_once_before_destination_validation() {
        assert_eq!(
            attribute_value("https://example.org/?a=1&copy=2&reg123=3"),
            "https://example.org/?a=1&copy=2&reg123=3"
        );
        let children = vec![json!({"type":"text","text":"Leave &amp; goodbye"})];
        let node = |href: &str| json!({"attrs":[{"name":"href","value":href}]});
        assert_eq!(
            link(&node("https://example.org/?a=1&amp;b=&amp;amp;"), &children),
            Some(json!({"text":"Leave & goodbye","url":"https://example.org/?a=1&b=&amp;"}))
        );
        for href in [
            "javascript&#58;bad",
            "https://example.org/&#10;",
            "http://127&#46;0.0.1/",
            "file&#58;///etc/passwd",
        ] {
            assert_eq!(link(&node(href), &children), None, "{href}");
        }
        // Headers are not HTML: an ampersand/entity spelling is URL data.
        assert_eq!(
            unsubscribe(
                &json!([{"name":"List-Unsubscribe","value":"<https://example.org/?a=1&amp;b=2>"}])
            )["urls"],
            json!(["https://example.org/?a=1&amp;b=2"])
        );
    }

    #[test]
    fn unsubscribe_is_allowlisted_deduplicated_and_requires_https_for_one_click() {
        let headers = json!([
            {"name":"List-Unsubscribe","value":"comment https://ignored.example.org <javascript:bad>, <http://127.0.0.1/>, <mailto:leave@example.org>, <mailto:leave@example.org>"},
            {"name":"List-Unsubscribe-Post","value":"List-Unsubscribe=One-Click"}
        ]);
        assert_eq!(
            unsubscribe(&headers),
            json!({"urls":["mailto:leave@example.org"],"oneClick":false})
        );
        assert_eq!(
            unsubscribe(&Value::Null),
            json!({"urls":[],"oneClick":false})
        );
    }
}
