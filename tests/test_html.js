const assert = require("assert")
const { load, deepEqual } = require("./load")

const html = load("message/Html.js")

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

  // A "<" that starts no tag is a "<" the sender typed, and it goes back out
  // escaped rather than raw. It draws the same either way, and leaving it raw
  // is how a "<" in one place and the letters that finish a tag in another end
  // up as a tag once something between them is unwrapped.
  assert.strictEqual(html.stripColors("a < b and 3<4"), "a &lt; b and 3&lt;4")

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
  // Numbered off the sender's own tree, before the image policy is applied: a
  // message's second picture is its second picture whether or not the first was
  // a request to the machine itself. A beacon is the one thing not counted —
  // it is not a picture, and a marker offering to open one would fire it.
  assert.strictEqual(asked.plainText.text, "copy\n[image 1][image 2]")
  deepEqual(asked.plainText.images, [
    "http://127.0.0.1/x.png", "https://cdn.example.com/real.png"])
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
  const table = "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"
  assert.strictEqual(html.sanitize("<div>" + table + "</div>").html, table)
  // An inline element carrying nothing is nothing.
  assert.strictEqual(html.sanitize("<p><span>a</span>b<font>c</font></p>").html, "<p>abc</p>")

  // Anything the wrapper carries is a reason it is there.
  assert.strictEqual(html.sanitize("<div style=\"padding:8px\"><p>hi</p></div>").html,
    "<div style=\"padding:8px\"><p>hi</p></div>")
  // Centring is not one of those reasons. The sender centres a 600px card in
  // the middle of a wide window; the reader is a panel of left-aligned text
  // beside a left-aligned list, and a newsletter kept centred there comes out
  // as a column of short lines adrift in it.
  assert.strictEqual(html.sanitize("<div align=\"center\"><p>hi</p></div>").html, "<p>hi</p>")
  assert.strictEqual(html.sanitize("<center><p>hi</p></center>").html, "<p>hi</p>")
  assert.strictEqual(html.sanitize("<p style=\"text-align:center;font-size:9px\">hi</p>").html,
    "<p style=\"font-size:9px\">hi</p>")
  // Every other alignment is the sender saying something the panel can honour:
  // a column of numbers reads right, and Arabic reads from the other end.
  assert.ok(html.sanitize("<p style=\"text-align:right\">9.00</p>").html
    .indexOf("text-align:right") > 0)
  // And a cell keeps even centring: a column lining up is the one thing a grid
  // is kept for.
  assert.ok(html.sanitize("<table><tr><th align=\"center\">a</th><th>b</th></tr>"
    + "<tr><td style=\"text-align:center\">c</td><td>d</td></tr></table>").html
    .indexOf("text-align:center") > 0)
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

  // HTML collapses a run of whitespace and so does this: a template's
  // indentation is not the sender spacing anything out, and kept it arrives as
  // gaps in the middle of sentences.
  assert.strictEqual(html.readPlainText("<p>Dear\n     Sir,\n  hello</p>").text,
    "Dear Sir, hello")
  // A non-breaking space is spacing the sender asked for, and survives.
  assert.strictEqual(html.readPlainText("a&nbsp;&nbsp;b").text, "a  b")

  // A cell ends a line. Without that a statement's labels and its figures come
  // out run together on one line each, which is the shape the fallback exists
  // to avoid.
  assert.strictEqual(
    html.readPlainText("<table><tr><td>Period</td><td>2026/07</td></tr>"
      + "<tr><td>Due</td><td>2026/08/03</td></tr></table>").text,
    "Period\n2026/07\n\nDue\n2026/08/03")

  // A line does not start where the markup was indented. Every nested tag a
  // block sits inside contributes a space of its own, so a heading four boxes
  // down arrived four spaces in — and a run of two is two non-breaking spaces
  // by the time the fallback is drawn, which is a ragged left edge down the
  // whole message. The sender indented markup, not text.
  assert.strictEqual(
    html.readPlainText("<div>\n  <div>\n    <p>\n      Heading\n    </p>\n  </div>\n</div>").text,
    "Heading")
  assert.strictEqual(html.readPlainText("<p>a</p>\n\n   <p>  b</p>").text, "a\nb")

  // A beacon is not a picture, and a marker offering to open one is noise in
  // the middle of the message it was hidden inside.
  deepEqual(html.readPlainText("<img src=\"p.gif\" width=\"1\"><img src=\"a.png\">"),
    { text: "[image 1]", images: ["a.png"] })
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
const table = "<table><tr><td>Item</td><td style=\"padding:6px\"><b>Total</b></td></tr>"
  + "<tr><td>Tea</td><td>2.00</td></tr></table>"
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

// A caller may defer remote resources until it has fetched and validated the
// bytes itself. Qt then sees no loading URL (and draws no broken placeholder),
// only a data URI once that exact source is ready.
{
  const source = "<p><img src=\"https://cdn.example.com/photo.png\" width=\"120\"></p>"
  const waiting = html.sanitize(source, {
    allowRemoteImages: true, remoteImageData: ({}), withReader: true
  })
  assert.strictEqual(waiting.html.indexOf("cdn.example.com"), -1)
  assert.strictEqual(waiting.reader.html.indexOf("cdn.example.com"), -1)
  deepEqual(waiting.remoteImageSources, ["https://cdn.example.com/photo.png"])
  deepEqual(html.sanitize("<div style=\"display:none\"><img src=\"https://track.example.com/hidden.png\" width=\"40\"></div>")
    .remoteImageSources, [], "a hidden picture is not prefetched")

  const ready = html.sanitize(source, {
    allowRemoteImages: true,
    remoteImageData: ({ "https://cdn.example.com/photo.png": "data:image/png;base64,AAAA" }),
    withReader: true
  })
  assert.ok(ready.html.indexOf("data:image/png;base64,AAAA") > 0)
  assert.ok(ready.reader.html.indexOf("data:image/png;base64,AAAA") > 0)
}

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

// An HTML `background` is not one of them. It is an image URL, Qt fetches it,
// and it rode in the colour list because senders write it beside `bgcolor` —
// so with `keepColors` on, a real message reached its sender's host with remote
// images off. No appearance option may buy a network request, so the attributes
// that carry an address are refused before the colour question is asked.
const painted = "<table background=\"https://static.example.net/tile.png\" bgcolor=\"#ffffff\">"
  + "<tr><td background=\"https://static.example.net/cell.png\" bgcolor=\"#eeeeee\">a</td>"
  + "<td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"
for (const options of [{}, { keepColors: true }, { keepColors: true, allowRemoteImages: true }]) {
  const formatted = html.sanitize(painted, options).html
  assert.ok(formatted.indexOf("background=") < 0,
    "background survived " + JSON.stringify(options))
  assert.ok(formatted.indexOf("static.example.net") < 0)
}
// The colours themselves are still an appearance question, still answered by
// the option rather than by the resource rule.
assert.ok(html.sanitize(painted, { keepColors: true }).html.indexOf("#ffffff") > 0)
assert.strictEqual(html.stripColors("<body background=\"https://x.example.com/a.png\">t</body>"),
  "<body>t</body>")

// The rest of the attributes whose value is an address rather than a value.
for (const attribute of ["srcset", "lowsrc", "dynsrc", "poster", "usemap",
    "ping", "formaction", "longdesc"]) {
  assert.ok(html.sanitize("<p " + attribute + "=\"https://x.example.com/a\">t</p>",
    { keepColors: true }).html.indexOf("x.example.com") < 0,
    attribute + " kept an address")
}
// And a url() in a style is a fetch wherever the engine honours one, whatever
// the appearance setting says.
for (const options of [{}, { keepColors: true }]) {
  assert.ok(html.sanitize("<div style=\"background-image:url(https://x.example.com/a.png)\">t</div>",
    options).html.indexOf("url(") < 0)
}

