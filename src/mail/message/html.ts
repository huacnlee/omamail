// Message HTML, from the backend's sanitized trees to what TextView draws.
// Port of the client-side half of omarchy/ui/message/Html.js.
//
// The sanitizer itself runs in Rust (core/src/message/html): `reader.open`
// and `reader.render` hand back two trees, never markup: `document` (the
// sender's own layout with everything dangerous removed) and
// `reader.document` (a new document built out of what the message says).
// Qt serialized those trees into the subset its rich text engine reads; this
// module serializes them into the subset TextView's `html` reads, and checks
// every value again on the way out. The second pass is not a formality:
// whatever reaches TextView decides what it fetches and what a press opens,
// so this is the last place a mistake upstream can still be caught.
//
// What leaves here is structural: an element list of our own, and of the
// sender's values only
//
//   text      escaped
//   href      on <a>, only mailto: or http(s) at a public host
//   src       on <img>, only raster bytes already in the message (data:)
//   alt       on <img>, escaped
//   width     on <img> and cells, numeric
//   colspan   on cells, numeric
//   start     on <ol>, numeric
//
// No style, class, id, colour, background or url() can survive by being
// missed, because nothing is copied that is not named above.
import type { TextViewBlock, TextViewDocument, TextViewInline } from "nsh/base";

// ================================================================ the tree

/** A node of the backend's sanitized tree (core/src/message/html/tree.rs). */
export interface HtmlNode {
  type: "root" | "element" | "text";
  name?: string;
  attrs?: { name: string; value?: string | null }[];
  children?: HtmlNode[];
  text?: string;
  selfClosing?: boolean;
  raw?: boolean;
}

export function attributeValue(node: HtmlNode | null | undefined, name: string): string {
  const attrs = node?.attrs ?? [];
  for (const attr of attrs) {
    if (attr.name === name) return attr.value === null || attr.value === undefined ? "" : String(attr.value);
  }
  return "";
}

function hasAttribute(node: HtmlNode, name: string): boolean {
  return (node.attrs ?? []).some((attr) => attr.name === name);
}

// ============================================================== references
//
// src="&#104;ttps://tracker/x.png" is a real https fetch while a check reading
// the raw attribute text sees something that starts with an "&". The named
// references mail actually uses; an unknown one is left as written.
const NAMED_REFERENCES: Record<string, string> = {
  amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", sol: "/", colon: ":",
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", hellip: "…", bull: "•",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  middot: "·", copy: "©", reg: "®", trade: "™",
  deg: "°", times: "×", laquo: "«", raquo: "»",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§",
};

export function decodeReferences(text: unknown): string {
  return String(text ?? "").replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);?/g, (match, body: string) => {
    if (body.charAt(0) !== "#") {
      const named = NAMED_REFERENCES[body.toLowerCase()];
      return named === undefined ? match : named;
    }
    const code = body.charAt(1) === "x" || body.charAt(1) === "X"
      ? parseInt(body.substring(2), 16)
      : parseInt(body.substring(1), 10);
    if (!isFinite(code) || code < 0 || code > 0x10ffff) return match;
    return String.fromCodePoint(code);
  });
}

// ===================================================================== URLs

// Decoded twice, because "&amp;#104;" is one reference to one reader and two to
// another. For the scheme, over-decoding can only make a source look more
// dangerous than it is, and the answer to that is to block it.
export function normalizedUrl(value: unknown): string {
  const text = decodeReferences(decodeReferences(String(value ?? "")));
  return text.replace(/[\t\n\r]/g, "").replace(/^[\s\u0000-\u001f]+|[\s\u0000-\u001f]+$/g, "");
}

/**
 * The host of an http(s) or protocol-relative URL, lower-cased, with the
 * userinfo, the port and everything after the authority removed. Userinfo
 * matters: "http://gmail.com@127.0.0.1/x.png" is a request to 127.0.0.1.
 */
