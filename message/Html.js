.pragma library

// Message HTML, reduced to what Qt's rich text engine may safely be handed.
//
// This is not a renderer. Qt already is one: a QTextDocument behind the
// reader's TextEdit parses HTML 4 and CSS 2.1 and lays it out, which is most of
// what real mail needs, because real mail is still table-and-inline-style HTML
// written for Outlook. What Qt does not give a QML plugin is any say over what
// that renderer does while it works, and it does three things a mail client
// cannot allow it to do unsupervised:
//
//   - it fetches <img src="https://..."> for real, so every tracking pixel in
//     the message fires the moment the document is set, and a source aimed at
//     the machine itself turns reading mail into a request to whatever is
//     listening on it
//   - it renders a <style> block's CSS as body text
//   - it ignores display:none, so the 1px preheader every marketing mail
//     carries comes out as a smudge of unreadable characters
//
// C++ could hook QTextDocument::loadResource and decide per request. QML cannot
// — QQuickTextDocument exposes nothing of the sort — so the only control point
// left is what the string says before it is handed over. This file is that
// gate, and it is deliberately the whole of it: every decision about what the
// renderer is allowed to see or fetch is made here and nowhere else.
//
// It works the way any HTML consumer does, and for the same reason a regex does
// not: parse, then decide on the tree, then write back out.
//
//   tokenize   text -> tags, attributes, text, comments, raw-text elements,
//              read the way the spec reads them
//   parse      tokens -> a tree, tolerantly: elements are closed, never moved
//   clean      the tree -> the tree, dropping and rewriting by an allow list
//   serialise  the tree -> the HTML subset Qt renders
//
// The parse is not a conformant HTML5 tree builder and must not become one. A
// browser's parser rewrites what it reads — it inserts <tbody>, hoists content
// out of a <table>, reopens formatting across a block — and every one of those
// is a change to mail nobody asked for. This one only ever closes what the
// sender left open. Structure in, same structure out, minus what was removed.

// ================================================================ tokenizer
//
// One pass, no backtracking. The only question it answers that a pattern could
// not is where things end: a tag ends at the first ">" that is not inside an
// attribute value, and a raw-text element ends at its own closing tag and at
// nothing else.

var RAW_TEXT_ELEMENTS = { script: true, style: true, textarea: true, title: true }

// Elements with no closing tag and no children. An <img> that says
// display:none has no subtree to take with it, and a <br> never closes.
var VOID_ELEMENTS = {
  img: true, br: true, hr: true, input: true, meta: true, link: true,
  area: true, base: true, col: true, embed: true, source: true, track: true,
  wbr: true, param: true, keygen: true
}

// By character code, not by one-character string. This is the innermost loop in
// the file and it runs over every byte of every message body; charAt allocates
// a string per character, charCodeAt does not.
function isSpaceCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12
}

function isNameStartCode(code) {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90)
}

function isNameCode(code) {
  return isNameStartCode(code) || (code >= 48 && code <= 57)
    || code === 45 || code === 95 || code === 58 || code === 46
}

function matchesIgnoreCase(text, at, needle) {
  if (at + needle.length > text.length) return false
  return text.substr(at, needle.length).toLowerCase() === needle
}

// Reads "<name attr=value ...>" from `from`, which must be its "<".
//
// Returns the tag and where it ends. `terminated` is false when the source ran
// out before the ">" — which is the case a pattern gets wrong and the case that
// matters, because Qt swallows the remainder of the document into that tag.
// `out` carries back where the tag ended and whether it ended at all. It is the
// caller's, and reused: a message body is tens of thousands of tags, and an
// object per tag to hold two numbers is an object per tag for the collector.
function readTag(text, from, out) {
  var length = text.length
  var at = from + 1
  var closing = false
  if (text.charCodeAt(at) === 47) {
    closing = true
    at++
  }
  // A tag name starts with a letter, which is what tells "<b>" from the "<" in
  // "3<4". Digits and dots are only allowed after that first character.
  if (!isNameStartCode(text.charCodeAt(at))) return null
  var nameStart = at
  var upper = false
  while (at < length) {
    var nameCode = text.charCodeAt(at)
    if (!isNameCode(nameCode)) break
    if (nameCode >= 65 && nameCode <= 90) upper = true
    at++
  }
  // Almost every tag and attribute in real mail is already lower case, and
  // toLowerCase on a string that is already lower case still walks it and can
  // still hand back a copy. Cheaper to have noticed while reading it.
  var name = text.substring(nameStart, at)
  if (upper) name = name.toLowerCase()

  var attributes = []
  var selfClosing = false
  while (at < length) {
    while (at < length && isSpaceCode(text.charCodeAt(at))) at++
    if (at >= length) break
    var code = text.charCodeAt(at)
    if (code === 62) {
      at++
      out.end = at
      out.terminated = true
      return {
        type: closing ? "end" : "start",
        name: name,
        attrs: attributes,
        selfClosing: selfClosing
      }
    }
    if (code === 47) {
      selfClosing = text.charCodeAt(at + 1) === 62
      at++
      continue
    }

    var attrStart = at
    var attrUpper = false
    while (at < length) {
      var attrCode = text.charCodeAt(at)
      if (isSpaceCode(attrCode) || attrCode === 61 || attrCode === 62 || attrCode === 47) break
      if (attrCode >= 65 && attrCode <= 90) attrUpper = true
      at++
    }
    // A character that can start neither a name nor anything else: step over it
    // rather than spinning on it.
    if (at === attrStart) {
      at++
      continue
    }
    var attributeName = text.substring(attrStart, at)
    if (attrUpper) attributeName = attributeName.toLowerCase()

    while (at < length && isSpaceCode(text.charCodeAt(at))) at++
    var value = null
    if (text.charCodeAt(at) === 61) {
      at++
      while (at < length && isSpaceCode(text.charCodeAt(at))) at++
      var quote = text.charCodeAt(at)
      if (quote === 34 || quote === 39) {
        at++
        var close = text.indexOf(quote === 34 ? "\"" : "'", at)
        // A quote that never closes runs to the end of the document, which is
        // also how Qt reads it.
        value = close < 0 ? text.substring(at) : text.substring(at, close)
        at = close < 0 ? length : close + 1
      } else {
        var valueStart = at
        while (at < length) {
          var valueCode = text.charCodeAt(at)
          if (isSpaceCode(valueCode) || valueCode === 62) break
          at++
        }
        value = text.substring(valueStart, at)
      }
    }
    attributes.push({ name: attributeName, value: value })
  }

  out.end = length
  out.terminated = false
  return {
    type: closing ? "end" : "start",
    name: name,
    attrs: attributes,
    selfClosing: selfClosing
  }
}

