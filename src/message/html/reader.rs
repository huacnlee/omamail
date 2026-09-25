use super::*;

#[derive(Default)]
struct State {
    blocks: Vec<Node>,
    inline: Vec<Node>,
    chain: Vec<Node>,
    pending: bool,
    filled: bool,
}
impl State {
    fn target(&mut self) -> &mut Vec<Node> {
        let mut out = &mut self.inline;
        for _ in 0..self.chain.len() {
            out = &mut out.last_mut().unwrap().children
        }
        out
    }
    fn space(&mut self) {
        if !self.pending || !self.filled {
            return;
        }
        let target = self.target();
        if let Some(n) = target.last_mut().filter(|n| n.kind == "text") {
            n.text.push(' ')
        } else {
            target.push(Node::text(" "))
        }
        self.pending = false
    }
    fn open(&mut self, n: Node) -> bool {
        if self.chain.len() >= 8 {
            return false;
        }
        self.space();
        self.target().push(n.clone());
        self.chain.push(n);
        true
    }
    fn text(&mut self, raw: &str) {
        let value = source_space(&undrawn(raw));
        if value.is_empty() {
            return;
        }
        let core = value.trim_matches(' ');
        if core.is_empty() {
            if self.filled {
                self.pending = true
            }
            return;
        }
        if value.starts_with(' ') && self.filled {
            self.pending = true
        }
        let lead = if self.pending && self.filled { " " } else { "" };
        let text = format!("{lead}{core}");
        let target = self.target();
        if let Some(n) = target.last_mut().filter(|n| n.kind == "text") {
            n.text.push_str(&text)
        } else {
            target.push(Node::text(&text))
        }
        self.filled = true;
        self.pending = value.ends_with(' ')
    }
    fn br(&mut self) {
        if !self.filled {
            return;
        }
        let target = self.target();
        if target.last().is_some_and(|n| n.name == "br") {
            return;
        }
        target.push(Node::element("br"));
        self.pending = false
    }
    fn flush(&mut self, name: &str) {
        let content = std::mem::take(&mut self.inline);
        self.pending = false;
        self.filled = false;
        let chain = std::mem::take(&mut self.chain);
        for n in chain {
            self.open(n);
        }
        if meaningful(&content) {
            let mut n = Node::element(name);
            n.children = trimmed(content);
            self.blocks.push(n)
        }
    }
}
fn meaningful(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| {
        if n.kind == "text" {
            !decode(&n.text).trim().is_empty()
        } else if n.name == "img" {
            true
        } else if matches!(n.name.as_str(), "br" | "hr") {
            false
        } else {
            meaningful(&n.children)
        }
    })
}
fn trimmed(mut nodes: Vec<Node>) -> Vec<Node> {
    let empty =
        |n: &Node| n.name == "br" || (n.kind == "text" && decode(&n.text).trim().is_empty());
    let start = nodes.iter().position(|n| !empty(n)).unwrap_or(nodes.len());
    nodes.drain(..start);
    while nodes.last().is_some_and(empty) {
        nodes.pop();
    }
    nodes
}
fn length(nodes: &[Node]) -> usize {
    nodes
        .iter()
        .map(|n| {
            if n.kind == "text" {
                decode(&n.text).encode_utf16().count()
            } else if n.name == "img" {
                8
            } else {
                length(&n.children)
            }
        })
        .sum()
}
fn drop_reader(n: &str) -> bool {
    dropped(n)
        || matches!(
            n,
            "head"
                | "input"
                | "select"
                | "option"
                | "optgroup"
                | "svg"
                | "canvas"
                | "map"
                | "area"
                | "frame"
                | "frameset"
                | "video"
                | "audio"
                | "source"
                | "track"
                | "param"
                | "template"
                | "col"
                | "colgroup"
        )
}
fn hidden_reader(n: &Node) -> bool {
    if n.has("hidden") {
        return true;
    }
    let styles = declarations(n.attr("style"));
    if hidden(&styles) {
        return true;
    }
    let leaf = n.children.iter().all(|n| n.kind == "text");
    let mut zero = false;
    let mut clip = false;
    for (name, value) in styles {
        if leaf
            && name == "font-size"
            && re!(r"(?i)^\s*[0-2](\.\d+)?\s*(px|pt)?\s*$").is_match(&value)
        {
            return true;
        }
        if name == "opacity" && re!(r"^\s*0(\.0+)?\s*$").is_match(&value) {
            return true;
        }
        if name == "max-height" && re!(r"(?i)^\s*0(\.0+)?\s*(px|pt|em|rem|%)?\s*$").is_match(&value)
        {
            zero = true
        }
        if name == "overflow" && re!(r"(?i)^\s*hidden\b").is_match(&value) {
            clip = true
        }
    }
    zero && clip
}
fn dimension(n: &Node, key: &str) -> usize {
    let raw = n.attr(key);
    let mut value = if re!(r"^\s*\d+(?:\.\d+)?\s*$").is_match(raw) {
        raw.trim().parse::<f64>().unwrap_or(0.0)
    } else {
        0.0
    };
    if value <= 0.0 {
        for (k, v) in declarations(n.attr("style")) {
            if k == key
                && let Some(c) = re!(r"(?i)^\s*(\d+(?:\.\d+)?)px\s*$").captures(&v)
            {
                value = c[1].parse().unwrap_or(0.0)
            }
        }
    }
    if !(2.0..=640.0).contains(&value) || value == 2.0 {
        0
    } else {
        value.round() as usize
    }
}
fn image(n: &Node, s: &mut State, ctx: &mut Images<'_>) {
    if tracking(n) {
        return;
    }
    let source = n.attr("src");
    let kind = if n.has("src") {
        image_kind(source)
    } else {
        "none"
    };
    let rendered = if kind == "remote" {
        ctx.prepared(source)
    } else {
        source.into()
    };
    if kind == "inline"
        || (kind == "remote" && ctx.allowed() && ctx.kept < ctx.limit && !rendered.is_empty())
    {
        if kind == "remote" {
            ctx.kept += 1
        }
        s.space();
        let mut out = Node::element("img");
        out.set("src", &rendered);
        let (w, h) = (dimension(n, "width"), dimension(n, "height"));
        if w > 0 {
            out.set("width", &w.to_string())
        }
        if h > 0 && w > 0 && w <= 96 && h <= 96 {
            out.set("height", &h.to_string())
        }
        s.target().push(out);
        s.filled = true;
        s.pending = false;
        return;
    }
    if kind == "remote" {
        ctx.blocked += 1
    }
    let alt = source_space(&tree::escape_text(&decode(n.attr("alt"))));
    if !alt.trim().is_empty() {
        s.text(alt.trim())
    } else if kind == "remote" && n.has("src") && !n.has("alt") {
        s.text("[image]")
    }
}
fn heading(n: &Node) -> String {
    let mut level = "";
    for (name, value) in declarations(n.attr("style")) {
        if name != "font-size" {
            continue;
        }
        let v = value.trim().to_ascii_lowercase();
        let num = re!(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)")
            .find(&v)
            .and_then(|m| m.as_str().parse::<f64>().ok())
            .unwrap_or(0.0);
        let px = if v.ends_with("px") {
            num
        } else if v.ends_with("pt") {
            num * 4.0 / 3.0
        } else if v.ends_with("em") {
            num * 16.0
        } else if v.ends_with('%') {
            num * 0.16
        } else {
            0.0
        };
        level = if px >= 28.0 {
            "h2"
        } else if px >= 20.0 {
            "h3"
        } else {
            ""
        }
    }
    level.into()
}
fn build_heading(
    n: &Node,
    s: &mut State,
    ctx: &mut Images<'_>,
    tables: bool,
    tag: &str,
    single: bool,
) {
    s.flush("p");
    let blocks = build(n, ctx, tables);
    let eligible = (!single || blocks.len() <= 1) && blocks.iter().all(|n| n.name == "p");
    let mut content = vec![];
    if eligible {
        for b in &blocks {
            if !content.is_empty() {
                content.push(Node::text(" "))
            }
            content.extend(b.children.clone())
        }
    }
    if content.is_empty() || length(&content) > 120 {
        s.blocks.extend(blocks)
    } else {
        let mut out = Node::element(tag);
        out.children = content;
        s.blocks.push(out)
    }
}
fn text_of(n: &Node) -> String {
    if n.kind == "text" {
        n.text.clone()
    } else {
        n.children.iter().map(text_of).collect()
    }
}
fn contains_image(n: &[Node]) -> bool {
    n.iter()
        .any(|n| n.name == "img" || contains_image(&n.children))
}
fn furniture(n: &Node) -> bool {
    !contains_image(&n.children)
        && re!(r"^[\s\x{00a0}]*[|\x{00b7}\x{2022}\x{2013}\x{2014}/-]?[\s\x{00a0}]*$")
            .is_match(&text_of(n))
}
fn inline_or_blocks(mut blocks: Vec<Node>) -> Vec<Node> {
    if blocks.len() == 1 && blocks[0].name == "p" {
        blocks.remove(0).children
    } else {
        blocks
    }
}
fn data_table(n: &Node, ctx: &mut Images<'_>) -> Option<Node> {
    let mut source = vec![];
    rows(n, &mut source);
    if source.is_empty() || source.len() > 40 {
        return None;
    }
    let mut grid = vec![];
    for r in source {
        let cells = r
            .children
            .iter()
            .filter(|n| matches!(n.name.as_str(), "td" | "th"))
            .collect::<Vec<_>>();
        if cells.len() > 8 {
            return None;
        }
        if !cells.is_empty() {
            grid.push(cells)
        }
    }
    let columns = grid.iter().map(Vec::len).max().unwrap_or(0);
    for col in (0..columns).rev() {
        if grid
            .iter()
            .all(|r| r.get(col).is_some_and(|n| furniture(n)))
        {
            for r in &mut grid {
                r.remove(col);
            }
        }
    }
    if grid.iter().map(Vec::len).max().unwrap_or(0) < 2 {
        return None;
    }
    let mut out = Node::element("table");
    for r in grid {
        let mut row = Node::element("tr");
        for c in r {
            let mut cell = Node::element(&c.name);
            cell.children = inline_or_blocks(build(c, ctx, false));
            row.children.push(cell)
        }
        out.children.push(row)
    }
    Some(out)
}
fn broken(n: &[Node]) -> bool {
    n.iter().any(|n| n.name == "br" || broken(&n.children))
}
fn row(n: &Node, s: &mut State, ctx: &mut Images<'_>, tables: bool) -> bool {
    let mut cells = vec![];
    for c in &n.children {
        if c.kind == "text" {
            continue;
        }
        if hidden_reader(c) {
            continue;
        }
        if !matches!(c.name.as_str(), "td" | "th") || !heading(c).is_empty() {
            return false;
        }
        if !s.chain.is_empty() || !furniture(c) {
            cells.push(c)
        }
    }
    let built = cells
        .into_iter()
        .map(|c| build_in_chain(c, ctx, tables, &s.chain))
        .collect::<Vec<_>>();
    if tables && let Some(status) = status_row(&built) {
        s.flush("p");
        s.blocks.push(status);
        return true;
    }
    // Only compact status strips change layout inside an existing link/style.
    // Keep the old block boundaries for other linked rows, without walking twice.
    if !s.chain.is_empty() {
        s.flush("p");
        s.blocks.extend(built.into_iter().flatten());
        return true;
    }
    let eligible = built
        .iter()
        .all(|b| b.is_empty() || (b.len() == 1 && b[0].name == "p" && !broken(&b[0].children)));
    let mut line = vec![];
    if eligible {
        for b in &built {
            if b.is_empty() {
                continue;
            }
            if !line.is_empty() {
                line.push(Node::text(" "))
            }
            line.extend(b[0].children.clone())
        }
    }
    s.flush("p");
    if eligible && length(&line) <= 160 {
        if !line.is_empty() {
            let mut p = Node::element("p");
            p.children = trimmed(line);
            s.blocks.push(p)
        }
    } else {
        for b in built {
            s.blocks.extend(b)
        }
    }
    true
}
// Judge rebuilt content, then create our own bounded layout. No sender
// attributes are copied into Reader's status strip.
fn status_row(cells: &[Vec<Node>]) -> Option<Node> {
    if !(2..=8).contains(&cells.len()) {
        return None;
    }
    let mut width = 0.0;
    for blocks in cells {
        if blocks.len() != 2 || blocks[0].name != "p" || blocks[1].name != "p" {
            return None;
        }
        let label = &blocks[0].children;
        if contains_image(label)
            || broken(label)
            || !(1..=4).contains(&length(label))
            || small_images(&blocks[1].children) != 1
        {
            return None;
        }
        let icon_width = formatting::icon_width(&blocks[1]);
        if icon_width == 0.0 {
            return None;
        }
        width += icon_width + 4.0;
    }
    if width > 256.0 {
        return None;
    }
    let mut table = Node::element("table");
    table.set("cellspacing", "0");
    table.set("cellpadding", "0");
    let mut row = Node::element("tr");
    for blocks in cells {
        let mut cell = Node::element("td");
        cell.set("align", "center");
        cell.set("valign", "top");
        cell.set("style", "padding:0px 2px");
        cell.children = blocks[0].children.clone();
        cell.children.push(Node::element("br"));
        cell.children.extend(blocks[1].children.clone());
        row.children.push(cell);
    }
    table.children.push(row);
    Some(table)
}

