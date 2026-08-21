.pragma library

// Everything that turns a Gmail API message resource into something a row or a
// reader can show. Two things force real work here rather than a few property
// reads:
//
//   - Gmail hands back part bodies as base64url and leaves the transfer
//     encoding already undone, but the QML JS engine has no `atob` and
//     `Qt.atob` is not available to a plain JS library, so base64 and UTF-8 are
//     decoded by hand.
//   - Gmail does *not* decode headers. A subject in any non-ASCII language
//     arrives as an RFC 2047 encoded word, so "=?UTF-8?B?5L2g5aW9?=" has to
//     become "你好" before it reaches a Text element.

var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// A lookup table rather than indexOf per character. Decoding a 60 KB body
// means 60 000 scans of a 64-character string otherwise, which measured at
// ~9 ms in V8 and several times that in QML's engine — a visible stutter on
// every message, in the process that draws the whole desktop.
var B64_LOOKUP = (function() {
  var table = {}
  for (var i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charAt(i)] = i
  table["-"] = 62
  table["_"] = 63
  return table
})()

function b64Index(character) {
  var value = B64_LOOKUP[character]
  return value === undefined ? -1 : value
}

// Returns an array of byte values. Padding and stray whitespace or newlines —
// both of which Gmail includes — are ignored rather than treated as an error.
function base64ToBytes(text) {
  var input = String(text || "")
  var bytes = []
  var buffer = 0
  var bits = 0
  for (var i = 0; i < input.length; i++) {
    var value = B64_LOOKUP[input.charAt(i)]
    if (value === undefined) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return bytes
}

function bytesToUtf8(bytes) {
  var out = ""
  var i = 0
  var length = bytes.length
  while (i < length) {
    var byte1 = bytes[i++]
    if (byte1 < 0x80) {
      out += String.fromCharCode(byte1)
      continue
    }
    var codePoint = -1
    if (byte1 >= 0xc2 && byte1 <= 0xdf && i < length) {
      codePoint = ((byte1 & 0x1f) << 6) | (bytes[i] & 0x3f)
      i += 1
    } else if (byte1 >= 0xe0 && byte1 <= 0xef && i + 1 < length) {
      codePoint = ((byte1 & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f)
      i += 2
    } else if (byte1 >= 0xf0 && byte1 <= 0xf4 && i + 2 < length) {
      codePoint = ((byte1 & 0x07) << 18) | ((bytes[i] & 0x3f) << 12)
        | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      i += 3
    }
    if (codePoint < 0) {
      // Not valid UTF-8. Latin-1 is the only other thing this is likely to be,
      // and showing the wrong accent beats showing a replacement block.
      out += String.fromCharCode(byte1)
      continue
    }
    if (codePoint > 0xffff) {
      codePoint -= 0x10000
      out += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff))
    } else {
      out += String.fromCharCode(codePoint)
    }
  }
  return out
}

function bytesToLatin1(bytes) {
  var out = ""
  for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

// Qt.atob is native C++ and skips the per-character base64 loop entirely; it
// hands back a string of raw bytes, which still needs UTF-8 decoding. The pure
// JS path stays for the node tests, and as the fallback anywhere Qt is absent.
function binaryStringToUtf8(binary) {
  var bytes = []
  for (var i = 0; i < binary.length; i++) bytes.push(binary.charCodeAt(i) & 0xff)
  return bytesToUtf8(bytes)
}

function decodeBase64Url(text) {
  var input = String(text || "")
  if (input === "") return ""
  if (typeof Qt !== "undefined" && typeof Qt.atob === "function") {
    try {
      return binaryStringToUtf8(Qt.atob(input.replace(/-/g, "+").replace(/_/g, "/")))
    } catch (e) {
      // Fall through to the portable path rather than losing the message.
    }
  }
  return bytesToUtf8(base64ToBytes(input))
}

function utf8Bytes(text) {
  var input = String(text || "")
  var bytes = []
  for (var i = 0; i < input.length; i++) {
    var code = input.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      var low = input.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i++
      }
    }
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
      0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }
  return bytes
}

