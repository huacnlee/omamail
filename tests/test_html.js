const assert = require("assert")
const { load, deepEqual } = require("./load")

const html = load("Html.js")

// =============================================================== the parser
//
// The gate is only as good as where it thinks a tag stops, so this is the part
// that gets read the way Qt reads it: tags by scanning, attributes with their
// quotes, raw-text elements by their own closing tag.
{
  // Structure in, same structure out. A browser's parser would insert a
  // <tbody> here, hoist stray content out of the table and reopen formatting
  // across a block; every one of those is a change to mail nobody asked for.
  const untouched = [
    "<table><tr><td>a</td><td>b</td></tr></table>",
    "<p>plain <b>bold <i>both</i></b> tail</p>",
    "<div><ul><li>one</li><li>two</li></ul></div>",
    "<blockquote><p>quoted</p></blockquote>"
  ]
  for (const markup of untouched) assert.strictEqual(html.stripColors(markup), markup)

  // Closed, never moved: mail leaves <td> and <li> open constantly, and without
  // an implied close each one nests inside the last.
  assert.strictEqual(html.stripColors("<ul><li>one<li>two</ul>"),
    "<ul><li>one</li><li>two</li></ul>")
  assert.strictEqual(html.stripColors("<table><tr><td>a<td>b</table>"),
    "<table><tr><td>a</td><td>b</td></tr></table>")
  assert.strictEqual(html.stripColors("<p>one<p>two"), "<p>one</p><p>two</p>")

  // What the sender left open is closed at the end; what they closed twice is
  // closed once. A stray end tag closes nothing, because the only other reading
  // would close something they meant to keep.
  assert.strictEqual(html.stripColors("<div><span>x"), "<div><span>x</span></div>")
  assert.strictEqual(html.stripColors("x</div></p>"), "x")
  // Mis-nesting comes out well-formed rather than mis-nested.
  assert.strictEqual(html.stripColors("<b><i>x</b></i>"), "<b><i>x</i></b>")

  // Attribute values are read with their quotes, so a ">" in one does not end
  // the tag — and an unquoted value ends at whitespace.
  assert.strictEqual(html.stripColors("<a title=\"a>b\" href=\"https://x.example.com\">t</a>"),
    "<a title=\"a>b\" href=\"https://x.example.com\">t</a>")
  assert.strictEqual(html.stripColors("<img src=a.png width=600>"),
    "<img src=\"a.png\" width=\"600\">")
  assert.strictEqual(html.stripColors("<input disabled>"), "<input disabled>")
  // A single-quoted value is re-quoted, so the quote inside it has to go.
  assert.strictEqual(html.stripColors("<a title='say \"hi\"'>t</a>"),
    "<a title=\"say &quot;hi&quot;\">t</a>")

  // Old mail is shouted, and names are matched folded. The reader takes the
  // fast path when it saw no capital while scanning a name, so the shouted form
  // is its own path and has to be checked.
  assert.strictEqual(
    html.sanitize("<DIV STYLE=\"COLOR:red;padding:4px\"><IMG SRC=\"https://cdn.example.com/a.png\" WIDTH=\"90\">x</DIV>",
      { allowRemoteImages: true }).html,
    "<div style=\"padding:4px\"><img src=\"https://cdn.example.com/a.png\" width=\"90\">x</div>")
  assert.strictEqual(html.sanitize("<SCRIPT>bad()</SCRIPT>ok").html, "ok")
  assert.strictEqual(html.sanitize("<P STYLE=\"DISPLAY:NONE\">secret</P><p>real</p>").html, "<p>real</p>")
  assert.strictEqual(html.sanitize("<A HREF=\"JAVASCRIPT:x()\">t</A>").html, "<a>t</a>")

  // A "<" that starts no tag is a "<" the sender typed.
  assert.strictEqual(html.stripColors("a < b and 3<4"), "a < b and 3<4")

  // A raw-text element ends at its own closing tag and at nothing else, so a
  // stylesheet cannot hide markup from the walk that follows it.
  assert.strictEqual(html.sanitize("<style>p::after{content:\"<img src=x>\"}</style>ok").html, "ok")
  assert.strictEqual(html.sanitize("<script>var a = 1 < 2;</script>ok").html, "ok")
  // ...and per the spec the first "</style" ends it, whatever it is inside.
  assert.ok(html.sanitize("<style>a{}</style><p>after</p>").html.indexOf("<p>after</p>") >= 0)

  // A tag that never closes takes the rest of the document with it, which is
  // what Qt does with it too — and is the reading that cannot leave a fetch
  // behind.
  assert.strictEqual(html.sanitize("<p>kept</p><div class=\"never").html, "<p>kept</p>")

  // A doctype is not text: Qt would lay it out as a line above the message.
  assert.strictEqual(html.sanitize("<!DOCTYPE html><p>hi</p>").html, "<p>hi</p>")

  // A title is not body text either, and nearly every marketing mail ships one.
  assert.strictEqual(html.sanitize("<head><title>Newsletter</title></head><p>real</p>").html,
    "<head></head><p>real</p>")
}

