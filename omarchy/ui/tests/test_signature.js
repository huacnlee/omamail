const assert = require("assert")
const { load, deepEqual } = require("./load")

const signature = load("message/Signature.js")

// One-pixel rasters, as base64.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>').toString("base64")

// A picture: only a real raster, by its bytes, within the cap.
assert.strictEqual(signature.rasterKind(PNG), "image/png")
assert.strictEqual(signature.rasterKind(GIF), "image/gif")
assert.strictEqual(signature.rasterKind(SVG), "", "an SVG is a document, whatever it is named")
assert.strictEqual(signature.rasterKind(""), "")
{
  const ok = signature.importImage(PNG)
  assert.strictEqual(ok.problem, "")
  assert.ok(ok.html.indexOf('<img src="data:image/png;base64,' + PNG + '"') > 0)
  assert.ok(signature.importImage(SVG).problem.indexOf("not a PNG") >= 0)
  assert.ok(signature.importImage(PNG, { maxImageBytes: 10 }).problem.indexOf("larger") >= 0)
}

// Markup: everything that could run, fetch or hide is gone; the words stay.
{
  const hostile = '<html><head><style>p{display:none}</style><script>alert(1)</script></head>'
    + '<body><p onmouseover="steal()" style="color:red" class="x">Ada <b>Lovelace</b></p>'
    + '<p style="background:url(https://evil.example.net/bg.png);color:blue">styled</p>'
    + '<a href="javascript:alert(1)">click</a> <a href="https://example.com/x?y=1">site</a> '
    + '<a href="http://127.0.0.1/admin">local</a> <a href="mailto:ada@example.com">mail</a>'
    + '<img src="https://tracker.example.net/p.gif"><img src="data:image/png;base64,' + PNG + '" width="16" height="16" alt="logo">'
    + '<img src="data:image/svg+xml;base64,' + SVG + '"><img src="data:image/png;base64,' + SVG + '">'
    + '<iframe src="https://evil.example.net"></iframe><object data="x"></object><form action="https://evil.example.net"><input name="pw"></form>'
    + '<div background="https://evil.example.net/bg.png">In a <span style="font-size:0">hidden</span> box</div>'
    + '<table><tr><td colspan="2" bgcolor="#fff">cell</td></tr></table></body></html>'
  const result = signature.importHtml(hostile)
  assert.strictEqual(result.problem, "")
  const html = result.html
  const forbidden = ["<script", "<style", "onmouseover", "javascript:", "tracker.example.net", "127.0.0.1",
    "svg", "<iframe", "<object", "<form", "<input", "background=", "url(", "evil.example.net", "font-size:0"]
  forbidden.forEach(function (needle) {
    assert.strictEqual(html.toLowerCase().indexOf(needle.toLowerCase()), -1, "must not survive: " + needle)
  })
  assert.ok(html.indexOf("Ada") >= 0 && html.indexOf("Lovelace") >= 0, "the words stay")
  assert.ok(html.indexOf('style="color:red"') > 0, "the formatting stays: an inline colour")
  assert.ok(html.indexOf("<b>Lovelace</b>") > 0)
  assert.ok(html.indexOf('href="https://example.com/x?y=1"') > 0, "a public link stays")
  assert.ok(html.indexOf('href="mailto:ada@example.com"') > 0, "a mailto stays")
  assert.strictEqual((html.match(/<img /g) || []).length, 1, "only the real raster survives")
  assert.ok(html.indexOf('width="16"') > 0 && html.indexOf('height="16"') > 0)
  assert.strictEqual(result.images, 1)
  assert.ok(result.dropped >= 6, "and the removals are counted: " + result.dropped)
  assert.ok(result.plain.indexOf("Ada Lovelace") >= 0, "a text-only client gets the words")
  assert.strictEqual(result.plain.indexOf("alert"), -1)
  assert.strictEqual(html.indexOf("<"), 0, "what is stored is markup rebuilt from the tree")
}

// Formatting is what the file was imported for: colours, a face, a table.
{
  const styled = signature.importHtml('<table style="border:1px solid #ccc"><tr><td align="left"><font color="#333" face="Arial" size="2">Ada</font><br><span style="color:#888">Analyst</span></td></tr></table>')
  assert.strictEqual(styled.problem, "")
  assert.ok(styled.html.indexOf('color="#333"') > 0 && styled.html.indexOf('face="Arial"') > 0, "a font's colour and face stay")
  assert.ok(styled.html.indexOf("color:#888") > 0, "an inline colour stays")
  assert.ok(styled.html.indexOf("border:1px solid #ccc") > 0, "a border stays")
  assert.strictEqual(styled.dropped, 0, "nothing needed removing")
}

// Nothing usable, and too big, are refused rather than stored empty.
assert.ok(signature.importHtml("<script>x()</script>").problem.indexOf("Nothing") >= 0)
assert.ok(signature.importHtml("x".repeat(300 * 1024)).problem.indexOf("too large") >= 0)
assert.ok(signature.importHtml("").problem !== "")

// Text with a break in it stays two lines, and a stored signature round-trips
// through the importer unchanged in what it says.
{
  const first = signature.importHtml("<p>Ada Lovelace<br>Analyst</p>")
  assert.strictEqual(first.problem, "")
  assert.ok(first.plain.indexOf("Ada Lovelace") >= 0 && first.plain.indexOf("Analyst") >= 0)
  const again = signature.importHtml(first.html)
  assert.strictEqual(again.plain, first.plain)
}

// Sending: each data image becomes a cid part.
{
  const swapped = signature.inlineParts('<p><img src="data:image/png;base64,' + PNG + '"> and <img src="data:image/gif;base64,' + GIF + '"></p>', "sig")
  assert.strictEqual(swapped.parts.length, 2)
  assert.strictEqual(swapped.parts[0].cid, "sig1@omamail")
  assert.strictEqual(swapped.parts[1].mimeType, "image/gif")
  assert.ok(swapped.html.indexOf('src="cid:sig1@omamail"') > 0)
  assert.strictEqual(swapped.html.indexOf("data:"), -1)
  deepEqual(signature.inlineParts("<p>no images</p>").parts, [])
}

assert.strictEqual(signature.importNote({ problem: "", images: 1, dropped: 0 }), "Imported: 1 image")
assert.strictEqual(signature.importNote({ problem: "", images: 0, dropped: 3 }), "Imported: 3 unsafe or unsupported parts removed")
assert.strictEqual(signature.importNote({ problem: "", images: 0, dropped: 0 }), "Imported")
assert.strictEqual(signature.importNote({ problem: "bad" }), "bad")

console.log("test_signature.js ok")
