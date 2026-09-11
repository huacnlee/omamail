.pragma library
.import "Html.js" as Html

// A signature imported from a file: a picture, or a page of markup somebody
// else's tool wrote. What is stored is never the file. A picture is checked
// to be the raster it claims and wrapped in one `<img>`; markup goes through
// the same gate the reader trusts for a stranger's message — `Html.sanitize`,
// which drops scripts, handlers and every fetch — and is then walked once
// more here against a short list of what can never be in a signature, so
// the argument does not rest on one pass. The formatting the file carries
// — colours, faces, sizes, tables, alignment — is kept: it is what the
// owner imported the file for. Scripts, styles blocks, forms, frames,
// objects, event handlers, remote images and every address that is not a
// public link, a mailto or an inline picture do not survive, and the count
// of what was dropped is reported so the preview can say so.

var MAX_HTML_BYTES = 256 * 1024
var MAX_IMAGE_BYTES = 512 * 1024
var MAX_DATA_IMAGES = 8

// What can never be in a signature, whatever the sanitiser kept: elements
// that run, embed, or take input, and attributes that name an address or a
// handler. Everything else — inline style without a url(), class, colour,
// face, size, alignment, table geometry — stays.
var FORBIDDEN_ELEMENTS = ["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "form", "input", "button", "select", "textarea", "option", "svg", "math", "template", "link", "meta",
  "base", "video", "audio", "source", "track", "canvas", "noscript"]
var FORBIDDEN_ATTRIBUTES = ["action", "formaction", "background", "srcset", "poster", "xlink:href",
  "data", "codebase", "usemap", "ping", "manifest", "longdesc", "profile"]

var RASTERS = [
  { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46], at12: [0x57, 0x45, 0x42, 0x50] }
]

function base64Prefix(data, count) {
  var text = String(data || "").replace(/[^A-Za-z0-9+\/=]/g, "")
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  var bytes = []
  var bits = 0
  var value = 0
  for (var i = 0; i < text.length && bytes.length < count; i++) {
    var ch = text.charAt(i)
    if (ch === "=") break
    var index = alphabet.indexOf(ch)
    if (index < 0) return []
    value = (value << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
    }
  }
  return bytes
}

// The raster a base64 body is, by its first bytes, or "" for anything else.
// The declared type is not consulted: an SVG named PNG is the case this
// exists to refuse, because SVG is a document with scripts in it.
function rasterKind(base64) {
  var head = base64Prefix(base64, 16)
  for (var r = 0; r < RASTERS.length; r++) {
    var raster = RASTERS[r]
    var ok = head.length >= raster.magic.length
    for (var i = 0; ok && i < raster.magic.length; i++) if (head[i] !== raster.magic[i]) ok = false
    if (ok && raster.at12) {
      ok = head.length >= 16
      for (var j = 0; ok && j < 4; j++) if (head[8 + j] !== raster.at12[j]) ok = false
    }
    if (ok) return raster.mime
  }
  return ""
}

function base64Bytes(base64) {
  var text = String(base64 || "").replace(/[^A-Za-z0-9+\/=]/g, "")
  var padding = text.length > 0 && text.charAt(text.length - 1) === "=" ? (text.charAt(text.length - 2) === "=" ? 2 : 1) : 0
  return Math.floor(text.length * 3 / 4) - padding
}

// A picture as a signature: one image, its type read from its bytes.
function importImage(base64, options) {
  var settings = options || {}
  var limit = Math.max(1, Math.floor(Number(settings.maxImageBytes) || MAX_IMAGE_BYTES))
  var mime = rasterKind(base64)
  if (mime === "") return { html: "", plain: "", problem: "That file is not a PNG, JPEG, GIF or WebP image" }
  var size = base64Bytes(base64)
  if (size > limit) return { html: "", plain: "", problem: "That image is larger than " + Math.round(limit / 1024) + " KB" }
  var clean = String(base64 || "").replace(/[^A-Za-z0-9+\/=]/g, "")
  return { html: "<p><img src=\"data:" + mime + ";base64," + clean + "\"></p>", plain: "", dropped: 0, images: 1, problem: "" }
}

function dataImageOk(value, limit) {
  var match = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+\/=]+)$/i.exec(String(value || ""))
  if (!match) return false
  if (base64Bytes(match[2]) > limit) return false
  var kind = rasterKind(match[2])
  return kind !== "" && (kind === match[1].toLowerCase() || (kind === "image/jpeg" && /jpe?g/i.test(match[1])))
}

