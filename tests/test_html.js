const assert = require("assert")
const { load } = require("./load")

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
const table = "<table><tr><td style=\"color:#333\"><b>Total</b></td></tr></table>"
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

const allowed = html.sanitize(tracked, { allowRemoteImages: true })
assert.strictEqual(allowed.blockedImages, 0)
assert.ok(allowed.html.indexOf("https://track.example/pixel.gif") > 0)

// cid: images point at attachments this plugin does not fetch, and data: URIs
// are already local. Neither is a network request, and neither is counted.
assert.strictEqual(html.sanitize("<img src=\"cid:logo\">").blockedImages, 0)
assert.strictEqual(html.sanitize("<img src=\"data:image/png;base64,AAA\">").blockedImages, 0)
assert.strictEqual(html.sanitize("<img src='http://a/b.png'><img src='https://c/d.png'>").blockedImages, 2)
// Protocol-relative sources are still network fetches.
assert.strictEqual(html.sanitize("<img src=\"//cdn.example/x.png\">").blockedImages, 1)

assert.strictEqual(html.hasRemoteImages(tracked), true)
assert.strictEqual(html.hasRemoteImages("<p>none</p>"), false)

assert.strictEqual(html.sanitize("").html, "")
assert.strictEqual(html.sanitize(null).html, "")
assert.strictEqual(html.sanitize(null).blockedImages, 0)

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

console.log("test_html.js ok")
