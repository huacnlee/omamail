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

// A url() in an inline style is a fetch wherever the engine honours it, and
// which declarations Qt honours is not worth having to be right about: nothing
// in mail needs one, because pictures arrive as <img>, which is where the image
// policy lives. The declaration goes rather than the whole attribute, so the
// padding and the font beside it survive.
function stripStyleUrls(html) {
  return String(html || "").replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi,
    function(match, raw, dq, sq) {
      var value = dq !== undefined ? dq : sq
      if (!/url\s*\(/i.test(decodeReferences(value))) return match
      var parts = String(value).split(";")
      var kept = []
      for (var i = 0; i < parts.length; i++) {
        if (/url\s*\(/i.test(decodeReferences(parts[i]))) continue
        if (parts[i].replace(/\s+/g, "") !== "") kept.push(parts[i])
      }
      var cleaned = kept.join(";").replace(/^[;\s]+|[;\s]+$/g, "")
      return cleaned === "" ? "" : " style=\"" + cleaned + "\""
    })
}

function stripElement(text, name) {
  var open = new RegExp("<" + name + "\\b[^>]*>[\\s\\S]*?<\\/" + name + "\\s*>", "gi")
  var lone = new RegExp("<\\/?" + name + "\\b[^>]*>", "gi")
  return String(text).replace(open, "").replace(lone, "")
}

// ------------------------------------------------------------- tag boundaries
//
// Where a tag ends is the one thing the image policy below cannot afford to be
// wrong about, and /<img\b[^>]*>/ is wrong about it. Qt's parser reads
// attribute values with their quotes, so
//
//   <img alt="a>b" src="http://127.0.0.1/p.gif">
//
// is one image tag to the engine and two pieces of nothing to that regex: it
// stops at the ">" inside the alt text, finds no src in what it took, and hands
// the whole tag back untouched — which is a fetch. A sender only has to put a
// ">" in an alt text to walk past the check.
//
// Qt has no HTML parser a QML plugin can call, so tag boundaries are scanned
// for rather than matched. This is not a parser and does not try to be one: it
// answers exactly one question, which is where a tag someone opened stops.
function tagEnd(text, from) {
  var quote = ""
  for (var i = from; i < text.length; i++) {
    var character = text.charAt(i)
    if (quote !== "") {
      if (character === quote) quote = ""
      continue
    }
    if (character === "\"" || character === "'") {
      quote = character
      continue
    }
    if (character === ">") return i + 1
  }
  return -1
}

// Every <name ...> tag rewritten through `fn`, which is handed the whole tag and
// returns what stands in its place. A tag that never closes takes the rest of
// the document with it: Qt would swallow the remainder into the tag anyway, and
// dropping it is the reading that cannot leave a fetch behind.
function replaceTags(html, name, fn) {
  var text = String(html || "")
  var opening = new RegExp("<" + name + "\\b", "gi")
  var out = ""
  var at = 0
  var found
  while ((found = opening.exec(text)) !== null) {
    if (found.index < at) continue
    var end = tagEnd(text, found.index + found[0].length)
    out += text.substring(at, found.index)
    if (end < 0) return out
    out += fn(text.substring(found.index, end))
    at = end
    opening.lastIndex = end
  }
  return out + text.substring(at)
}

// ------------------------------------------------------------ image sources
//
// An attribute value is not a URL until the HTML parser has resolved the
// character references inside it. Qt does that before it fetches anything, so
// src="&#104;ttps://tracker/x.png" is a real https fetch to the engine while a
// check reading the raw attribute text sees something that starts with an "&"
// and lets it through. Tab and newline inside a URL are dropped for the same
// reason: they are not part of it by the time the fetch is made.
var NAMED_REFERENCES = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", sol: "/", colon: ":" }

function decodeReferences(text) {
  return String(text).replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);?/g,
    function(match, body) {
      if (body.charAt(0) !== "#") {
        var named = NAMED_REFERENCES[body.toLowerCase()]
        return named === undefined ? match : named
      }
      var code = body.charAt(1) === "x" || body.charAt(1) === "X"
        ? parseInt(body.substring(2), 16)
        : parseInt(body.substring(1), 10)
      if (!isFinite(code) || code < 0 || code > 0x10ffff) return match
      return String.fromCharCode(code)
    })
}