// Spelled with a character reference it is the same fetch, and the reference
// carries a ";" — which is also what separates one declaration from the next.
// Split on that ";", the declaration became two pieces that matched no rule
// here and were written back out as the url( they started as, for Qt to decode.
// So the references come out before anything is split.
for (const hidden of ["&#117;rl", "&#x75;rl", "&amp;#117;rl", "u&#114;l"]) {
  for (const options of [{}, { keepColors: true }]) {
    const out = html.sanitize("<div style=\"background-image:" + hidden
      + "(https://x.example.com/a.png)\">t</div>", options).html
    assert.ok(out.indexOf("x.example.com") < 0,
      hidden + " reached the renderer " + JSON.stringify(options) + ": " + out)
  }
}
// The same reference used to smuggle a whole second declaration past the split.
assert.strictEqual(
  html.sanitize("<div style=\"padding:2px&#59;background-image:url(https://x.example.com/a.png)\">t</div>",
    { keepColors: true }).html,
  "<div style=\"padding:2px\">t</div>")
// ...and to hide the thing that says it is hidden.
assert.strictEqual(html.sanitize("<p style=\"display:&#110;one\">secret</p><p>real</p>").html,
  "<p>real</p>")

// A `src` is an image's attribute and is checked as one. Anywhere else it is
// the same address with none of that checking behind it.
for (const source of ["<input type=\"image\" src=\"https://x.example.com/a.png\">",
    "<image src=\"https://x.example.com/a.png\">"]) {
  assert.ok(html.sanitize(source, { allowRemoteImages: true }).html.indexOf("x.example.com") < 0,
    "a src survived on " + source)
}

// A data: URL is the message's own bytes only when it is a picture. Anything
// else is a document with references of its own, and whether Qt follows them
// depends on which image plugins happen to be installed.
assert.ok(html.sanitize("<img src=\"data:image/png;base64,AAA\">").html.indexOf("data:image/png") > 0)
assert.strictEqual(html.sanitize("<img src=\"data:text/html,<b>x\">").html, "")
assert.strictEqual(html.sanitize("<img src=\"data:image/svg+xml;base64,AAA\">").html,
  "<img src=\"data:image/svg+xml;base64,AAA\">")

// The host is the one question where reading an address twice is not the safe
// direction: a second decoding can turn up a "@" and hand the authority to a
// later label. So it has to be public to both readings.
assert.ok(html.sanitize("<img src=\"https://127.0.0.1&amp;#64;good.example.com/x.png\">",
  { allowRemoteImages: true }).html.indexOf("127.0.0.1") < 0)
assert.strictEqual(
  reading("<p><a href=\"https://127.0.0.1&amp;#64;good.example.com/x\">t</a></p>").html, "<p>t</p>")
// An "&" in an ordinary query string decodes to itself and changes no host.
assert.strictEqual(
  reading("<p><a href=\"https://good.example.com/a?b=1&amp;c=2\">t</a></p>").html,
  "<p><a href=\"https://good.example.com/a?b=1&amp;c=2\">t</a></p>")

// ------------------------------------------------- markup that was text
//
// The tokenizer refuses a "<" that starts no tag and keeps it as text, and the
// serialiser used to write it back exactly as it found it. That held only while
// nothing moved the text: `collapse` welds together the text on either side of
// a span it unwraps, and reading mode rebuilds a paragraph out of pieces and
// drops the characters that draw as nothing between them. Either way a "<" can
// end up beside the letters that finish a tag, and Qt then parses an element
// nobody sent — past the image policy, past the link rule, past all of it,
// because by then it was not an element, it was a string.
const smuggled = [
  // A zero-width space is what stopped it being a tag on the way in.
  "<p>Hello <\u200bimg src=\"http://127.0.0.1:9/x.png\" width=\"1\" height=\"1\"> world</p>",
  // No zero-width needed when the halves are in two elements.
  "<p><span><</span><span>img src=\"https://x.example.com/b.png\"></span></p>",
  "<pre><b><</b>img src=\"https://x.example.com/c.png\"></pre>",
  "<p><\u200ba href=\"file:///etc/passwd\">click me</p>",
  "<p><\u200bstyle>body{background-image:url(https://x.example.com/x.png)}</p>"
]
for (const source of smuggled) {
  const ready = html.sanitize(source, { withReader: true })
  for (const [view, out] of [["formatted", ready.html], ["reading", ready.reader.html]]) {
    assert.ok(!/<(img|a|style)\b/i.test(out.replace(/<\/?(p|span|pre|b|strong|em|br)\b[^>]*>/gi, "")),
      view + " parsed a tag out of text: " + out)
  }
  assert.strictEqual(ready.reader.images + ready.reader.blockedImages, 0,
    "an image nobody counted reached the reading: " + ready.reader.html)
}
// What the sender actually typed still reads as itself, entities and all.
assert.strictEqual(reading("<p>a &lt; b, 3<4, &pound;4.00 and two &amp; three</p>").html,
  "<p>a &lt; b, 3&lt;4, &pound;4.00 and two &amp; three</p>")

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

// A grid survives untouched however deep it sits: two rows that each hold more
// than one cell is the sender saying "these line up", and nothing else in the
// message says it.
const grid = "<table><tr><th>Status</th><th>Job</th></tr><tr><td>ok</td><td>build</td></tr></table>"
assert.strictEqual(html.flattenTables(grid, 2), grid)
assert.strictEqual(html.flattenTables("<table><tr><td><table><tr><td>"
  + grid + "</td></tr></table></td></tr></table>").indexOf("<th>Status</th>") > 0, true,
  "a grid three tables down is still the message")

// A row of cells is not a grid: one row is how mail lays a logo out beside a
// nav, and how GitHub centres a card. It becomes plain blocks.
const strip = "<table><tr><td>logo</td><td>nav</td></tr></table>"
assert.strictEqual(html.flattenTables(strip, 2).indexOf("<table"), -1)
assert.ok(html.flattenTables(strip, 2).indexOf("logo") > 0, "the content stays")

// So does a single cell, which is a box and nothing more — with whatever
// styling rode on it.
const deep = "<table><tr><td><table><tr><td><table><tr><td style=\"padding:4px\">deep</td></tr></table></td></tr></table></td></tr></table>"
const flat = html.flattenTables(deep, 2)
assert.strictEqual(html.tableDepth(flat), 0, "no layout table survives at any depth")
assert.ok(flat.indexOf("deep") > 0, "the content stays")
assert.ok(flat.indexOf("padding:4px") > 0, "and so does its styling")
// Tags balance, or Qt renders the rest of the message inside a stray block.
assert.strictEqual((flat.match(/<div/g) || []).length, (flat.match(/<\/div>/g) || []).length)

// The depth cap is still the backstop, and it counts the grids that were kept
// rather than every box on the way down.
const grids = "<table><tr><td>a</td><td>b</td></tr><tr><td><table><tr><td>c</td><td>d</td></tr>"
  + "<tr><td><table><tr><td>e</td><td>f</td></tr><tr><td>g</td><td>h</td></tr></table></td></tr>"
  + "</table></td><td>i</td></tr></table>"
assert.strictEqual(html.tableDepth(grids), 3)
assert.strictEqual(html.tableDepth(html.flattenTables(grids, 2)), 2, "nothing survives past the limit")

// sanitize flattens by default; a caller can ask for the original.
assert.strictEqual(html.complexity(html.sanitize(deep).html).tableDepth, 0)
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