fn list_items(n: &Node, list: &mut Node, ctx: &mut Images<'_>, tables: bool) {
    for c in &n.children {
        if c.kind == "text" || drop_reader(&c.name) {
            continue;
        }
        if c.name != "li" {
            list_items(c, list, ctx, tables);
            continue;
        }
        let mut item = Node::element("li");
        item.children = inline_or_blocks(build(c, ctx, tables));
        if !item.children.is_empty() {
            list.children.push(item)
        }
    }
}
fn pre_text(n: &Node, out: &mut String) {
    for c in &n.children {
        if c.kind == "text" {
            if !c.raw {
                out.push_str(&c.text)
            }
            continue;
        }
        if drop_reader(&c.name) {
            continue;
        }
        if c.name == "br" {
            out.push('\n')
        } else {
            pre_text(c, out)
        }
    }
}
fn walk(n: &Node, s: &mut State, ctx: &mut Images<'_>, tables: bool) {
    for c in &n.children {
        node(c, s, ctx, tables)
    }
}
fn node(n: &Node, s: &mut State, ctx: &mut Images<'_>, tables: bool) {
    if n.kind == "text" {
        if !n.raw {
            s.text(&n.text)
        }
        return;
    }
    let name = n.name.as_str();
    if drop_reader(name) || hidden_reader(n) {
        return;
    }
    match name {
        "br" => s.br(),
        "img" => image(n, s, ctx),
        "hr" => {
            s.flush("p");
            s.blocks.push(Node::element("hr"))
        }
        "a" => {
            let raw = n.attr("href");
            let norm = normalized(raw);
            if !safe_href(raw)
                || !safe_href(&norm)
                || (!norm.to_ascii_lowercase().starts_with("mailto:") && !is_public_url(raw))
            {
                walk(n, s, ctx, tables)
            } else {
                let mut link = Node::element("a");
                link.set("href", raw);
                let opened = s.open(link);
                walk(n, s, ctx, tables);
                if opened {
                    s.chain.pop();
                }
            }
        }
        "b" | "strong" | "i" | "em" | "cite" | "dfn" | "var" | "code" | "kbd" | "samp" | "tt" => {
            let tag = match name {
                "b" | "strong" => "strong",
                "code" | "kbd" | "samp" | "tt" => "code",
                _ => "em",
            };
            let opened = s.open(Node::element(tag));
            walk(n, s, ctx, tables);
            if opened {
                s.chain.pop();
            }
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => build_heading(n, s, ctx, tables, name, false),
        "pre" => {
            s.flush("p");
            let mut text = String::new();
            pre_text(n, &mut text);
            let text = text.trim_start_matches('\n').trim_end();
            if !text.is_empty() {
                let mut out = Node::element("pre");
                out.children.push(Node::text(text));
                s.blocks.push(out)
            }
        }
        "ul" | "ol" => {
            s.flush("p");
            let mut list = Node::element(name);
            list_items(n, &mut list, ctx, tables);
            if list.children.is_empty() {
                walk(n, s, ctx, tables);
                s.flush("p")
            } else {
                s.blocks.push(list)
            }
        }
        "blockquote" => {
            s.flush("p");
            let blocks = build(n, ctx, tables);
            if !blocks.is_empty() {
                let mut quote = Node::element("blockquote");
                quote.children = blocks;
                s.blocks.push(quote)
            }
        }
        "table" => {
            s.flush("p");
            if tables
                && grid(n)
                && let Some(table) = data_table(n, ctx)
            {
                s.blocks.push(table);
                return;
            }
            walk(n, s, ctx, tables);
            s.flush("p")
        }
        _ => {
            if name == "tr" && row(n, s, ctx, tables) {
                return;
            }
            if table_part(name)
                || matches!(
                    name,
                    "div"
                        | "p"
                        | "section"
                        | "article"
                        | "aside"
                        | "header"
                        | "footer"
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
                )
            {
                let inferred = if s.chain.is_empty() {
                    heading(n)
                } else {
                    String::new()
                };
                if !inferred.is_empty() {
                    build_heading(n, s, ctx, tables, &inferred, true)
                } else {
                    s.flush("p");
                    walk(n, s, ctx, tables);
                    s.flush("p")
                }
            } else {
                walk(n, s, ctx, tables)
            }
        }
    }
}
fn build(n: &Node, ctx: &mut Images<'_>, tables: bool) -> Vec<Node> {
    build_in_chain(n, ctx, tables, &[])
}
fn build_in_chain(n: &Node, ctx: &mut Images<'_>, tables: bool, chain: &[Node]) -> Vec<Node> {
    let mut s = State::default();
    for parent in chain {
        let mut wrapper = Node::element(&parent.name);
        wrapper.attrs = parent.attrs.clone();
        s.open(wrapper);
    }
    walk(n, &mut s, ctx, tables);
    s.flush("p");
    s.blocks
}
fn small_images(nodes: &[Node]) -> usize {
    let mut count = 0;
    for n in nodes {
        if n.kind == "text" {
            if !decode(&n.text).trim().is_empty() {
                return 0;
            }
            continue;
        }
        if n.name == "img" {
            let w = n.attr("width").parse::<f64>().unwrap_or(0.0);
            let h = n.attr("height").parse::<f64>().unwrap_or(0.0);
            if w <= 2.0 || w > 96.0 || h > 96.0 {
                return 0;
            }
            count += 1
        } else if n.name == "a" {
            let child = small_images(&n.children);
            if child == 0 {
                return 0;
            }
            count += child
        } else {
            return 0;
        }
    }
    count
}
fn avatar(mut block: Node) -> Node {
    if block.name != "p" {
        return block;
    }
    let children = trimmed(block.children.clone());
    if children.len() < 2
        || small_images(&children[..1]) != 1
        || !meaningful(&children[1..])
        || contains_image(&children[1..])
    {
        return block;
    }
    block = Node::element("table");
    block.set("cellspacing", "0");
    block.set("cellpadding", "0");
    let mut row = Node::element("tr");
    let mut picture = Node::element("td");
    picture.set("valign", "middle");
    picture.set("style", "padding:0px;padding-right:6px");
    picture.children = children[..1].to_vec();
    let mut words = Node::element("td");
    words.set("valign", "middle");
    words.set("style", "padding:0px");
    words.children = children[1..].to_vec();
    row.children = vec![picture, words];
    block.children = vec![row];
    block
}
fn tidy(blocks: Vec<Node>) -> Vec<Node> {
    let mut out: Vec<Node> = vec![];
    for block in blocks {
        if block.name == "hr" && (out.is_empty() || out.last().is_some_and(|n| n.name == "hr")) {
            continue;
        }
        let block = avatar(block);
        if block.name == "p"
            && small_images(&block.children) > 0
            && out
                .last()
                .is_some_and(|n| n.name == "p" && small_images(&n.children) > 0)
        {
            let last = out.last_mut().unwrap();
            last.children.push(Node::text(" "));
            last.children.extend(block.children)
        } else {
            out.push(block)
        }
    }
    while out.last().is_some_and(|n| n.name == "hr") {
        out.pop();
    }
    out
}
pub fn render(n: &Node, options: &Value) -> Result<Value, &'static str> {
    let mut ctx = Images::new(options);
    let mut document = Node::root();
    document.children = tidy(build(n, &mut ctx, true));
    let html = serialize(&document)?;
    let size = measure(&document, &html);
    Ok(
        json!({"html":html,"empty":document.children.is_empty(),"document":document,"images":ctx.kept,"blockedImages":ctx.blocked,"tooHeavy":too_heavy(&size),"complexity":size}),
    )
}