export function hostOf(url: unknown): string {
  const text = String(url ?? "").replace(/^https?:/i, "");
  if (text.indexOf("//") !== 0) return "";
  let authority = text.substring(2);
  const end = authority.search(/[\/?#\\]/);
  if (end >= 0) authority = authority.substring(0, end);
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.substring(at + 1);
  if (authority.charAt(0) === "[") {
    const close = authority.indexOf("]");
    return (close < 0 ? authority : authority.substring(0, close + 1)).toLowerCase();
  }
  const colon = authority.indexOf(":");
  return (colon < 0 ? authority : authority.substring(0, colon)).toLowerCase();
}

// The host is asked of both readings and has to be public to both: a decoding
// can introduce a "@" and hand the authority to a later label.
function hostsOf(value: unknown): string[] {
  const text = String(value ?? "");
  const once = decodeReferences(text);
  const twice = decodeReferences(once);
  return once === twice
    ? [hostOf(normalizedUrl(text))]
    : [hostOf(normalizedUrl(text)), hostOf(once.replace(/[\t\n\r]/g, ""))];
}

const DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isPublicIpv4(host: string): boolean {
  const parts = String(host).match(DOTTED_QUAD);
  if (!parts) return false;
  const octets: number[] = [];
  for (let i = 1; i <= 4; i++) {
    // A leading zero is octal to some resolvers and decimal to others.
    if (parts[i].length > 1 && parts[i].charAt(0) === "0") return false;
    const value = Number(parts[i]);
    if (value > 255) return false;
    octets.push(value);
  }
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a >= 224) return false;
  return true;
}

const PRIVATE_SUFFIX = /(^|\.)(localhost|home\.arpa)$|\.(local|localdomain|internal|intranet|lan|home|corp|test)$/;
const PUBLIC_TLD = /\.(xn--[a-z0-9-]+|[a-z]{2,})$/;

/**
 * A name whose last label is a real top-level domain, or a public IPv4
 * address: a list of what is allowed rather than of what is not. This is a
 * name check only; the backend checks every DNS answer before it fetches.
 */
export function isPublicHost(host: unknown): boolean {
  const name = String(host ?? "");
  if (name === "" || name.length > 253) return false;
  if (isPublicIpv4(name)) return true;
  if (!/^[a-z0-9.-]+$/.test(name)) return false;
  if (name.indexOf("..") >= 0) return false;
  if (PRIVATE_SUFFIX.test(name)) return false;
  return PUBLIC_TLD.test(name);
}

export function isPublicUrl(value: unknown): boolean {
  return hostsOf(value).every(isPublicHost);
}

/**
 * A cheap spelling gate before a deliberate click leaves through the system
 * browser: http(s) at a public host, as written; "" for anything else.
 */
export function externallyOpenableHttpUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return "";
  if (/[\u0000- \u007f\\]/.test(text)) return "";
  return isPublicUrl(text) ? text : "";
}

/** Protocol-relative sources are network fetches too. */
export function isRemoteSource(value: unknown): boolean {
  return /^(https?:)?\/\//i.test(normalizedUrl(value));
}