// A tree is walked by recursion everywhere downstream, so a message nested a
// few thousand elements deep would be a stack overflow inside the process that
// draws the whole desktop. Past the ceiling an element keeps its content, it
// just stops adding a level to hold it.
{
  const deepest = "<div>".repeat(20000) + "<img src=\"http://127.0.0.1/x.png\">text"
  const out = html.sanitize(deepest, { allowRemoteImages: true })
  assert.ok(out.html.indexOf("127.0.0.1") < 0, "the ceiling is not a way past the image policy")
  assert.ok(out.html.indexOf("text") > 0, "the content is still there")
  const tables = "<table><tr><td>".repeat(4000) + "cell"
  assert.ok(html.sanitize(tables).html.indexOf("cell") > 0)
  assert.ok(html.tooHeavyForRichText(tables), "and it is still refused as too heavy")
}

// The reader is told how heavy the result is by the call that produced it:
// asking separately would mean parsing the whole body again to count what was
// just counted.
{
  const light = html.sanitize("<p>hi</p>")
  assert.strictEqual(light.tooHeavy, false)
  assert.strictEqual(light.complexity.tags, 1)
  const heavy = html.sanitize("<div></div>".repeat(html.MAX_ELEMENTS + 1))
  assert.strictEqual(heavy.tooHeavy, true)
  assert.strictEqual(heavy.tooHeavy, html.tooHeavyForRichText(heavy.html),
    "and it agrees with asking the long way round")
}

// Both readings of a body out of one parse, because the tokenize underneath is
// the most expensive thing this file does and the reader wants both.
{
  const body = "<img src=\"https://track.example.com/p.gif\" width=\"1\">"
    + "<p>copy</p><img src=\"http://127.0.0.1/x.png\" width=\"90\">"
    + "<img src=\"https://cdn.example.com/real.png\" width=\"90\">"
  const asked = html.sanitize(body, { withPlainText: true })
  // Numbered off the sender's own tree, before anything is dropped: a message's
  // third picture is its third picture whether or not the first two were a
  // beacon and a request to the machine itself.
  assert.strictEqual(asked.plainText.text, "[image 1]copy\n[image 2][image 3]")
  deepEqual(asked.plainText.images, [
    "https://track.example.com/p.gif", "http://127.0.0.1/x.png",
    "https://cdn.example.com/real.png"])
  // ...while the document itself keeps none of them.
  assert.strictEqual(asked.images, 0)
  assert.ok(asked.html.indexOf("127.0.0.1") < 0)
  // The same answer the long way round, so the shortcut cannot drift from it.
  deepEqual(asked.plainText, html.readPlainText(body))
  // And nothing is paid for it unless it is asked for.
  assert.strictEqual(html.sanitize(body).plainText, null)
}