function bytesToBase64(bytes, urlSafe) {
  var out = ""
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i]
    var b1 = i + 1 < bytes.length ? bytes[i + 1] : -1
    var b2 = i + 2 < bytes.length ? bytes[i + 2] : -1
    out += B64_ALPHABET.charAt(b0 >> 2)
    out += B64_ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 < 0 ? 0 : b1 >> 4))
    out += b1 < 0 ? "=" : B64_ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 < 0 ? 0 : b2 >> 6))
    out += b2 < 0 ? "=" : B64_ALPHABET.charAt(b2 & 0x3f)
  }
  if (!urlSafe) return out
  return out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function encodeBase64Url(text) {
  return bytesToBase64(utf8Bytes(text), true)
}

function encodeBase64(text) {
  return bytesToBase64(utf8Bytes(text), false)
}

// ------------------------------------------------------- RFC 2047 headers

function decodeQuotedPrintableWord(text) {
  var input = String(text || "").replace(/_/g, " ")
  var bytes = []
  for (var i = 0; i < input.length; i++) {
    if (input.charAt(i) === "=" && i + 2 < input.length) {
      var hex = input.substr(i + 1, 2)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
        continue
      }
    }
    bytes.push(input.charCodeAt(i) & 0xff)
  }
  return bytes
}

function decodeWordBytes(charset, bytes) {
  var name = String(charset || "").toLowerCase()
  if (name.indexOf("utf-8") === 0 || name.indexOf("utf8") === 0) return bytesToUtf8(bytes)
  if (name.indexOf("iso-8859") === 0 || name.indexOf("windows-125") === 0
    || name.indexOf("us-ascii") === 0 || name === "") return bytesToLatin1(bytes)
  // GB18030, Shift_JIS and friends need a table this plugin does not carry.
  // UTF-8 decoding degrades to Latin-1 per byte, which at least keeps the
  // ASCII parts of the header readable.
  return bytesToUtf8(bytes)
}

// Adjacent encoded words are defined to join with the whitespace between them
// dropped, which is what makes multi-word CJK subjects come out unspaced when
// a naive decoder keeps it.
function decodeHeaderValue(value) {
  var input = String(value === undefined || value === null ? "" : value)
  if (input.indexOf("=?") < 0) return input
  var pattern = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g
  var out = ""
  var lastEnd = 0
  var previousWasWord = false
  var match
  while ((match = pattern.exec(input)) !== null) {
    var between = input.substring(lastEnd, match.index)
    if (!(previousWasWord && /^[\s]*$/.test(between))) out += between
    var bytes = match[2].toUpperCase() === "B"
      ? base64ToBytes(match[3])
      : decodeQuotedPrintableWord(match[3])
    out += decodeWordBytes(match[1], bytes)
    lastEnd = match.index + match[0].length
    previousWasWord = true
  }
  out += input.substring(lastEnd)
  return out
}

// ---------------------------------------------------------------- headers

function headerValue(message, name) {
  var payload = message && message.payload ? message.payload : null
  var headers = payload && Array.isArray(payload.headers) ? payload.headers : []
  var wanted = String(name || "").toLowerCase()
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name || "").toLowerCase() === wanted)
      return String(headers[i].value || "")
  }
  return ""
}

function decodedHeader(message, name) {
  return decodeHeaderValue(headerValue(message, name))
}

function unquote(value) {
  var text = String(value || "").trim()
  if (text.length >= 2 && text.charAt(0) === "\"" && text.charAt(text.length - 1) === "\"")
    text = text.substring(1, text.length - 1)
  return text.replace(/\\(.)/g, "$1").trim()
}

// "Jane Doe <jane@example.com>", "<jane@example.com>" and a bare address all
// have to end up as the same shape.
function parseAddress(value) {
  var raw = decodeHeaderValue(value).trim()
  if (!raw) return { name: "", email: "", display: "" }
  var angled = raw.match(/^(.*)<([^>]*)>\s*$/)
  var name = ""
  var email = ""
  if (angled) {
    name = unquote(angled[1])
    email = angled[2].trim()
  } else {
    email = raw.replace(/^\s*<|>\s*$/g, "").trim()
  }
  if (!name && email.indexOf("@") > 0) name = email.substring(0, email.indexOf("@"))
  return { name: name, email: email, display: name || email }
}

