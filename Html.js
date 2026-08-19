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

  var blocked = 0
  if (settings.allowRemoteImages !== true) {
    text = text.replace(/<img\b[^>]*>/gi, function(tag) {
      var source = tag.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
      if (!source) return tag
      var value = source[2] !== undefined ? source[2]
        : (source[3] !== undefined ? source[3] : source[4])
      if (!isRemoteSource(value)) return tag
      blocked++
      // Removed rather than emptied: an <img> with no src still reserves a
      // broken-image box in Qt's layout, which reads as a rendering fault.
      return ""
    })
  }

  return { html: text, blockedImages: blocked }
}

function hasRemoteImages(html) {
  return sanitize(html).blockedImages > 0
}

// Wraps the sanitised body in a document that carries the active Omarchy
// theme. Every colour is passed in — nothing here names one.
function documentFor(bodyHtml, colors) {
  var palette = colors || {}
  var foreground = String(palette.foreground || "")
  var background = String(palette.background || "")
  var link = String(palette.link || foreground)
  var quote = String(palette.quote || foreground)
  return "<html><head><style type=\"text/css\">"
    + "body{color:" + foreground + ";background-color:" + background + ";}"
    + "a{color:" + link + ";}"
    + "blockquote{color:" + quote + ";margin-left:8px;padding-left:8px;}"
    + "td,th{padding:2px;}"
    + "</style></head><body>" + String(bodyHtml || "") + "</body></html>"
}