// ------------------------------------------------------------ scaffolding
//
// Real mail is mostly boxes holding one box. Qt parses each one back out of the
// string and lays it out, and that half of the cost is the half this file
// cannot measure — so the document it is handed is made smaller, but only in
// the two shapes that provably render the same.
{
  // A stack of empty wrappers is the innermost thing in it.
  assert.strictEqual(html.sanitize("<div><div><div><p>hi</p></div></div></div>").html, "<p>hi</p>")
  assert.strictEqual(html.sanitize("<div><table><tr><td>x</td></tr></table></div>").html,
    "<table><tr><td>x</td></tr></table>")
  // An inline element carrying nothing is nothing.
  assert.strictEqual(html.sanitize("<p><span>a</span>b<font>c</font></p>").html, "<p>abc</p>")

  // Anything the wrapper carries is a reason it is there.
  assert.strictEqual(html.sanitize("<div style=\"padding:8px\"><p>hi</p></div>").html,
    "<div style=\"padding:8px\"><p>hi</p></div>")
  assert.strictEqual(html.sanitize("<div align=\"center\"><p>hi</p></div>").html,
    "<div align=\"center\"><p>hi</p></div>")
  // Qt honours <center>, so a card that was centred must not come out left.
  assert.strictEqual(html.sanitize("<center><p>hi</p></center>").html, "<center><p>hi</p></center>")
  // <b> is not <span>: it says something with no attributes at all.
  assert.strictEqual(html.sanitize("<p><b>bold</b></p>").html, "<p><b>bold</b></p>")

  // Two boxes are two boxes, and a box holding text as well as a box is not
  // holding only that box.
  assert.strictEqual(html.sanitize("<div><p>a</p><p>b</p></div>").html, "<div><p>a</p><p>b</p></div>")
  assert.strictEqual(html.sanitize("<div>text<p>b</p></div>").html, "<div>text<p>b</p></div>")
  // Whitespace between blocks is not text: a template's newlines do not pin a
  // wrapper in place.
  assert.strictEqual(html.sanitize("<div>\n  <p>a</p>\n</div>").html, "<p>a</p>")
  // An inline child means the wrapper is what puts it on its own line.
  assert.strictEqual(html.sanitize("<div><span style=\"font-size:9px\">a</span></div>").html,
    "<div><span style=\"font-size:9px\">a</span></div>")

  // On mail shaped like the real thing this is most of the document. Nine
  // layout tables around a card is what this mailbox actually receives.
  let card = "", close = ""
  for (let d = 0; d < 9; d++) {
    card += "<table width=\"" + (600 - d * 10) + "\" align=\"center\"><tr><td>"
    close = "</td></tr></table>" + close
  }
  card += "<img src=\"https://cdn.example.com/h.png\" width=\"540\"><p>copy</p>" + close
  const carded = html.sanitize(card, { allowRemoteImages: true })
  assert.ok(carded.complexity.tags < 12,
    "nine levels of scaffolding come out as a handful of elements, not thirty")
  assert.ok(carded.html.indexOf("copy") > 0 && carded.html.indexOf("h.png") > 0,
    "and everything that was in them is still there")
}

// --------------------------------------------------- html read as plain text
//
// The markers and the picture list come off one walk, so a marker cannot open
// somebody else's image however strange the markup is.
{
  deepEqual(html.readPlainText("<div>Hello</div><img src=\"a.png\"><br><img src='b.png' width=600><p>Bye</p>"),
    { text: "Hello\n[image 1]\n[image 2]Bye", images: ["a.png", "b.png"] })
  assert.strictEqual(html.readPlainText("<ul><li>one</li><li>two &amp; three</li></ul>").text,
    "• one\n• two & three")
  assert.strictEqual(html.readPlainText("a&nbsp;&nbsp;b").text, "a  b")
  // An <img> written inside another element's attribute is text, not a picture.
  deepEqual(html.readPlainText("<div title=\"<img src=ghost.png>\">real</div>"),
    { text: "real", images: [] })
  deepEqual(html.readPlainText(""), { text: "", images: [] })
}

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
assert.strictEqual(html.sanitize("<img src='https://a.example.com/b.gif' height=\"1\">",
  { allowRemoteImages: true }).images, 0)
