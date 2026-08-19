.pragma library

// Message HTML, reduced to what Qt's rich text engine actually renders.
//
// Qt supports a subset of HTML 4 and CSS 2.1 natively — tables, inline
// styles, <font>, links, images — which is most of what real email uses,
// because real email is still table-and-inline-style HTML written for
// Outlook. What it does not support it ignores, with two exceptions this
// module exists to handle:
//
//   - a <style> block's CSS text is rendered as body text
//   - <img src="https://..."> is genuinely fetched, so every tracking pixel
//     in the message fires the moment the reader opens it
//
// Remote images are therefore removed by default and the count is reported so
// the reader can offer to load them.

var DROPPED_ELEMENTS = ["script", "style", "iframe", "object", "embed", "applet", "noscript"]

// Qt lays rich text out synchronously on the GUI thread, and this plugin lives
// inside the shell that draws the user's whole desktop. A message heavy enough
// to make that layout take seconds does not just stall the reader — it stalls
// the bar, the menu and every other panel. So the reader refuses documents past
// these bounds and shows the plain-text part instead, with a way to override.
var MAX_RICH_TEXT = 120000
var MAX_ELEMENTS = 2500
var MAX_IMAGES = 24
// Backstop for anything flattening does not tame.
var MAX_TABLES = 60
var MAX_TABLE_DEPTH = 4

// Nesting depth is the measure that matters. Qt lays tables out by resolving
// column widths against each other, and deeply nested tables with competing
// widths — which is exactly how notification mail is built — can keep that
// resolution going far longer than anyone will wait. Real mail in this mailbox
// reaches nine levels.
function tableDepth(html) {
  var text = String(html || "")
  var pattern = /<(\/?)table\b/gi
  var depth = 0
  var deepest = 0
  var match
  while ((match = pattern.exec(text)) !== null) {
    if (match[1]) depth = Math.max(0, depth - 1)
    else {
      depth++
      if (depth > deepest) deepest = depth
    }
  }
  return deepest
}

function complexity(html) {
  var text = String(html || "")
  return {
    length: text.length,
    tags: (text.match(/<[a-zA-Z]/g) || []).length,
    images: (text.match(/<img\b/gi) || []).length,
    tables: (text.match(/<table\b/gi) || []).length,
    tableDepth: tableDepth(text)
  }
}

// Tables past this depth become plain blocks. Two levels covers the real
// tabular content in mail — a status table, a receipt — while the layers above
// it are only there to centre a card in an Outlook window.
var KEEP_TABLE_DEPTH = 2
var TABLE_TAG = /<(\/?)(table|thead|tbody|tfoot|tr|td|th)\b([^>]*)>/gi