function parseAddressList(value) {
  var raw = String(value || "")
  var entries = []
  var current = ""
  var inQuotes = false
  var inAngle = false
  for (var i = 0; i < raw.length; i++) {
    var character = raw.charAt(i)
    if (character === "\"") inQuotes = !inQuotes
    else if (character === "<") inAngle = true
    else if (character === ">") inAngle = false
    if (character === "," && !inQuotes && !inAngle) {
      entries.push(current)
      current = ""
      continue
    }
    current += character
  }
  entries.push(current)
  var result = []
  for (var j = 0; j < entries.length; j++) {
    if (!entries[j].trim()) continue
    result.push(parseAddress(entries[j]))
  }
  return result
}

function formatAddressList(addresses, limit) {
  var list = Array.isArray(addresses) ? addresses : []
  var max = Math.max(1, Math.floor(Number(limit) || 3))
  var names = []
  for (var i = 0; i < list.length && i < max; i++) names.push(list[i].display)
  if (list.length > max) names.push("+" + (list.length - max))
  return names.join(", ")
}

// ------------------------------------------------------------------ bodies

function partCharset(part) {
  var mime = String(part && part.mimeType ? part.mimeType : "")
  var match = mime.match(/charset="?([^";]+)"?/i)
  if (match) return match[1]
  var headers = part && Array.isArray(part.headers) ? part.headers : []
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name || "").toLowerCase() !== "content-type") continue
    var found = String(headers[i].value || "").match(/charset="?([^";\s]+)"?/i)
    if (found) return found[1]
  }
  return ""
}

function decodePart(part) {
  var data = part && part.body ? part.body.data : ""
  if (!data) return ""
  return decodeWordBytes(partCharset(part) || "utf-8", base64ToBytes(data))
}

// Images become a marker rather than nothing at all. Stripped outright — which
// is what removing every tag does — a message built around its pictures reads as
// a long run of unexplained blank space, with no way to tell an empty message
// from one whose contents happen not to be text. The number is what lets the
// reader offer the image itself when the marker is clicked.
var IMAGE_MARKER = /\[image (\d+)\]/g

function htmlToText(html) {
  var imageCount = 0
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    // The reader does not use this numbering: MailAccount takes the body text
    // and the picture list from one walk over Html.js's parse tree, so the two
    // cannot disagree. What is left here serves decodeSnippet, where Gmail's
    // snippet is escaped prose that never carried an image.
    .replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, function() {
      imageCount++
      return "[image " + imageCount + "]"
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, function(match, code) { return String.fromCharCode(Number(code)) })
    .replace(/&#x([0-9a-fA-F]+);/g, function(match, code) { return String.fromCharCode(parseInt(code, 16)) })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "")
}

function isAttachment(part) {
  if (!part) return false
  if (part.filename && String(part.filename).length > 0) return true
  var disposition = ""
  var headers = Array.isArray(part.headers) ? part.headers : []
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name || "").toLowerCase() === "content-disposition")
      disposition = String(headers[i].value || "")
  }
  return /attachment/i.test(disposition)
}

// Walks the MIME tree once and keeps the best text it saw. text/plain wins
// outright; a text/html part is kept only as a fallback because converting it
// always loses something.
function extractBody(payload) {
  var plain = ""
  var html = ""

  function walk(part, depth) {
    if (!part || depth > 12) return
    var mime = String(part.mimeType || "").toLowerCase()
    var children = Array.isArray(part.parts) ? part.parts : []
    if (children.length > 0) {
      for (var i = 0; i < children.length; i++) walk(children[i], depth + 1)
      return
    }
    if (isAttachment(part)) return
    if (mime.indexOf("text/plain") === 0 && !plain) plain = decodePart(part)
    else if (mime.indexOf("text/html") === 0 && !html) html = decodePart(part)
  }

  walk(payload, 0)
  if (plain) return { text: plain.replace(/\r\n/g, "\n"), source: "plain" }
  if (html) return { text: htmlToText(html), source: "html" }
  return { text: "", source: "" }
}