assert.strictEqual(html.sanitize("<img src='https://a.example.com/b.gif' style='width:1px;height:1px'>",
  { allowRemoteImages: true }).images, 0)

// A real picture is kept.
const real = "<img src=\"https://cdn.example/photo.png\" width=\"600\" height=\"400\">"
assert.strictEqual(html.sanitize(real, { allowRemoteImages: true }).images, 1)
assert.ok(html.sanitize(real, { allowRemoteImages: true }).html.indexOf("photo.png") > 0)
assert.strictEqual(html.sanitize(real).images, 0, "still off unless asked for")

// Every image is a fetch Qt performs during layout, and every completed fetch
// triggers another layout pass, so the count is capped.
let many = ""
for (let i = 0; i < html.MAX_IMAGES + 8; i++) many += "<img src=\"https://cdn.example.com/" + i + ".png\" width=\"90\">"
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
assert.strictEqual(html.sanitize("<img src='http://a.example.com/b.png'><img src='https://c.example.com/d.png'>").blockedImages, 2)
assert.strictEqual(html.sanitize("<img src='http://a.example.com/b.png'><img src='https://c.example.com/d.png'>",
  { allowRemoteImages: true }).images, 2, "images with no stated size are real pictures")
// Protocol-relative sources are still network fetches.
assert.strictEqual(html.sanitize("<img src=\"//cdn.example/x.png\">").blockedImages, 1)

// ------------------------------------------------- where an image may point
//
// A crafted message must not be able to make the reader talk to the machine it
// runs on. These are requests the user never asked for, aimed at whatever the
// sender names, and issuing one is the attack whether or not anything is drawn.

const localSources = [
  "http://127.0.0.1:8080/x.png",
  "http://localhost/x.png",
  "http://[::1]/x.png",
  "http://10.0.0.1/x.png",
  "http://192.168.1.1/x.png",
  "http://172.16.4.4/x.png",
  "http://169.254.169.254/latest/meta-data",
  "http://router/x.png",
  "http://printer.local/x.png",
  // 127.0.0.1 written so a naive check does not recognise it.
  "http://2130706433/x.png",
  "http://0177.0.0.1/x.png",
  "http://0x7f000001/x.png",
  // Userinfo, so the host is not what a reader skimming the URL sees.
  "http://cdn.example.com@127.0.0.1/x.png"
]
for (const source of localSources) {
  const asked = html.sanitize("<img src=\"" + source + "\" width=\"90\">",
    { allowRemoteImages: true })
  assert.strictEqual(asked.images, 0, source + " must never be fetched")
  assert.ok(asked.html.indexOf("img") < 0, source + " must not reach the renderer")
  assert.strictEqual(asked.remoteImages, 0, source + " is not something to offer")
}

// A public address in a URL is fine, however it is written.
assert.strictEqual(html.sanitize("<img src=\"https://93.184.216.34/x.png\" width=\"90\">",
  { allowRemoteImages: true }).images, 1)

// Qt resolves the character references in an attribute before it fetches, so a
// source that does not look like a URL to a reader can still be one to it.
assert.strictEqual(
  html.sanitize("<img src=\"&#104;ttps://track.example.com/p.gif\" width=\"90\">").blockedImages, 1)
assert.strictEqual(
  html.sanitize("<img src=\"&#104;ttps://127.0.0.1/p.gif\" width=\"90\">",
    { allowRemoteImages: true }).images, 0)

// A relative source has no base but the plugin's own directory, so Qt would
// read whatever sits next to the QML.
assert.ok(html.sanitize("<img src=\"../../../etc/hostname\">").html.indexOf("img") < 0)
assert.ok(html.sanitize("<img src=\"file:///etc/hostname\">").html.indexOf("img") < 0)

