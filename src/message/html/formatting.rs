//! Layout repairs over sanitized nodes only. Resource policy stays in clean().
use super::*;

pub(super) fn icon_width(n: &Node) -> f64 {
    if n.name == "img" {
        let w = n.attr("width").parse::<f64>().unwrap_or(0.0);
        let h = n.attr("height").parse::<f64>().unwrap_or(0.0);
        return if w > 2.0 && w <= 96.0 && h > 2.0 && h <= 96.0 {
            w
        } else {
            0.0
        };
    }
    n.children
        .iter()
        .map(icon_width)
        .find(|w| *w > 0.0)
        .unwrap_or(0.0)
}

fn status_content(n: &Node, text: &mut String, count: &mut usize, width: &mut f64) -> bool {
    for c in &n.children {
        if c.kind == "text" {
            text.push_str(&c.text);
        } else if c.name == "img" {
            let w = icon_width(c);
            if w == 0.0 {
                return false;
            }
            *count += 1;
            *width += w;
        } else if !matches!(
            c.name.as_str(),
            "div" | "span" | "p" | "b" | "strong" | "em" | "i" | "a" | "br"
        ) || !status_content(c, text, count, width)
        {
            return false;
        }
    }
    true
}

pub(super) fn status_table(n: &Node) -> bool {
    let mut source = vec![];
    rows(n, &mut source);
    if source.len() != 1 {
        return false;
    }
    let cells: Vec<_> = source[0]
        .children
        .iter()
        .filter(|c| c.kind != "text")
        .collect();
    if !(2..=8).contains(&cells.len()) {
        return false;
    }
    let mut total = 0.0;
    for c in cells {
        if !matches!(c.name.as_str(), "td" | "th") {
            return false;
        }
        let (mut text, mut count, mut width) = (String::new(), 0, 0.0);
        if !status_content(c, &mut text, &mut count, &mut width) {
            return false;
        }
        let label = source_space(&decode(&text));
        if !(1..=4).contains(&label.trim_matches(' ').encode_utf16().count()) || count != 1 {
            return false;
        }
        total += width + 4.0;
    }
    total <= 256.0
}

pub(super) fn align_image_cell(n: &mut Node) {
    if !matches!(n.name.as_str(), "td" | "th") || !n.children.iter().any(|c| c.name == "img") {
        return;
    }
    let mut alignment = n.attr("align").to_ascii_lowercase();
    for (key, value) in declarations(n.attr("style")) {
        if key == "text-align" {
            alignment = value.to_ascii_lowercase();
        }
    }
    if !matches!(alignment.as_str(), "left" | "center" | "right" | "justify") {
        return;
    }
    fn flush(out: &mut Vec<Node>, run: &mut Vec<Node>, alignment: &str) {
        if !run.iter().any(|c| c.name == "img") {
            out.append(run);
            return;
        }
        // Qt 6.11 mispaints an image that leads an aligned paragraph. A tiny
        // real spacing glyph establishes the aligned run (zero-width does not).
        if matches!(alignment, "center" | "right") {
            let first = run
                .iter()
                .position(|c| c.kind != "text" || !decode(&c.text).trim().is_empty());
            if let Some(first) = first.filter(|i| run[*i].name == "img") {
                let mut spacer = Node::element("span");
                spacer.set("style", "font-size:1px");
                spacer.children.push(Node::text("\u{a0}"));
                run.insert(first, spacer);
            }
        }
        let mut paragraph = Node::element("div");
        paragraph.set("align", alignment);
        paragraph.children = std::mem::take(run);
        out.push(paragraph);
    }
    let (mut out, mut run) = (vec![], vec![]);
    for c in std::mem::take(&mut n.children) {
        let boundary = block(&c.name)
            || table_part(&c.name)
            || matches!(
                c.name.as_str(),
                "aside"
                    | "main"
                    | "nav"
                    | "center"
                    | "form"
                    | "fieldset"
                    | "figure"
                    | "figcaption"
                    | "address"
                    | "dl"
                    | "dt"
                    | "dd"
                    | "caption"
                    | "legend"
                    | "details"
                    | "summary"
                    | "pre"
                    | "hr"
            );
        if c.kind != "text" && boundary {
            flush(&mut out, &mut run, &alignment);
            out.push(c);
        } else {
            run.push(c);
        }
    }
    flush(&mut out, &mut run, &alignment);
    n.children = out;
}