// QTextDocument ignores max-width on ordinary containers. The QML reader uses
// the sender's outer content width instead, so a 600px message does not stretch
// across a wide monitor.
{
  const card = html.sanitize("<html><body><div style=\"max-width:600px\">"
    + "<div style=\"max-width:520px\"><p>copy</p></div></div></body></html>")
  assert.strictEqual(html.preferredContentWidth(card.document, 1800), 600)
  assert.strictEqual(html.preferredContentWidth(card.document, 480), 480,
    "the message still fits a narrow reader")
  assert.strictEqual(html.preferredContentWidth("<p>copy</p>", 1800), 1800,
    "unconstrained mail keeps the available width")
}


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

  // A sender pads the inbox's preview line with characters that draw nothing —
  // soft hyphens and combining grapheme joiners, hundreds of them — so the list
  // shows one sentence and stops. Linear's text/plain is fifty lines, and
  // thirty-one of them hold nothing but that padding: rendered honestly, a page
  // of blank between the greeting and the message.
  var padded = "Lead sentence.\n\n\u034f \u00ad\u034f\u2007\u00a0\u00ad\u034f\n \u00ad\u034f\n\nBody."
  assert.strictEqual(html.readableText(padded), "Lead sentence.\n\nBody.")
  assert.ok(html.plainTextDocument(padded, {}, false).indexOf("Lead sentence.<br><br>Body.") > 0)
  // One blank line is a paragraph break and stays one.
  assert.strictEqual(html.readableText("a\n\nb"), "a\n\nb")
  assert.strictEqual(html.readableText("a\n\n\n\n\nb"), "a\n\nb")
  // A line the sender indented is still indented, and a single break is single.
  assert.strictEqual(html.readableText("a\n  b"), "a\n  b")
  // Spacing inside a line that says something is the sender aligning it.
  assert.strictEqual(html.readableText("Name\u00a0\u00a0Jane"), "Name\u00a0\u00a0Jane")
  // A zero-width space inside a word is padding too, and the word closes up.
  assert.strictEqual(html.readableText("un\u200bsubscribe"), "unsubscribe")
  assert.strictEqual(html.readableText(null), "")

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
  var cssSizedLogo = html.sanitize(
    '<img src="https://cdn.example.com/logo.png" style="height:34px;padding:3px">',
    { allowRemoteImages: true })
  var logoDoc = html.documentFor(cssSizedLogo.document, { maxImageWidth: 1200 })
  assert.ok(logoDoc.indexOf('height="34"') > 0,
    "a CSS-only logo height becomes the HTML attribute Qt supports")

  var logoRow = html.sanitize('<div style="line-height:0;font-size:0">'
    + '<img src="https://cdn.example.com/logo.png" style="height:34px"></div>'
    + '<p>Title below</p>', { allowRemoteImages: true }).html
  assert.ok(logoRow.indexOf("line-height:0") < 0,
    "an image row keeps enough line height to separate the next block")
  assert.ok(logoRow.indexOf("font-size:0") < 0,
    "zero-size image-row text cannot collapse the row")

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
  var fitted = "<table width=\"600\"><tr><td>a</td><td>b</td></tr>"
    + "<tr><td style=\"padding:4px 30px\">"
    + "<img src=\"a.png\" width=\"540\" height=\"200\"></td><td>c</td></tr></table>"
  var narrow = html.documentFor(fitted, { maxImageWidth: 380, compact: true })
  var roomy = html.documentFor(fitted, { maxImageWidth: 800, compact: true })
  assert.ok(narrow.indexOf('width="600"') < 0, "600 does not fit in 380")
  assert.ok(roomy.indexOf('width="600"') > 0, "but it fits in 800, from the same parse")
  assert.ok(narrow.indexOf("padding:4px 0") > 0)
  assert.strictEqual(html.documentFor(fitted, { maxImageWidth: 380, compact: true }), narrow,
    "and the same width twice is the same document")
  // Uncompacted, the sender's gutters are their own again.
  assert.ok(html.documentFor(fitted, { maxImageWidth: 380 }).indexOf("padding:4px 30px") > 0)
  // A width the window cannot hold is given up at every window, though: the
  // reader has no horizontal scroll, so what overflows is simply not read.
  assert.ok(html.documentFor(fitted, { maxImageWidth: 380 }).indexOf('width="600"') < 0)
  assert.ok(html.documentFor(fitted, { maxImageWidth: 800 }).indexOf('width="600"') > 0,
    "and one that fits is the sender's own")
  assert.ok(html.documentFor(fitted, { maxImageWidth: 380 }).indexOf('height="200"') < 0,
    "a clamped image gives up the height that would smear it")
  assert.ok(html.documentFor(fitted, { maxImageWidth: 800 }).indexOf('height="200"') > 0,
    "an image that already fits keeps its intended height")

  // The document itself is accepted in place of the string written from it, and
  // has to fit to exactly the same thing.
  var built = html.sanitize(fitted, { allowRemoteImages: true })
  assert.strictEqual(html.documentFor(built.document, { maxImageWidth: 380, compact: true }),
    html.documentFor(built.html, { maxImageWidth: 380, compact: true }))
  assert.strictEqual(html.documentFor(built.document, { maxImageWidth: 800, compact: true })
    .indexOf('width="600"') > 0, true, "and it is still good at the next width")

  // Qt honours white-space:nowrap, and the reader has nowhere to scroll to. A
  // heading the sender promised would stay on one line is a heading cut off at
  // the panel's edge — Cloudflare's Chinese subject ran a third of the way past
  // it. Wrapping is what the reader can honour.
  var nowrap = "<p style=\"white-space:nowrap;font-size:28px\">a long heading</p>"
  assert.ok(html.relaxFixedWidths(nowrap, 380).indexOf("nowrap") < 0)
  assert.ok(html.relaxFixedWidths(nowrap, 380).indexOf("font-size:28px") > 0,
    "and nothing else about the line changes")
  assert.ok(html.documentFor(nowrap, { maxImageWidth: 380 }).indexOf("nowrap") < 0)

  var relaxed = html.relaxFixedWidths(
    '<table width="600"><td width="100" style="width:640px">x</td></table>', 380)
  assert.ok(relaxed.indexOf('width="600"') < 0, "a table wider than the window gives it up")
  assert.ok(relaxed.indexOf('width="100"') > 0, "one that fits is left alone")
  assert.ok(relaxed.indexOf("width:640px") < 0, "declared widths too")

  // Some mail templates use a 1%-wide cell plus nowrap to mean "take only
  // what the label needs". Qt does not implement that intrinsic sizing. Once
  // nowrap is removed, the percentage squeezes each word into one character
  // per line. The Semrush status labels exposed this combination.
  var intrinsic = html.relaxFixedWidths(
    '<table width="100%"><tr><td>page</td><td width="1%" '
      + 'style="white-space:nowrap;width:1%;min-width:165px">Good → To improve</td></tr></table>',
    640)
  assert.ok(intrinsic.indexOf('width="1%"') < 0, "a tiny cell is allowed to size to its label")
  assert.ok(intrinsic.indexOf("width:1%") < 0, "the matching style is removed too")
  assert.ok(intrinsic.indexOf('width="100%"') > 0, "the table still fills its container")

  var intrinsicTable = html.relaxFixedWidths(
    '<table width="1%" style="width:1%"><tr><td width="1%" '
      + 'style="white-space:nowrap;width:1%">Healthy</td><td>3</td></tr></table>', 640)
  assert.ok(intrinsicTable.indexOf('width="1%"') < 0,
    "the intrinsic table around the labels is not squeezed either")
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


// ============================================================== reading mode
//
// A different question from the one the sanitiser answers. The sanitiser is a
// filter over the sender's document and is judged on what it removed; this
// builds a document of its own and is judged on what it kept — every word the
// message says, in order, with none of the sender's presentation anywhere in
// it.

// Every attribute in a reading-mode document, as "element/name" pairs. The
// whole security argument for this mode is that the list is `a/href` and
// `img/src` and cannot be anything else, because no attribute is ever copied
// from the sender's tree — each one in the output was constructed from a value
// that had already been checked.
function attributesOf(node, out) {
  var children = node.children || []
  for (var i = 0; i < children.length; i++) {
    var child = children[i]
    if (child.type === "text") continue
    for (var j = 0; j < child.attrs.length; j++) {
      out.push(child.name + "/" + child.attrs[j].name)
    }
    attributesOf(child, out)
  }
  return out
}

function reading(source, options) {
  const settings = Object.assign({ withReader: true }, options || {})
  const ready = html.sanitize(source, settings)
  const kinds = {}
  for (const pair of attributesOf(ready.reader.document, [])) kinds[pair] = true
  for (const pair of Object.keys(kinds)) {
    assert.ok(pair === "a/href" || pair === "img/src"
      || pair === "img/width" || pair === "img/height"
      || pair === "table/cellspacing" || pair === "table/cellpadding"
      || pair === "td/valign" || pair === "td/style",
      "reading mode emitted " + pair + ", which is a sender attribute it cannot have")
  }
  // The attribute list is only half of it. An element the reader never built
  // can still arrive as text: this mode joins text the sender kept apart, so a
  // "<" that was not a tag when it was parsed can be one by the time it is
  // written. Every "<" in the output has to belong to an element in the tree.
  const tags = ready.reader.html.match(/</g)
  assert.strictEqual(tags === null ? 0 : tags.length, elementsOf(ready.reader.document) * 2
    - voidsOf(ready.reader.document),
    "reading mode wrote a \"<\" that is not one of its own elements: " + ready.reader.html)
  return ready.reader
}

