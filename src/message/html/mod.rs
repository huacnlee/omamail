//! Bounded native HTML preparation. Qt receives only the sanitized tree;
//! sender-controlled network resources are replaced with approved raster bytes.
macro_rules! re {
    ($pattern:literal) => {{
        static VALUE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        #[allow(clippy::regex_creation_in_loops)] // OnceLock compiles once, outside repeated work.
        let pattern = VALUE
            .get_or_init(|| regex::Regex::new($pattern).expect("constant HTML policy pattern"));
        pattern
    }};
}
mod formatting;
mod policy;
mod reader;
#[cfg(test)]
mod tests;
mod tree;
pub use policy::is_public_url;
use policy::*;
use serde_json::{Value, json};
use std::collections::HashSet;
pub use tree::{Attr, Node, parse, serialize};

pub fn dropped(name: &str) -> bool {
    matches!(
        name,
        "script"
            | "style"
            | "iframe"
            | "object"
            | "embed"
            | "applet"
            | "noscript"
            | "meta"
            | "link"
            | "base"
            | "title"
            | "textarea"
    )
}
pub fn block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "tr"
            | "li"
            | "blockquote"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "table"
            | "ul"
            | "ol"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
    )
}
pub fn table_part(name: &str) -> bool {
    matches!(
        name,
        "table" | "thead" | "tbody" | "tfoot" | "tr" | "td" | "th"
    )
}
pub fn rows<'a>(n: &'a Node, out: &mut Vec<&'a Node>) {
    for c in &n.children {
        if c.kind == "text" || c.name == "table" {
            continue;
        }
        if c.name == "tr" {
            out.push(c)
        }
        rows(c, out)
    }
}
pub fn grid(n: &Node) -> bool {
    let mut r = vec![];
    rows(n, &mut r);
    r.iter()
        .filter(|r| {
            r.children
                .iter()
                .filter(|c| matches!(c.name.as_str(), "td" | "th"))
                .count()
                >= 2
        })
        .count()
        >= 2
}
fn as_block(n: &mut Node) {
    let style = n.attr("style").to_owned();
    n.name = "div".into();
    n.attrs.clear();
    if !style.is_empty() {
        n.set("style", &style)
    }
}
fn flatten_parts(n: &mut Node) {
    for c in &mut n.children {
        if c.kind == "text" || c.name == "table" {
            continue;
        }
        flatten_parts(c);
        if table_part(&c.name) {
            as_block(c)
        }
    }
}
fn flatten_tables(n: &mut Node, limit: usize, depth: usize, layout: bool) {
    for c in &mut n.children {
        if c.kind == "text" {
            continue;
        }
        if c.name != "table" {
            flatten_tables(c, limit, depth, layout);
            continue;
        }
        let keep = depth < limit && (layout || grid(c) || formatting::status_table(c));
        flatten_tables(c, limit, depth + usize::from(keep), layout);
        if !keep {
            flatten_parts(c);
            as_block(c)
        }
    }
}
fn collapse(n: &mut Node) {
    let mut kept = vec![];
    for mut c in std::mem::take(&mut n.children) {
        collapse(&mut c);
        if c.attrs.is_empty() {
            if matches!(c.name.as_str(), "span" | "font" | "small" | "big") {
                kept.extend(c.children);
                continue;
            }
            if matches!(
                c.name.as_str(),
                "div" | "section" | "article" | "aside" | "header" | "footer" | "main" | "nav"
            ) {
                let meaningful: Vec<_> = c
                    .children
                    .iter()
                    .enumerate()
                    .filter(|(_, v)| v.kind != "text" || !v.text.trim().is_empty())
                    .collect();
                if meaningful.len() == 1 && block(&meaningful[0].1.name) {
                    let index = meaningful[0].0;
                    kept.push(c.children.remove(index));
                    continue;
                }
            }
        }
        kept.push(c)
    }
    n.children = kept
}
fn colour_attr(n: &str) -> bool {
    matches!(n, "bgcolor" | "bordercolor" | "color")
}
fn colour_style(n: &str) -> bool {
    matches!(
        n,
        "color" | "background" | "background-color" | "border-color" | "outline-color"
    )
}
fn resource(n: &str) -> bool {
    matches!(
        n,
        "background"
            | "srcset"
            | "lowsrc"
            | "dynsrc"
            | "poster"
            | "data"
            | "codebase"
            | "usemap"
            | "ping"
            | "formaction"
            | "longdesc"
            | "profile"
            | "manifest"
            | "archive"
            | "cite"
    )
}
fn clean_attrs(n: &mut Node, colors: bool, styles: Vec<(String, String)>, alignment: bool) {
    let centre = !alignment && !matches!(n.name.as_str(), "td" | "th");
    let mut seen = HashSet::new();
    let is_img = n.name == "img";
    let is_link = n.name == "a";
    n.attrs.retain(|a| {
        re!(r"^[a-z_:][a-z0-9_.:-]*$").is_match(&a.name)
            && !resource(&a.name)
            && !(a.name.ends_with(":href") || (a.name == "href" && !is_link))
            && !(a.name == "src" && !is_img)
            && !(colour_attr(&a.name) && !colors)
            && !re!(r"^on[a-z]+$").is_match(&a.name)
            && !(a.name == "href" && !safe_href(a.value.as_deref().unwrap_or("")))
            && !(centre
                && a.name == "align"
                && re!(r"(?i)^center\b").is_match(a.value.as_deref().unwrap_or("")))
            && seen.insert(a.name.clone())
    });
    if n.has("style") {
        let kept = styles
            .into_iter()
            .filter(|(k, v)| {
                !(!colors && colour_style(k))
                    && !(centre && k == "text-align" && re!(r"(?i)^center\b").is_match(v))
                    && !v.to_ascii_lowercase().contains("url")
                    && !v.contains('\\')
            })
            .collect::<Vec<_>>();
        set_style(n, &kept)
    }
}
fn bounded_option(options: &Value, key: &str, default: usize, cap: usize) -> usize {
    let Some(value) = options.get(key) else {
        return default;
    };
    let numeric = match value {
        Value::Null => 0.0,
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::String(value) => value.trim().parse().unwrap_or(0.0),
        value => value.as_f64().unwrap_or(0.0),
    };
    numeric.floor().max(0.0).min(cap as f64) as usize
}
pub(super) struct Images<'a> {
    options: &'a Value,
    pub kept: usize,
    pub blocked: usize,
    loadable: usize,
    sources: Vec<String>,
    pub limit: usize,
}
impl<'a> Images<'a> {
    pub fn new(options: &'a Value) -> Self {
        Self {
            options,
            kept: 0,
            blocked: 0,
            loadable: 0,
            sources: vec![],
            limit: bounded_option(options, "maxImages", 24, 256),
        }
    }
    pub fn prepared(&self, source: &str) -> String {
        self.options
            .get("remoteImageData")
            .and_then(|m| m.get(source))
            .and_then(Value::as_str)
            .filter(|s| raster(s))
            .unwrap_or("")
            .into()
    }
    pub fn allowed(&self) -> bool {
        self.options.get("allowRemoteImages") == Some(&Value::Bool(true))
    }
    fn keep(&mut self, n: &mut Node) -> bool {
        if !n.has("src") {
            return true;
        }
        let source = n.attr("src").to_owned();
        match image_kind(&source) {
            "inline" | "none" => true,
            "remote" => {
                if tracking(n) {
                    self.blocked += 1;
                    return false;
                }
                if self.loadable < self.limit {
                    self.loadable += 1
                }
                let prepared = self.prepared(&source);
                if !self.allowed() || self.kept >= self.limit || prepared.is_empty() {
                    self.blocked += 1;
                    return false;
                }
                n.set("src", &prepared);
                self.kept += 1;
                true
            }
            _ => false,
        }
    }
}
fn clean(n: &mut Node, images: &mut Images<'_>, colors: bool, formatting: bool) {
    let mut kept = vec![];
    for mut c in std::mem::take(&mut n.children) {
        if c.kind == "text" {
            kept.push(c);
            continue;
        }
        if dropped(&c.name) {
            continue;
        }
        if c.name == "center" && !formatting {
            c.name = "div".into()
        }
        let styles = declarations(c.attr("style"));
        if !tree::void(&c.name) && hidden(&styles) {
            continue;
        }
        if c.name == "img" && images.sources.len() < images.limit {
            let source = c.attr("src");
            if image_kind(source) == "remote"
                && !tracking(&c)
                && !images.sources.iter().any(|s| s == source)
            {
                images.sources.push(source.into())
            }
        }
        for (key, value) in &styles {
            if c.name == "img"
                && matches!(key.as_str(), "width" | "height")
                && !c.has(key)
                && let Some(caps) = re!(r"(?i)^(\d+(?:\.\d+)?)px$").captures(value)
            {
                c.set(key, &caps[1])
            }
            if key == "direction"
                && !c.has("dir")
                && matches!(value.trim().to_ascii_lowercase().as_str(), "ltr" | "rtl")
            {
                c.set("dir", &value.trim().to_ascii_lowercase())
            }
        }
        clean_attrs(&mut c, colors, styles, formatting);
        if c.name == "img" && !images.keep(&mut c) {
            continue;
        }
        clean(&mut c, images, colors, formatting);
        if c.children.iter().any(|c| c.name == "img") {
            let styles = declarations(c.attr("style"))
                .into_iter()
                .filter(|(n, v)| {
                    !matches!(n.as_str(), "line-height" | "font-size")
                        || !re!(r"(?i)^0(?:\.0+)?(?:px|pt|%|em|rem)?$").is_match(v)
                })
                .collect::<Vec<_>>();
            set_style(&mut c, &styles)
        }
        if formatting {
            formatting::align_image_cell(&mut c);
        }
        kept.push(c)
    }
    n.children = kept
}
pub fn measure(n: &Node, html: &str) -> Value {
    fn walk(
        n: &Node,
        depth: usize,
        tags: &mut usize,
        images: &mut usize,
        tables: &mut usize,
    ) -> usize {
        let mut deepest = depth;
        for c in &n.children {
            if c.kind == "text" {
                continue;
            }
            *tags += 1;
            if c.name == "img" {
                *images += 1
            }
            let d = depth + usize::from(c.name == "table");
            if c.name == "table" {
                *tables += 1
            }
            deepest = deepest.max(walk(c, d, tags, images, tables))
        }
        deepest
    }
    let (mut tags, mut images, mut tables) = (0, 0, 0);
    let depth = walk(n, 0, &mut tags, &mut images, &mut tables);
    json!({"length":html.encode_utf16().count(),"tags":tags,"images":images,"tables":tables,"tableDepth":depth})
}
pub fn too_heavy(size: &Value) -> bool {
    size["length"].as_u64().unwrap_or(0) > 120000
        || size["tags"].as_u64().unwrap_or(0) > 2500
        || size["tables"].as_u64().unwrap_or(0) > 60
        || size["tableDepth"].as_u64().unwrap_or(0) > 4
}
pub fn read_plain(n: &Node) -> Value {
    fn walk(n: &Node, text: &mut String, images: &mut Vec<String>) {
        for c in &n.children {
            if c.kind == "text" {
                if !c.raw {
                    text.push_str(&decode(&source_space(&c.text)))
                }
                continue;
            }
            if dropped(&c.name) {
                continue;
            }
            if c.name == "img" {
                if tracking(c) {
                    continue;
                }
                images.push(c.attr("src").into());
                text.push_str(&format!("[image {}]", images.len()));
                continue;
            }
            if c.name == "br" {
                text.push('\n');
                continue;
            }
            if c.name == "li" {
                text.push_str("• ")
            }
            walk(c, text, images);
            if block(&c.name) || matches!(c.name.as_str(), "td" | "th") {
                text.push('\n')
            }
        }
    }
    let mut text = String::new();
    let mut images = vec![];
    walk(n, &mut text, &mut images);
    let text = re!(r"[^\S\n]+\n").replace_all(&text, "\n");
    let text = re!(r"\n[^\S\n]+").replace_all(&text, "\n");
    let text = re!(r"\n{3,}").replace_all(&text, "\n\n");
    json!({"text":text.trim(),"images":images,"bodyDirection":crate::message::direction::resolve_body(text.trim(),crate::message::direction::AUTO)})
}
pub fn to_text(s: &str) -> Result<String, &'static str> {
    Ok(read_plain(&parse(s)?)["text"].as_str().unwrap_or("").into())
}
pub fn sanitize(source: &str, options: &Value) -> Result<Value, &'static str> {
    let mut root = parse(source)?;
    let plain = if options["withPlainText"] == true {
        read_plain(&root)
    } else {
        Value::Null
    };
    let reader = if options["withReader"] == true {
        reader::render(&root, options)?
    } else {
        Value::Null
    };
    let mut images = Images::new(options);
    let formatting = options["preserveFormatting"] == true;
    clean(
        &mut root,
        &mut images,
        formatting || options["keepColors"] == true,
        formatting,
    );
    if formatting {
        flatten_tables(&mut root, 4, 0, true);
    } else if options["keepTables"] != true {
        flatten_tables(
            &mut root,
            bounded_option(options, "keepTableDepth", 2, 128),
            0,
            false,
        )
    }
    collapse(&mut root);
    let html = serialize(&root)?;
    let size = measure(&root, &html);
    let heavy = too_heavy(&size);
    Ok(
        json!({"html":html,"blockedImages":images.blocked,"images":images.kept,"remoteImages":images.loadable,"remoteImageSources":images.sources,"complexity":size,"tooHeavy":heavy,"plainText":plain,"reader":reader,"document":root}),
    )
}
pub fn request(params: &Value) -> Result<Value, &'static str> {
    let source = params["html"].as_str().ok_or("invalid_params")?;
    sanitize(source, params.get("options").unwrap_or(&Value::Null))
}