// The count the reader offers to load is the count it can actually load.
const mixed = "<img src=\"https://cdn.example.com/a.png\" width=\"90\">"
  + "<img src=\"http://127.0.0.1/b.png\" width=\"90\">"
  + "<img src=\"https://cdn.example.com/pixel.gif\" width=\"1\">"
assert.strictEqual(html.sanitize(mixed).remoteImages, 1)
assert.strictEqual(html.sanitize(mixed, { allowRemoteImages: true }).images, 1)

// A url() in an inline style is a fetch too, wherever the engine honours one.
assert.ok(html.sanitize("<div style=\"background-image:url(https://track.example.com/p.gif);padding:4px\">x</div>")
  .html.indexOf("track.example.com") < 0)
assert.ok(html.sanitize("<div style=\"background-image:url(https://track.example.com/p.gif);padding:4px\">x</div>")
  .html.indexOf("padding:4px") > 0, "the rest of the style survives")

// ---------------------------------------------------------- tag boundaries
//
// Qt reads an attribute value with its quotes, so a ">" inside an alt text does
// not end the tag for the engine — and a check that stops at the first ">" it
// sees takes half a tag, finds no src in it, and hands the whole thing back.
// Putting a ">" in an alt text was enough to walk an image past the block.
{
  const hidden = "<img alt=\"a>b\" src=\"https://tracker.example.com/p.gif\" width=\"90\">"
  assert.strictEqual(html.sanitize(hidden).blockedImages, 1)
  assert.ok(html.sanitize(hidden).html.indexOf("tracker.example.com") < 0)
  assert.strictEqual(html.sanitize(hidden, { allowRemoteImages: true }).images, 1)

  const hiddenLocal = "<img alt='a>b' src=\"http://127.0.0.1/p.gif\" width=\"90\">"
  assert.ok(html.sanitize(hiddenLocal, { allowRemoteImages: true }).html.indexOf("127.0.0.1") < 0)

  // A quote that never closes takes the rest of the document with it: Qt would
  // swallow the remainder into the tag anyway, and dropping it is the reading
  // that cannot leave a fetch behind.
  assert.ok(html.sanitize("<p>hi</p><img src=\"https://tracker.example.com/p.gif\" alt=\"oops")
    .html.indexOf("tracker.example.com") < 0)

  // Ordinary markup around an image is untouched.
  assert.strictEqual(
    html.sanitize("<p>hi</p><img alt=\"x\" src=\"https://cdn.example.com/a.png\" width=\"90\"><p>bye</p>").html,
    "<p>hi</p><p>bye</p>")
}

// The markers in a plain-text body and the list of pictures they open are two
// walks over the same tags, so they have to end a tag in the same place.
{
  const body = "<img alt=\"a>b\" src=\"https://cdn.example.com/one.png\"><p>x</p>"
    + "<img src=\"https://cdn.example.com/two.png\">"
  deepEqual(html.readPlainText(body).images,
    ["https://cdn.example.com/one.png", "https://cdn.example.com/two.png"])
}