// Where a raw-text element's content stops. Per the spec this is the first
// "</name" followed by whitespace, "/" or ">" — a "</style>" inside a CSS
// string really does end the stylesheet, which is why a <style> block cannot be
// trusted to contain its own contents.
function findRawTextEnd(text, from, name) {
  var needle = "</" + name
  for (var at = from; at < text.length; at++) {
    if (text.charAt(at) !== "<") continue
    if (!matchesIgnoreCase(text, at, needle)) continue
    // NaN when the needle ran to the end of the document, which ends it too.
    var after = text.charCodeAt(at + needle.length)
    if (!isNaN(after) && after !== 62 && after !== 47 && !isSpaceCode(after)) continue
    var close = text.indexOf(">", at + needle.length)
    return { contentEnd: at, next: close < 0 ? text.length : close + 1 }
  }
  return { contentEnd: text.length, next: text.length }
}

// With a `visit`, tokens are handed over one at a time and nothing is kept;
// without one they come back as an array. The tree builder takes the first
// form, because a message body is tens of thousands of tokens and building a
// list of them only to walk it once is a list nobody needed.
function tokenize(html, visit) {
  var text = String(html === undefined || html === null ? "" : html)
  var tokens = visit ? null : []
  var emit = visit || function(token) { tokens.push(token) }
  var pending = ""
  var at = 0
  var out = { end: 0, terminated: false }

  function flushText() {
    if (pending === "") return
    emit({ type: "text", text: pending })
    pending = ""
  }

  while (at < text.length) {
    var open = text.indexOf("<", at)
    if (open < 0) {
      pending += text.substring(at)
      break
    }
    pending += text.substring(at, open)

    // By code: this runs at every "<" in the document, and substr+toLowerCase
    // here allocates two strings per tag for a four-character test.
    if (text.charCodeAt(open + 1) === 33 && text.charCodeAt(open + 2) === 45
      && text.charCodeAt(open + 3) === 45) {
      var commentEnd = text.indexOf("-->", open + 4)
      flushText()
      emit({ type: "comment" })
      at = commentEnd < 0 ? text.length : commentEnd + 3
      continue
    }
    // <!DOCTYPE ...>, <?xml ...> and anything else that is not a tag: a
    // declaration, ending at the first ">".
    var second = text.charCodeAt(open + 1)
    if (second === 33 || second === 63) {
      var declarationEnd = text.indexOf(">", open + 2)
      flushText()
      emit({ type: "declaration" })
      at = declarationEnd < 0 ? text.length : declarationEnd + 1
      continue
    }

    var token = readTag(text, open, out)
    if (!token) {
      // A "<" that starts no tag is a "<" the sender typed.
      pending += "<"
      at = open + 1
      continue
    }
    flushText()
    if (out.terminated) emit(token)
    // An unterminated tag took the rest of the document with it, so there is
    // nothing after it to keep and nothing about it worth keeping.
    at = out.end
    if (!out.terminated) break

    if (token.type === "start" && !token.selfClosing
      && RAW_TEXT_ELEMENTS[token.name] === true) {
      var raw = findRawTextEnd(text, at, token.name)
      emit({ type: "text", text: text.substring(at, raw.contentEnd), raw: true })
      emit({ type: "end", name: token.name })
      at = raw.next
    }
  }

  flushText()
  return tokens
}

// ===================================================================== tree
//
// Tolerant, and tolerant in one direction only: it closes what the sender left
// open and it discards a close that matches nothing. It never moves an element,
// never invents one, and never reopens anything — a browser's parser does all
// three, and each of them is a change to the message that nobody asked for.

// Openings that imply the close of a sibling. Mail is full of <td> and <li>
// left unclosed, and without these each one nests inside the last until the
// whole message is one deep staircase.
var IMPLIED_CLOSE = {
  li: { li: true },
  p: { p: true },
  dt: { dt: true, dd: true },
  dd: { dt: true, dd: true },
  tr: { tr: true, td: true, th: true },
  td: { td: true, th: true },
  th: { td: true, th: true },
  thead: { thead: true, tbody: true, tfoot: true },
  tbody: { thead: true, tbody: true, tfoot: true },
  tfoot: { thead: true, tbody: true, tfoot: true },
  option: { option: true }
}

function elementNode(token) {
  return {
    type: "element",
    name: token.name,
    attrs: token.attrs,
    selfClosing: token.selfClosing === true,
    children: []
  }
}

// How deep the tree may go. Everything downstream of the parse walks it by
// recursion, so without a ceiling a message nested a few thousand elements deep
// is a stack overflow — inside the process that draws the whole desktop. Real
// mail reaches nine levels of tables, which is about forty elements; past this
// an element still keeps its content, it just stops adding a level to hold it.
// Qt would not survive laying such a document out either, and
// tooHeavyForRichText refuses it a step later.
var MAX_TREE_DEPTH = 128

function parse(html) {
  var root = { type: "root", children: [] }
  var stack = [root]

  tokenize(html, function(token) {
    var top = stack[stack.length - 1]

    if (token.type === "text") {
      if (token.text !== "")
        top.children.push({ type: "text", text: token.text, raw: token.raw === true })
      return
    }
    // A comment or a doctype has nothing a reader needs, and Qt would lay the
    // doctype out as text.
    if (token.type !== "start" && token.type !== "end") return

    if (token.type === "start") {
      var implied = IMPLIED_CLOSE[token.name]
      if (implied) {
        while (stack.length > 1 && implied[stack[stack.length - 1].name] === true) stack.pop()
        top = stack[stack.length - 1]
      }
      var node = elementNode(token)
      top.children.push(node)
      if (VOID_ELEMENTS[token.name] !== true && !node.selfClosing
        && stack.length < MAX_TREE_DEPTH) stack.push(node)
      return
    }

    // An end tag closes the nearest ancestor of that name, and everything still
    // open inside it. One that matches nothing open is noise, and dropping it
    // is the only reading that cannot close something the sender meant to keep.
    for (var depth = stack.length - 1; depth > 0; depth--) {
      if (stack[depth].name === token.name) {
        stack.length = depth
        return
      }
    }
  })

  return root
}

// =============================================================== serialiser
//
// Back into the subset Qt renders. Attribute values keep whatever character
// references the sender wrote — they are the value, and re-escaping them would
// turn "&amp;" into "&amp;amp;" on every round trip — so only the quote that
// delimits them has to go.

