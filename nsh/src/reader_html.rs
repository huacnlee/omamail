//! The reader document the backend sends (`nativeRender.reader.document`,
//! a `message::html::tree::Node` tree) back to HTML for `TextView`.
//!
//! `reader.render` leaves the serialized HTML out on purpose: the tree
//! already crossed the pipe. This writes it the way
//! `src/message/html/tree.rs` `serialize` does, so the text is the one
//! the backend sanitized; nothing here adds markup.

use serde_json::Value;

/// Elements with no closing tag.
const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];
/// The same bound as the backend's `MAX_DEPTH`.
const MAX_DEPTH: usize = 128;

/// The HTML of `document`, or `None` when it is not a document tree.
pub fn to_html(document: &Value) -> Option<String> {
    if document["type"] != "root" && document["type"] != "element" {
        return None;
    }
    let mut out = String::new();
    write(document, &mut out, 0);
    Some(out)
}

fn write(node: &Value, out: &mut String, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    match node["type"].as_str() {
        Some("text") => {
            let text = node["text"].as_str().unwrap_or_default();
            out.push_str(&text.replace('<', "&lt;").replace('>', "&gt;"));
        }
        Some(kind @ ("root" | "element")) => {
            let element = kind == "element";
            let name = node["name"].as_str().unwrap_or_default();
            if element {
                if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    return;
                }
                out.push('<');
                out.push_str(name);
                for attr in node["attrs"].as_array().into_iter().flatten() {
                    let Some(key) = attr["name"].as_str() else {
                        continue;
                    };
                    if key.is_empty()
                        || !key
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b':')
                    {
                        continue;
                    }
                    out.push(' ');
                    out.push_str(key);
                    if let Some(value) = attr["value"].as_str() {
                        out.push_str("=\"");
                        out.push_str(&value.replace('"', "&quot;"));
                        out.push('"');
                    }
                }
                let self_closing = node["selfClosing"] == true;
                if VOID.contains(&name) || self_closing {
                    out.push_str(if self_closing { "/>" } else { ">" });
                    return;
                }
                out.push('>');
            }
            for child in node["children"].as_array().into_iter().flatten() {
                write(child, out, depth + 1);
            }
            if element {
                out.push_str("</");
                out.push_str(name);
                out.push('>');
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::to_html;

    #[test]
    fn writes_the_tree_as_the_backend_does() {
        let document = json!({"type": "root", "children": [
            {"type": "element", "name": "p", "attrs": [], "selfClosing": false, "children": [
                {"type": "text", "text": "a < b"},
                {"type": "element", "name": "br", "attrs": [], "selfClosing": false, "children": []},
                {"type": "element", "name": "a", "attrs": [{"name": "href", "value": "https://x.test/?q=\"1\""}],
                 "selfClosing": false, "children": [{"type": "text", "text": "link"}]}
            ]}
        ]});
        assert_eq!(
            to_html(&document).unwrap(),
            "<p>a &lt; b<br><a href=\"https://x.test/?q=&quot;1&quot;\">link</a></p>"
        );
    }

    #[test]
    fn refuses_what_is_not_a_tree_and_odd_names() {
        assert_eq!(to_html(&json!("<p>x</p>")), None);
        let document = json!({"type": "root", "children": [
            {"type": "element", "name": "p onclick", "attrs": [], "children": [{"type": "text", "text": "x"}]},
            {"type": "element", "name": "em", "attrs": [{"name": "x\" y", "value": "1"}], "children": []}
        ]});
        assert_eq!(to_html(&document).unwrap(), "<em></em>");
    }
}