function hrefOk(value) {
  var url = String(value || "").trim()
  if (/^mailto:[^\s<>"]+$/i.test(url)) return true
  var match = /^https?:\/\/([^\/?#:]+)/i.exec(url)
  return !!match && Html.isPublicHost(match[1])
}

// The second walk: drop what can never be here, count it, keep the rest.
function prune(node, ctx) {
  var kept = []
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") { kept.push(child); continue }
    if (child.type !== "element") { ctx.dropped++; continue }
    var name = String(child.name || "").toLowerCase()
    if (FORBIDDEN_ELEMENTS.indexOf(name) >= 0) { ctx.dropped++; continue }
    var attrs = []
    var list = Array.isArray(child.attrs) ? child.attrs : []
    for (var a = 0; a < list.length; a++) {
      var attr = list[a]
      var attrName = String(attr.name || "").toLowerCase()
      var value = String(attr.value === undefined ? "" : attr.value)
      if (attrName.indexOf("on") === 0 || FORBIDDEN_ATTRIBUTES.indexOf(attrName) >= 0) { ctx.dropped++; continue }
      if (attrName === "href" && !hrefOk(value)) { ctx.dropped++; continue }
      if (attrName === "src") {
        if (name !== "img" || !dataImageOk(value, ctx.imageLimit) || ctx.images >= MAX_DATA_IMAGES) { ctx.dropped++; continue }
        ctx.images++
      }
      // A style that fetches, runs, or hides text is dropped whole: a
      // signature has no business carrying invisible words.
      if (attrName === "style" && /url\s*\(|expression\s*\(|@import|behavior\s*:|javascript:|display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?![.\d])|font-size\s*:\s*0?\.\d|text-indent\s*:\s*-/i.test(value)) { ctx.dropped++; continue }
      attrs.push({ name: attrName, value: value })
    }
    child.attrs = attrs
    child.name = name
    if (name === "img" && attrs.filter(function(x) { return x.name === "src" }).length === 0) { ctx.dropped++; continue }
    prune(child, ctx)
    kept.push(child)
  }
  node.children = kept
}

function sourceRemovals(source) {
  var text = String(source || "")
  var count = 0
  var patterns = [/<\s*(script|style|iframe|object|embed|form|input|svg|template|link|meta)\b/gi,
    /\son[a-z]+\s*=/gi, /javascript\s*:/gi, /url\s*\(/gi, /\sbackground\s*=/gi]
  for (var i = 0; i < patterns.length; i++) {
    var found = text.match(patterns[i])
    if (found) count += found.length
  }
  return count
}

// Markup as a signature. Returns what is stored (`html`), the plain text a
// text-only client sees (`plain`), how many things were dropped, and a
// problem where the file cannot be a signature at all.
function importHtml(html, options) {
  var settings = options || {}
  var source = String(html === undefined || html === null ? "" : html)
  if (source.length > Math.max(1, Math.floor(Number(settings.maxHtmlBytes) || MAX_HTML_BYTES)))
    return { html: "", plain: "", dropped: 0, images: 0, problem: "That file is too large for a signature" }
  var cleaned = Html.sanitize(source, { allowRemoteImages: false, keepColors: true })
  // What the sanitiser took out is counted from the source, since it reports
  // only images: every script, frame, form and handler the file carried is a
  // removal the preview should own up to.
  var ctx = { dropped: sourceRemovals(source) + cleaned.blockedImages, images: 0,
    imageLimit: Math.max(1, Math.floor(Number(settings.maxImageBytes) || MAX_IMAGE_BYTES)) }
  var document = Html.parse(cleaned.html)
  prune(document, ctx)
  var text = Html.serialize(document)
  var read = Html.readTree(document)
  var plain = String(read && read.text !== undefined ? read.text : read || "").replace(/[ \t]+\n/g, "\n").trim()
  if (text.trim() === "" || (plain === "" && ctx.images === 0))
    return { html: "", plain: "", dropped: ctx.dropped, images: 0, problem: "Nothing in that file can be a signature" }
  return { html: text, plain: plain, dropped: ctx.dropped, images: ctx.images, problem: "" }
}

// What the preview says about the import.
function importNote(result) {
  if (!result) return ""
  if (result.problem) return result.problem
  var parts = []
  if (result.images > 0) parts.push(result.images === 1 ? "1 image" : result.images + " images")
  if (result.dropped > 0) parts.push(result.dropped + " unsafe or unsupported " + (result.dropped === 1 ? "part" : "parts") + " removed")
  return parts.length === 0 ? "Imported" : "Imported: " + parts.join(", ")
}

// The data: images a stored signature carries, each swapped for a cid: so
// the message can carry them as parts; a client that hides data: images in
// HTML mail still shows a related part.
function inlineParts(html, prefix) {
  var text = String(html || "")
  var parts = []
  var stem = String(prefix || "sig")
  var out = text.replace(/src="data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+\/=]+)"/gi,
    function(all, mime, data) {
      var id = stem + (parts.length + 1) + "@omamail"
      parts.push({ cid: id, mimeType: mime.toLowerCase(), data: data })
      return "src=\"cid:" + id + "\""
    })
  return { html: out, parts: parts }
}