function keptStyle(attrs) {
  var style = String(attrs || "").match(/\sstyle\s*=\s*("[^"]*"|'[^']*')/i)
  return style ? " style=" + style[1] : ""
}

function flattenTables(html, keepDepth) {
  var limit = keepDepth === undefined ? KEEP_TABLE_DEPTH : Math.max(0, keepDepth)
  var depth = 0
  return String(html || "").replace(TABLE_TAG, function(tag, slash, name, attrs) {
    var lower = String(name).toLowerCase()
    if (lower === "table") {
      if (slash) {
        var closing = depth > limit
        depth = Math.max(0, depth - 1)
        return closing ? "</div>" : tag
      }
      depth++
      return depth > limit ? "<div" + keptStyle(attrs) + ">" : tag
    }
    if (depth > limit) return slash ? "</div>" : "<div" + keptStyle(attrs) + ">"
    return tag
  })
}

function tooHeavyForRichText(html) {
  var size = complexity(html)
  return size.length > MAX_RICH_TEXT
    || size.tags > MAX_ELEMENTS
    || size.tables > MAX_TABLES
    || size.tableDepth > MAX_TABLE_DEPTH
}

// A 1x1 image is a tracking pixel, never something to look at. Dropping them
// removes both the beacon and a layout pass per message.
function isTrackingPixel(tag) {
  var width = tag.match(/\swidth\s*=\s*"?(\d+)/i)
  var height = tag.match(/\sheight\s*=\s*"?(\d+)/i)
  if (width && Number(width[1]) <= 2) return true
  if (height && Number(height[1]) <= 2) return true
  return /(width|height)\s*:\s*[012](\.\d+)?px/i.test(tag)
}

// Senders ship their own palette: a background *and* the text colour that
// suits it. Removing only the background is what makes a message unreadable —
// GitHub's #24292e text would sit on a #131313 ground — so both go, and the
// document stylesheet supplies the pair. Anything that survives (images,
// borders) belongs to the sender.
var COLOUR_DECLARATION = /(^|;)\s*(color|background|background-color|border-color|outline-color)\s*:[^;]*/gi

function stripColorsFromStyle(style) {
  return String(style || "")
    .replace(COLOUR_DECLARATION, "$1")
    // Removing a declaration from the middle leaves the separators on both
    // sides of it, which Qt reads as an empty rule.
    .replace(/;{2,}/g, ";")
    .replace(/^[;\s]+|[;\s]+$/g, "")
}

function stripColors(html) {
  var text = String(html || "")
  // Presentational attributes first: bgcolor and <font color> predate CSS and
  // still turn up in mail written for Outlook.
  text = text.replace(/\s(bgcolor|background|bordercolor)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
  text = text.replace(/\s(color)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
  return text.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi,
    function(match, raw, dq, sq) {
      var cleaned = stripColorsFromStyle(dq !== undefined ? dq : sq)
      return cleaned === "" ? "" : " style=\"" + cleaned + "\""
    })
}

function stripElement(text, name) {
  var open = new RegExp("<" + name + "\\b[^>]*>[\\s\\S]*?<\\/" + name + "\\s*>", "gi")
  var lone = new RegExp("<\\/?" + name + "\\b[^>]*>", "gi")
  return String(text).replace(open, "").replace(lone, "")
}

// Protocol-relative sources are network fetches too — "//cdn/x.png" resolves
// against the page protocol, which is exactly the tracking case.
function isRemoteSource(value) {
  return /^\s*(https?:)?\/\//i.test(String(value || ""))
}

// Only http(s) and mailto survive. A javascript: href does nothing in Qt's
// renderer, but it would still be handed to xdg-open by the link handler.
function safeHref(value) {
  return /^\s*(https?:|mailto:)/i.test(String(value || ""))
}

function sanitize(html, options) {
  var settings = options || {}
  var text = String(html === undefined || html === null ? "" : html)
  if (text === "") return { html: "", blockedImages: 0 }

  // The message takes the window's theme, so the sender's palette comes out
  // before anything else looks at the markup.
  if (settings.keepColors !== true) text = stripColors(text)
  if (settings.keepTables !== true) text = flattenTables(text, settings.keepTableDepth)

  text = text.replace(/<!--[\s\S]*?-->/g, "")
  for (var i = 0; i < DROPPED_ELEMENTS.length; i++) text = stripElement(text, DROPPED_ELEMENTS[i])
  text = text.replace(/<(meta|link|base)\b[^>]*>/gi, "")

  // Event handlers, which Qt ignores but which have no business surviving a
  // trip through a mail client.
  text = text.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")

  text = text.replace(/\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    function(match, raw, dq, sq, bare) {
      var value = dq !== undefined ? dq : (sq !== undefined ? sq : bare)
      return safeHref(value) ? match : ""
    })

  // Every image is a network fetch Qt performs while laying the document out,
  // and every completed fetch triggers another layout pass. Tracking pixels
  // are pure cost, and past the cap the rest are decoration.
  var blocked = 0
  var kept = 0
  var allowImages = settings.allowRemoteImages === true
  var limit = Math.max(0, Math.floor(
    settings.maxImages === undefined ? MAX_IMAGES : settings.maxImages))

  text = text.replace(/<img\b[^>]*>/gi, function(tag) {
    var source = tag.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
    if (!source) return tag
    var value = source[2] !== undefined ? source[2]
      : (source[3] !== undefined ? source[3] : source[4])
    if (!isRemoteSource(value)) return tag
    if (isTrackingPixel(tag)) {
      blocked++
      return ""
    }
    if (!allowImages || kept >= limit) {
      blocked++
      // Removed rather than emptied: an <img> with no src still reserves a
      // broken-image box in Qt's layout, which reads as a rendering fault.
      return ""
    }
    kept++
    return tag
  })

  return { html: text, blockedImages: blocked, images: kept }
}

function hasRemoteImages(html) {
  return sanitize(html).blockedImages > 0
}

// Wraps the sanitised body in a document. `colors` styles the parts the sender
// did not: the ground, the default text, links and quoted replies.
function documentFor(bodyHtml, colors) {
  var palette = colors || {}
  var foreground = String(palette.foreground || "")
  var background = String(palette.background || "")
  var link = String(palette.link || foreground)
  var quote = String(palette.quote || foreground)
  // Margin on body is ignored by Qt's rich text engine, so the padding lives
  // on a wrapper the sender's markup sits inside.
  var pad = Math.max(0, Math.floor(Number(palette.padding) || 0))
  return "<html><head><style type=\"text/css\">"
    + "body{color:" + foreground + ";background-color:" + background + ";}"
    + "a{color:" + link + ";}"
    + "blockquote{color:" + quote + ";margin-left:8px;padding-left:8px;}"
    + "td,th{padding:2px;}"
    + "</style></head><body>"
    + (pad > 0 ? "<div style=\"padding:" + pad + "px\">" : "")
    + String(bodyHtml || "")
    + (pad > 0 ? "</div>" : "")
    + "</body></html>"
}

// ------------------------------------------------------- plain text bodies
//
// The reader falls back to plain text when the user asks for it and when a
// message is too heavy to lay out as rich text. Both cases still want the
// images to be reachable, so the markers htmlToText leaves behind are turned
// into links — and this document is built here rather than taken from the
// sender, so it stays trivially cheap to lay out even for the messages that
// were too heavy in the first place.

var IMAGE_LINK_PREFIX = "omarchy-image:"

// Counted off the sender's own HTML, with exactly the parts htmlToText drops
// dropped first. The markers in the text are numbered by that same walk, so the
// two lists line up position for position — counting these off the sanitised
// HTML instead would drift the moment a tracking pixel was removed or the image
// cap was reached, and every marker after it would open the wrong picture.
function imageSources(html) {
  var out = []
  var pattern = /<img\b[^>]*>/gi
  var tags = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .match(pattern) || []
  for (var i = 0; i < tags.length; i++) {
    var src = tags[i].match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
    out.push(src ? String(src[2] || src[3] || src[4] || "") : "")
  }
  return out
}

function escapeText(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

// HTML collapses runs of whitespace, which would take the alignment out of a
// signature, an indented quote or anything else the sender laid out by hand —
// the very thing someone reading in plain text is asking to see.
function preserveSpacing(escaped) {
  return String(escaped).replace(/ {2,}/g, function(run) {
    return new Array(run.length + 1).join("&nbsp;")
  })
}

function plainTextDocument(text, colors, linkImages) {
  var palette = colors || {}
  var foreground = String(palette.foreground || "")
  var background = String(palette.background || "")
  var link = String(palette.link || foreground)
  var body = preserveSpacing(escapeText(text))
  if (linkImages) {
    body = body.replace(/\[image (\d+)\]/g, function(match, index) {
      return "<a href=\"" + IMAGE_LINK_PREFIX + index + "\">" + match + "</a>"
    })
  }
  body = body.replace(/\n/g, "<br>")
  return "<html><head><style type=\"text/css\">"
    + "body{color:" + foreground + ";background-color:" + background + ";}"
    + "a{color:" + link + ";}"
    + "</style></head><body>" + body + "</body></html>"
}

// The index a marker link carries, or 0 when the link is something else.
function imageLinkIndex(url) {
  var text = String(url || "")
  if (text.indexOf(IMAGE_LINK_PREFIX) !== 0) return 0
  var index = Number(text.substring(IMAGE_LINK_PREFIX.length))
  return index > 0 ? Math.floor(index) : 0
}
