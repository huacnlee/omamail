const assert = require("assert")
const { load, deepEqual } = require("./load")

const html = load("Html.js")

// ------------------------------------------------------------- stripping
//
// Qt's rich text engine ignores unknown tags but renders the *text content*
// of a <style> block, so a message with a stylesheet shows its CSS as a wall
// of text unless the block is removed outright.

assert.strictEqual(html.sanitize("<style>p{color:red}</style><p>hi</p>").html, "<p>hi</p>")
assert.strictEqual(html.sanitize("<script>alert(1)</script>text").html, "text")
assert.strictEqual(html.sanitize("<iframe src='x'></iframe>text").html, "text")
assert.strictEqual(html.sanitize("<p onclick='x()'>hi</p>").html, "<p>hi</p>")
assert.strictEqual(html.sanitize("<a href='javascript:x()'>hi</a>").html, "<a>hi</a>")
assert.strictEqual(html.sanitize("<!-- c -->kept").html, "kept")
assert.strictEqual(html.sanitize("<meta charset='utf-8'>body").html, "body")

// The tags that carry an email's actual layout must survive untouched. Real
// mail is still table-and-inline-style HTML written for Outlook, which is
// exactly the subset Qt renders.
// Layout survives; the sender's palette does not (see the theming block).
const table = "<table><tr><td style=\"padding:6px\"><b>Total</b></td></tr></table>"
assert.strictEqual(html.sanitize(table).html, table)
assert.strictEqual(html.sanitize("<a href=\"https://example.com\">link</a>").html,
  "<a href=\"https://example.com\">link</a>")
assert.strictEqual(html.sanitize("<a href=\"mailto:a@b.com\">mail</a>").html,
  "<a href=\"mailto:a@b.com\">mail</a>")

// -------------------------------------------------------- remote images
//
// Qt fetches <img src="https://..."> for real. Left alone, every tracking
// pixel in the message fires the moment the reader opens it.

const tracked = "<p>Hi</p><img src=\"https://track.example/pixel.gif\" width=\"1\">"
const blocked = html.sanitize(tracked)
assert.strictEqual(blocked.blockedImages, 1)
assert.ok(blocked.html.indexOf("track.example") < 0, "the URL must not reach the renderer")
assert.ok(blocked.html.indexOf("<p>Hi</p>") === 0, "the rest of the message is untouched")

// A 1x1 image is a beacon, never something to look at, so it goes even when
// images are welcome. Every real message in a live mailbox carries one.
const allowedPixel = html.sanitize(tracked, { allowRemoteImages: true })
assert.strictEqual(allowedPixel.images, 0)
assert.strictEqual(allowedPixel.blockedImages, 1)
assert.strictEqual(html.sanitize("<img src='https://a/b.gif' height=\"1\">",
  { allowRemoteImages: true }).images, 0)
assert.strictEqual(html.sanitize("<img src='https://a/b.gif' style='width:1px;height:1px'>",
  { allowRemoteImages: true }).images, 0)

// A real picture is kept.
const real = "<img src=\"https://cdn.example/photo.png\" width=\"600\" height=\"400\">"
assert.strictEqual(html.sanitize(real, { allowRemoteImages: true }).images, 1)
assert.ok(html.sanitize(real, { allowRemoteImages: true }).html.indexOf("photo.png") > 0)
assert.strictEqual(html.sanitize(real).images, 0, "still off unless asked for")

// Every image is a fetch Qt performs during layout, and every completed fetch
// triggers another layout pass, so the count is capped.
let many = ""
for (let i = 0; i < html.MAX_IMAGES + 8; i++) many += "<img src=\"https://cdn/" + i + ".png\" width=\"90\">"
const capped = html.sanitize(many, { allowRemoteImages: true })
assert.strictEqual(capped.images, html.MAX_IMAGES)
assert.strictEqual(capped.blockedImages, 8)
assert.strictEqual(html.sanitize(many, { allowRemoteImages: true, maxImages: 3 }).images, 3)

// -------------------------------------------------------------- complexity
//
// Qt lays rich text out synchronously on the GUI thread, and this plugin runs
// inside the shell that draws the whole desktop. A document heavy enough to
// stall that layout stalls the bar and every other panel with it, so the
// reader has to be able to refuse one.

assert.strictEqual(html.tooHeavyForRichText("<p>ordinary</p>"), false)
assert.strictEqual(html.tooHeavyForRichText("x".repeat(html.MAX_RICH_TEXT + 1)), true)
assert.strictEqual(html.tooHeavyForRichText("<div></div>".repeat(html.MAX_ELEMENTS + 1)), true)
assert.strictEqual(html.tooHeavyForRichText(""), false)
assert.strictEqual(html.tooHeavyForRichText(null), false)

// Opening tags only — a closing tag adds no element to lay out.
const size = html.complexity("<div><p>hi</p><img src='x'></div>")
assert.strictEqual(size.tags, 3)
assert.strictEqual(size.images, 1)
assert.strictEqual(html.complexity(null).length, 0)