// Decoded twice, because "&amp;#104;" is one reference to Qt and two to a
// reader looking for a scheme. Over-decoding can only make a source look more
// remote than it is, and the answer to "remote" is to block it.
function normalizedUrl(value) {
  var text = String(value === undefined || value === null ? "" : value)
  text = decodeReferences(decodeReferences(text))
  return text.replace(/[\t\n\r]/g, "").replace(/^[\s\u0000-\u001f]+|[\s\u0000-\u001f]+$/g, "")
}

// The host of an http(s) or protocol-relative URL, lower-cased, with the
// userinfo, the port and everything after the authority removed. Userinfo
// matters: "http://gmail.com@127.0.0.1/x.png" is a request to 127.0.0.1.
function hostOf(url) {
  var text = String(url || "").replace(/^https?:/i, "")
  if (text.indexOf("//") !== 0) return ""
  var authority = text.substring(2)
  var end = authority.search(/[\/?#]/)
  if (end >= 0) authority = authority.substring(0, end)
  var at = authority.lastIndexOf("@")
  if (at >= 0) authority = authority.substring(at + 1)
  if (authority.charAt(0) === "[") {
    var close = authority.indexOf("]")
    return (close < 0 ? authority : authority.substring(0, close + 1)).toLowerCase()
  }
  var colon = authority.indexOf(":")
  return (colon < 0 ? authority : authority.substring(0, colon)).toLowerCase()
}

var DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isPublicIpv4(host) {
  var parts = String(host).match(DOTTED_QUAD)
  if (!parts) return false
  var octets = []
  for (var i = 1; i <= 4; i++) {
    // A leading zero reads as octal to some resolvers and as decimal to
    // others, so "0177.0.0.1" is 127.0.0.1 to one of them. Neither reading is
    // worth the risk of picking the wrong one.
    if (parts[i].length > 1 && parts[i].charAt(0) === "0") return false
    var value = Number(parts[i])
    if (value > 255) return false
    octets.push(value)
  }
  var a = octets[0]
  var b = octets[1]
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 168 || b === 0)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a >= 224) return false
  return true
}

// Names that are the machine this runs on, or the network around it. The
// reserved-but-unresolvable ones (.example, .invalid) are left out: they are
// not internal, they simply do not exist.
var PRIVATE_SUFFIX = /(^|\.)(localhost|home\.arpa)$|\.(local|localdomain|internal|intranet|lan|home|corp|test)$/
var PUBLIC_TLD = /\.(xn--[a-z0-9-]+|[a-z]{2,})$/

// A message must not be able to make this client talk to the machine it runs
// on or to the network that machine sits in. A crafted <img> is a request the
// reader never asked for, aimed at whatever the sender names — a router's
// admin page, a printer, a service listening on loopback — and issuing it is
// the attack whether or not the answer is ever drawn.
//
// So the rule is a list of what is allowed rather than a list of what is not:
// a name whose last label is a real top-level domain, or a public IPv4
// address. That refuses "localhost", a bare "printer", ".local" and
// ".internal", every IPv6 literal, and an address written in octal, in hex, or
// as one number — without having to have thought of each of them first.
//
// A public name that resolves to a private address is beyond what any check on
// the URL can see. That is DNS rebinding, and stopping it needs a resolver
// this plugin does not own.
function isPublicHost(host) {
  var name = String(host || "")
  if (name === "" || name.length > 253) return false
  if (isPublicIpv4(name)) return true
  if (!/^[a-z0-9.-]+$/.test(name)) return false
  if (name.indexOf("..") >= 0) return false
  if (PRIVATE_SUFFIX.test(name)) return false
  return PUBLIC_TLD.test(name)
}

// Protocol-relative sources are network fetches too — "//cdn/x.png" resolves
// against the page protocol, which is exactly the tracking case.
function isRemoteSource(value) {
  return /^(https?:)?\/\//i.test(normalizedUrl(value))
}

