// The benchmark itself, kept apart from the two things that run it.
//
// Every number this project has argued about so far came out of node, and node
// is V8. The shell runs QML's own engine, so the same fixtures and the same
// loops are run there too — `make bench` prints both, side by side, and the
// difference between the columns is the only honest answer to "how much does it
// cost to have written this in JavaScript".
//
// Written in the same ES5 the QML engine is fed everywhere else in this
// repository, and it reaches Html.js through a plain object of functions rather
// than an import, so neither runner needs anything the other does not have.

// A marketing mail shaped like the real thing: a card behind nine layout
// tables, because that is what this mailbox actually receives. `cards` is the
// only knob; roughly 0.8 KB of source per card.
function outlookMail(cards) {
  var out = "<html><head><title>Newsletter</title><style>.x{color:red}</style></head><body>"
    + "<div style=\"display:none;font-size:1px\">preheader text nobody reads</div>"
  for (var i = 0; i < cards; i++) {
    var open = ""
    var close = ""
    for (var depth = 0; depth < 9; depth++) {
      open += "<table width=\"" + (600 - depth * 10) + "\" align=\"center\" cellpadding=\"0\""
        + " bgcolor=\"#ffffff\"><tr><td style=\"padding:0\">"
      close = "</td></tr></table>" + close
    }
    out += open
      + "<img src=\"https://cdn.example.com/hero" + i + ".png\" width=\"540\" height=\"200\" alt=\"a>b\">"
      + "<h2 style=\"color:#111;margin:0 0 8px\">Headline " + i + "</h2>"
      + "<p style=\"margin:0 12px;color:#555\">Body copy &amp; more of it, "
      + "<a href=\"https://example.com/" + i + "\">read on</a>.</p>"
      + "<img src=\"https://track.example.com/p" + i + ".gif\" width=\"1\" height=\"1\">"
      + close
  }
  return out + "</body></html>"
}

function kb(measured) {
  return (measured.length / 1024).toFixed(0)
}

function pad(text, width) {
  var out = String(text)
  while (out.length < width) out = " " + out
  return out
}

// Milliseconds per run, over enough runs to outlast the clock's resolution.
function timed(run) {
  var started = Date.now()
  var runs = 0
  while (Date.now() - started < 250 || runs < 3) {
    run()
    runs++
  }
  return (Date.now() - started) / runs
}

// What opening a message costs: the body is sanitised once, and the reader
// builds its document from the tree that came back.
function openOnce(html, source, palette) {
  var ready = html.sanitize(source, { allowRemoteImages: false, withPlainText: true })
  html.documentFor(ready.document, palette)
  return ready
}

// Which bound refused it, because "too heavy" is four different bounds and
// which one bites is the thing worth knowing when tuning them.
function refusedBy(size, limits) {
  if (size.length > limits.richText) return "too long (" + kb(size) + " KB)"
  if (size.tags > limits.elements) return "too many elements (" + size.tags + ")"
  if (size.tables > limits.tables) return "too many tables (" + size.tables + ")"
  if (size.tableDepth > limits.tableDepth) return "tables too deep (" + size.tableDepth + ")"
  return ""
}

function run(html, log) {
  var palette = {
    foreground: "#cacccc", background: "#101315", link: "#7aa2f7", quote: "#707880",
    maxImageWidth: 380, compact: true
  }

  log("  " + pad("source", 8) + pad("to Qt", 9) + pad("elements", 10)
    + pad("open", 9) + pad("relayout", 10) + "   verdict")
  log("  " + pad("", 58).replace(/ /g, "-"))

  var sizes = [6, 24, 90, 240]
  for (var i = 0; i < sizes.length; i++) {
    var source = outlookMail(sizes[i])
    var ready = openOnce(html, source, palette)

    var open = timed(function() { openOnce(html, source, palette) })
    // A drag walks through widths; the document is not reparsed for any of them.
    var step = 0
    var relayout = timed(function() {
      palette.maxImageWidth = 300 + (step++ % 30) * 20
      html.documentFor(ready.document, palette)
    })
    palette.maxImageWidth = 380

    var refused = ready.tooHeavy ? refusedBy(ready.complexity, html.limits) : ""
    log("  " + pad(kb(source) + " KB", 8)
      + pad(kb(ready.html) + " KB", 9)
      + pad(ready.complexity.tags, 10)
      + pad(open.toFixed(2) + "ms", 9)
      + pad(relayout.toFixed(2) + "ms", 10)
      + (refused === "" ? "" : "   refused: " + refused))
  }

  log("")
  log("  source    the sender's HTML, as Gmail handed it over")
  log("  to Qt     what the renderer is given, after sanitising and collapsing")
  log("  open      sanitise once, then build the document from the tree")
  log("  relayout  one width step of a splitter drag, no parse")
  log("  verdict   which bound refused it; the reader shows the plain text instead,")
  log("            so such a row is the cost of finding that out, not of showing it")
}