// cid: images point at attachments this plugin does not fetch, and data: URIs
// are already local. Neither is a network request, and neither is counted.
assert.strictEqual(html.sanitize("<img src=\"cid:logo\">").blockedImages, 0)
assert.strictEqual(html.sanitize("<img src=\"data:image/png;base64,AAA\">").blockedImages, 0)
assert.strictEqual(html.sanitize("<img src='http://a/b.png'><img src='https://c/d.png'>").blockedImages, 2)
assert.strictEqual(html.sanitize("<img src='http://a/b.png'><img src='https://c/d.png'>",
  { allowRemoteImages: true }).images, 2, "images with no stated size are real pictures")
// Protocol-relative sources are still network fetches.
assert.strictEqual(html.sanitize("<img src=\"//cdn.example/x.png\">").blockedImages, 1)

assert.strictEqual(html.hasRemoteImages(tracked), true)
assert.strictEqual(html.hasRemoteImages("<p>none</p>"), false)

assert.strictEqual(html.sanitize("").html, "")
assert.strictEqual(html.sanitize(null).html, "")
assert.strictEqual(html.sanitize(null).blockedImages, 0)

// ----------------------------------------------------------- theming
//
// A sender ships a background AND the text colour that suits it. Removing only
// the background is what makes a message unreadable — GitHub's #24292e text
// would land on a #131313 ground — so both come out and the document
// stylesheet supplies the pair.

assert.strictEqual(html.stripColors("<td bgcolor=\"#ffffff\">hi</td>"), "<td>hi</td>")
assert.strictEqual(html.stripColors("<font color=\"#333\">hi</font>"), "<font>hi</font>")
assert.strictEqual(html.stripColors("<p style=\"color:#24292e\">hi</p>"), "<p>hi</p>")
assert.strictEqual(html.stripColors("<p style=\"background-color:#fff\">hi</p>"), "<p>hi</p>")

// Everything that is not a colour survives: layout is the sender's to keep.
assert.strictEqual(
  html.stripColors("<p style=\"color:#111;font-weight:bold;padding:4px\">hi</p>"),
  "<p style=\"font-weight:bold;padding:4px\">hi</p>")
assert.strictEqual(
  html.stripColors("<div style=\"margin:0;background:#eee;width:600px\">x</div>"),
  "<div style=\"margin:0;width:600px\">x</div>")
assert.strictEqual(html.stripColors("<img src=\"a.png\" width=\"600\">"),
  "<img src=\"a.png\" width=\"600\">", "an image is not a colour")
assert.strictEqual(html.stripColors(""), "")
assert.strictEqual(html.stripColors(null), "")

// sanitize does it by default, so nothing renders in the sender's palette
// unless a caller explicitly asks to keep it.
assert.ok(html.sanitize("<td bgcolor=\"#fff\" style=\"color:#000\">x</td>").html.indexOf("#") < 0)
assert.ok(html.sanitize("<td bgcolor=\"#fff\">x</td>", { keepColors: true }).html.indexOf("#fff") > 0)

// --------------------------------------------------------- table nesting
//
// Qt lays tables out by resolving column widths against each other, and
// deeply nested tables with competing widths keep that resolution going far
// longer than anyone waits — with the GUI thread held, which in this plugin is
// the thread drawing the whole desktop. Real mail in a live mailbox reaches
// nine levels of nesting.

assert.strictEqual(html.tableDepth("<table><tr><td>x</td></tr></table>"), 1)
assert.strictEqual(html.tableDepth("<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>"), 2)
assert.strictEqual(html.tableDepth("<p>none</p>"), 0)
assert.strictEqual(html.tableDepth(null), 0)
// Sibling tables are not nesting.
assert.strictEqual(html.tableDepth("<table></table><table></table>"), 1)

// A shallow table is real tabular content and survives untouched.
const shallow = "<table><tr><td>Status</td><td>Job</td></tr></table>"
assert.strictEqual(html.flattenTables(shallow, 2), shallow)

// Past the limit the structure becomes plain blocks, keeping the content and
// whatever styling rode on it.
const deep = "<table><tr><td><table><tr><td><table><tr><td style=\"padding:4px\">deep</td></tr></table></td></tr></table></td></tr></table>"
const flat = html.flattenTables(deep, 2)
assert.strictEqual(html.tableDepth(flat), 2, "nothing survives past the limit")
assert.ok(flat.indexOf("deep") > 0, "the content stays")
assert.ok(flat.indexOf("padding:4px") > 0, "and so does its styling")
// Tags balance, or Qt renders the rest of the message inside a stray block.
assert.strictEqual((flat.match(/<div/g) || []).length, (flat.match(/<\/div>/g) || []).length)

// sanitize flattens by default; a caller can ask for the original.
assert.strictEqual(html.complexity(html.sanitize(deep).html).tableDepth, 2)
assert.strictEqual(html.complexity(html.sanitize(deep, { keepTables: true }).html).tableDepth, 3)