function serializeAttributes(attrs) {
  var out = ""
  for (var i = 0; i < attrs.length; i++) {
    var attr = attrs[i]
    out += " " + attr.name
    if (attr.value === null || attr.value === undefined) continue
    out += "=\"" + String(attr.value).replace(/"/g, "&quot;") + "\""
  }
  return out
}

// Written into one array and joined once. Returning a string per level builds a
// fresh copy of everything below it at every level, which on a document a few
// hundred elements deep is most of the time this file spends.
function serializeInto(node, out, fit) {
  if (node.type === "text") {
    out.push(node.text)
    return
  }
  if (node.type !== "root") {
    out.push("<" + node.name + serializeAttributes(fit ? fitAttributes(node, fit) : node.attrs))
    if (VOID_ELEMENTS[node.name] === true || node.selfClosing) {
      out.push(node.selfClosing ? "/>" : ">")
      return
    }
    out.push(">")
  }
  for (var i = 0; i < node.children.length; i++) serializeInto(node.children[i], out, fit)
  if (node.type !== "root") out.push("</" + node.name + ">")
}

// `fit` is applied on the way out rather than to the tree, so the tree is still
// exactly what the parse produced and can be handed to the next width.
function serialize(node, fit) {
  var out = []
  serializeInto(node, out, fit)
  return out.join("")
}

// A tree walk that may replace a node with nothing, with itself, or with its
// own children. Returning null drops the subtree; returning "unwrap" keeps the
// children and drops the element around them.
function transform(node, visit) {
  var kept = []
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") {
      kept.push(child)
      continue
    }
    var verdict = visit(child)
    if (verdict === null) continue
    transform(child, visit)
    if (verdict === "unwrap") {
      for (var j = 0; j < child.children.length; j++) kept.push(child.children[j])
      continue
    }
    kept.push(child)
  }
  node.children = kept
  return node
}

function attributeOf(node, name) {
  for (var i = 0; i < node.attrs.length; i++) {
    if (node.attrs[i].name === name) return node.attrs[i]
  }
  return null
}

function attributeValue(node, name) {
  var attr = attributeOf(node, name)
  return attr && attr.value !== null && attr.value !== undefined ? String(attr.value) : ""
}

function removeAttribute(node, name) {
  var kept = []
  for (var i = 0; i < node.attrs.length; i++) {
    if (node.attrs[i].name !== name) kept.push(node.attrs[i])
  }
  node.attrs = kept
}

function setAttribute(node, name, value) {
  var attr = attributeOf(node, name)
  if (attr) attr.value = String(value)
  else node.attrs.push({ name: name, value: String(value) })
}

function setStyle(node, declarations) {
  var attr = attributeOf(node, "style")
  var style = joinDeclarations(declarations)
  if (style === "") {
    if (attr) removeAttribute(node, "style")
    return
  }
  if (attr) attr.value = style
  else node.attrs.push({ name: "style", value: style })
}

// ================================================ what a source may point at
//
// An attribute value is not a URL until the HTML parser has resolved the
// character references inside it. Qt does that before it fetches anything, so
// src="&#104;ttps://tracker/x.png" is a real https fetch to the engine while a
// check reading the raw attribute text sees something that starts with an "&"
// and lets it through. Tab and newline inside a URL are dropped for the same
// reason: they are not part of it by the time the fetch is made.
// The named references mail actually uses. An unknown one is left as written,
// which is what Qt does with it too.
var NAMED_REFERENCES = {
  amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", sol: "/", colon: ":",
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", bull: "\u2022",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  middot: "\u00b7", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  deg: "\u00b0", times: "\u00d7", laquo: "\u00ab", raquo: "\u00bb",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2", sect: "\u00a7"
}

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


// ========================================================= style declarations
//
// Split on ";", but not on a ";" inside a quoted string or inside url(...),
// where it is part of the value rather than the end of one.

function splitDeclarations(style) {
  var text = String(style === undefined || style === null ? "" : style)
  var out = []
  var current = ""
  var quote = ""
  var depth = 0
  for (var i = 0; i < text.length; i++) {
    var character = text.charAt(i)
    if (quote !== "") {
      current += character
      if (character === quote) quote = ""
      continue
    }
    if (character === "\"" || character === "'") {
      quote = character
      current += character
      continue
    }
    if (character === "(") depth++
    else if (character === ")") depth = Math.max(0, depth - 1)
    else if (character === ";" && depth === 0) {
      out.push(current)
      current = ""
      continue
    }
    current += character
  }
  out.push(current)

  var declarations = []
  for (var j = 0; j < out.length; j++) {
    var piece = out[j]
    if (piece.replace(/\s+/g, "") === "") continue
    var colon = piece.indexOf(":")
    if (colon < 0) continue
    declarations.push({
      name: piece.substring(0, colon).replace(/^\s+|\s+$/g, "").toLowerCase(),
      value: piece.substring(colon + 1).replace(/^\s+|\s+$/g, "")
    })
  }
  return declarations
}

function joinDeclarations(declarations) {
  var parts = []
  for (var i = 0; i < declarations.length; i++) {
    if (declarations[i].value === "") continue
    parts.push(declarations[i].name + ":" + declarations[i].value)
  }
  return parts.join(";")
}

// Rewrites an element's style attribute through `decide`, which is handed each
// declaration and returns it, a replacement, or null to drop it.
function rewriteStyle(node, decide) {
  var attr = attributeOf(node, "style")
  if (!attr || attr.value === null || attr.value === undefined) return
  var declarations = splitDeclarations(attr.value)
  var kept = []
  for (var i = 0; i < declarations.length; i++) {
    var verdict = decide(declarations[i])
    if (verdict) kept.push(verdict)
  }
  setStyle(node, kept)
}

// ================================================================== passes
//
// Each of these is a decision about the tree. They are exported one by one
// because each encodes a fact measured against Qt's engine and each is worth
// being able to test on its own; `sanitize` runs them in one walk rather than
// parsing the document once per pass.

// Elements whose content Qt would either lay out as text or has no business
// seeing. <style> and <script> are the ones that matter: their CSS and their
// source come out as body text.
var DROPPED_ELEMENTS = {
  script: true, style: true, iframe: true, object: true, embed: true,
  applet: true, noscript: true, meta: true, link: true, base: true,
  // Raw-text elements whose content is not body text and which Qt lays out as
  // if it were. Nearly every marketing mail ships <head><title>, and it came
  // out as a stray line above the message.
  title: true, textarea: true
}