// The same walk as extractBody, kept separate because the reader wants the
// markup and the list row wants the flattened text, and neither should pay for
// the other's work.
function extractHtml(payload) {
  var found = ""

  function walk(part, depth) {
    if (!part || depth > 12 || found) return
    var mime = String(part.mimeType || "").toLowerCase()
    var children = Array.isArray(part.parts) ? part.parts : []
    if (children.length > 0) {
      for (var i = 0; i < children.length; i++) walk(children[i], depth + 1)
      return
    }
    if (isAttachment(part)) return
    if (mime.indexOf("text/html") === 0) found = decodePart(part)
  }

  walk(payload, 0)
  return found
}

function attachments(payload) {
  var found = []

  function walk(part, depth) {
    if (!part || depth > 12) return
    var children = Array.isArray(part.parts) ? part.parts : []
    if (isAttachment(part) && part.body && part.body.attachmentId) {
      found.push({
        filename: decodeHeaderValue(part.filename || "attachment"),
        mimeType: String(part.mimeType || "application/octet-stream"),
        size: Math.max(0, Math.floor(Number(part.body.size) || 0)),
        attachmentId: String(part.body.attachmentId)
      })
    }
    for (var i = 0; i < children.length; i++) walk(children[i], depth + 1)
  }

  walk(payload, 0)
  return found
}

// The part an attachment id names, or null. Gmail describes a part it will not
// send — an id, a type and a size — and this is how the caller gets back to
// what it was told about it once the octets arrive.
function partForAttachment(payload, attachmentId) {
  var wanted = String(attachmentId || "")
  if (wanted === "") return null
  var found = null

  function walk(part, depth) {
    if (!part || depth > 12 || found !== null) return
    if (part.body && String(part.body.attachmentId || "") === wanted) {
      found = part
      return
    }
    var children = Array.isArray(part.parts) ? part.parts : []
    for (var i = 0; i < children.length; i++) walk(children[i], depth + 1)
  }

  walk(payload, 0)
  return found
}

function formatSize(bytes) {
  var value = Math.max(0, Math.floor(Number(bytes) || 0))
  if (value < 1024) return value + " B"
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10240 ? 1 : 0) + " KB"
  return (value / (1024 * 1024)).toFixed(value < 10485760 ? 1 : 0) + " MB"
}

// ------------------------------------------------------ RFC 822 → payload
//
// Gmail hands back a message already taken apart: a headers array, a MIME
// tree, part bodies in base64url. An IMAP server hands back the message.
//
// So this rebuilds Gmail's shape from the wire format, and everything above —
// `extractBody`, `extractHtml`, `attachments`, `summarize`, the whole reader —
// goes on working without learning a second vocabulary. It is the single
// adapter that lets one panel drive two very different services.
//
// The input is a *byte string*: one character per octet, which is what
// `Imap.decodeResponse` produces. Anything else and a Content-Length or a
// literal count would be measured in the wrong unit.

var MAX_MIME_DEPTH = 12

function latin1Bytes(text) {
  var input = String(text || "")
  var bytes = []
  for (var i = 0; i < input.length; i++) bytes.push(input.charCodeAt(i) & 0xff)
  return bytes
}

// The body form of quoted-printable, which differs from the encoded-word form
// above in two ways that matter: "_" is a literal underscore rather than a
// space, and a "=" at the end of a line is a soft break that disappears.
function decodeQuotedPrintableBytes(text) {
  var input = String(text || "").replace(/=\r?\n/g, "")
  var bytes = []
  for (var i = 0; i < input.length; i++) {
    if (input.charAt(i) === "=" && i + 2 < input.length) {
      var hex = input.substr(i + 1, 2)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
        continue
      }
    }
    bytes.push(input.charCodeAt(i) & 0xff)
  }
  return bytes
}

// A header may be folded across several lines, each continuation beginning
// with a space or a tab. Unfolding has to happen before anything looks for a
// ":", or a long Subject becomes a header called "of the meeting".
function unfoldHeaders(text) {
  return String(text || "").replace(/\r?\n[ \t]+/g, " ")
}

