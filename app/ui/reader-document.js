// @ts-check

// The message, reduced to what a flex layout can draw.
//
// Qt drew the reader's document itself — `TextEdit` with `RichText` is a real
// HTML engine, so the QML reader handed it a string and was finished. gpui has
// no such engine, so the document is walked once here and comes out as blocks:
// a heading, a paragraph, a list item, a quote, a rule, a grid, preformatted
// text, and nothing else. That is also the whole security argument for this
// seam. A block is a kind and a string, so no attribute, no `src` and no `href`
// of the sender's can reach a view that only ever draws text.
//
// **The one thing that is deliberately lost is the link.** `Html.readerHref`
// clears an address for the reading document and Qt drew it as a link, but
// carrying it across this seam would put a sender-written URL in the render
// model — which `tests/test_mail_ui_reader_security.mjs` asserts never happens.
// gpui also has no inline text run reachable from JavaScript: a paragraph is
// one string in one style, so a link, a `<strong>` or a `<code>` inside a
// sentence could only be drawn by breaking the sentence into separate elements,
// which puts every emphasised phrase on a line of its own. The words are the
// message and they all come through; the address and the weight do not.

import * as Html from "../message/Html.js";

/** @typedef {{kind:string,text:string,level?:number,marker?:string,last?:boolean,rows?:ReadingRow[]}} ReadingBlock */
/** @typedef {{header:boolean,cells:string[]}} ReadingRow */

// Past this many blocks the reading is not a reading. Laying them out costs a
// frame of the thread that draws every other view in this window, for a
// document nobody is going to scroll to the end of, so the reader says it
// refused rather than spending it.
export const MAX_READING_BLOCKS = 512;

/**
 * Every character under a node, entity references and all. The tree here is
 * already the sanitiser's or the reader-mode rebuild's, so this reads text and
 * never an attribute.
 *
 * A `<br>` is the one element that contributes something of its own: it is the
 * sender ending a line inside a block, which Qt drew as a line break and which
 * a joined string would weld into the middle of the next sentence. It comes
 * across as the newline it is, the same character the plain-text reading is
 * already made of.
 *
 * Which is also why the newlines the sender's *source* carries go: in HTML they
 * are whitespace and nothing else, so a template that wrote `<br>` at the end
 * of its line would otherwise arrive as two breaks where one was meant.
 * `verbatim` is for `<pre>`, where every character is the content.
 * @param {any} node @param {boolean} [verbatim]
 */
export function nodeText(node, verbatim = false) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") {
    const text = Html.decodeReferences(String(node.text || ""));
    return verbatim ? text : text.replace(/\n/g, " ");
  }
  if (String(node.name || "") === "br") return "\n";
  return (node.children ?? [])
    .map((/** @type {any} */ child) => nodeText(child, verbatim))
    .join("");
}

/**
 * The sender's whitespace, collapsed to what a paragraph means. Tabs and runs
 * of spaces are their typesetting rather than their words; a blank line is
 * theirs and survives, but a dozen of them is not a dozen blank lines.
 * @param {string} value
 */