// Senders ship their own palette: a background *and* the text colour that
// suits it. Removing only the background is what makes a message unreadable —
// GitHub's #24292e text would sit on a #131313 ground — so both go, and the
// document stylesheet supplies the pair. Anything that survives (images,
// borders) belongs to the sender.
var COLOUR_ATTRIBUTES = { bgcolor: true, bordercolor: true, color: true }
var COLOUR_DECLARATIONS = {
  color: true, background: true, "background-color": true,
  "border-color": true, "outline-color": true
}

// Attributes whose value is an address rather than a colour or a number, and
// which therefore belong to the image policy or to nothing at all.
//
// `background` is the one that matters and the one that hid here for a while:
// it sat in the colour list because senders write it beside `bgcolor`, and in
// HTML it is an image URL. Qt fetches it. With `keepColors` on, a real message
// reached mirostatic.com with remote images off — a colour setting had bought
// the sender a network request, which is exactly the thing no appearance option
// may ever do. The rest are here because being right about which of them Qt
// honours is not worth the risk of being wrong: a picture arrives as <img>, and
// that is the one attribute the image policy owns.
var RESOURCE_ATTRIBUTES = {
  background: true, srcset: true, lowsrc: true, dynsrc: true, poster: true,
  data: true, codebase: true, usemap: true, ping: true, formaction: true,
  longdesc: true, profile: true, manifest: true, archive: true, cite: true
}

function stripColorsFrom(node) {
  for (var name in COLOUR_ATTRIBUTES) removeAttribute(node, name)
  for (var resource in RESOURCE_ATTRIBUTES) removeAttribute(node, resource)
  rewriteStyle(node, function(declaration) {
    return COLOUR_DECLARATIONS[declaration.name] === true ? null : declaration
  })
}

// A url() in an inline style is a fetch wherever the engine honours it, and
// which declarations Qt honours is not worth having to be right about: nothing
// in mail needs one, because pictures arrive as <img>, which is where the image
// policy lives.
function stripStyleUrlsFrom(node) {
  rewriteStyle(node, function(declaration) {
    return /url\s*\(/i.test(decodeReferences(declaration.value)) ? null : declaration
  })
}

// Qt's rich text engine ignores display:none outright — measured: a hidden div
// adds a full line of text to the layout. It does honour font-size, though, and
// the standard email preheader is hidden text set at 1px, so it comes out as a
// two-pixel smudge of unreadable characters above the message. Elements the
// sender marked hidden are therefore removed rather than styled away.
function isHiddenBy(declarations) {
  for (var i = 0; i < declarations.length; i++) {
    var declaration = declarations[i]
    if (declaration.name === "display" && /^none\b/i.test(declaration.value)) return true
    if (declaration.name === "visibility" && /^hidden\b/i.test(declaration.value)) return true
  }
  return false
}

function isHidden(node) {
  if (VOID_ELEMENTS[node.name] === true) return false
  var style = attributeValue(node, "style")
  if (style === "") return false
  return isHiddenBy(splitDeclarations(style))
}

// A 1x1 image is a tracking pixel, never something to look at. Dropping them
// removes both the beacon and a layout pass per message.
function isTrackingPixel(node) {
  var width = Number(attributeValue(node, "width"))
  var height = Number(attributeValue(node, "height"))
  if (isFinite(width) && attributeValue(node, "width") !== "" && width <= 2) return true
  if (isFinite(height) && attributeValue(node, "height") !== "" && height <= 2) return true
  var declarations = splitDeclarations(attributeValue(node, "style"))
  for (var i = 0; i < declarations.length; i++) {
    if (declarations[i].name !== "width" && declarations[i].name !== "height") continue
    if (/^[012](\.\d+)?px/i.test(declarations[i].value)) return true
  }
  return false
}

// Grids past this depth become plain blocks. Two levels covers the real
// tabular content in mail — a status table, a receipt — and past it Qt is
// resolving column widths against column widths for no one's benefit.
var KEEP_TABLE_DEPTH = 2
var TABLE_PARTS = {
  table: true, thead: true, tbody: true, tfoot: true, tr: true, td: true, th: true
}

// A table in mail is either the sender's content or the sender's layout, and
// almost all of them are the layout: a box centring a card in an Outlook
// window. Depth cannot tell the two apart, because the layout is what wraps
// the content — counting from the outside kept the scaffolding and flattened
// the table that meant something. GitHub's build-status table sits three
// tables down, and its header row came out as "Status", "Job", "Annotations"
// on three lines of their own.
//
// So the question asked of a table is whether it is a **grid**: two rows that
// each hold more than one cell. That is the whole of what a table can say that
// a stack of blocks cannot — these cells line up with those. One row of cells
// is a logo beside a nav, one cell is a box, and neither loses anything by
// becoming what it already was.
function rowsOf(node, out) {
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") continue
    // A nested table's rows are its own. They answer this question for it.
    if (child.name === "table") continue
    if (child.name === "tr") out.push(child)
    rowsOf(child, out)
  }
  return out
}

function isGrid(node) {
  var rows = rowsOf(node, [])
  var lines = 0
  for (var i = 0; i < rows.length; i++) {
    var cells = 0
    for (var j = 0; j < rows[i].children.length; j++) {
      var cell = rows[i].children[j]
      if (cell.type === "text") continue
      if (cell.name === "td" || cell.name === "th") cells++
    }
    if (cells >= 2 && ++lines >= 2) return true
  }
  return false
}

// What is worth keeping off a table that was the layout is the styling that
// rode on it, not the table semantics.
function asBlock(node) {
  var style = attributeValue(node, "style")
  node.name = "div"
  node.attrs = style === "" ? [] : [{ name: "style", value: style }]
}

// The parts belonging to this table, which stops at a nested one: that table
// has been asked its own question already, and those rows and cells are its.
function flattenPartsOf(node) {
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text" || child.name === "table") continue
    flattenPartsOf(child)
    if (TABLE_PARTS[child.name] === true) asBlock(child)
  }
}

// Depth is what the limit counts, and it counts grids: the boxes on the way
// down are not tables by the time this returns, and charging them against a
// budget meant for competing column widths is what put the budget on the
// wrong two levels in the first place.
function flattenTablesIn(node, limit, depth) {
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") continue
    if (child.name !== "table") {
      flattenTablesIn(child, limit, depth)
      continue
    }
    var keep = depth < limit && isGrid(child)
    flattenTablesIn(child, limit, keep ? depth + 1 : depth)
    if (keep) continue
    flattenPartsOf(child)
    asBlock(child)
  }
}