function elementsOf(node) {
  var total = 0
  var children = node.children || []
  for (var i = 0; i < children.length; i++) {
    if (children[i].type === "text") continue
    total += 1 + elementsOf(children[i])
  }
  return total
}

// An <img> or a <br> writes one "<" rather than two.
function voidsOf(node) {
  var total = 0
  var children = node.children || []
  for (var i = 0; i < children.length; i++) {
    if (children[i].type === "text") continue
    if (children[i].name === "img" || children[i].name === "br" || children[i].name === "hr") total++
    total += voidsOf(children[i])
  }
  return total
}

// A newsletter shaped like the ones that made this mode necessary: a card seven
// layout tables down, rows of avatars and names, a styled call to action, a
// footer, a beacon, and a preheader hidden four different ways. No real domain
// and nothing from anybody's mailbox — the structure is the fixture.
function activityMail() {
  function boxes(depth, inner) {
    var open = ""
    var close = ""
    for (var i = 0; i < depth; i++) {
      open += '<table width="' + (600 - i * 20) + '" align="center" cellpadding="0"'
        + ' cellspacing="0" bgcolor="#ffffff"'
        + ' background="https://static.example.net/tile.png" class="card">'
        + '<tr><td align="center" style="padding:0 24px;'
        + 'background:url(https://static.example.net/tile.png)">'
      close = "</td></tr></table>" + close
    }
    return open + inner + close
  }

  var people = ""
  for (var i = 1; i <= 3; i++) {
    people += '<table width="100%"><tr>'
      + '<td width="40"><img src="https://static.example.net/avatar' + i + '.png"'
      + ' width="32" height="32" alt=""></td>'
      + '<td style="font-family:Graphik;font-size:14px;color:#050038">Person ' + i + '</td>'
      + '<td align="right" style="font-size:12px;color:#6c6c6c">moved 4 cards</td>'
      + '</tr></table>'
  }

  return '<html><head><title>Board activity</title>'
    + '<style>.card{width:100%!important}</style></head>'
    + '<body bgcolor="#f7f7f7" background="https://static.example.net/bg.png" style="margin:0">'
    + '<div style="display:none;font-size:1px;max-height:0;overflow:hidden">'
    + 'Three people were busy on your board&#8203;&#8203;&#8203;&#8203;</div>'
    + boxes(7,
        '<img src="https://static.example.net/logo.png" width="120" height="32" alt="Example">'
        + '<div style="font-family:Graphik;font-size:28px;font-weight:600;color:#050038">'
        + 'Activity on Sprint board</div>'
        + '<p style="font-size:16px;line-height:24px;color:#404040;margin:0 0 16px">'
        + 'Here is what happened while you were away.</p>'
        + people
        + '<table width="100%" cellpadding="0"><tr><td align="center" bgcolor="#4262ff"'
        + ' style="border-radius:8px;padding:14px 28px">'
        + '<a href="https://example.com/board/123"'
        + ' style="color:#ffffff;font-size:16px;text-decoration:none">Open the board</a>'
        + '</td></tr></table>'
        + '<img src="https://track.example.net/open.gif" width="1" height="1" alt="">')
    + boxes(3, '<p style="font-size:11px;color:#9b9b9b">You are a member of this board. '
        + '<a href="https://example.com/unsubscribe">Unsubscribe</a> at any time.</p>')
    + '</body></html>'
}

{
  const newsletter = activityMail()
  const read = reading(newsletter)

  // Everything the message says, in the order it says it, and nothing about how
  // it was arranged to say it.
  assert.strictEqual(read.html,
    "<p>Example</p>"
    + "<h2>Activity on Sprint board</h2>"
    + "<p>Here is what happened while you were away.</p>"
    + "<p>Person 1 moved 4 cards</p>"
    + "<p>Person 2 moved 4 cards</p>"
    + "<p>Person 3 moved 4 cards</p>"
    + "<p><a href=\"https://example.com/board/123\">Open the board</a></p>"
    + "<p>You are a member of this board. "
    + "<a href=\"https://example.com/unsubscribe\">Unsubscribe</a> at any time.</p>")

  // The sender's fourteen tables, eight deep, are gone as structure rather than
  // flattened into eight levels of empty box.
  assert.ok(html.complexity(newsletter).tableDepth >= 7, "the fixture really is a stack of tables")
  assert.strictEqual(read.complexity.tables, 0)
  assert.strictEqual(read.complexity.tableDepth, 0)

  // A row of a layout table is a line. Three paragraphs where a name and what
  // that person did used to sit side by side is the loose vertical stream this
  // whole mode exists to stop producing.
  assert.ok(read.html.indexOf("Person 2 moved 4 cards") > 0)

  // Not one attribute of the sender's survived, checked by name rather than by
  // reading the string: `reading` walks the document and refuses anything that
  // is not a/href or img/src.
  for (const attribute of ["class=", "bgcolor=", "background=", "align=",
      "cellpadding=", "cellspacing=", "width=", "style=", "url("]) {
    assert.ok(read.html.indexOf(attribute) < 0,
      "reading mode kept " + attribute + " from the sender")
  }

  // The preheader is hidden four ways at once, and Qt honours none of them.
  assert.ok(read.html.indexOf("Three people were busy") < 0, "the preheader stays hidden")
  assert.ok(read.html.indexOf("width:100%") < 0, "and the stylesheet is not body text")
  assert.ok(read.html.indexOf("Board activity") < 0, "nor is the <title>")

  // The beacon is not a picture, so it leaves nothing behind — not even a
  // placeholder, which would be announcing the tracker rather than removing it.
  assert.ok(read.html.indexOf("track.example.net") < 0)
  assert.ok(read.html.indexOf("open.gif") < 0)

  // The call to action was a link styled as a button. It is a link.
  assert.ok(read.html.indexOf("<a href=\"https://example.com/board/123\">Open the board</a>") > 0)

  // Reading mode is lighter than the formatted view of the same message, which
  // is what lets it draw messages the formatted view refuses.
  const formatted = html.sanitize(newsletter)
  assert.ok(read.complexity.tags < formatted.complexity.tags)
  assert.strictEqual(read.tooHeavy, false)
}

// ------------------------------------------------------------ what is kept
{
  const read = reading("<h1>Title</h1><h2>Second</h2><p>A <b>bold</b> word and an <i>emphasised</i> one.</p>"
    + "<ul><li>one</li><li>two &amp; three</li></ul>"
    + "<ol><li>first</li><li>second</li></ol>"
    + "<blockquote><p>They wrote this.</p></blockquote>"
    + "<p><code>inline()</code></p><pre>  indented\n  lines</pre>"
    + "<hr><p>After the rule, <a href=\"https://example.com/x\">a link</a>.</p>")

  assert.strictEqual(read.html,
    "<h1>Title</h1><h2>Second</h2>"
    + "<p>A <strong>bold</strong> word and an <em>emphasised</em> one.</p>"
    + "<ul><li>one</li><li>two &amp; three</li></ul>"
    + "<ol><li>first</li><li>second</li></ol>"
    + "<blockquote><p>They wrote this.</p></blockquote>"
    + "<p><code>inline()</code></p><pre>  indented\n  lines</pre>"
    + "<hr><p>After the rule, <a href=\"https://example.com/x\">a link</a>.</p>")

  // Every spelling of the same intention arrives as one element, because the
  // reader draws one thing for it.
  assert.strictEqual(reading("<strong>a</strong><em>b</em><cite>c</cite><kbd>d</kbd>").html,
    "<p><strong>a</strong><em>b</em><em>c</em><code>d</code></p>")
  // Type the sender set is not markup the reader draws.
  assert.strictEqual(reading("<font face=\"Arial\" color=\"#f00\"><span style=\"font-size:9px\">"
    + "small print</span></font>").html, "<p>small print</p>")

  // A run of whitespace in the source is one space; the indentation a template
  // arrives with is none.
  assert.strictEqual(reading("<div>\n  <div>\n    <p>\n      Dear Sir,\n    </p>\n  </div>\n</div>").html,
    "<p>Dear Sir,</p>")
  assert.strictEqual(reading("<p>Body <a href=\"https://example.com/a\">link</a> tail</p>").html,
    "<p>Body <a href=\"https://example.com/a\">link</a> tail</p>")
  // Mail is padded with characters that draw nothing so the inbox preview line
  // ends where the sender wants it to.
  assert.strictEqual(reading("<p>Ends here.­​​​⁠</p>").html,
    "<p>Ends here.</p>")
  // A block with nothing in it is not a blank line in the reader.
  assert.strictEqual(reading("<p>a</p><div>&nbsp;</div><div><br></div><p>b</p>").html,
    "<p>a</p><p>b</p>")
  assert.strictEqual(reading("").html, "")
  assert.strictEqual(reading("<div><table><tr><td>&nbsp;</td></tr></table></div>").empty, true)
}