function parseHeaderBlock(text) {
  var lines = unfoldHeaders(text).split(/\r?\n/)
  var headers = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line === "") continue
    var colon = line.indexOf(":")
    // A line with no colon is not a header. It is what the first line of a
    // message looks like when a server included the "From " envelope line, and
    // keeping it would give every message a header with an empty name.
    if (colon <= 0) continue
    headers.push({
      name: line.substring(0, colon).trim(),
      value: line.substring(colon + 1).trim()
    })
  }
  return headers
}

function headerFrom(headers, name) {
  var list = Array.isArray(headers) ? headers : []
  var wanted = String(name || "").toLowerCase()
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].name || "").toLowerCase() === wanted) return String(list[i].value || "")
  }
  return ""
}

// A Content-Type parameter, quoted or bare. RFC 2231 continuations
// (name*0=, name*1=) are not handled: they appear on long filenames, and a
// truncated filename is a smaller loss than a parser that guesses.
function contentTypeParam(value, name) {
  var pattern = new RegExp(name + "\\s*=\\s*(\"([^\"]*)\"|([^;\\s]+))", "i")
  var match = String(value || "").match(pattern)
  if (!match) return ""
  return (match[2] !== undefined ? match[2] : match[3] || "").trim()
}

function mimeTypeOf(contentType) {
  var value = String(contentType || "").split(";")[0].trim().toLowerCase()
  // No Content-Type at all means text/plain, which is what the RFC says and
  // what a message from a script that forgot the header actually is.
  return value === "" ? "text/plain" : value
}

// Splits a multipart body on its boundary. Everything before the first
// delimiter is the preamble and everything after the closing one is the
// epilogue; both are for clients that do not understand MIME, and neither is
// part of the message.
function splitMultipart(body, boundary) {
  var text = String(body || "")
  var marker = "--" + String(boundary || "")
  if (boundary === "" || boundary === undefined || boundary === null) return []

  var parts = []
  var index = text.indexOf(marker)
  if (index < 0) return []

  while (index >= 0) {
    var afterMarker = index + marker.length
    // The closing delimiter is the boundary followed by "--".
    if (text.substr(afterMarker, 2) === "--") break
    var start = text.indexOf("\n", afterMarker)
    if (start < 0) break
    start += 1
    var next = text.indexOf(marker, start)
    var end = next < 0 ? text.length : next
    // The CRLF that precedes the next delimiter belongs to the delimiter, not
    // to the part — a body that keeps it gains a trailing blank line, and a
    // base64 part gains bytes that were never in the attachment.
    var chunk = text.substring(start, end).replace(/\r?\n$/, "")
    parts.push(chunk)
    index = next
  }
  return parts
}

// Only ever asked about a body whose own Content-Type has already been shown
// to be wrong, so a guess is the best information there is. Deliberately
// narrow: a plain-text message that happens to mention <brackets> should stay
// plain text, and only a document that opens like markup is treated as markup.
function looksLikeHtml(body) {
  return /^\s*(<!doctype\s+html|<html\b|<head\b|<body\b|<div\b|<table\b|<p\b)/i
    .test(String(body || ""))
}

function decodeTransfer(body, encoding) {
  var name = String(encoding || "").trim().toLowerCase()
  if (name === "base64") return base64ToBytes(body)
  if (name === "quoted-printable") return decodeQuotedPrintableBytes(body)
  // 7bit, 8bit, binary, and anything unrecognised: the octets as they stand.
  return latin1Bytes(body)
}