// ================================================================ sanitize
//
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

// One walk over one element's attributes. Doing it as four passes — colours,
// then handlers, then hrefs, then styles — rebuilt the array four times for
// every element in the document, which on a large message is most of the work.
var HANDLER_ATTRIBUTE = /^on[a-z]+$/

// The sender centres a 600px card in the middle of a wide window. This reader
// is a panel of left-aligned text beside a left-aligned list, and the same
// mail kept centred in it comes out as a column of short lines adrift — the
// window is the card. Every other alignment is something the panel can honour:
// a column of numbers reads right, and Arabic reads from the other end.
//
// A cell is the exception, because a column lining up is the one thing a grid
// is kept for.
var CENTRED = /^center\b/i
var ALIGNED_BY_COLUMN = { td: true, th: true }

function cleanAttributes(node, keepColors, declarations) {
  var uncentre = ALIGNED_BY_COLUMN[node.name] !== true
  var attrs = node.attrs
  var kept = attrs
  var dropped = false

  for (var i = 0; i < attrs.length; i++) {
    var attr = attrs[i]
    var name = attr.name
    var drop = false
    // Unconditionally, and before the colour question is asked: `keepColors`
    // is an appearance setting, and no appearance setting may hand the
    // renderer an address to fetch.
    if (RESOURCE_ATTRIBUTES[name] === true) drop = true
    else if (!keepColors && COLOUR_ATTRIBUTES[name] === true) drop = true
    // Event handlers, which Qt ignores but which have no business surviving a
    // trip through a mail client.
    else if (name.charCodeAt(0) === 111 && HANDLER_ATTRIBUTE.test(name)) drop = true
    else if (name === "href" && !safeHref(attr.value)) drop = true
    else if (uncentre && name === "align" && CENTRED.test(String(attr.value))) drop = true

    if (drop && !dropped) {
      dropped = true
      kept = attrs.slice(0, i)
    } else if (!drop && dropped) {
      kept.push(attr)
    }
  }
  if (dropped) node.attrs = kept
  if (declarations === null) return

  var survivors = []
  for (var j = 0; j < declarations.length; j++) {
    var declaration = declarations[j]
    if (!keepColors && COLOUR_DECLARATIONS[declaration.name] === true) continue
    if (uncentre && declaration.name === "text-align" && CENTRED.test(declaration.value)) continue
    if (/url\s*\(/i.test(declaration.value)
      && /url\s*\(/i.test(decodeReferences(declaration.value))) continue
    survivors.push(declaration)
  }
  setStyle(node, survivors)
}

// QTextDocument supports image dimensions as HTML attributes, but not as CSS
// width and height declarations. Most mail clients accept both spellings, and
// many senders use only CSS. Promote absolute pixel dimensions to the spelling
// Qt understands while leaving the original declaration for other consumers.
function promoteImageDimensions(node, declarations) {
  if (node.name !== "img" || declarations === null) return
  for (var i = 0; i < declarations.length; i++) {
    var declaration = declarations[i]
    if (declaration.name !== "width" && declaration.name !== "height") continue
    if (attributeOf(node, declaration.name) !== null) continue
    var pixels = String(declaration.value).match(/^(\d+(?:\.\d+)?)px$/i)
    if (!pixels) continue
    setAttribute(node, declaration.name, pixels[1])
  }
}

function hasDirectImage(node) {
  for (var i = 0; i < node.children.length; i++) {
    if (node.children[i].type !== "text" && node.children[i].name === "img") return true
  }
  return false
}

// Browser email templates use a zero line height around adjacent images to
// remove the small inline-image baseline gap. QTextDocument instead collapses
// the whole row and paints the following block over those images.
function keepImageRowOpen(node) {
  if (!hasDirectImage(node)) return
  rewriteStyle(node, function(declaration) {
    if ((declaration.name === "line-height" || declaration.name === "font-size")
      && /^0(?:\.0+)?(?:px|pt|%|em|rem)?$/i.test(declaration.value)) return null
    return declaration
  })
}

// ----------------------------------------------------------- scaffolding
//
// Real mail is mostly scaffolding. A card centred in an Outlook window is six
// or seven boxes deep, and flattening the tables past the second turns every
// layer above that into a div with nothing on it — in a live mailbox they are
// most of the tree.
//
// They are not free. Qt parses each one back out of the string, gives it a box
// and lays the box out, and that half of the work is the half this file cannot
// move or measure. Handing it a smaller document is the only lever on it.
//
// Two shapes, and only two, because both are provably the same document:
// a box with nothing on it around a single box is that box, and an inline
// element with nothing on it is nothing at all.
var TRANSPARENT_INLINE = { span: true, font: true, small: true, big: true }
// <center> is here because it arrives as a <div>: `clean` renames it, on the
// same grounds that take `text-align:center` off everything but a cell. A
// container only counts as plain when it carries no meaning of its own — which
// is the whole test being applied here.
var PLAIN_CONTAINER = {
  div: true, section: true, article: true, aside: true,
  header: true, footer: true, main: true, nav: true
}

// The one block this element holds, or null if it holds anything else.
// Whitespace between blocks is not content and does not count against it.
function soleBlockChild(node) {
  var found = null
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") {
      if (child.text.replace(/[\s\u00a0]+/g, "") !== "") return null
      continue
    }
    if (found !== null) return null
    if (BLOCK_ELEMENTS[child.name] !== true) return null
    found = child
  }
  return found
}

// Bottom up, so a stack of seven collapses to one rather than to six.
function collapse(node) {
  var kept = []
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") {
      kept.push(child)
      continue
    }
    collapse(child)
    if (child.attrs.length === 0) {
      if (TRANSPARENT_INLINE[child.name] === true) {
        for (var j = 0; j < child.children.length; j++) kept.push(child.children[j])
        continue
      }
      if (PLAIN_CONTAINER[child.name] === true) {
        var inner = soleBlockChild(child)
        if (inner !== null) {
          kept.push(inner)
          continue
        }
      }
    }
    kept.push(child)
  }
  node.children = kept
}