// -------------------------------------------------------- inferred headings
//
// Most headings in mail are not elements. They are a cell with a font size on
// it, and the size is the only honest evidence there is.
{
  assert.strictEqual(reading("<div style=\"font-size:28px;font-weight:600\">Your week</div>").html,
    "<h2>Your week</h2>")
  assert.strictEqual(reading("<td style=\"font-size:22px\">Your week</td>").html,
    "<h3>Your week</h3>")
  assert.strictEqual(reading("<div style=\"font-size:18pt\">Your week</div>").html,
    "<h3>Your week</h3>")
  assert.strictEqual(reading("<div style=\"font-size:2em\">Your week</div>").html,
    "<h2>Your week</h2>")
  assert.strictEqual(reading("<div style=\"font-size:150%\">Your week</div>").html,
    "<h3>Your week</h3>")

  // Never from weight. Half the lines in a newsletter are bold and none of them
  // are headings.
  assert.strictEqual(reading("<div style=\"font-weight:bold\">Not a heading</div>").html,
    "<p>Not a heading</p>")
  assert.strictEqual(reading("<div style=\"font-size:16px;font-weight:800\">Not a heading</div>").html,
    "<p>Not a heading</p>")
  // Nor from a long line: a paragraph the sender set large is still a paragraph,
  // and promoting it puts a page of body copy in heading type.
  const paragraph = "This is a long run of body copy that the sender happened to set "
    + "in a larger size than the rest of the message, which does not make it a heading."
  assert.strictEqual(reading("<div style=\"font-size:24px\">" + paragraph + "</div>").html,
    "<p>" + paragraph + "</p>")
  // A whole card inside one large-typed box is the card, not a heading.
  assert.strictEqual(
    reading("<div style=\"font-size:24px\"><p>Short.</p><p>Also short.</p></div>").html,
    "<p>Short.</p><p>Also short.</p>")

  // A native heading is kept at the level the sender wrote, and rebuilt: the
  // size it is drawn at is the reader's.
  assert.strictEqual(reading("<h4 style=\"font-size:40px;color:#f00\">Small heading</h4>").html,
    "<h4>Small heading</h4>")
  // A link inside a large-typed cell keeps its address rather than being
  // recursed away from it.
  assert.strictEqual(
    reading("<a href=\"https://example.com/go\"><td style=\"font-size:26px\">Go</td></a>").html,
    "<p><a href=\"https://example.com/go\">Go</a></p>")
}

// ------------------------------------------------------------------ tables
{
  // A grid — two rows that each hold more than one cell — is the sender saying
  // these cells line up with those, which is the one thing a stack of blocks
  // cannot say. It survives, with nothing on it.
  assert.strictEqual(
    reading("<table cellpadding=\"6\" bgcolor=\"#eee\" width=\"600\">"
      + "<thead><tr><th align=\"left\">Item</th><th>Total</th></tr></thead>"
      + "<tbody><tr><td>Tea</td><td>&pound;4.00</td></tr>"
      + "<tr><td>Coffee</td><td>&pound;3.50</td></tr></tbody></table>").html,
    "<table><tr><th>Item</th><th>Total</th></tr>"
    + "<tr><td>Tea</td><td>&pound;4.00</td></tr>"
    + "<tr><td>Coffee</td><td>&pound;3.50</td></tr></table>")

  // A statement must not become one run-together line, which is what removing
  // the table without replacing the boundaries does.
  const statement = reading("<table><tr><th>Period</th><th>Charge</th></tr>"
    + "<tr><td>July</td><td>12.00</td></tr><tr><td>August</td><td>13.00</td></tr></table>").html
  assert.ok(statement.indexOf("<td>July</td><td>12.00</td>") > 0)
  assert.ok(statement.indexOf("July12.00") < 0)

  // Everything else is the scaffolding a card is centred with, and its cells
  // are the blocks they always were, in the order they were written.
  const layout = reading("<table><tr><td><table><tr><td>"
    + "<h2>Inner</h2><p>Body</p></td></tr></table></td></tr></table>")
  assert.strictEqual(layout.html, "<h2>Inner</h2><p>Body</p>")
  assert.strictEqual(layout.complexity.tables, 0)

  // One table of grid is what the reader draws. A grid inside a kept cell is
  // the scaffolding again.
  const nested = reading("<table><tr><td>a</td><td>b</td></tr>"
    + "<tr><td><table><tr><td>x</td><td>y</td></tr><tr><td>z</td><td>w</td></tr></table></td>"
    + "<td>d</td></tr></table>")
  assert.strictEqual(nested.complexity.tables, 1)
  assert.ok(nested.html.indexOf("x y") > 0, "and what was in it is still readable")

  // A grid too wide or too long to read is not a grid worth laying out.
  let manyColumns = "<table>"
  for (let row = 0; row < 2; row++) {
    manyColumns += "<tr>"
    for (let cell = 0; cell < 12; cell++) manyColumns += "<td>c" + cell + "</td>"
    manyColumns += "</tr>"
  }
  assert.strictEqual(reading(manyColumns + "</table>").complexity.tables, 0)
}

// ---------------------------------------------------------------- addresses
//
// Reading mode is built from an allow list rather than filtered, and its list
// is stricter than the formatted view's on purpose: a message must not be able
// to put the machine this runs on, or the network behind the user's front door,
// under the pointer.
{
  const links = reading("<a href=\"javascript:steal()\">js</a>"
    + " <a href=\"file:///etc/passwd\">file</a>"
    + " <a href=\"/relative/page\">relative</a>"
    + " <a href=\"http://127.0.0.1/admin\">loopback</a>"
    + " <a href=\"http://192.168.1.1/reboot\">private</a>"
    + " <a href=\"http://[::1]/x\">v6</a>"
    + " <a href=\"http://printer/\">single label</a>"
    + " <a href=\"http://nas.local/\">local name</a>"
    + " <a href=\"http://example.com@127.0.0.1/x\">userinfo</a>"
    + " <a href=\"&#106;avascript:steal()\">encoded</a>"
    + " <a href=\"mailto:someone@example.com\">mail</a>"
    + " <a href=\"https://example.com/ok\">public</a>").html

  for (const refused of ["javascript:", "file:", "/relative/page", "127.0.0.1",
      "192.168.1.1", "[::1]", "printer", "nas.local"]) {
    assert.ok(links.indexOf(refused) < 0, refused + " reached the rendered document")
  }
  // The label is still the message's words even where the address is refused.
  assert.ok(links.indexOf("loopback") > 0 && links.indexOf("single label") > 0)
  assert.ok(links.indexOf("<a href=\"mailto:someone@example.com\">mail</a>") > 0)
  assert.ok(links.indexOf("<a href=\"https://example.com/ok\">public</a>") > 0)
  assert.strictEqual((links.match(/<a /g) || []).length, 2, "and nothing else is a link")
}

