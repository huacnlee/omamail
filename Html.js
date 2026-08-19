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

function complexity(html) {
  var text = String(html || "")
  return {
    length: text.length,
    tags: (text.match(/<[a-zA-Z]/g) || []).length,
    images: (text.match(/<img\b/gi) || []).length
  }
}

function tooHeavyForRichText(html) {
  var size = complexity(html)
  return size.length > MAX_RICH_TEXT || size.tags > MAX_ELEMENTS
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

// PAPER and INK are the only literal colours in this project, and they are
// content colours rather than theme colours.
//
// A sender's HTML arrives with its own palette and, crucially, its own text
// colours to match. GitHub sets #24292e on white; stripping its backgrounds to
// force the message dark would leave that text on a #131313 ground and make it
// invisible. So a formatted message is rendered on a sheet, the way a mail
// client has always shown one, and the window's own chrome stays themed.
//
// A plain-text body has no palette of its own and does take the theme — see
// documentFor's callers.
var PAPER = "#ffffff"
var INK = "#1a1a1a"

// Wraps the sanitised body in a document. `colors` styles the parts the sender
// did not: the ground, the default text, links and quoted replies.
function documentFor(bodyHtml, colors) {
  var palette = colors || {}
  var foreground = String(palette.foreground || INK)
  var background = String(palette.background || PAPER)
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

// The sheet a formatted message is printed on.
function paperPalette(linkColor) {
  return {
    foreground: INK,
    background: PAPER,
    link: String(linkColor || "#1155cc"),
    quote: "#5f6368",
    padding: 18
  }
}