// What an <img src> is, as far as the fetch it would cause is concerned:
//
//   inline  cid: and data: — the message's own bytes, no network at all
//   remote  http(s) at a host on the public internet
//   unsafe  anything else with a scheme, or a host that is not public. file:
//           and qrc: are local reads; loopback and private addresses are the
//           network behind the user's front door.
//   local   no scheme. Qt resolves a relative source against the document's
//           base URL, which for a TextEdit is the QML file's own directory —
//           a read of whatever sits next to the plugin.
function imageSourceKind(value) {
  var url = normalizedUrl(value)
  if (url === "") return "none"
  if (/^cid:/i.test(url)) return "inline"
  if (/^data:/i.test(url)) return "inline"
  if (/^(https?:)?\/\//i.test(url)) return isPublicHost(hostOf(url)) ? "remote" : "unsafe"
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? "unsafe" : "local"
}

// Whether the reader may hand a source straight to an Image element, which is
// what opening an image marker in a plain-text body does.
function isDisplayableImageUrl(value) {
  var kind = imageSourceKind(value)
  if (kind === "remote") return true
  return kind === "inline" && /^data:image\//i.test(normalizedUrl(value))
}

// Only http(s) and mailto survive. A javascript: href does nothing in Qt's
// renderer, but it would still be handed to xdg-open by the link handler.
function safeHref(value) {
  return /^\s*(https?:|mailto:)/i.test(String(value || ""))
}

// Qt's rich text engine ignores display:none outright — measured: a hidden div
// adds a full line of text to the layout. It does honour font-size, though, and
// the standard email preheader is hidden text set at 1px, so it comes out as a
// two-pixel smudge of unreadable characters above the message. Elements the
// sender marked hidden are therefore removed rather than styled away.
var HIDDEN_STYLE = /(display\s*:\s*none|visibility\s*:\s*hidden)/i
var VOID_ELEMENTS = /^(img|br|hr|input|meta|link|area|base|col|embed|source|track|wbr)$/i

// Counts nesting, so a hidden wrapper takes exactly its own subtree and not
// whatever happens to close first.
function closeIndexFor(text, name, from) {
  var pattern = new RegExp("<(/?)" + name + "\\b[^>]*>", "gi")
  pattern.lastIndex = from
  var depth = 1
  var found = pattern.exec(text)
  while (found !== null) {
    if (found[1] === "/") {
      depth--
      if (depth === 0) return pattern.lastIndex
    } else if (found[0].charAt(found[0].length - 2) !== "/") {
      depth++
    }
    found = pattern.exec(text)
  }
  return -1
}

function dropHidden(html) {
  var text = String(html || "")
  var opening = /<([a-z][a-z0-9]*)\b([^>]*)>/gi
  var found = opening.exec(text)
  while (found !== null) {
    var name = found[1]
    if (!VOID_ELEMENTS.test(name) && HIDDEN_STYLE.test(found[2] || "")) {
      var end = closeIndexFor(text, name, opening.lastIndex)
      if (end < 0) end = text.length
      text = text.substring(0, found.index) + text.substring(end)
      opening.lastIndex = found.index
    }
    found = opening.exec(text)
  }
  return text
}

function sanitize(html, options) {
  var settings = options || {}
  var text = String(html === undefined || html === null ? "" : html)
  if (text === "") return { html: "", blockedImages: 0, images: 0, remoteImages: 0 }

  // The message takes the window's theme, so the sender's palette comes out
  // before anything else looks at the markup.
  if (settings.keepColors !== true) text = stripColors(text)
  if (settings.keepTables !== true) text = flattenTables(text, settings.keepTableDepth)

  text = text.replace(/<!--[\s\S]*?-->/g, "")
  text = stripStyleUrls(text)
  text = dropHidden(text)
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

  // Every remote image is a network fetch Qt performs while laying the document
  // out, and every completed fetch triggers another layout pass. Tracking
  // pixels are pure cost, and past the cap the rest are decoration.
  //
  // Nothing remote is fetched unless the reader asked for it. Opening a message
  // is not asking: the fetch alone tells the sender the mail was read, from
  // which address and at what time, and a source pointed at the machine itself
  // turns reading mail into a request to whatever is listening on it.
  var blocked = 0
  var kept = 0
  var loadable = 0
  var allowImages = settings.allowRemoteImages === true
  var limit = Math.max(0, Math.floor(
    settings.maxImages === undefined ? MAX_IMAGES : settings.maxImages))

  text = replaceTags(text, "img", function(tag) {
    var source = tag.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
    if (!source) return tag
    var value = source[2] !== undefined ? source[2]
      : (source[3] !== undefined ? source[3] : source[4])
    var kind = imageSourceKind(value)
    // Removed rather than emptied: an <img> with no src still reserves a
    // broken-image box in Qt's layout, which reads as a rendering fault.
    if (kind === "inline" || kind === "none") return tag
    // Neither a local read nor a private-network request is something the
    // reader can ever be offered, so these are dropped without being counted
    // as something "show images" would bring back.
    if (kind !== "remote") return ""
    if (isTrackingPixel(tag)) {
      blocked++
      return ""
    }
    if (loadable < limit) loadable++
    if (!allowImages || kept >= limit) {
      blocked++
      return ""
    }
    kept++
    return tag
  })

  return { html: text, blockedImages: blocked, images: kept, remoteImages: loadable }
}

function hasRemoteImages(html) {
  return sanitize(html).blockedImages > 0
}

// Wraps the sanitised body in a document. `colors` styles the parts the sender
// did not: the ground, the default text, links and quoted replies.
// ------------------------------------------------------------ fitting
//
// Qt's rich text engine takes max-width on images, but only in pixels: a
// percentage collapses the image to nothing at all. An explicit height
// attribute also survives the clamp, so a banner scaled from 1600 to 380 keeps
// its original height and renders as a smear. Both were measured against the
// engine rather than assumed — strip the heights, give a pixel ceiling, and Qt
// derives the height from the aspect ratio on its own.
var MIN_IMAGE_WIDTH = 40

function stripImageHeights(html) {
  return String(html || "").replace(/<img\b[^>]*>/gi, function(tag) {
    return tag
      .replace(/\sheight\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // The character before "height" keeps "max-height" from matching.
      .replace(/([;"'\s])height\s*:[^;"']*/gi, "$1")
  })
}

// Senders lay their mail out for a wide window, and at a narrow one their
// horizontal padding is most of the screen. The vertical rhythm is worth
// keeping; the side gutters are not.
function compactHorizontal(html) {
  return String(html || "")
    .replace(/([;"'\s])(padding|margin)-(left|right)\s*:[^;"']*/gi, "$1")
    .replace(/([;"'\s])(padding|margin)\s*:\s*([^;"']*)/gi,
      function(all, lead, prop, value) {
        var parts = String(value).trim().split(/\s+/)
        if (parts.length >= 4) return lead + prop + ":" + parts[0] + " 0 " + parts[2] + " 0"
        if (parts.length === 3) return lead + prop + ":" + parts[0] + " 0 " + parts[2]
        return lead + prop + ":" + parts[0] + " 0"
      })
}

// A table told to be 600px wide inside a 380px window is a horizontal scrollbar
// over content that would have wrapped perfectly well.
function relaxFixedWidths(html, available) {
  var limit = Math.max(MIN_IMAGE_WIDTH, Math.floor(Number(available) || 0))
  return String(html || "").replace(/<(table|td|th|tr|div)\b[^>]*>/gi, function(tag) {
    return tag
      .replace(/\swidth\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/gi, function(match, a, b, c) {
        return Number(a || b || c) > limit ? "" : match
      })
      .replace(/([;"'\s])width\s*:\s*(\d+)px/gi, function(match, lead, px) {
        return Number(px) > limit ? lead : match
      })
  })
}

function documentFor(bodyHtml, colors) {
  var palette = colors || {}
  var foreground = String(palette.foreground || "")
  var background = String(palette.background || "")
  var link = String(palette.link || foreground)
  var quote = String(palette.quote || foreground)
  // Margin on body is ignored by Qt's rich text engine, so the padding lives
  // on a wrapper the sender's markup sits inside.
  var pad = Math.max(0, Math.floor(Number(palette.padding) || 0))
  var maxImage = Math.floor(Number(palette.maxImageWidth) || 0)
  var body = stripImageHeights(bodyHtml)
  if (palette.compact) body = relaxFixedWidths(compactHorizontal(body), maxImage)
  return "<html><head><style type=\"text/css\">"
    + "body{color:" + foreground + ";background-color:" + background + ";}"
    + "a{color:" + link + ";}"
    + "blockquote{color:" + quote + ";margin-left:8px;padding-left:8px;}"
    + "td,th{padding:2px;}"
    + (maxImage >= MIN_IMAGE_WIDTH ? "img{max-width:" + maxImage + "px;}" : "")
    + "</style></head><body>"
    + (pad > 0 ? "<div style=\"padding:" + pad + "px\">" : "")
    + body
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
  // The same pattern Message.htmlToText numbers the markers with, quotes and
  // all: the two walks have to see the same tags or every marker after a
  // disagreement opens the wrong picture. Not the scanner sanitize uses —
  // nothing here is fetched, so a miss costs a marker rather than a request.
  var pattern = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi
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