// ------------------------------------------------------------------ images
{
  // Nothing remote is fetched unless the reader asked. The fetch alone tells
  // the sender the mail was read, from which address and at what moment.
  const blocked = reading("<p><img src=\"https://cdn.example.com/hero.png\" alt=\"The new board\">"
    + "<img src=\"https://cdn.example.com/spacer.png\" alt=\"\">"
    + "<img src=\"https://cdn.example.com/plain.png\">"
    + "<img src=\"https://track.example.net/o.gif\" width=\"1\" height=\"1\"></p>")
  assert.ok(blocked.html.indexOf("http") < 0, "no remote source reached the document")
  assert.ok(blocked.html.indexOf("The new board") > 0, "the picture's own words stand in for it")
  assert.ok(blocked.html.indexOf("[image]") > 0, "and one with nothing to say says so")
  assert.ok(blocked.html.indexOf("spacer") < 0, "an empty alt is the sender saying decoration")
  assert.strictEqual(blocked.blockedImages, 3, "the beacon is not something to offer")

  // Asked for, they arrive — and nothing else does.
  const shown = reading("<p><img src=\"https://cdn.example.com/hero.png\" alt=\"Hero\">"
    + "<img src=\"file:///etc/x.png\"><img src=\"http://127.0.0.1/a.png\">"
    + "<img src=\"//cdn.example.com/protocol.png\">"
    + "<img src=\"data:image/png;base64,AAAA\">"
    + "<img src=\"cid:part1\"></p>", { allowRemoteImages: true })
  assert.strictEqual(shown.html,
    "<p><img src=\"https://cdn.example.com/hero.png\">"
    + "<img src=\"//cdn.example.com/protocol.png\">"
    + "<img src=\"data:image/png;base64,AAAA\">"
    + "<img src=\"cid:part1\"></p>")
  assert.strictEqual(shown.images, 2)

  // The cap is the same one the formatted view keeps, for the same reason:
  // every fetch is another layout pass.
  const many = reading("<p>" + "<img src=\"https://cdn.example.com/a.png\">".repeat(40) + "</p>",
    { allowRemoteImages: true, maxImages: 3 })
  assert.strictEqual(many.images, 3)
  assert.strictEqual(many.blockedImages, 37)

  // An alt is an attribute value, not markup.
  assert.strictEqual(reading("<img src=\"https://cdn.example.com/a.png\" alt=\"a<b & c\">").html,
    "<p>a&lt;b &amp; c</p>")
}

// ------------------------------------------------------------- what is gone
{
  // The preheader, in each of the ways it is written.
  for (const hidden of ["display:none", "visibility:hidden", "font-size:1px",
      "font-size:0", "max-height:0;overflow:hidden", "opacity:0"]) {
    assert.strictEqual(reading('<div style="' + hidden + '">SECRET</div><p>real</p>').html,
      "<p>real</p>", hidden + " did not hide it")
  }
  assert.strictEqual(reading('<div hidden>SECRET</div><p>real</p>').html, "<p>real</p>")

  // And the three that look like it and are not. A cell writes "font-size:0" to
  // take the space out from between the boxes it holds, and every box inside
  // sets a size of its own: read as hiding, it took a whole message with it. A
  // box of no height hides nothing unless what overflows it is clipped. And
  // "mso-hide:all" is the sender hiding something from Outlook, which makes it
  // the version meant for everybody else — reading it as hidden threw away a
  // call to action and left nothing where it had been.
  assert.strictEqual(
    reading('<td style="font-size:0"><div style="font-size:17px">Real words</div></td>').html,
    "<p>Real words</p>")
  assert.strictEqual(reading('<div style="max-height:0">Still drawn</div>').html,
    "<p>Still drawn</p>")
  assert.strictEqual(
    reading('<table style="mso-hide:all"><tr><td><a href="https://x.example.com/">Book it</a>'
      + "</td></tr></table>").html,
    "<p><a href=\"https://x.example.com/\">Book it</a></p>")

  // Scripts, stylesheets, and the parts of a document that are not the message.
  assert.strictEqual(reading("<script>steal()</script><style>p{color:red}</style>"
    + "<noscript>fallback</noscript><iframe src=\"https://x.example.com\"></iframe>"
    + "<object data=\"https://x.example.com/a.swf\"></object><p>real</p>").html, "<p>real</p>")

  // A form is a picture of a form. Its words are the message; its controls and
  // its address are not. A button's label is still one of those words, so it
  // survives as plain content with no action attached.
  const form = reading("<form action=\"https://collect.example.net/\">"
    + "<p>Search the help centre</p><input name=\"q\" value=\"secret\">"
    + "<select><option>one</option></select><button>Go</button></form>").html
  assert.strictEqual(form, "<p>Search the help centre</p><p>Go</p>")

  // Handlers, ids and classes have no path into the output at all, which is
  // what `reading` asserts on every case in this file.
  assert.strictEqual(reading("<p id=\"x\" class=\"y\" onclick=\"steal()\" "
    + "style=\"color:red;background:url(https://x.example.com/a.png)\">text</p>").html,
    "<p>text</p>")

  // An HTML `background` is an address, not a colour, whatever it is sitting
  // beside — and Qt fetches it. The formatted view's half of this is with the
  // rest of the colour rules; here it is one more sender attribute with no path
  // into a rebuilt document.
  assert.ok(reading("<table background=\"https://static.example.net/tile.png\" bgcolor=\"#ffffff\">"
    + "<tr><td background=\"https://static.example.net/cell.png\">a</td><td>b</td></tr>"
    + "<tr><td>c</td><td>d</td></tr></table>").html.indexOf("static.example.net") < 0)
}