function sanitize(html, options) {
  var settings = options || {}
  var source = String(html === undefined || html === null ? "" : html)
  var keepColors = settings.keepColors === true
  var allowImages = settings.allowRemoteImages === true
  var limit = Math.max(0, Math.floor(
    settings.maxImages === undefined ? MAX_IMAGES : settings.maxImages))

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

  function keepImage(node) {
    var source = attributeValue(node, "src")
    if (attributeOf(node, "src") === null) return true
    var kind = imageSourceKind(source)
    // cid: and data: are the message's own bytes and never touch the network.
    if (kind === "inline" || kind === "none") return true
    // Neither a local read nor a private-network request is something the
    // reader can ever be offered, so these go without being counted as
    // something "show images" would bring back.
    if (kind !== "remote") return false
    if (isTrackingPixel(node)) {
      blocked++
      return false
    }
    if (loadable < limit) loadable++
    if (!allowImages || kept >= limit) {
      blocked++
      return false
    }
    kept++
    return true
  }

  function clean(node) {
    var survivors = []
    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i]
      if (child.type === "text") {
        survivors.push(child)
        continue
      }
      if (DROPPED_ELEMENTS[child.name] === true) continue
      // <center> is the same instruction spelled as an element, and Qt honours
      // it. As a plain box it is one more wrapper for `collapse` to fold away.
      if (child.name === "center") child.name = "div"

      // The style attribute is the only one worth parsing, and it is parsed
      // once per element: whether the sender marked this hidden and what
      // survives of its declarations are two questions about the same list.
      // Most elements in real mail carry one, so asking twice was most of a
      // second pass over the document.
      var style = attributeOf(child, "style")
      var declarations = style !== null && style.value !== null && style.value !== undefined
        ? splitDeclarations(style.value)
        : null
      if (declarations !== null && VOID_ELEMENTS[child.name] !== true
        && isHiddenBy(declarations)) continue

      promoteImageDimensions(child, declarations)
      cleanAttributes(child, keepColors, declarations)

      if (child.name === "img" && !keepImage(child)) continue

      clean(child)
      keepImageRowOpen(child)
      survivors.push(child)
    }
    node.children = survivors
  }

  var root = parse(source)

  // Read as text before anything is dropped, and only when a caller asked: the
  // reader wants both of these for a message with no text/plain part of its
  // own, and the tokenize underneath is the most expensive thing this file
  // does — paying for it twice to get two readings of one document is the
  // whole reason this is an option rather than a second call.
  //
  // Before, specifically. A message's third picture is its third picture
  // whether or not the first two were beacons, so the markers are numbered off
  // the sender's own tree and not off what survives the image policy.
  var plain = settings.withPlainText === true ? readTree(root) : null

  clean(root)
  if (settings.keepTables !== true) {
    flattenTablesIn(root, settings.keepTableDepth === undefined
      ? KEEP_TABLE_DEPTH : Math.max(0, settings.keepTableDepth), 0)
  }

  collapse(root)

  // Measured off the tree that is already in hand. The reader needs to know
  // whether this document is too heavy to lay out, and asking with the string
  // would mean parsing the whole thing a second time to count what was just
  // counted.
  var text = serialize(root)
  var size = { length: text.length, tags: 0, images: 0, tables: 0, tableDepth: 0 }
  size.tableDepth = measure(root, 0, size)

  return {
    html: text,
    blockedImages: blocked,
    images: kept,
    remoteImages: loadable,
    complexity: size,
    tooHeavy: isTooHeavy(size),
    plainText: plain,
    // The document itself, so the reader can fit it to a window without
    // parsing back the string that was just written from it. Nothing below
    // fitting mutates a tree, which is what makes handing this out safe.
    document: root
  }
}

function hasRemoteImages(html) {
  return sanitize(html).blockedImages > 0
}

// ---------------------------------------------------------- single passes

function stripColors(html) {
  var root = parse(html)
  transform(root, function(node) {
    stripColorsFrom(node)
    return node
  })
  return serialize(root)
}

function dropHidden(html) {
  var root = parse(html)
  transform(root, function(node) {
    return isHidden(node) ? null : node
  })
  return serialize(root)
}

function flattenTables(html, keepDepth) {
  var root = parse(html)
  flattenTablesIn(root, keepDepth === undefined ? KEEP_TABLE_DEPTH : Math.max(0, keepDepth), 0)
  return serialize(root)
}

function stripElement(html, name) {
  var wanted = String(name || "").toLowerCase()
  var root = parse(html)
  transform(root, function(node) {
    return node.name === wanted ? null : node
  })
  return serialize(root)
}

// =============================================================== complexity

function measure(node, depth, size) {
  var deepest = depth
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") continue
    size.tags++
    if (child.name === "img") size.images++
    var childDepth = depth
    if (child.name === "table") {
      size.tables++
      childDepth = depth + 1
    }
    var reached = measure(child, childDepth, size)
    if (reached > deepest) deepest = reached
  }
  return deepest
}

function complexity(html) {
  var text = String(html === undefined || html === null ? "" : html)
  var size = { length: text.length, tags: 0, images: 0, tables: 0, tableDepth: 0 }
  size.tableDepth = measure(parse(text), 0, size)
  return size
}

function tableDepth(html) {
  return complexity(html).tableDepth
}

function isTooHeavy(size) {
  return size.length > MAX_RICH_TEXT
    || size.tags > MAX_ELEMENTS
    || size.tables > MAX_TABLES
    || size.tableDepth > MAX_TABLE_DEPTH
}

function tooHeavyForRichText(html) {
  return isTooHeavy(complexity(html))
}

// ============================================================ fitting to width
//
// Qt's rich text engine takes max-width on images, but only in pixels: a
// percentage collapses the image to nothing at all. An explicit height
// attribute also survives the clamp, so a banner scaled from 1600 to 380 keeps
// its original height and renders as a smear. Both were measured against the
// engine rather than assumed — strip the heights, give a pixel ceiling, and Qt
// derives the height from the aspect ratio on its own.
var MIN_IMAGE_WIDTH = 40

// Which of the three fittings to apply, and the width to fit to. Kept as one
// object because they are asked for together and because the answer for an
// element is one pass over its attributes however many of them are on.
function fitting(heights, sides, widths, available, clampedHeightsOnly) {
  return {
    heights: heights === true,
    clampedHeightsOnly: clampedHeightsOnly === true,
    sides: sides === true,
    widths: widths === true,
    limit: Math.max(MIN_IMAGE_WIDTH, Math.floor(Number(available) || 0))
  }
}

// Senders lay their mail out for a wide window, and at a narrow one their
// horizontal padding is most of the screen. The vertical rhythm is worth
// keeping; the side gutters are not.
var SIDE_SPACING = {
  "padding-left": true, "padding-right": true,
  "margin-left": true, "margin-right": true
}

function withoutSides(value) {
  var parts = String(value).replace(/^\s+|\s+$/g, "").split(/\s+/)
  if (parts.length >= 4) return parts[0] + " 0 " + parts[2] + " 0"
  if (parts.length === 3) return parts[0] + " 0 " + parts[2]
  return parts[0] + " 0"
}