// One MIME entity — headers, and either a body or children. `partId` is the
// RFC 3501 part path ("1", "1.2"), which is what an attachment would be
// fetched by if this plugin ever fetches one separately.
function parseMimeEntity(raw, partId, depth) {
  var text = String(raw || "")
  // The first blank line ends the headers. CRLF is the standard; bare LF is
  // what a surprising number of senders actually emit.
  var split = text.search(/\r?\n\r?\n/)
  var headerText = split < 0 ? text : text.substring(0, split)
  var body = ""
  if (split >= 0) {
    var blank = text.match(/\r?\n\r?\n/)
    body = text.substring(split + blank[0].length)
  }

  var headers = parseHeaderBlock(headerText)
  var contentType = headerFrom(headers, "Content-Type")
  var mimeType = mimeTypeOf(contentType)
  var disposition = headerFrom(headers, "Content-Disposition")
  var filename = contentTypeParam(disposition, "filename") || contentTypeParam(contentType, "name")

  var entity = {
    partId: String(partId || ""),
    mimeType: mimeType,
    filename: filename ? decodeHeaderValue(filename) : "",
    headers: headers,
    body: { size: 0 },
    parts: []
  }

  var boundary = contentTypeParam(contentType, "boundary")
  if (mimeType.indexOf("multipart/") === 0 && boundary !== "" && depth < MAX_MIME_DEPTH) {
    var chunks = splitMultipart(body, boundary)
    for (var i = 0; i < chunks.length; i++) {
      var childId = entity.partId === "" ? String(i + 1) : entity.partId + "." + String(i + 1)
      entity.parts.push(parseMimeEntity(chunks[i], childId, depth + 1))
    }
    // A multipart whose boundary never appeared is not a container at all.
    // Falling through decodes its body, but that is only half the repair:
    // `extractBody` dispatches on `mimeType`, so an entity still labelled
    // multipart is skipped by every reader and the message shows as blank.
    // Relabelling is what makes those octets reachable.
    if (entity.parts.length > 0) return entity
    entity.mimeType = looksLikeHtml(body) ? "text/html" : "text/plain"
  }

  var bytes = decodeTransfer(body, headerFrom(headers, "Content-Transfer-Encoding"))
  entity.body.size = bytes.length
  // base64url, because that is the shape `decodePart` decodes and the shape
  // Gmail would have sent. Encoded from the byte array rather than from the
  // string, so a Latin-1 body does not get re-encoded as UTF-8 on the way in.
  entity.body.data = bytesToBase64(bytes, true)

  // An attachment needs an id before `attachments()` will list it. The part
  // path is the honest one: it is what a later FETCH would ask for.
  if (entity.filename !== "" || /attachment/i.test(disposition))
    entity.body.attachmentId = "part:" + entity.partId

  return entity
}

// The whole message. Returns the `payload` half of a Gmail message resource —
// the caller supplies the id, the labels and the internal date, because those
// come from the IMAP response rather than from the message itself.
function parseRfc822(raw) {
  return parseMimeEntity(raw, "", 0)
}

// A list row's preview. Gmail sends one; IMAP has no equivalent, so it is made
// from the body once the body is here. Long enough to be useful, short enough
// that the cache is not storing the message twice.
function buildSnippet(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200)
}

// ------------------------------------------------------------------- dates

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function messageDate(message) {
  var internal = Number(message && message.internalDate)
  if (isFinite(internal) && internal > 0) return new Date(internal)
  var header = headerValue(message, "Date")
  if (header) {
    var parsed = new Date(header)
    if (!isNaN(parsed.getTime())) return parsed
  }
  return null
}

function pad(value) {
  return (value < 10 ? "0" : "") + value
}

// Compact enough for a list row: minutes for the last hour, then the clock
// time for today, a weekday inside the week, and a date beyond it.
function relativeTime(date, now) {
  if (!date) return ""
  var reference = now instanceof Date ? now : new Date(Number(now) || Date.now())
  var elapsed = reference.getTime() - date.getTime()
  if (elapsed < 0) elapsed = 0
  var minutes = Math.floor(elapsed / 60000)
  if (minutes < 1) return "now"
  if (minutes < 60) return minutes + "m"
  var sameDay = date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate()
  if (sameDay) return pad(date.getHours()) + ":" + pad(date.getMinutes())
  var days = Math.floor(elapsed / 86400000)
  if (days < 7) return WEEKDAYS[date.getDay()]
  if (date.getFullYear() === reference.getFullYear())
    return MONTHS[date.getMonth()] + " " + date.getDate()
  return MONTHS[date.getMonth()] + " " + date.getDate() + ", " + date.getFullYear()
}