// --------------------------------------------------------------- complexity
{
  // Reading mode is flat by construction, so the document it produces stays
  // inside the bounds on mail the formatted view refuses — which is the other
  // half of what it is for.
  function outlookMail(cards) {
    var out = "<html><body>"
    for (var i = 0; i < cards; i++) {
      var open = ""
      var close = ""
      for (var depth = 0; depth < 9; depth++) {
        open += "<table width=\"600\" align=\"center\" bgcolor=\"#ffffff\""
          + " background=\"https://static.example.net/t.png\"><tr><td style=\"padding:0\">"
        close = "</td></tr></table>" + close
      }
      out += open
        + "<img src=\"https://cdn.example.com/hero" + i + ".png\" width=\"540\" alt=\"Hero\">"
        + "<h2 style=\"color:#111\">Headline " + i + "</h2>"
        + "<p style=\"margin:0 12px\">Body copy, <a href=\"https://example.com/"
        + i + "\">read on</a>.</p>"
        + "<img src=\"https://track.example.net/p" + i + ".gif\" width=\"1\" height=\"1\">"
        + close
    }
    return out + "</body></html>"
  }

  const heavy = html.sanitize(outlookMail(240), { withReader: true })
  assert.strictEqual(heavy.tooHeavy, true, "the formatted view refuses this one")
  assert.strictEqual(heavy.reader.tooHeavy, false, "and reading mode still draws it")
  assert.ok(heavy.reader.complexity.tags < heavy.complexity.tags / 2)
  assert.strictEqual(heavy.reader.complexity.tableDepth, 0)
  assert.ok(heavy.reader.html.indexOf("Headline 239") > 0, "with the whole message in it")

  // Nothing is truncated to fit. A reading that grew past what Qt can lay out
  // is refused whole and the message is shown as text, which is an answer —
  // where a reading that stopped in the middle would have looked exactly like a
  // message that ended there.
  let long = "<html><body>"
  for (let i = 0; i < 3000; i++) long += "<p>Paragraph number " + i + " of a long message.</p>"
  const enormous = html.sanitize(long + "</body></html>", { withReader: true }).reader
  assert.strictEqual(enormous.tooHeavy, true)
  assert.ok(enormous.html.indexOf("number 2999") > 0, "and the whole message is in what was refused")

  // An inline element left open is reopened in every block the chain crosses,
  // so a sender holding a hundred of them open multiplies the whole message by
  // a hundred — and the multiplying happens before anything measures the result
  // and refuses it, on the thread that draws the desktop. Past a handful another
  // one changes nothing anybody can see, so it is not opened; what was inside it
  // is still there.
  let held = "<b>".repeat(126)
  for (let i = 0; i < 400; i++) held += "<div>x</div>"
  const stacked = html.sanitize(held, { withReader: true }).reader
  assert.ok(stacked.complexity.tags < 400 * (html.MAX_READER_CHAIN + 2),
    "a held-open chain multiplied the message: " + stacked.complexity.tags)
  assert.ok(stacked.html.indexOf("x") > 0, "and the message is still in it")
  // A column of nothing but the "|" between two links is the sender drawing a
  // line. Out it goes — and what is left is one column, which is not a grid at
  // all, so a footer of links becomes a list of links instead of a table with a
  // dangling pipe on every row.
  assert.strictEqual(
    reading("<table><tr><td><a href=\"https://a.example.com/\">Online kaufen</a></td><td>|</td></tr>"
      + "<tr><td><a href=\"https://b.example.com/\">Store finden</a></td><td>|</td></tr>"
      + "<tr><td>0800 2000 136</td><td>|</td></tr></table>").html,
    "<p><a href=\"https://a.example.com/\">Online kaufen</a></p>"
      + "<p><a href=\"https://b.example.com/\">Store finden</a></p>"
      + "<p>0800 2000 136</p>")
  // A table that is data on both sides of it is untouched, and a picture is
  // content however few characters it weighs.
  assert.strictEqual(
    reading("<table><tr><th>Hostname</th><td>gitlab.example.com</td></tr>"
      + "<tr><th>Location</th><td>Munich</td></tr></table>").html,
    "<table><tr><th>Hostname</th><td>gitlab.example.com</td></tr>"
      + "<tr><th>Location</th><td>Munich</td></tr></table>")
  assert.strictEqual(
    reading("<table><tr><td><img src=\"https://cdn.example.com/a.png\" alt=\"A\"></td><td>Alpha</td></tr>"
      + "<tr><td><img src=\"https://cdn.example.com/b.png\" alt=\"B\"></td><td>Beta</td></tr></table>").html,
    "<table><tr><td>A</td><td>Alpha</td></tr><tr><td>B</td><td>Beta</td></tr></table>")
  // Between two links in a sentence it is punctuation and stays.
  assert.strictEqual(
    reading("<p><a href=\"https://a.example.com/\">A</a> | <a href=\"https://b.example.com/\">B</a></p>").html,
    "<p><a href=\"https://a.example.com/\">A</a> | <a href=\"https://b.example.com/\">B</a></p>")

  // A cell that breaks its own line is already two lines, and joining it to the
  // cell beside it hands the bottom half of one to the top half of the next.
  assert.strictEqual(
    reading("<table><tr><td>Kundennummer<br><strong>1210617221</strong></td>"
      + "<td>Rechnung Nr.<br><strong>M26056185488</strong></td></tr></table>").html,
    "<p>Kundennummer<br><strong>1210617221</strong></p>"
      + "<p>Rechnung Nr.<br><strong>M26056185488</strong></p>")
  // A row of whole lines still becomes one.
  assert.strictEqual(
    reading("<table><tr><td>Person 1</td><td>moved</td><td>4 cards</td></tr></table>").html,
    "<p>Person 1 moved 4 cards</p>")

  // What a real message nests is untouched.
  assert.strictEqual(
    reading("<p><a href=\"https://x.example.com/\"><b><i>hi</i></b></a></p>").html,
    "<p><a href=\"https://x.example.com/\"><strong><em>hi</em></strong></a></p>")

  // Small pictures in layout rows are inline content: avatars sit beside the
  // words they identify and social icons form one strip. Their bounded numeric
  // dimensions survive so native 256px artwork does not become body-sized.
  const icons = reading("<table>"
    + "<tr><td><a href=\"https://social.example.com/a\"><img src=\"https://cdn.example.com/a.png\" width=\"32\" height=\"32\"></a></td></tr>"
    + "<tr><td><a href=\"https://social.example.com/b\"><img src=\"https://cdn.example.com/b.png\" style=\"width:32px;height:32px\"></a></td></tr>"
    + "</table>", { allowRemoteImages: true }).html
  assert.strictEqual(icons,
    "<p><a href=\"https://social.example.com/a\"><img src=\"https://cdn.example.com/a.png\" width=\"32\" height=\"32\"></a> "
      + "<a href=\"https://social.example.com/b\"><img src=\"https://cdn.example.com/b.png\" width=\"32\" height=\"32\"></a></p>")

  // A standalone logo is not inline artwork, but its declared size still
  // prevents Qt from expanding the source bitmap to its natural pixel width.
  // It keeps the bounded dimension without becoming an avatar or icon strip.
  assert.strictEqual(reading("<p><img src=\"https://cdn.example.com/logo.png\" width=\"120\"></p>",
    { allowRemoteImages: true }).html,
  "<p><img src=\"https://cdn.example.com/logo.png\" width=\"120\"></p>")

  // The reading column may clamp a large picture's width. Its explicit height
  // must not survive that clamp or Qt stretches the image instead of deriving
  // the matching height from its intrinsic aspect ratio.
  assert.strictEqual(reading("<p><img src=\"https://cdn.example.com/hero.jpg\" width=\"600\" height=\"375\"></p>",
    { allowRemoteImages: true }).html,
  "<p><img src=\"https://cdn.example.com/hero.jpg\" width=\"600\"></p>")

  // An avatar at the start of a line is interface-like identity content, not
  // a picture sitting on the text baseline. Qt ignores image alignment in the
  // paragraph here, so the reader builds one compact, vertically centred row.
  const avatar = reading("<p><a href=\"https://example.com/alice\">"
    + "<img src=\"https://cdn.example.com/alice.png\" width=\"20\" height=\"20\"></a>"
    + "<strong>Alice</strong> left a comment</p>", { allowRemoteImages: true }).html
  assert.strictEqual(avatar,
    "<table cellspacing=\"0\" cellpadding=\"0\"><tr>"
      + "<td valign=\"middle\" style=\"padding:0px;padding-right:6px\"><a href=\"https://example.com/alice\">"
      + "<img src=\"https://cdn.example.com/alice.png\" width=\"20\" height=\"20\"></a></td>"
      + "<td valign=\"middle\" style=\"padding:0px\"><strong>Alice</strong> left a comment</td>"
      + "</tr></table>")

  // One parse answers for all three readings, which is what makes changing mode
  // free: the reader is built from the tree the sanitiser is about to clean,
  // and reading that tree does not change it.
  const both = html.sanitize(activityMail(), { withReader: true, withPlainText: true })
  assert.strictEqual(both.html, html.sanitize(activityMail()).html)
  deepEqual(both.plainText, html.readPlainText(activityMail()))
  assert.strictEqual(html.sanitize(activityMail()).reader, null,
    "and nobody pays for a reading no caller asked for")
}