// The backstop still catches anything flattening cannot tame.
let wide = ""
for (let i = 0; i < html.MAX_TABLES + 5; i++) wide += "<table><tr><td>x</td></tr></table>"
assert.strictEqual(html.tooHeavyForRichText(wide), true, "too many tables is still too many")

// ------------------------------------------------------------- document
//
// Colours are passed in from the panel, which reads them off the active theme.
// Nothing in this file may name a colour.

const doc = html.documentFor("<p>hi</p>", {
  foreground: "#cacccc", background: "#101315", link: "#7aa2f7", quote: "#707880"
})
assert.ok(doc.indexOf("<p>hi</p>") > 0)
assert.ok(doc.indexOf("#cacccc") > 0, "the theme foreground reaches the document")
assert.ok(doc.indexOf("blockquote") > 0, "quoted replies get their own colour")
assert.ok(doc.indexOf("<html>") === 0)

// A caller that passes nothing still gets a well-formed document rather than
// "undefined" in the stylesheet.
const bare = html.documentFor("x")
assert.ok(bare.indexOf("undefined") < 0)
assert.ok(bare.indexOf("x</body>") > 0)


// ------------------------------------------------- plain text with images
//
// Stripping images outright left a message built around its pictures reading as
// a long run of unexplained blank space.
{
  deepEqual(html.imageSources('<img src="a.png"><img src=\'b b.png\'><img data-x=1 src=c.png >'),
    ["a.png", "b b.png", "c.png"])
  deepEqual(html.imageSources(""), [])
  deepEqual(html.imageSources("<img alt=none>"), [""], "an image with no src still holds its place")

  var plainDoc = html.plainTextDocument("Hi\n[image 1]  spaced\n<b>not bold</b>",
    { foreground: "#DEDEDE", background: "#131313", link: "#077CFD" }, true)
  assert.ok(plainDoc.indexOf('<a href="omarchy-image:1">[image 1]</a>') > 0, "markers become links")
  assert.ok(plainDoc.indexOf("&lt;b&gt;not bold&lt;/b&gt;") > 0, "text is escaped, never interpreted")
  assert.ok(plainDoc.indexOf("&nbsp;&nbsp;spaced") > 0, "hand-made alignment survives")
  assert.ok(plainDoc.indexOf("Hi<br>") > 0, "line breaks survive")

  // A message that shipped its own text/plain part never had images in it.
  assert.ok(html.plainTextDocument("[image 1]", {}, false).indexOf("<a ") < 0,
    "markers are left alone when the text is the sender's own")

  assert.strictEqual(html.imageLinkIndex("omarchy-image:3"), 3)
  assert.strictEqual(html.imageLinkIndex("https://example.com"), 0, "ordinary links are untouched")
  assert.strictEqual(html.imageLinkIndex("omarchy-image:0"), 0)
  assert.strictEqual(html.imageLinkIndex(""), 0)
}


// ------------------------------------------------------- fitting to width
//
// These encode facts measured against Qt's own rich text engine: max-width is
// honoured in pixels but a percentage collapses the image, and an explicit
// height survives the clamp and smears the picture.
{
  var img = html.stripImageHeights(
    '<img src=a.png width="1600" height="400" style="width:1600px;height:400px;max-height:9px">')
  assert.ok(img.indexOf('height="400"') < 0, "the height attribute goes")
  assert.ok(img.indexOf("height:400px") < 0, "so does the height declaration")
  assert.ok(img.indexOf('width="1600"') > 0, "the width stays; Qt derives height from it")
  assert.ok(img.indexOf("max-height:9px") > 0, "max-height is not a height")

  var fitDoc = html.documentFor("<img src=a.png>",
    { foreground: "#fff", background: "#000", maxImageWidth: 380 })
  assert.ok(fitDoc.indexOf("img{max-width:380px;}") > 0, "a pixel ceiling, never a percentage")
  assert.ok(html.documentFor("<p>x</p>", {}).indexOf("img{") < 0,
    "no ceiling until the width is known")

  var compact = html.compactHorizontal(
    '<div style="padding-left:40px;margin:10px 30px;padding:5px 20px 7px 20px">x</div>')
  assert.ok(compact.indexOf("padding-left") < 0, "side gutters go")
  assert.ok(compact.indexOf("margin:10px 0") > 0, "vertical rhythm stays")
  assert.ok(compact.indexOf("padding:5px 0 7px 0") > 0, "all four sides handled")

  var relaxed = html.relaxFixedWidths(
    '<table width="600"><td width="100" style="width:640px">x</td></table>', 380)
  assert.ok(relaxed.indexOf('width="600"') < 0, "a table wider than the window gives it up")
  assert.ok(relaxed.indexOf('width="100"') > 0, "one that fits is left alone")
  assert.ok(relaxed.indexOf("width:640px") < 0, "declared widths too")
}

console.log("test_html.js ok")