// ================================================================== images

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Prefix(payload: string, byteLimit: number): number[] {
  const text = String(payload ?? "");
  if (text === "" || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return [];
  const padding = text.slice(-2) === "==" ? 2 : text.slice(-1) === "=" ? 1 : 0;
  if (padding === 2 && BASE64_ALPHABET.indexOf(text.charAt(text.length - 3)) % 16 !== 0) return [];
  if (padding === 1 && BASE64_ALPHABET.indexOf(text.charAt(text.length - 2)) % 4 !== 0) return [];
  const out: number[] = [];
  for (let i = 0; i < text.length && out.length < byteLimit; i += 4) {
    const a = BASE64_ALPHABET.indexOf(text.charAt(i));
    const b = BASE64_ALPHABET.indexOf(text.charAt(i + 1));
    const c = text.charAt(i + 2) === "=" ? 0 : BASE64_ALPHABET.indexOf(text.charAt(i + 2));
    const d = text.charAt(i + 3) === "=" ? 0 : BASE64_ALPHABET.indexOf(text.charAt(i + 3));
    if (a < 0 || b < 0 || c < 0 || d < 0) return [];
    out.push((a << 2) | (b >> 4));
    if (text.charAt(i + 2) !== "=" && out.length < byteLimit) out.push(((b & 15) << 4) | (c >> 2));
    if (text.charAt(i + 3) !== "=" && out.length < byteLimit) out.push(((c & 3) << 6) | d);
  }
  return out;
}

function bytesStartWith(bytes: number[], expected: number[]): boolean {
  if (bytes.length < expected.length) return false;
  return expected.every((byte, i) => bytes[i] === byte);
}

/**
 * Raster bytes already in the message, or already fetched through the
 * backend's public-host worker, checked by their magic numbers. SVG is a
 * document with hrefs of its own and never qualifies.
 */
export function isRasterDataImage(value: unknown): boolean {
  const match = String(value ?? "").match(/^data:image\/(png|jpe?g|gif|webp|bmp);base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!match) return false;
  const bytes = base64Prefix(match[2], 12);
  const kind = match[1].toLowerCase();
  if (kind === "png") return bytesStartWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
  if (kind === "jpg" || kind === "jpeg") return bytesStartWith(bytes, [255, 216, 255]);
  if (kind === "gif") {
    return bytesStartWith(bytes, [71, 73, 70, 56, 55, 97]) || bytesStartWith(bytes, [71, 73, 70, 56, 57, 97]);
  }
  if (kind === "webp") {
    return bytesStartWith(bytes, [82, 73, 70, 70]) && bytes.length >= 12
      && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
  }
  return kind === "bmp" && bytesStartWith(bytes, [66, 77]);
}

/** A body picture as the reader's documents carry it: data the backend prepared. */
export function isDataImageSource(value: unknown): boolean {
  return /^data:image\//i.test(String(value ?? "").substring(0, 11));
}

export type ImageSourceKind = "none" | "inline" | "remote" | "unsafe" | "local";

/**
 * What an <img src> is, as far as the fetch it would cause is concerned:
 * inline (cid:, raster data:), remote (http(s) at a public host), unsafe
 * (any other scheme, or a host that is not public), local (no scheme).
 */
export function imageSourceKind(value: unknown): ImageSourceKind {
  const url = normalizedUrl(value);
  if (url === "") return "none";
  if (/^cid:/i.test(url)) return "inline";
  if (/^data:/i.test(url)) return isRasterDataImage(url) ? "inline" : "unsafe";
  if (/^(https?:)?\/\//i.test(url)) return isPublicUrl(value) ? "remote" : "unsafe";
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? "unsafe" : "local";
}

/** Only http(s) and mailto survive as a link at all. */
export function safeHref(value: unknown): boolean {
  return /^\s*(https?:|mailto:)/i.test(String(value ?? ""));
}

/** A link the reader may draw: mailto:, or http(s) at a public host; "" for anything else. */
export function linkTarget(value: unknown): string {
  const url = normalizedUrl(value);
  if (/^mailto:/i.test(url)) return /[\u0000-\u001f\u007f]/.test(url) ? "" : url;
  // Public to every reading of the sender's spelling, not only to ours.
  return isPublicUrl(value) ? externallyOpenableHttpUrl(url) : "";
}

// A 1x1 image is a tracking pixel, never something to look at.
function isTrackingPixel(node: HtmlNode): boolean {
  for (const name of ["width", "height"]) {
    const raw = attributeValue(node, name);
    if (raw !== "" && isFinite(Number(raw)) && Number(raw) <= 2) return true;
  }
  return false;
}

// ============================================================= image links

export const IMAGE_LINK_PREFIX = "omarchy-image:";

/** The `omarchy-image:N` a picture's link carries, numbered from 1. */
export function imageLink(index: number): string {
  return IMAGE_LINK_PREFIX + Math.max(1, Math.floor(index));
}

/** The index a marker link carries, or 0 when the link is something else. */
export function imageLinkIndex(url: unknown): number {
  const text = String(url ?? "");
  if (text.indexOf(IMAGE_LINK_PREFIX) !== 0) return 0;
  const index = Number(text.substring(IMAGE_LINK_PREFIX.length));
  return index > 0 ? Math.floor(index) : 0;
}

/**
 * The pictures of a tree in document order, the same walk `toHtml` numbers
 * them by: position N in this list is the `omarchy-image:N+1` link.
 */
export function documentImages(tree: HtmlNode | null | undefined): string[] {
  const out: string[] = [];
  const walk = (node: HtmlNode | null | undefined, depth: number) => {
    if (!node || node.type === "text" || depth > MAX_DEPTH) return;
    if (node.type === "element" && node.name === "img") {
      const src = attributeValue(node, "src");
      if (isRasterDataImage(src) && !isTrackingPixel(node)) out.push(src);
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(tree, 0);
  return out;
}

// ============================================================ serializing

/** Elements that leave as themselves; every other element leaves as its children. */
const KEPT_ELEMENTS: Record<string, true> = {
  p: true, div: true, br: true, hr: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
  b: true, strong: true, i: true, em: true, u: true, s: true, strike: true, del: true, ins: true,
  small: true, sup: true, sub: true, mark: true, code: true, kbd: true, samp: true, tt: true, pre: true,
  blockquote: true, ul: true, ol: true, li: true, dl: true, dt: true, dd: true,
  table: true, thead: true, tbody: true, tfoot: true, tr: true, td: true, th: true, caption: true,
  a: true, img: true, details: true, summary: true, cite: true, q: true, abbr: true,
  section: true, article: true, header: true, footer: true, main: true, aside: true, nav: true,
  figure: true, figcaption: true, center: true, address: true,
};

/** Elements whose subtree holds nothing a reader wants: never serialized, even as text. */
const DROPPED_ELEMENTS: Record<string, true> = {
  script: true, style: true, title: true, head: true, template: true, noscript: true, iframe: true,
  object: true, embed: true, applet: true, frame: true, frameset: true, svg: true, math: true,
  form: true, input: true, button: true, select: true, option: true, textarea: true, canvas: true,
  audio: true, video: true, source: true, track: true, picture: true, map: true, area: true,
  base: true, link: true, meta: true, param: true,
};

const VOID_ELEMENTS: Record<string, true> = { br: true, hr: true, img: true };

const MAX_DEPTH = 128;

function escapeText(text: string): string {
  return text.replace(/&(?![a-zA-Z]+;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attribute(name: string, value: string): string {
  return " " + name + "=\"" + escapeAttribute(value) + "\"";
}

function numeric(value: string, max: number): string {
  const text = String(value ?? "").trim();
  if (!/^\d{1,5}$/.test(text)) return "";
  const n = Number(text);
  return n > 0 && n <= max ? String(n) : "";
}

export interface SerializeOptions {
  /** Number each picture and wrap it in an `omarchy-image:N` link for the viewer. */
  linkImages?: boolean;
}

interface SerializeState {
  out: string[];
  linkImages: boolean;
  images: number;
  insideLink: number;
}

function serializeChildren(node: HtmlNode, state: SerializeState, depth: number) {
  for (const child of node.children ?? []) serializeNode(child, state, depth + 1);
}

// ------------------------------------------------------- layout tables
//
// Mail is laid out in tables: a notification is a table in a table in a
// table, each cell one block of the message. Drawn as a TextView table those
// are bordered boxes with header-styled text. Only a table that holds data
// stays a table; a layout table leaves as its cells, each a block.

const ROW_GROUPS: Record<string, true> = { thead: true, tbody: true, tfoot: true };
/** What a data cell does not hold: a cell with these is a layout box. */
const LAYOUT_CONTENT: Record<string, true> = {
  table: true, p: true, div: true, ul: true, ol: true, dl: true, blockquote: true, pre: true, img: true,
  h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, section: true, article: true, center: true,
};
const NUMERIC_CELL = /^[\s$€£¥%+\-−.,:()/\d]*\d[\s$€£¥%+\-−.,:()/\d]*$/;

function nameOf(node: HtmlNode): string {
  return node.type === "element" ? String(node.name ?? "").toLowerCase() : "";
}

/** The table's own rows: not those of a table nested in a cell. */
function ownRows(table: HtmlNode): HtmlNode[] {
  const rows: HtmlNode[] = [];
  for (const child of table.children ?? []) {
    const name = nameOf(child);
    if (name === "tr") rows.push(child);
    else if (ROW_GROUPS[name]) for (const row of child.children ?? []) if (nameOf(row) === "tr") rows.push(row);
  }
  return rows;
}

function cellsOf(row: HtmlNode): HtmlNode[] {
  return (row.children ?? []).filter((c) => nameOf(c) === "td" || nameOf(c) === "th");
}

function holdsLayout(node: HtmlNode, depth: number): boolean {
  if (depth > MAX_DEPTH) return true;
  for (const child of node.children ?? []) {
    if (LAYOUT_CONTENT[nameOf(child)] || holdsLayout(child, depth + 1)) return true;
  }
  return false;
}

function textOf(node: HtmlNode, depth = 0): string {
  if (depth > MAX_DEPTH) return "";
  if (node.type === "text") return node.raw ? "" : String(node.text ?? "");
  return (node.children ?? []).map((c) => textOf(c, depth + 1)).join("");
}

/**
 * Whether a table holds data, so it stays a table: a header row (`th`,
 * `thead`, `caption`), or a grid of at least 2 x 2 short cells, half or more
 * of them numbers. `role="presentation"` and every other table is layout.
 */
export function isDataTable(table: HtmlNode): boolean {
  const role = attributeValue(table, "role").toLowerCase();
  if (role === "presentation" || role === "none") return false;
  if ((table.children ?? []).some((c) => nameOf(c) === "caption" || nameOf(c) === "thead")) return true;
  const rows = ownRows(table);
  const cells = rows.map(cellsOf);
  if (cells.some((row) => row.some((cell) => nameOf(cell) === "th"))) return true;
  if (rows.length < 2 || cells.some((row) => row.length < 2)) return false;
  const all = cells.reduce<HtmlNode[]>((out, row) => out.concat(row), []);
  if (all.some((cell) => holdsLayout(cell, 0))) return false;
  const numbers = all.filter((cell) => NUMERIC_CELL.test(decodeReferences(textOf(cell)).trim())).length;
  return numbers * 2 >= all.length;
}

/** A layout table as its cells, in reading order, each a block. */
function serializeLayoutTable(table: HtmlNode, state: SerializeState, depth: number) {
  for (const row of ownRows(table)) {
    for (const cell of cellsOf(row)) {
      if (textOf(cell).trim() === "" && !holdsLayout(cell, 0)) continue;
      state.out.push("<div>");
      serializeChildren(cell, state, depth + 2);
      state.out.push("</div>");
    }
  }
}

function serializeNode(node: HtmlNode, state: SerializeState, depth: number) {
  if (depth > MAX_DEPTH) return;
  if (node.type === "text") {
    // Raw text is a raw-text element's content (a <style>'s): never prose.
    if (!node.raw) state.out.push(escapeText(String(node.text ?? "")));
    return;
  }
  if (node.type === "root") {
    serializeChildren(node, state, depth);
    return;
  }
  const name = String(node.name ?? "").toLowerCase();
  if (DROPPED_ELEMENTS[name]) return;
  if (!KEPT_ELEMENTS[name]) {
    serializeChildren(node, state, depth);
    return;
  }
  if (name === "table" && !isDataTable(node)) {
    serializeLayoutTable(node, state, depth);
    return;
  }

  if (name === "img") {
    const src = attributeValue(node, "src");
    // Only bytes already here: a remote source the backend did not replace
    // with data is a fetch, and there is no image without one.
    if (!isRasterDataImage(src) || isTrackingPixel(node)) {
      const alt = decodeReferences(attributeValue(node, "alt")).trim();
      if (alt !== "") state.out.push(escapeText(alt));
      return;
    }
    state.images++;
    let tag = "<img" + attribute("src", src);
    const alt = decodeReferences(attributeValue(node, "alt"));
    if (alt !== "") tag += attribute("alt", alt);
    const width = numeric(attributeValue(node, "width"), 4096);
    if (width !== "") tag += attribute("width", width);
    const height = numeric(attributeValue(node, "height"), 4096);
    if (height !== "" && width !== "") tag += attribute("height", height);
    tag += ">";
    if (state.linkImages && state.insideLink === 0) {
      state.out.push("<a" + attribute("href", imageLink(state.images)) + ">" + tag + "</a>");
    } else {
      state.out.push(tag);
    }
    return;
  }

  let open = "<" + name;
  if (name === "a") {
    const target = hasAttribute(node, "href") ? linkTarget(attributeValue(node, "href")) : "";
    if (target === "" || state.insideLink > 0) {
      // A link that may not be followed is text; anchors do not nest.
      serializeChildren(node, state, depth);
      return;
    }
    open += attribute("href", target);
  } else if (name === "td" || name === "th") {
    const span = numeric(attributeValue(node, "colspan"), 64);
    if (span !== "" && span !== "1") open += attribute("colspan", span);
  } else if (name === "ol") {
    const start = numeric(attributeValue(node, "start"), 99999);
    if (start !== "") open += attribute("start", start);
  }
  if (VOID_ELEMENTS[name]) {
    state.out.push(open + ">");
    return;
  }
  state.out.push(open + ">");
  if (name === "a") state.insideLink++;
  serializeChildren(node, state, depth);
  if (name === "a") state.insideLink--;
  state.out.push("</" + name + ">");
}

/**
 * The tree as the HTML TextView's `html` reads: kept elements, checked
 * values, pictures linked `omarchy-image:N` when asked. With `linkImages`,
 * the numbers agree with `documentImages(tree)`.
 */
export function toHtml(tree: HtmlNode | null | undefined, options: SerializeOptions = {}): string {
  if (!tree) return "";
  const state: SerializeState = { out: [], linkImages: options.linkImages === true, images: 0, insideLink: 0 };
  serializeNode(tree, state, 0);
  return state.out.join("");
}

// ============================================================== plain text

// Characters that draw nothing: senders pad preview lines with soft hyphens,
// grapheme joiners and zero-width spaces. Not U+00A0, which is a space.
const UNDRAWN_CHARACTERS = /[­͏؜᠎​-‏⁠-⁤﻿]/g;
const BLANK_LINE = /^[^\S\n]+$/gm;
const BLANK_RUN = /\n{3,}/g;

/** What the sender wrote, less what nothing draws; one blank line survives a run. */
export function readableText(text: unknown): string {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(UNDRAWN_CHARACTERS, "")
    .replace(BLANK_LINE, "")
    .replace(BLANK_RUN, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

const IMAGE_MARKER = /\[image (\d+)\]/g;
// A link the plain text draws itself: http(s) as typed.
const BARE_URL = /\bhttps?:\/\/[^\s<>"' ]+[^\s<>"'.,;:!?)\]} ]/gi;

function lineInlines(line: string, linkImages: boolean): TextViewInline[] {
  const out: TextViewInline[] = [];
  const pattern = new RegExp(IMAGE_MARKER.source + "|" + BARE_URL.source, "gi");
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const isMarker = match[1] !== undefined;
    const target = isMarker ? (linkImages ? imageLink(Number(match[1])) : "") : externallyOpenableHttpUrl(match[0]);
    if (target === "") continue;
    if (match.index > last) out.push({ type: "text", text: line.substring(last, match.index) });
    out.push({ type: "link", url: target, content: [{ type: "text", text: match[0] }] });
    last = match.index + match[0].length;
  }
  if (last < line.length) out.push({ type: "text", text: line.substring(last) });
  return out;
}

/**
 * The text as a TextView document: a paragraph per run of lines, a line break
 * per line, `[image N]` markers as `omarchy-image:N` links, and public web
 * addresses as links. Spacing is kept, because spacing is what somebody
 * reading in plain text asked to see.
 */
export function plainDocument(text: unknown, linkImages = true): TextViewDocument {
  const body = readableText(text);
  if (body === "") return { blocks: [] };
  const blocks: TextViewBlock[] = [];
  for (const paragraph of body.split(/\n{2,}/)) {
    const content: TextViewInline[] = [];
    paragraph.split("\n").forEach((line, i) => {
      if (i > 0) content.push({ type: "break" });
      content.push(...lineInlines(line, linkImages));
    });
    if (content.length > 0) blocks.push({ type: "paragraph", content });
  }
  return { blocks };
}

// ======================================================= which mode is on
//
// Three ways of reading a message and one preference across all of them, so a
// message that cannot be drawn the chosen way falls through to the one that
// can rather than showing an empty panel: reader, the sender's own
// formatting, then text.
export type BodyMode = "reader" | "original" | "plain";
const BODY_MODES: Record<string, true> = { reader: true, original: true, plain: true };

export interface BodyOffer {
  html?: boolean;
  reader?: boolean;
  readerHeavy?: boolean;
  originalHeavy?: boolean;
  forced?: boolean;
}

/** A stored preference, or anything else, read as one of the three. */
export function bodyModeOf(value: unknown, fallback?: unknown): BodyMode {
  const wanted = String(value ?? "");
  if (BODY_MODES[wanted]) return wanted as BodyMode;
  const other = String(fallback ?? "");
  return BODY_MODES[other] ? (other as BodyMode) : "reader";
}

export function resolveBodyMode(wanted: unknown, available: BodyOffer | null | undefined): BodyMode {
  const has = available ?? {};
  let want: BodyMode = BODY_MODES[String(wanted)] ? (wanted as BodyMode) : "reader";
  // No markup at all: the text is not a fallback, it is the message.
  if (has.html !== true) return "plain";
  if (want === "plain") return "plain";
  if (want === "reader" && has.reader !== true) want = "original";
  const heavy = want === "reader" ? has.readerHeavy === true : has.originalHeavy === true;
  // A document past the bounds gets the text instead, until somebody insists.
  if (heavy && has.forced !== true) return "plain";
  return want;
}

/** The reader had nothing to rebuild, so the sender's layout is on screen instead. */
export function bodyModeEmptied(wanted: unknown, available: BodyOffer | null | undefined): boolean {
  const has = available ?? {};
  if (wanted !== "reader" || has.html !== true) return false;
  return has.reader !== true && resolveBodyMode(wanted, available) === "original";
}

/** The plain text on screen is a refusal (too heavy) rather than a request. */
export function bodyModeRefused(wanted: unknown, available: BodyOffer | null | undefined): boolean {
  const has = available ?? {};
  if (wanted === "plain" || has.html !== true) return false;
  return resolveBodyMode(wanted, available) === "plain";
}

// ============================================================= the measure

/** Fit the chosen content-width ceiling inside the available panel space. */
export function readingColumnWidth(available: unknown, maximum: unknown): number {
  const room = Math.max(80, Math.floor(Number(available) || 0));
  const ideal = Math.floor(Number(maximum) || 0);
  return ideal > 0 ? Math.min(room, ideal) : room;
}

/** Centred in what is left over. */
export function readingColumnOffset(available: unknown, width: unknown): number {
  const room = Math.max(0, Math.floor(Number(available) || 0));
  const column = Math.max(0, Math.floor(Number(width) || 0));
  return Math.max(0, Math.round((room - column) / 2));
}