function fullTime(date) {
  if (!date) return ""
  return MONTHS[date.getMonth()] + " " + date.getDate() + ", " + date.getFullYear()
    + " " + pad(date.getHours()) + ":" + pad(date.getMinutes())
}

// ------------------------------------------------------------- row summary

function labelIds(message) {
  return message && Array.isArray(message.labelIds) ? message.labelIds : []
}

function hasLabel(message, label) {
  return labelIds(message).indexOf(label) >= 0
}

function decodeSnippet(text) {
  // Gmail's snippet is HTML-escaped even though it carries no markup.
  return htmlToText(String(text || "")).replace(/\s+/g, " ").trim()
}

function summarize(message, now) {
  var from = parseAddress(headerValue(message, "From"))
  var date = messageDate(message)
  var subject = decodedHeader(message, "Subject").replace(/\s+/g, " ").trim()
  return {
    id: String(message && message.id ? message.id : ""),
    threadId: String(message && message.threadId ? message.threadId : ""),
    from: from,
    // Reply-To and Message-ID only arrive with the full format, so a list row
    // carries empty ones and the reader — which is where replying happens —
    // carries the real values.
    replyTo: parseAddress(headerValue(message, "Reply-To")),
    messageId: headerValue(message, "Message-ID"),
    to: parseAddressList(headerValue(message, "To")),
    cc: parseAddressList(headerValue(message, "Cc")),
    subject: subject || "(no subject)",
    snippet: decodeSnippet(message && message.snippet),
    date: date,
    time: relativeTime(date, now),
    fullTime: fullTime(date),
    unread: hasLabel(message, "UNREAD"),
    starred: hasLabel(message, "STARRED"),
    important: hasLabel(message, "IMPORTANT"),
    inInbox: hasLabel(message, "INBOX"),
    inTrash: hasLabel(message, "TRASH"),
    isDraft: hasLabel(message, "DRAFT"),
    labelIds: labelIds(message).slice(),
    sizeEstimate: Math.max(0, Math.floor(Number(message && message.sizeEstimate) || 0))
  }
}

// ------------------------------------------------------------- composition

// A header value can never carry a line break. One would end the header and let
// whatever followed be read as the next one, which is how a Bcc gets into a
// message nobody wrote it into. Removed rather than rejected: the values that
// reach here are addresses and subjects, and a stray newline in one of them is
// not worth refusing to send over.
function headerSafe(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[\r\n]+/g, " ")
}