// What the plain-text reader may hand to an Image element.
assert.strictEqual(html.isDisplayableImageUrl("https://cdn.example.com/a.png"), true)
assert.strictEqual(html.isDisplayableImageUrl("http://127.0.0.1/a.png"), false)
assert.strictEqual(html.isDisplayableImageUrl("file:///etc/hostname"), false)
assert.strictEqual(html.isDisplayableImageUrl("data:image/png;base64,AAA"), true)
assert.strictEqual(html.isDisplayableImageUrl("cid:logo"), false)
assert.strictEqual(html.isDisplayableImageUrl(""), false)

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
  deepEqual(html.readPlainText('<img src="a.png"><img src=\'b b.png\'><img data-x=1 src=c.png >').images,
    ["a.png", "b b.png", "c.png"])
  deepEqual(html.readPlainText("").images, [])
  deepEqual(html.readPlainText("<img alt=none>").images, [""],
    "an image with no src still holds its place")

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

  // The reader rebuilds its document on every relayout from the document
  // `sanitize` already built, so a whole drag costs no parse at all — which is
  // only safe as long as fitting writes the tree out rather than editing it. A
  // narrow pass must not leave its marks on the wide one that follows.
  // Only the table carries 600: a width on an image is the picture's own and is
  // clamped by the stylesheet's max-width instead.
  var fitted = "<table width=\"600\"><tr><td style=\"padding:4px 30px\">"
    + "<img src=\"a.png\" width=\"540\" height=\"200\"></td></tr></table>"
  var narrow = html.documentFor(fitted, { maxImageWidth: 380, compact: true })
  var roomy = html.documentFor(fitted, { maxImageWidth: 800, compact: true })
  assert.ok(narrow.indexOf('width="600"') < 0, "600 does not fit in 380")
  assert.ok(roomy.indexOf('width="600"') > 0, "but it fits in 800, from the same parse")
  assert.ok(narrow.indexOf("padding:4px 0") > 0)
  assert.strictEqual(html.documentFor(fitted, { maxImageWidth: 380, compact: true }), narrow,
    "and the same width twice is the same document")
  // Uncompacted, the sender's gutters are their own again.
  assert.ok(html.documentFor(fitted, { maxImageWidth: 380 }).indexOf("padding:4px 30px") > 0)
  assert.ok(html.documentFor(fitted, { maxImageWidth: 380 }).indexOf('height="200"') < 0,
    "heights come out at every width")

  // The document itself is accepted in place of the string written from it, and
  // has to fit to exactly the same thing.
  var built = html.sanitize(fitted, { allowRemoteImages: true })
  assert.strictEqual(html.documentFor(built.document, { maxImageWidth: 380, compact: true }),
    html.documentFor(built.html, { maxImageWidth: 380, compact: true }))
  assert.strictEqual(html.documentFor(built.document, { maxImageWidth: 800, compact: true })
    .indexOf('width="600"') > 0, true, "and it is still good at the next width")

  var relaxed = html.relaxFixedWidths(
    '<table width="600"><td width="100" style="width:640px">x</td></table>', 380)
  assert.ok(relaxed.indexOf('width="600"') < 0, "a table wider than the window gives it up")
  assert.ok(relaxed.indexOf('width="100"') > 0, "one that fits is left alone")
  assert.ok(relaxed.indexOf("width:640px") < 0, "declared widths too")
}


// ------------------------------------------------------------ hidden text
//
// Measured: Qt's rich text engine ignores display:none outright, but honours
// font-size — so an email preheader, which is hidden text set at 1px, renders
// as a two-pixel smudge of unreadable characters above the message.
{
  assert.strictEqual(
    html.dropHidden('<div class=preheader style="display: none; font-size:1px">SECRET</div><p>real</p>'),
    "<p>real</p>", "the preheader goes entirely")
  assert.strictEqual(
    html.dropHidden('<div style="display:none"><div>inner</div>outer</div><p>real</p>'),
    "<p>real</p>", "nesting is counted, so the wrapper takes its own subtree")
  assert.strictEqual(html.dropHidden('<span style="visibility:hidden">x</span>keep'), "keep")
  assert.strictEqual(html.dropHidden('<p>before</p><div style="display:none">tail'),
    "<p>before</p>", "an unclosed hidden element runs to the end")
  assert.strictEqual(html.dropHidden('<div style="color:red">keep</div>'),
    '<div style="color:red">keep</div>', "visible markup is untouched")
  // A void element has no subtree to eat, so it must not swallow what follows.
  assert.ok(html.dropHidden('<img src=a.png style="display:none"><p>real</p>').indexOf("<p>real</p>") >= 0)

  assert.ok(html.sanitize('<div style="display:none">SECRET</div><p>real</p>').html.indexOf("SECRET") < 0,
    "and the sanitizer applies it")
}

console.log("test_html.js ok")