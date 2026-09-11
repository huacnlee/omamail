use serde::{Deserialize, Serialize};

pub const MAX_INPUT: usize = 16 * 1024 * 1024;
pub const MAX_NODES: usize = 100_000;
pub const MAX_DEPTH: usize = 128;
pub const MAX_OUTPUT: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Attr {
    pub name: String,
    pub value: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Node {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default)]
    pub attrs: Vec<Attr>,
    #[serde(default)]
    pub children: Vec<Node>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(default, rename = "selfClosing")]
    pub self_closing: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub raw: bool,
}
impl Serialize for Node {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut output = serializer.serialize_map(None)?;
        output.serialize_entry("type", &self.kind)?;
        if self.kind == "text" {
            output.serialize_entry("text", &self.text)?;
            if self.raw {
                output.serialize_entry("raw", &true)?;
            }
        } else {
            if self.kind != "root" {
                output.serialize_entry("name", &self.name)?;
                output.serialize_entry("attrs", &self.attrs)?;
                output.serialize_entry("selfClosing", &self.self_closing)?;
            }
            output.serialize_entry("children", &self.children)?;
        }
        output.end()
    }
}
impl Node {
    pub fn element(name: &str) -> Self {
        Self {
            kind: "element".into(),
            name: name.into(),
            attrs: vec![],
            children: vec![],
            text: String::new(),
            self_closing: false,
            raw: false,
        }
    }
    pub fn root() -> Self {
        let mut n = Self::element("");
        n.kind = "root".into();
        n
    }
    pub fn text(text: &str) -> Self {
        let mut n = Self::element("");
        n.kind = "text".into();
        n.text = text.into();
        n
    }
    pub fn attr(&self, name: &str) -> &str {
        self.attrs
            .iter()
            .find(|a| a.name == name)
            .and_then(|a| a.value.as_deref())
            .unwrap_or("")
    }
    pub fn has(&self, name: &str) -> bool {
        self.attrs.iter().any(|a| a.name == name)
    }
    pub fn remove(&mut self, name: &str) {
        self.attrs.retain(|a| a.name != name)
    }
    pub fn set(&mut self, name: &str, value: &str) {
        if let Some(a) = self.attrs.iter_mut().find(|a| a.name == name) {
            a.value = Some(value.into())
        } else {
            self.attrs.push(Attr {
                name: name.into(),
                value: Some(value.into()),
            })
        }
    }
}
pub fn void(name: &str) -> bool {
    matches!(
        name,
        "img"
            | "br"
            | "hr"
            | "input"
            | "meta"
            | "link"
            | "area"
            | "base"
            | "col"
            | "embed"
            | "source"
            | "track"
            | "wbr"
            | "param"
            | "keygen"
    )
}
fn space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 12)
}
fn name(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b':' | b'-' | b'_' | b'.')
}
fn tag(s: &str, start: usize) -> Option<(Node, bool, usize, bool)> {
    let b = s.as_bytes();
    let mut i = start + 1;
    let closing = b.get(i) == Some(&b'/');
    if closing {
        i += 1
    }
    if !b.get(i).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    let begin = i;
    while i < b.len() && name(b[i]) {
        i += 1
    }
    let mut n = Node::element(&s[begin..i].to_ascii_lowercase());
    while i < b.len() {
        while i < b.len() && space(b[i]) {
            i += 1
        }
        if i == b.len() {
            break;
        }
        if b[i] == b'>' {
            return Some((n, closing, i + 1, true));
        }
        if b[i] == b'/' {
            n.self_closing = b.get(i + 1) == Some(&b'>');
            i += 1;
            continue;
        }
        let begin = i;
        while i < b.len() && !space(b[i]) && !matches!(b[i], b'=' | b'>' | b'/') {
            i += 1
        }
        if i == begin {
            i += 1;
            continue;
        }
        let key = s[begin..i].to_ascii_lowercase();
        while i < b.len() && space(b[i]) {
            i += 1
        }
        let mut value = None;
        if b.get(i) == Some(&b'=') {
            i += 1;
            while i < b.len() && space(b[i]) {
                i += 1
            }
            if b.get(i).is_some_and(|c| matches!(c, b'\'' | b'"')) {
                let quote = b[i];
                i += 1;
                let begin = i;
                while i < b.len() && b[i] != quote {
                    i += 1
                }
                value = Some(s[begin..i].into());
                if i < b.len() {
                    i += 1
                }
            } else {
                let begin = i;
                while i < b.len() && !space(b[i]) && b[i] != b'>' {
                    i += 1
                }
                value = Some(s[begin..i].into())
            }
        }
        n.attrs.push(Attr { name: key, value });
        if n.attrs.len() > 1024 {
            return Some((n, closing, b.len(), false));
        }
    }
    Some((n, closing, b.len(), false))
}
fn implied(new: &str, old: &str) -> bool {
    match new {
        "li" => old == "li",
        "p" => old == "p",
        "dt" | "dd" => matches!(old, "dt" | "dd"),
        "tr" => matches!(old, "tr" | "td" | "th"),
        "td" | "th" => matches!(old, "td" | "th"),
        "thead" | "tbody" | "tfoot" => matches!(old, "thead" | "tbody" | "tfoot"),
        "option" => old == "option",
        _ => false,
    }
}
fn finish(stack: &mut Vec<Node>) {
    let n = stack.pop().unwrap();
    stack.last_mut().unwrap().children.push(n)
}
pub fn parse(s: &str) -> Result<Node, &'static str> {
    if s.len() > MAX_INPUT {
        return Err("html_too_large");
    }
    let mut stack = vec![Node::root()];
    let mut at = 0;
    let mut count = 0;
    while at < s.len() {
        count += 1;
        if count > MAX_NODES {
            return Err("html_too_complex");
        }
        let Some(offset) = s[at..].find('<') else {
            stack
                .last_mut()
                .unwrap()
                .children
                .push(Node::text(&s[at..]));
            break;
        };
        let open = at + offset;
        if open > at {
            stack
                .last_mut()
                .unwrap()
                .children
                .push(Node::text(&s[at..open]))
        }
        if s[open..].starts_with("<!--") {
            at = s[open + 4..]
                .find("-->")
                .map_or(s.len(), |v| open + 4 + v + 3);
            continue;
        }
        if s[open..].starts_with("<!") || s[open..].starts_with("<?") {
            at = s[open..].find('>').map_or(s.len(), |v| open + v + 1);
            continue;
        }
        let Some((mut n, closing, end, terminated)) = tag(s, open) else {
            stack.last_mut().unwrap().children.push(Node::text("<"));
            at = open + 1;
            continue;
        };
        at = end;
        if n.attrs.len() > 1024 {
            return Err("html_too_complex");
        }
        if !terminated {
            break;
        }
        if closing {
            if let Some(i) = stack.iter().rposition(|v| v.name == n.name) {
                while stack.len() > i && stack.len() > 1 {
                    finish(&mut stack)
                }
            }
            continue;
        }
        while stack.len() > 1 && implied(&n.name, &stack.last().unwrap().name) {
            finish(&mut stack)
        }
        if matches!(n.name.as_str(), "script" | "style" | "textarea" | "title") && !n.self_closing {
            let needle = format!("</{}", n.name);
            let mut search = at;
            let mut found = None;
            while let Some(off) = s[search..].find('<') {
                let pos = search + off;
                let end = pos + needle.len();
                if s.as_bytes()
                    .get(pos..end)
                    .is_some_and(|v| v.eq_ignore_ascii_case(needle.as_bytes()))
                    && s.as_bytes()
                        .get(end)
                        .is_some_and(|v| space(*v) || matches!(v, b'/' | b'>'))
                {
                    found = Some(pos);
                    break;
                }
                search = pos + 1
            }
            let stop = found.unwrap_or(s.len());
            let mut raw = Node::text(&s[at..stop]);
            raw.raw = true;
            n.children.push(raw);
            at = found
                .and_then(|pos| tag(s, pos).map(|v| v.2))
                .unwrap_or(s.len());
            stack.last_mut().unwrap().children.push(n);
            continue;
        }
        if void(&n.name) || n.self_closing || stack.len() >= MAX_DEPTH {
            stack.last_mut().unwrap().children.push(n)
        } else {
            stack.push(n)
        }
    }
    while stack.len() > 1 {
        finish(&mut stack)
    }
    Ok(stack.pop().unwrap())
}
pub fn escape_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
pub fn serialize(n: &Node) -> Result<String, &'static str> {
    let mut out = String::new();
    write(n, &mut out)?;
    Ok(out)
}
fn write(n: &Node, out: &mut String) -> Result<(), &'static str> {
    if n.kind == "text" {
        out.push_str(&n.text.replace('<', "&lt;").replace('>', "&gt;"))
    } else {
        if n.kind != "root" {
            out.push('<');
            out.push_str(&n.name);
            for a in &n.attrs {
                out.push(' ');
                out.push_str(&a.name);
                if let Some(v) = &a.value {
                    out.push_str("=\"");
                    out.push_str(&v.replace('"', "&quot;"));
                    out.push('"')
                }
            }
            if void(&n.name) || n.self_closing {
                out.push_str(if n.self_closing { "/>" } else { ">" });
                return if out.len() > MAX_OUTPUT {
                    Err("html_output_too_large")
                } else {
                    Ok(())
                };
            }
            out.push('>')
        }
        for c in &n.children {
            write(c, out)?
        }
        if n.kind != "root" {
            out.push_str("</");
            out.push_str(&n.name);
            out.push('>')
        }
    }
    if out.len() > MAX_OUTPUT {
        Err("html_output_too_large")
    } else {
        Ok(())
    }
}