// A table told to be 600px wide inside a 380px window is a horizontal scrollbar
// over content that would have wrapped perfectly well.
var SIZED_ELEMENTS = { table: true, td: true, th: true, tr: true, div: true }

function intrinsicContentWidth(node, value) {
  var percent = String(value || "").replace(/^\s+|\s+$/g, "").match(/^(\d+(?:\.\d+)?)%$/)
  if (!percent || Number(percent[1]) > 5) return false
  if (node.name === "table") return true
  if (node.name !== "td" && node.name !== "th") return false
  return String(attributeValue(node, "style")).toLowerCase().indexOf("nowrap") >= 0
}

function fitDeclaration(declaration, node, fit, dropImageHeight) {
  var name = declaration.name
  if (dropImageHeight && name === "height") return null
  if (fit.sides) {
    if (SIDE_SPACING[name] === true) return null
    if (name === "padding" || name === "margin")
      return { name: name, value: withoutSides(declaration.value) }
  }
  if (fit.widths) {
    if (name === "width" && intrinsicContentWidth(node, declaration.value)) return null
    if (name === "width" && SIZED_ELEMENTS[node.name] === true) {
      var pixels = declaration.value.match(/^(\d+)px$/i)
      if (pixels && Number(pixels[1]) > fit.limit) return null
    }
    // Qt honours this and the reader has nowhere to scroll to, so a line the
    // sender promised would not wrap is a line that runs off the panel and is
    // not read. Wrapping is the half of that promise the reader can keep.
    if (name === "white-space" && /^nowrap\b/i.test(declaration.value)) return null
  }
  return declaration
}

// Splitting an element's declarations to fit them is most of what a relayout
// costs, and a relayout happens on every drag of the splitter. Everything the
// width pass can change says one of two words, so the string is asked before
// it is parsed. The gutter pass has no such tell — padding, margin and their
// four sides — and skips the question.
var FITTABLE_DECLARATION = /width|nowrap/i

// The attribute list an element is written with. The node keeps its own: this
// is the reader fitting a message to the window it happens to be, and the same
// message is fitted again at the next width.
function fitAttributes(node, fit) {
  var attrs = node.attrs
  if (attrs.length === 0) return attrs
  var isImage = fit.heights && node.name === "img"
  var isSized = fit.widths && SIZED_ELEMENTS[node.name] === true
  var imageWidth = Number(attributeValue(node, "width"))
  var dropImageHeight = isImage && (!fit.clampedHeightsOnly
    || (isFinite(imageWidth) && imageWidth > fit.limit))
  if (!isImage && !isSized && !fit.sides) {
    if (!fit.widths) return attrs
    // Anything can carry white-space:nowrap, so the fast path out of here has
    // to ask every element about it — and asks with a substring test, because
    // splitting the declarations of a document that has none is the whole cost
    // of a relayout for nothing.
    var carried = attributeOf(node, "style")
    if (carried === null || String(carried.value).indexOf("nowrap") < 0) return attrs
  }

  var out = null
  for (var i = 0; i < attrs.length; i++) {
    var attr = attrs[i]
    var replacement = attr

    // An explicit height survives the max-width clamp, so a banner scaled from
    // 1600 to 380 keeps its original height and renders as a smear. Measured
    // against the engine rather than assumed: strip the heights and Qt derives
    // the height from the aspect ratio on its own.
    if (dropImageHeight && attr.name === "height") replacement = null
    else if (isSized && attr.name === "width"
      && intrinsicContentWidth(node, attr.value)) replacement = null
    else if (isSized && attr.name === "width" && /^\d+$/.test(String(attr.value))
      && Number(attr.value) > fit.limit) replacement = null
    else if (attr.name === "style" && attr.value !== null && attr.value !== undefined
      && (fit.sides || FITTABLE_DECLARATION.test(String(attr.value))
        || dropImageHeight)) {
      var declarations = splitDeclarations(attr.value)
      var kept = []
      var changed = false
      for (var j = 0; j < declarations.length; j++) {
        var fitted = fitDeclaration(declarations[j], node, fit, dropImageHeight)
        if (fitted !== declarations[j]) changed = true
        if (fitted) kept.push(fitted)
      }
      if (changed) {
        var style = joinDeclarations(kept)
        replacement = style === "" ? null : { name: "style", value: style }
      }
    }

    if (replacement === attr) {
      if (out !== null) out.push(attr)
      continue
    }
    if (out === null) out = attrs.slice(0, i)
    if (replacement !== null) out.push(replacement)
  }
  return out === null ? attrs : out
}

// The reader rebuilds its document whenever the window width or the zoom
// changes, and the body it rebuilds from has not changed at all — so it hands
// over the document `sanitize` already built rather than the string that was
// written from it, and a whole drag costs no parse at all. A string is still
// accepted, because a caller that only has one should not have to care.
function documentTree(source) {
  if (source && source.type === "root") return source
  return parse(source)
}

var CONTENT_WIDTH_ELEMENTS = {
  body: true, div: true, table: true, section: true, article: true,
  header: true, footer: true, main: true
}

function fixedPixelWidth(value) {
  var match = String(value === undefined || value === null ? "" : value)
    .replace(/^\s+|\s+$/g, "").match(/^(\d+(?:\.\d+)?)(?:px)?$/i)
  return match ? Number(match[1]) : 0
}

function widestDeclaredContent(node, current) {
  var widest = current
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") continue
    if (CONTENT_WIDTH_ELEMENTS[child.name] === true) {
      var width = fixedPixelWidth(attributeValue(child, "width"))
      var declarations = splitDeclarations(attributeValue(child, "style"))
      for (var j = 0; j < declarations.length; j++) {
        if (declarations[j].name !== "max-width"
          && declarations[j].name !== "width") continue
        width = Math.max(width, fixedPixelWidth(declarations[j].value))
      }
      // Tiny fixed boxes are icons, bullets, and badges, not the message card.
      if (width >= 240) widest = Math.max(widest, width)
    }
    widest = widestDeclaredContent(child, widest)
  }
  return widest
}

function preferredContentWidth(source, available) {
  var limit = Math.max(80, Math.floor(Number(available) || 0))
  var declared = widestDeclaredContent(documentTree(source), 0)
  return declared > 0 ? Math.min(limit, Math.floor(declared)) : limit
}

function stripImageHeights(html) {
  return serialize(parse(html), fitting(true, false, false, 0))
}