// -------------------------------------------------------------- the document
//
// What Qt is handed. Everything in the stylesheet comes from the theme or from
// the size the message is read at, so the sender's contribution to how this
// looks is exactly nothing.
{
  const palette = {
    foreground: "#cacccc", background: "#101315", link: "#7aa2f7", quote: "#707880",
    fontSize: 13, maxImageWidth: 420
  }
  const read = reading(activityMail())
  const document = html.readerDocumentFor(read.document, palette)

  assert.ok(document.indexOf("<body>") > 0 && document.indexOf("</body></html>") > 0)
  assert.ok(document.indexOf("body{color:#cacccc;background-color:#101315;}") > 0)
  assert.ok(document.indexOf("a{color:#7aa2f7;}") > 0)
  assert.ok(document.indexOf("img{max-width:420px;}") > 0)
  assert.ok(document.indexOf("ul,ol{margin-top:0px;margin-bottom:11px;margin-left:26px;-qt-list-indent:0;}") > 0,
    "lists use one explicit two-character indent instead of Qt's default plus a margin")
  assert.ok(document.indexOf(read.html) > 0, "the document is the reading, unaltered")

  // The rhythm follows the size it is read at rather than standing still while
  // the type grows past it.
  const zoomed = html.readerDocumentFor(read.document, Object.assign({}, palette, { fontSize: 26 }))
  const headingAt = text => Number(/h1\{font-size:(\d+)px/.exec(text)[1])
  assert.ok(headingAt(zoomed) > headingAt(document) * 1.9)
  assert.ok(headingAt(document) > 13, "and a heading is bigger than body copy")

  // A tree or a string, because a caller that only has one should not have to
  // care — and the reader has the tree, so a redraw costs no parse.
  assert.strictEqual(html.readerDocumentFor(read.html, palette), document)

  // Nothing in it points anywhere the document did not already point.
  assert.ok(document.indexOf("url(") < 0)
  assert.ok(document.indexOf("background=") < 0)
  assert.ok(document.indexOf("src=\"http") < 0)
}

// ----------------------------------------------------------- which mode is on
//
// Three ways of reading and one preference across all of them, so a message
// that cannot be drawn the chosen way falls through to one that can rather than
// leaving an empty panel.
{
  assert.strictEqual(html.alwaysRenderHeavyMessages("Always render"), true)
  assert.strictEqual(html.alwaysRenderHeavyMessages("Show plain text first"), false)
  assert.strictEqual(html.alwaysRenderHeavyMessages("unknown"), false)
  assert.strictEqual(html.heavyMessageRendering(true), "Always render")
  assert.strictEqual(html.heavyMessageRendering(false), "Show plain text first")

  const full = { html: true, reader: true }
  assert.strictEqual(html.resolveBodyMode("reader", full), "reader")
  assert.strictEqual(html.resolveBodyMode("original", full), "original")
  assert.strictEqual(html.resolveBodyMode("plain", full), "plain")
  assert.strictEqual(html.resolveBodyMode("nonsense", full), "reader", "and reading is the default")

  // A message with no markup has no readings to choose between: its text is the
  // message rather than one view of it.
  for (const wanted of ["reader", "original", "plain"]) {
    assert.strictEqual(html.resolveBodyMode(wanted, { html: false }), "plain")
    assert.strictEqual(html.bodyModeRefused(wanted, { html: false }), false)
  }

  // A message whose every word was inside a picture reads as nothing, and the
  // sender's own formatting is the honest answer for it.
  assert.strictEqual(html.resolveBodyMode("reader", { html: true, reader: false }), "original")

  // Qt lays rich text out on the GUI thread of the shell that draws the whole
  // desktop, so a document past the bounds gets the text until somebody insists.
  const heavy = { html: true, reader: true, readerHeavy: true, originalHeavy: true }
  assert.strictEqual(html.resolveBodyMode("reader", heavy), "plain")
  assert.strictEqual(html.bodyModeRefused("reader", heavy), true)
  assert.strictEqual(html.resolveBodyMode("reader", Object.assign({ forced: true }, heavy)), "reader")
  assert.strictEqual(html.bodyModeRefused("reader", Object.assign({ forced: true }, heavy)), false)
  // Each mode is heavy for its own reasons: the readings are different
  // documents and are measured separately.
  assert.strictEqual(html.resolveBodyMode("reader",
    { html: true, reader: true, originalHeavy: true }), "reader")
  assert.strictEqual(html.resolveBodyMode("original",
    { html: true, reader: true, originalHeavy: true }), "plain")
  // Asking for the text is never a refusal, however heavy the message is.
  assert.strictEqual(html.bodyModeRefused("plain", heavy), false)

  // A window written before there were three ways to read a message knew only
  // whether the text had been asked for.
  assert.strictEqual(html.bodyModeOf(undefined, "plain"), "plain")
  assert.strictEqual(html.bodyModeOf(undefined, "reader"), "reader")
  assert.strictEqual(html.bodyModeOf("original", "plain"), "original")
  assert.strictEqual(html.bodyModeOf("", undefined), "reader")
  assert.strictEqual(html.bodyModeOf(null, "nonsense"), "reader")
}

// ------------------------------------------------------------- the measure
//
// Sixty-five to seventy-five characters, which is the rule a book obeys and the
// reason a browser's reading mode is a column rather than a window.
{
  // A wide panel gives the column what it needs and keeps the rest.
  assert.strictEqual(html.readingColumnWidth(1200, 640), 640)
  assert.strictEqual(html.readingColumnOffset(1200, 640), 280)
  // A narrow one has nothing to give up, so the column is the panel.
  assert.strictEqual(html.readingColumnWidth(380, 640), 380)
  assert.strictEqual(html.readingColumnOffset(380, 380), 0)
  // The measure grows with the zoom, and the column follows it until the panel
  // runs out — at which point it stops rather than overflowing.
  let previous = 0
  for (const zoom of [0.8, 1.0, 1.4, 2.0, 3.0]) {
    const width = html.readingColumnWidth(900, Math.round(500 * zoom))
    assert.ok(width >= previous, "the column never narrows as the type grows")
    assert.ok(width <= 900, "and never leaves the panel")
    assert.strictEqual(html.readingColumnOffset(900, width) * 2 + width <= 900 + 1, true)
    previous = width
  }
  // Nothing measured yet is not a reason to draw a column one pixel wide.
  assert.strictEqual(html.readingColumnWidth(700, 0), 700)
  assert.strictEqual(html.readingColumnWidth(0, 0), 80)
  assert.strictEqual(html.readingColumnOffset(0, 80), 0)
}

// ------------------------------------------------------------------ direction
//
// Qt's rich text engine reads the `dir` attribute and ignores the CSS
// `direction` property, so a template written for a browser states its
// direction in the one spelling that will be thrown away.
{
  const rtl = html.sanitize('<div style="direction:rtl">مرحبا</div>', {})
  assert.ok(/dir="rtl"/.test(rtl.html),
    "a CSS direction is promoted to the attribute Qt reads")
  assert.ok(/direction:\s*rtl/.test(rtl.html),
    "and the sender's own declaration is left where it was")

  const ltr = html.sanitize('<div style="direction:ltr">hello</div>', {})
  assert.ok(/dir="ltr"/.test(ltr.html))

  // The sender's own attribute is the more specific statement of the two.
  const both = html.sanitize('<div dir="ltr" style="direction:rtl">x</div>', {})
  assert.ok(/dir="ltr"/.test(both.html), "an existing attribute is not overwritten")
  assert.ok(!/dir="rtl"/.test(both.html))

  // Only the two values mean anything. `inherit` and friends are not directions
  // a renderer can be handed.
  const junk = html.sanitize('<div style="direction:inherit">x</div>', {})
  assert.ok(!/ dir=/.test(junk.html), "an unusable value promotes nothing")
}

// The stylesheet's physical sides follow the document's direction; the `dir` on
// the body is written only when the reader has actually chosen one.
{
  const reader = html.readerDocumentFor("<p>مرحبا</p>", { direction: "rtl" })
  assert.ok(/margin-right:26px/.test(reader), "a list indents from the start edge")
  assert.ok(/text-align:right/.test(reader), "a header aligns to the start edge")
  assert.ok(/padding-left:/.test(reader), "a cell's gutter follows its text")
  // The side and the `dir` are one statement: Qt puts a list marker on the side
  // the block runs from, so a right-hand indent without a right-to-left block
  // loses the bullet entirely.
  assert.ok(/<body dir="rtl">/.test(reader),
    "the sheet's sides and the body's direction agree")

  const ltr = html.readerDocumentFor("<p>hello</p>", { direction: "ltr" })
  assert.ok(/margin-left:26px/.test(ltr))
  assert.ok(/text-align:left/.test(ltr))
  assert.ok(/<body dir="ltr">/.test(ltr))

  // No answer at all leaves every side where it was.
  const unknown = html.readerDocumentFor("<p>123</p>", { direction: "" })
  assert.ok(/margin-left:26px/.test(unknown))
  assert.ok(!/<body dir=/.test(unknown))
}

{
  const formatted = html.documentFor("<p>مرحبا</p>", { direction: "rtl" })
  assert.ok(/margin-right:8px/.test(formatted), "the quote bar sits on the start edge")
  assert.ok(/<body dir="rtl">/.test(formatted))

  const plain = html.plainTextDocument("مرحبا", { direction: "rtl" }, false)
  assert.ok(/<body dir="rtl">/.test(plain))

  // A base direction is a default. A sender who states one of their own keeps
  // it, which is why supplying one is safe.
  const sender = html.sanitize('<div dir="ltr">hello</div>', {})
  assert.ok(/dir="ltr"/.test(sender.html),
    "the sender's own direction survives into the document it is wrapped in")
}

console.log("test_html.js ok")