function visibleText(value) {
  return String(value)
    .replace(/[\t\r ]+/g, " ")
    // The space either side of a line break is the sender's indentation, not a
    // word gap: left in, every wrapped line started one column further along
    // than the one above it.
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Preformatted text keeps every space it was written with — that is the whole
 * of what `<pre>` means, and `Html`'s own reader rebuild preserves it for the
 * same reason. Only the edges go, which is what `readerNode` does to a `<pre>`
 * before it stores one.
 * @param {string} value
 */
function preformattedText(value) {
  return String(value)
    .replace(/\r/g, "")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

/**
 * @typedef {{overflow:boolean, cost:number}} WalkState
 *
 * `cost` rather than `blocks.length`: a grid is one block holding a row per
 * line, and counting it as one would let a document of forty-row tables spend
 * far more of the layout thread than the cap is there to bound.
 */

/** @param {ReadingBlock[]} blocks @param {WalkState} state @param {ReadingBlock} block @param {number} [weight] */
function push(blocks, state, block, weight = 1) {
  if (state.cost + weight > MAX_READING_BLOCKS) {
    state.overflow = true;
    return false;
  }
  state.cost += weight;
  blocks.push(block);
  return true;
}

/**
 * The `li` elements of one list, in order. Stops at each item rather than
 * descending into it, so a list nested inside an item stays part of that item
 * instead of being pulled up beside its parent.
 * @param {any} node @param {any[]} out
 */
function listItemsOf(node, out) {
  for (const child of node.children ?? []) {
    if (!child || child.type === "text") continue;
    if (String(child.name || "") === "li") out.push(child);
    else listItemsOf(child, out);
  }
  return out;
}

/**
 * A grid's rows, or null for a table that is the sender's layout rather than
 * their content. `Html.isGrid` is the same question the reader rebuild asks —
 * two rows that each hold more than one cell — and the ceilings are the ones
 * `Html.readerDataTable` refuses past, because a table larger than that is not
 * something anybody reads as a table either.
 * @param {any} node
 */
function gridRowsOf(node) {
  if (!Html.isGrid(node)) return null;
  const lines = Html.rowsOf(node, []);
  if (lines.length === 0 || lines.length > Html.MAX_READER_TABLE_ROWS)
    return null;
  /** @type {ReadingRow[]} */
  const rows = [];
  for (const line of lines) {
    /** @type {string[]} */
    const cells = [];
    let headers = 0;
    for (const cell of line.children ?? []) {
      if (!cell || cell.type === "text") continue;
      const name = String(cell.name || "");
      if (name !== "td" && name !== "th") continue;
      if (name === "th") headers++;
      cells.push(visibleText(nodeText(cell)));
    }
    if (cells.length > Html.MAX_READER_TABLE_COLUMNS) return null;
    if (cells.length > 0)
      rows.push({ header: headers === cells.length, cells });
  }
  return rows.length > 0 ? rows : null;
}

/** @param {ReadingRow[]} rows */
function tableText(rows) {
  return rows.map((row) => row.cells.join("  ")).join("\n");
}

/** @param {any} node @param {ReadingBlock[]} blocks @param {WalkState} state */
function walk(node, blocks, state) {
  if (!node || typeof node !== "object" || state.overflow) return;
  const name = String(node.name || "");
  const heading = name.match(/^h([1-6])$/);
  if (heading) {
    const text = visibleText(nodeText(node));
    if (text)
      push(blocks, state, {
        kind: "heading",
        text,
        level: Number(heading[1]),
      });
    return;
  }
  // A rule carries no words, so it is the one block whose text is empty on
  // purpose: it is the sender dividing the message, which is content.
  if (name === "hr") {
    push(blocks, state, { kind: "rule", text: "" });
    return;
  }
  if (name === "blockquote") {
    // A quoted reply is paragraphs, and Qt drew them as paragraphs inside the
    // quote's own indent. This model has one string per block, so they are
    // joined by the blank line that stands for a paragraph break — welded
    // together, "wrote:" ran straight into the first word of the quote.
    //
    // The inner walk carries the document's own budget rather than a fresh
    // one, and hands back what it spent: a quote is part of the message, so a
    // sender cannot buy another five hundred blocks by wrapping them.
    /** @type {ReadingBlock[]} */
    const inner = [];
    const inside = { overflow: false, cost: state.cost };
    walkChildren(node, inner, inside);
    state.cost = inside.cost;
    if (inside.overflow) {
      state.overflow = true;
      return;
    }
    const text =
      inner
        .map((block) => block.text)
        .filter(Boolean)
        .join("\n\n") || visibleText(nodeText(node));
    if (text) push(blocks, state, { kind: "quote", text });
    return;
  }
  if (name === "ul" || name === "ol") {
    const items = listItemsOf(node, []);
    /** @type {ReadingBlock[]} */
    const drawn = [];
    for (const item of items) {
      const text = visibleText(nodeText(item));
      if (!text) continue;
      drawn.push({
        kind: "list-item",
        text,
        // Qt numbered an `<ol>` and bulleted a `<ul>`; the marker is decided
        // here because the list is the only place that knows which this is.
        marker: name === "ol" ? `${drawn.length + 1}.` : "•",
      });
    }
    // `ul,ol{margin-bottom:gap}` sits under the last item and `li{margin-
    // bottom:rule}` between them, so the closing gap belongs to one item
    // rather than to a list element this flat model has nowhere to put.
    if (drawn.length > 0) drawn[drawn.length - 1].last = true;
    for (const block of drawn) if (!push(blocks, state, block)) return;
    return;
  }
  if (name === "li") {
    const text = visibleText(nodeText(node));
    if (text) push(blocks, state, { kind: "list-item", text, marker: "•" });
    return;
  }
  if (name === "table") {
    const rows = gridRowsOf(node);
    if (rows) {
      push(
        blocks,
        state,
        { kind: "table", text: tableText(rows), rows },
        rows.length,
      );
      return;
    }
    // Everything else was the sender's layout, and its rows become the blocks
    // they always were.
    walkChildren(node, blocks, state);
    return;
  }
  if (name === "pre") {
    const text = preformattedText(nodeText(node, true));
    if (text) push(blocks, state, { kind: "pre", text });
    return;
  }
  if (name === "p" || name === "tr") {
    const text = visibleText(nodeText(node));
    // A table row that reached here is a row of a layout table, so it lands as
    // one more paragraph rather than as a grid nothing would line up in.
    if (text) push(blocks, state, { kind: "paragraph", text });
    return;
  }
  walkChildren(node, blocks, state);
}

/** @param {any} node @param {ReadingBlock[]} blocks @param {WalkState} state */
function walkChildren(node, blocks, state) {
  for (const child of node.children ?? []) walk(child, blocks, state);
}

/**
 * The blocks of one document, and whether it ran past the cap.
 *
 * All or nothing on overflow: half a message with no mark where the other half
 * stopped reads as a message that ended, which is a worse answer than one that
 * says it was refused.
 * @param {any} document
 */
export function readingBlocksOf(document) {
  /** @type {ReadingBlock[]} */
  const blocks = [];
  /** @type {WalkState} */
  const state = { overflow: false, cost: 0 };
  walk(document, blocks, state);
  if (state.overflow) blocks.length = 0;
  return { blocks, overflow: state.overflow };
}