function compactHorizontal(html) {
  return serialize(parse(html), fitting(false, true, false, 0))
}

function relaxFixedWidths(html, available) {
  return serialize(parse(html), fitting(false, false, true, available))
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
  var maxImage = Math.floor(Number(palette.maxImageWidth) || 0)

  // No parse at all when the caller kept the document: this is rebuilt on every
  // relayout, and the body it is built from has not changed.
  var root = documentTree(bodyHtml)
  // The gutters go only when the window is too narrow to spare them, because a
  // wide one reads better with the sender's own spacing. A width the window
  // cannot hold goes at every width: there is no horizontal scroll here, so
  // what overflows is not read at all.
  var fit = fitting(true, palette.compact === true,
    maxImage >= MIN_IMAGE_WIDTH, maxImage, true)

  return "<html><head><style type=\"text/css\">"
    + "body{color:" + foreground + ";background-color:" + background + ";}"
    + "a{color:" + link + ";}"
    + "blockquote{color:" + quote + ";margin-left:8px;padding-left:8px;}"
    + "td,th{padding:2px;}"
    + (maxImage >= MIN_IMAGE_WIDTH ? "img{max-width:" + maxImage + "px;}" : "")
    + "</style></head><body>"
    + (pad > 0 ? "<div style=\"padding:" + pad + "px\">" : "")
    + serialize(root, fit)
    + (pad > 0 ? "</div>" : "")
    + "</body></html>"
}

// ========================================================= plain text bodies
//
// The reader falls back to plain text when the user asks for it and when a
// message is too heavy to lay out as rich text. Both cases still want the
// images to be reachable, so the markers `toText` leaves behind are turned into
// links — and this document is built here rather than taken from the sender, so
// it stays trivially cheap to lay out even for the messages that were too heavy
// in the first place.

var IMAGE_LINK_PREFIX = "omarchy-image:"

// Closing one of these ends a line. Everything else is inline as far as a
// plain-text reading is concerned.
var BLOCK_ELEMENTS = {
  p: true, div: true, tr: true, li: true, blockquote: true, section: true,
  article: true, header: true, footer: true, table: true, ul: true, ol: true,
  h1: true, h2: true, h3: true, h4: true, h5: true, h6: true
}

// Images become a marker rather than nothing at all. Stripped outright — which
// is what removing every tag does — a message built around its pictures reads
// as a long run of unexplained blank space, with no way to tell an empty
// message from one whose contents happen not to be text. The number is what
// lets the reader offer the image itself when the marker is clicked.
//
// The markers and `imageSources` are numbered by the same walk over the same
// tree, so the two lists line up position for position. They have to: a marker
// that disagrees with the list opens somebody else's picture.
// A run of spaces, tabs and newlines in the source is one space, which is what
// HTML says it is and what the renderer would have done with it. Kept as
// written, a template's indentation arrives as gaps in the middle of a
// sentence — a bank statement came out with its greeting a hand's width from
// the name it greeted.
var SOURCE_WHITESPACE = /[ \t\r\n\f]+/g

// A cell ends a line the way a paragraph does, even though a cell is not a
// block. Without it a row's label and its figure run together into one word,
// and a statement is nothing but rows.
var CELL_ELEMENTS = { td: true, th: true }

function flatten(node, state) {
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") {
      // Collapsed before the references are decoded, not after: the run in the
      // source is the template's formatting, while &nbsp;&nbsp; is the sender
      // spacing something out by hand and decodes to spaces of its own.
      if (!child.raw) state.text += decodeReferences(child.text.replace(SOURCE_WHITESPACE, " "))
      continue
    }
    if (DROPPED_ELEMENTS[child.name] === true) continue
    if (child.name === "img") {
      // A beacon is not a picture. Numbered, it becomes a marker offering to
      // open a 1x1 gif in the middle of the message it was hidden inside — and
      // the statements that fall back to text are the ones carrying dozens.
      if (isTrackingPixel(child)) continue
      state.images.push(imageSourceOf(child))
      state.text += "[image " + state.images.length + "]"
      continue
    }
    if (child.name === "br") {
      state.text += "\n"
      continue
    }
    if (child.name === "li") state.text += "• "
    flatten(child, state)
    if (BLOCK_ELEMENTS[child.name] === true || CELL_ELEMENTS[child.name] === true) {
      state.text += "\n"
    }
  }
  return state
}

function imageSourceOf(node) {
  var attr = attributeOf(node, "src")
  return attr && attr.value !== null && attr.value !== undefined ? String(attr.value) : ""
}

function readTree(root) {
  var state = flatten(root, { text: "", images: [] })
  state.text = state.text
    .replace(/[^\S\n]+\n/g, "\n")
    // A line does not start where the markup was indented. Every box a block
    // sits inside contributes a space of its own on the way down, so a heading
    // four tables deep arrived four spaces in — and two spaces are two
    // non-breaking spaces by the time this is drawn, which is a ragged left
    // edge down the whole message. The sender indented markup, not text.
    .replace(/\n[^\S\n]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "")
  return state
}

// The sender's HTML as text, with a numbered marker where each picture was, and
// the pictures those numbers point at.
function readPlainText(html) {
  return readTree(parse(html))
}

// Mail is padded with characters that draw nothing. A sender wants the inbox's
// preview line to end where their first sentence does, so they fill the rest of
// it with soft hyphens, combining grapheme joiners and zero-width spaces —
// Linear ships three hundred and sixty of them. Every mail client's list stops
// there, which is the point; a reader that draws them honestly gets thirty-one
// blank lines between the greeting and the message.
//
// Not U+00A0: a non-breaking space is a space, and spacing is the one thing
// somebody reading in plain text asked to see.
var UNDRAWN_CHARACTERS = /[\u00ad\u034f\u061c\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g

// The rest of that padding is whitespace that does draw: figure spaces and
// non-breaking spaces, twenty-five of each to the line. A line holding nothing
// else holds nothing — there is no alignment to keep in a line with nothing on
// it — so it is emptied, and then it is one of a run of blank lines rather than
// twenty-five columns of nothing.
var BLANK_LINE = /^[^\S\n]+$/gm
var BLANK_RUN = /\n{3,}/g

// What the sender wrote, less what nothing draws. One blank line survives a run
// of them, because that one is a paragraph break.
function readableText(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(UNDRAWN_CHARACTERS, "")
    .replace(BLANK_LINE, "")
    .replace(BLANK_RUN, "\n\n")
    .replace(/^\s+|\s+$/g, "")
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
  var body = preserveSpacing(escapeText(readableText(text)))
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
