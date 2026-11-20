const assert = require("assert")
const { load, deepEqual } = require("./load")

const html = load("message/Html.js")
const images = load("message/Images.js")

// Kept out of test_html.js on purpose: golden.js replays that file against
// the Rust sanitizer, and linking pictures to the viewer is a view concern.

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLa0AAAAASUVORK5CYII="
const GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA="

function tree(markup) { return html.documentTree(markup) }
function links(text) { return (text.match(/href="omarchy-image:\d+"/g) || []).map(function(m) { return m.slice(6, -1) }) }

// ------------------------------------------------- numbering and the list

// Three pictures, the second inside a sender's link. Every picture is
// numbered and listed in the same order; the linked one keeps the sender's
// link instead of nesting a second anchor inside it.
const body = "<p>One <img src=\"" + PNG + "\"></p>"
  + "<p><a href=\"https://example.org/\"><img src=\"" + GIF + "\"></a></p>"
  + "<p><img src=\"" + PNG + "\" width=\"40\"></p>"
const original = html.documentFor(tree(body), { linkImages: true })
deepEqual(links(original), ["omarchy-image:1", "omarchy-image:3"])
assert.ok(!/<a href="https:\/\/example.org\/"><a /.test(original), "anchors never nest")
assert.ok(/<a href="https:\/\/example.org\/"><img src="data:image\/gif/.test(original),
  "a picture inside a sender's link keeps that link")
deepEqual(images.documentImages(tree(body)), [PNG, GIF, PNG],
  "the list the numbers index has every picture, in the same order")

// Off unless asked: the plain document tree is serialized as before.
assert.strictEqual(links(html.documentFor(tree(body), {})).length, 0)

// Reading mode numbers the same way over its own document.
const reading = html.readerDocumentFor(tree("<p>Text</p><p><img src=\"" + PNG + "\"></p>"), { linkImages: true })
deepEqual(links(reading), ["omarchy-image:1"])

// A sender cannot write a viewer link: the sanitizer keeps only http(s) and
// mailto hrefs, so the only viewer links are the ones numbered here.
const forged = html.sanitize("<p><a href=\"omarchy-image:2\">click</a> <img src=\"" + PNG + "\"></p>",
  { withReader: true })
for (const doc of [html.documentFor(forged.document, { linkImages: true }),
                   html.readerDocumentFor(forged.reader.document, { linkImages: true })]) {
  deepEqual(links(doc), ["omarchy-image:1"], doc)
}

// A remote address that was never prepared is not a picture here.
deepEqual(images.documentImages(tree("<img src=\"https://example.org/a.png\">")), [])

// ------------------------------------------------------------- the gallery

const attachments = [
  { filename: "scan.pdf", mimeType: "application/pdf", attachmentId: "a1", size: 10 },
  { filename: "photo.jpg", mimeType: "image/jpeg", attachmentId: "a2", size: 2048 },
  { filename: "IMG_0001.HEIC", mimeType: "image/heic", attachmentId: "a3", size: 2048 },
  { filename: "camera.png", mimeType: "application/octet-stream", attachmentId: "a4", size: 9 * 1024 * 1024 },
  { filename: "no-id.png", mimeType: "image/png", attachmentId: "", size: 10 }
]
const entries = images.gallery([PNG, "https://example.org/pending.png"], attachments, true)
deepEqual(entries.map(function(e) { return e.kind + ":" + e.name }),
  ["marker:Image 1", "marker:Image 2", "attachment:photo.jpg", "attachment:camera.png"],
  "HEIC, a PDF and an attachment the provider cannot fetch are not pages")
assert.strictEqual(entries[0].source, PNG)
assert.strictEqual(entries[1].source, "", "a marker's remote picture is fetched when shown")
assert.strictEqual(images.attachmentIndex(entries, attachments[1]), 2)
assert.strictEqual(images.attachmentIndex(entries, attachments[2]), -1)

assert.ok(!images.viewable(attachments[2]), "HEIC opens elsewhere")
assert.ok(images.viewable(attachments[3]), "a known extension counts when the type is generic")
assert.ok(images.isImage(attachments[2]), "HEIC is a picture for a thumbnail's type tile")
assert.ok(images.thumbnailable(attachments[1]))
assert.ok(!images.thumbnailable(attachments[3]), "a large file gets a type tile, not a decode")
assert.strictEqual(images.typeLabel(attachments[2]), "HEIC")

// ------------------------------------------------- stepping, zoom, names

assert.strictEqual(images.step(0, 4, -1), 3)
assert.strictEqual(images.step(3, 4, 1), 0)
assert.strictEqual(images.step(0, 0, 1), -1)
assert.strictEqual(images.counter(2, 7), "3 / 7")
assert.strictEqual(images.fitScale(4000, 1000, 800, 600), 0.2)
assert.strictEqual(images.fitScale(100, 50, 800, 600), 1, "a small picture is not enlarged to fit")
assert.strictEqual(images.zoomBy(1, 1), 1.25)
assert.strictEqual(images.zoomBy(8, 1), images.MAX_ZOOM)
assert.strictEqual(images.zoomBy(0.1, -1), images.MIN_ZOOM)
assert.strictEqual(images.filenameFor({ kind: "body", number: 3, source: GIF }), "image-3.gif")
assert.strictEqual(images.filenameFor({ kind: "attachment", attachment: attachments[1] }), "photo.jpg")
assert.strictEqual(images.payloadOf(PNG), PNG.substring(PNG.indexOf(",") + 1))
assert.strictEqual(images.payloadOf("https://example.org/a.png"), "")

console.log("test_images.js ok")