// A display name is a phrase, not a header value: an encoded word may not sit
// inside quotes, and an ASCII name carrying a comma or a dot is only legal
// quoted. `foldHeader` cannot do this, because it encodes the whole value as
// one word — `=?UTF-8?B?...?=` wrapped around `"Name" <a@b>` is not an address.
function encodedPhrase(text) {
  var value = headerSafe(text).trim()
  if (value === "") return ""
  if (!/^[\x20-\x7e]*$/.test(value))
    return "=?UTF-8?B?" + encodeBase64(value) + "?="
  return '"' + value.replace(/([\\"])/g, "\\$1") + '"'
}

// Written by hand rather than through `foldHeader` for the reason above. The
// address still loses its line breaks, so a display name cannot smuggle a
// second header in either.
function fromHeader(email, displayName) {
  var address = headerSafe(email).trim()
  var phrase = encodedPhrase(displayName)
  return "From: " + (phrase === "" ? address : phrase + " <" + address + ">")
}

function foldHeader(name, value) {
  var text = headerSafe(value)
  // Any non-ASCII in a header has to go back out as an encoded word, or Gmail
  // rejects the raw message.
  if (/^[\x20-\x7e]*$/.test(text)) return name + ": " + text
  return name + ": =?UTF-8?B?" + encodeBase64(text) + "?="
}

// In-Reply-To and References carry a Message-ID, and a Message-ID is a string
// off a message a stranger sent — it reaches here having been read out of their
// headers and no further. It goes back out verbatim because a reply has to
// thread, so it is cut down to what a message id can legally be first:
// printable ASCII, on one line, no longer than a header may run.
function referenceValue(value) {
  return headerSafe(value).replace(/[^\x20-\x7e]+/g, "").substring(0, 512).trim()
}

function quoteBody(summary, body) {
  var header = summary && summary.from
    ? "On " + (summary.fullTime || "") + ", " + summary.from.display + " wrote:"
    : ""
  var lines = String(body || "").split("\n")
  var quoted = []
  for (var i = 0; i < lines.length; i++) quoted.push("> " + lines[i])
  return (header ? header + "\n" : "") + quoted.join("\n")
}

function replySubject(subject) {
  var text = String(subject || "").trim()
  if (/^re:/i.test(text)) return text
  return "Re: " + (text || "(no subject)")
}

// A minimal RFC 5322 message. Gmail wants the whole thing base64url encoded in
// a single `raw` field, so this returns the string ready for that.
// Base64 body lines are wrapped at 76 characters as the RFC requires; Gmail
// accepts longer lines but other receiving servers do not.
function base64Body(text) {
  var encoded = encodeBase64(String(text || ""))
  var wrapped = []
  for (var i = 0; i < encoded.length; i += 76) wrapped.push(encoded.substr(i, 76))
  return wrapped.join("\r\n")
}

// The separator only has to be a string the parts do not contain, and every
// part here is base64 — an alphabet with no "_" in it, so a boundary carrying
// one cannot occur inside a body however long it is. The caller may name it,
// which is what lets a test read the message it built.
function mimeBoundary(given) {
  var stated = String(given || "").replace(/[^A-Za-z0-9'()+_,\-.\/:=?]/g, "")
  if (stated !== "") return stated.substring(0, 60)
  var random = Math.floor(Math.random() * 0x100000000).toString(36)
  return "=_Omamail_" + (new Date()).getTime().toString(36) + "_" + random
}

// One method name, and nothing that could end the header early: this string
// arrives from a calendar file somebody else wrote.
function calendarMethod(value) {
  var text = String(value || "").toUpperCase().replace(/[^A-Z]/g, "")
  return text === "" ? "REPLY" : text.substring(0, 20)
}

function buildRawMessage(fields) {
  var values = fields || {}
  var lines = []
  if (values.from) lines.push(fromHeader(values.from, values.fromName))
  lines.push(foldHeader("To", values.to || ""))
  if (values.cc) lines.push(foldHeader("Cc", values.cc))
  lines.push(foldHeader("Subject", values.subject || ""))
  var inReplyTo = referenceValue(values.inReplyTo)
  if (inReplyTo) {
    lines.push("In-Reply-To: " + inReplyTo)
    lines.push("References: " + (referenceValue(values.references) || inReplyTo))
  }
  lines.push("MIME-Version: 1.0")

  var calendar = values.calendar && String(values.calendar.text || "") !== ""
    ? values.calendar : null
  if (!calendar) {
    lines.push("Content-Type: text/plain; charset=UTF-8")
    lines.push("Content-Transfer-Encoding: base64")
    lines.push("")
    return lines.join("\r\n") + "\r\n" + base64Body(values.body) + "\r\n"
  }

  // `multipart/alternative`, not `mixed`: the calendar part and the sentence
  // beside it are two readings of one answer, and a client that understands
  // the first should not also show the second as a file to open. It is also
  // the shape every calendar server recognises a reply in.
  var boundary = mimeBoundary(values.boundary)
  lines.push("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"")
  lines.push("")
  lines.push("--" + boundary)
  lines.push("Content-Type: text/plain; charset=UTF-8")
  lines.push("Content-Transfer-Encoding: base64")
  lines.push("")
  lines.push(base64Body(values.body))
  lines.push("--" + boundary)
  lines.push("Content-Type: text/calendar; charset=UTF-8; method="
    + calendarMethod(calendar.method))
  lines.push("Content-Transfer-Encoding: base64")
  lines.push("")
  lines.push(base64Body(calendar.text))
  lines.push("--" + boundary + "--")
  return lines.join("\r\n") + "\r\n"
}

function buildSendPayload(fields) {
  var payload = { raw: encodeBase64Url(buildRawMessage(fields)) }
  if (fields && fields.threadId) payload.threadId = String(fields.threadId)
  return payload
}
