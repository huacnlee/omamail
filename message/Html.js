.pragma library

.import "Direction.js" as Direction

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

// A text node goes back out with its `<` and `>` escaped. What the tokenizer
// read as text is not always what a second reader would read: this file joins
// text that the sender had kept apart. `collapse` unwraps a `<span>` and welds
// the text on either side of it together; reading mode rebuilds a paragraph out
// of pieces and drops the undrawable characters between them. So a `<` that was
// refused as a tag — because a zero-width space followed it, or because the
// letters that would have made it a tag were in the next element — can end up
// beside those letters, and Qt then parses a tag nobody sent. One sender did
// exactly this to get an `<img>` past the image policy: the policy never saw it,
// because by then it was not an element, it was a string.
//
// The two characters are escaped at the one place every document leaves by, and
// it costs a reader nothing: `&lt;` draws as `<`. `&` is deliberately left
// alone — the text still carries the sender's own entity references, and
// escaping it would print "&pound;4.00" at somebody expecting a price.
function escapeMarkup(text) {
  var value = String(text)
  if (value.indexOf("<") < 0 && value.indexOf(">") < 0) return value
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Written into one array and joined once. Returning a string per level builds a
// fresh copy of everything below it at every level, which on a document a few
// hundred elements deep is most of the time this file spends.
function serializeInto(node, out, fit) {
  if (node.type === "text") {
    out.push(escapeMarkup(node.text))
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
// reader looking for a scheme. For the scheme, over-decoding can only make a
// source look more dangerous than it is, and the answer to that is to block it.
function normalizedUrl(value) {
  var text = String(value === undefined || value === null ? "" : value)
  text = decodeReferences(decodeReferences(text))
  return text.replace(/[\t\n\r]/g, "").replace(/^[\s\u0000-\u001f]+|[\s\u0000-\u001f]+$/g, "")
}

// The host is the one question where that is not true, because a decoding can
// introduce a "@" and hand the authority to a later label: "127.0.0.1&#64;
// good.example.com" is a public host to a reader who decodes it and loopback to
// one who does not. So the host is asked of both readings and has to be public
// to both — one decode is what Qt does, two is what a sender may be counting on.
function hostsOf(value) {
  var text = String(value === undefined || value === null ? "" : value)
  var once = decodeReferences(text)
  var twice = decodeReferences(once)
  return once === twice ? [hostOf(normalizedUrl(text))]
    : [hostOf(normalizedUrl(text)), hostOf(once.replace(/[\t\n\r]/g, ""))]
}

function isPublicUrl(value) {
  var hosts = hostsOf(value)
  for (var i = 0; i < hosts.length; i++) {
    if (!isPublicHost(hosts[i])) return false
  }
  return true
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
  // Only a picture. A data: URL of any other type is not the message's own
  // bytes drawn in place — an SVG is a document with its own references, and
  // whether Qt follows them depends on which image plugins are installed.
  if (/^data:image\//i.test(url)) return "inline"
  if (/^data:/i.test(url)) return "unsafe"
  if (/^(https?:)?\/\//i.test(url)) return isPublicUrl(value) ? "remote" : "unsafe"
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
//
// The references come out first, and everything downstream therefore reads CSS
// rather than a puzzle. CSS has escapes of its own and no use for an HTML
// entity, so one in a style attribute is a sender hiding from a filter: with
// them left in, "background-image:&#117;rl(...)" split at the ";" inside
// "&#117;" into two declarations that were nonsense to every test here, and
// reassembled on the way out into the "url(" Qt decodes and fetches. Twice,
// for the same reason an address is read twice.
function splitDeclarations(style) {
  var text = String(style === undefined || style === null ? "" : style)
  if (text.indexOf("&") >= 0) text = decodeReferences(decodeReferences(text))
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
    return /url\s*\(/i.test(declaration.value) ? null : declaration
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

// The addresses a caller may prepare before Qt receives the document. Taken
// from the parsed tree so asking for them costs no second parse, with the same
// tracker, host and count rules the renderer uses.
function readerRemoteImageSources(root, limit) {
  var out = []
  var seen = {}

  function walk(node) {
    for (var i = 0; i < node.children.length && out.length < limit; i++) {
      var child = node.children[i]
      if (child.type === "text") continue
      if (DROPPED_ELEMENTS[child.name] === true) continue
      var style = attributeOf(child, "style")
      var declarations = style !== null && style.value !== null && style.value !== undefined
        ? splitDeclarations(style.value) : null
      if (declarations !== null && VOID_ELEMENTS[child.name] !== true
        && isHiddenBy(declarations)) continue
      if (child.name === "img") {
        var source = attributeValue(child, "src")
        if (imageSourceKind(source) === "remote" && !isTrackingPixel(child)
          && seen[source] !== true) {
          seen[source] = true
          out.push(source)
        }
      }
      walk(child)
    }
  }

  walk(root)
  return out
}

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
    // A `src` belongs to an image and is checked as one. Anywhere else — an
    // <input type="image">, an SVG <image> — it is the same address with none
    // of that checking behind it, and which of those Qt honours today is not
    // worth being wrong about tomorrow.
    else if (name === "src" && node.name !== "img") drop = true
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
    // No test for a reference here: `splitDeclarations` has already taken them
    // out, so this reads the same value Qt would.
    if (/url\s*\(/i.test(declaration.value)) continue
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

// The same promotion, for the same reason, on the other property Qt reads in
// only one of its two spellings.
//
// Qt's rich text engine honours the `dir` attribute and ignores the CSS
// `direction` property outright. A mail template written for a browser has no
// reason to use the attribute — CSS is where a browser reads it — so an Arabic
// or Hebrew newsletter that sets `style="direction:rtl"` arrives with its
// direction stated in the one spelling the renderer does not look at, and is
// laid out left-to-right against the wrong margin.
//
// The declaration is left in place rather than moved: it is the sender's, it is
// correct, and something other than Qt may yet read this document.
var DIRECTION_VALUES = { ltr: true, rtl: true }

function promoteDirection(node, declarations) {
  if (declarations === null) return
  // The sender's own attribute wins. It is the more specific statement of the
  // two, and it is the one they wrote for a client that reads it.
  if (attributeOf(node, "dir") !== null) return
  for (var i = 0; i < declarations.length; i++) {
    if (declarations[i].name !== "direction") continue
    var value = String(declarations[i].value).trim().toLowerCase()
    if (DIRECTION_VALUES[value] !== true) continue
    setAttribute(node, "dir", value)
    return
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
  var imageData = settings.remoteImageData && typeof settings.remoteImageData === "object"
    ? settings.remoteImageData : null
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

  function preparedImage(source) {
    if (imageData === null || !Object.prototype.hasOwnProperty.call(imageData, source)) return ""
    var value = String(imageData[source] || "")
    return /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i.test(value) ? value : ""
  }

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
    if (imageData !== null) {
      var prepared = preparedImage(source)
      if (prepared === "") {
        blocked++
        return false
      }
      attributeOf(node, "src").value = prepared
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
      promoteDirection(child, declarations)
      cleanAttributes(child, keepColors, declarations)

      if (child.name === "img" && !keepImage(child)) continue

      clean(child)
      keepImageRowOpen(child)
      survivors.push(child)
    }
    node.children = survivors
  }

  var root = parse(source)
  var remoteSources = readerRemoteImageSources(root, limit)

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

  // Before too, and for the same reason: reading mode is built out of what the
  // sender wrote rather than out of what survived the formatted view, so it
  // needs the type sizes that `clean` is about to discard and the tables that
  // `flattenTablesIn` is about to fold away. It reads the tree and does not
  // touch it, which is what lets one parse answer for all three ways of reading
  // a message — switching between them costs no parse and no fetch.
  var reader = settings.withReader === true
    ? readerTree(root, ({ allowRemoteImages: allowImages, maxImages: limit,
        remoteImageData: imageData }))
    : null

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
    remoteImageSources: remoteSources,
    complexity: size,
    tooHeavy: isTooHeavy(size),
    plainText: plain,
    // The reading-mode document, its own complexity and its own verdict: it is
    // a different document from the one below and is not heavy for the same
    // reasons.
    reader: reader,
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

// Which way the document runs, said in the two spellings that have to agree.
//
// The stylesheets below are written in physical sides — Qt's rich text engine
// reads `margin-left` and has never heard of `margin-inline-start` — so a list
// indent, a quote bar and a header's alignment are each given a side when the
// sheet is built. The `dir` on the body is the same statement in the other
// spelling, and the two are written together or not at all.
//
// Separating them was tried and is wrong, visibly: a sheet that indents a list
// from the right while the block is still left-to-right does not move the
// bullet to the right, it drops the bullet altogether. Qt places a list marker
// on the side the block runs from, and a margin alone does not tell it which
// side that is.
//
// A base direction is a default, not an override. A sender who states `dir` on
// their own element — or writes `direction` in CSS, which `promoteDirection`
// turns into the same thing — still wins inside it, so this supplies an answer
// only where the document gives none.
function baseDirectionAttribute(palette) {
  return Direction.attributeFor(String(palette.direction || ""))
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
  // Which way the message runs — see `baseDirectionAttribute` below.
  var direction = String(palette.direction || "")
  var quoteEdge = Direction.startEdge(direction)

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
    // The quote rule indents from the side the text starts on. Qt reads only
    // physical properties — there is no `margin-inline-start` in a
    // QTextDocument — so the side is chosen here rather than by the renderer.
    + "blockquote{color:" + quote + ";margin-" + quoteEdge + ":8px;padding-"
      + quoteEdge + ":8px;}"
    + "td,th{padding:2px;}"
    + (maxImage >= MIN_IMAGE_WIDTH ? "img{max-width:" + maxImage + "px;}" : "")
    + "</style></head><body" + baseDirectionAttribute(palette) + ">"
    + (pad > 0 ? "<div style=\"padding:" + pad + "px\">" : "")
    + serialize(root, fit)
    + (pad > 0 ? "</div>" : "")
    + "</body></html>"
}

// ============================================================== reading mode
//
// What a browser means by a reader: not the sender's presentation cleaned up,
// but the sender's presentation discarded and a small document built out of
// what the message actually says.
//
// The formatted view above is a filter. It walks the sender's tree, removes
// what Qt draws badly or must not fetch, and hands back what is left — which on
// real mail is a card six tables deep with its own type, its own gutters and
// its own palette, minus whichever of those the filter happened to take. That
// is why a newsletter renders as debris: the layout is gone and the leftovers
// of it are not, so the result looks accidental rather than deliberately plain.
//
// This builds a new tree instead. Nothing is carried across from the sender's
// document but four kinds of sender value:
//
//   text          collapsed the way HTML says whitespace collapses
//   href          on <a>, and only mailto: or http(s) at a public host
//   src           on <img>, and only what the image policy already allows
//   width/height  on <img>, numeric and capped to an inline-image size
//
// Every element the reader emits is constructed here with an empty attribute
// list and only these checked values are added. The reader may also add fixed
// layout attributes of its own to a compact avatar row; none is copied from
// the sender. A class, an id, a bgcolor, an align, a style, a background or a
// url() therefore cannot survive this pass by being missed. That is the whole
// security argument for reading mode: structural, with a narrow numeric
// exception rather than a list of removals.
//
// The type, the spacing, the measure and the colours are then Omamail's, and
// are applied by `readerDocumentFor` from the theme.

// Elements whose subtree holds nothing a reader wants. <style> and <script>
// are the ones that matter — Qt lays their contents out as body text — and the
// form controls are here because a text field in a mail is a picture of one.
var READER_DROPPED = {
  script: true, style: true, head: true, title: true, textarea: true,
  iframe: true, object: true, embed: true, applet: true, noscript: true,
  meta: true, link: true, base: true, input: true, select: true, option: true,
  optgroup: true, svg: true, canvas: true, map: true, area: true,
  frame: true, frameset: true, video: true, audio: true, source: true,
  track: true, param: true, template: true, col: true, colgroup: true
}

// Inline markup the reader draws, mapped to the one element it draws it with.
// Everything else inline — span, font, small, u — is the sender setting type,
// and the reader sets its own.
var READER_INLINE = {
  b: "strong", strong: "strong",
  i: "em", em: "em", cite: "em", dfn: "em", "var": "em",
  code: "code", kbd: "code", samp: "code", tt: "code"
}

var READER_HEADINGS = { h1: true, h2: true, h3: true, h4: true, h5: true, h6: true }

// Containers that end one line of text and begin another, and mean nothing
// else. <center> and <nav> are here for the same reason <div> is: by the time
// the reader has finished, a strip of links is a paragraph of links.
var READER_BLOCK = {
  div: true, p: true, section: true, article: true, aside: true, header: true,
  footer: true, main: true, nav: true, center: true, form: true,
  fieldset: true, figure: true, figcaption: true, address: true, dl: true,
  dt: true, dd: true, caption: true, legend: true, details: true, summary: true
}

// A reader document is flat by construction, so these bite only on mail that is
// enormous rather than merely deep. There is no ceiling on how many blocks one
// may hold: a document that grew past what Qt can lay out is refused whole by
// `isTooHeavy` and the message is shown as text, which is an answer, where a
// truncated reading would have silently lost the end of the message and looked
// exactly like a message that ended there.
var MAX_READER_TABLE_ROWS = 40
var MAX_READER_TABLE_COLUMNS = 8
// A heading is a short line. Past this it is a paragraph the sender happened to
// set large, and promoting it would put a page of body copy in heading type.
var MAX_HEADING_CHARS = 120

function readerElement(name) {
  return { type: "element", name: name, attrs: [], selfClosing: false, children: [] }
}

function readerText(text) {
  return { type: "text", text: text }
}

// The document being built.
//
//   blocks  what is finished
//   inline  the run of inline content not yet closed into a block
//   chain   the inline elements open around that run, outermost first
//
// `chain` is what lets a link survive a block boundary. Mail wraps <a> around a
// whole table to make a button, and without reopening the link in each block
// the choice is between one block holding the rest of the message and a button
// whose label has lost its address.
function readerState() {
  return { blocks: [], inline: [], chain: [], pending: false, filled: false }
}

function readerTarget(state) {
  return state.chain.length === 0 ? state.inline : state.chain[state.chain.length - 1].children
}

function readerLastText(state) {
  var target = readerTarget(state)
  var last = target.length > 0 ? target[target.length - 1] : null
  return last && last.type === "text" ? last : null
}

// A space owed is written before anything that is not text. Left for the next
// text to carry, it lands inside the element it was owed in front of, and
// "Body <a>link</a>" comes out as "Body<a> link</a>".
function readerSpace(state) {
  if (!state.pending || !state.filled) return
  var last = readerLastText(state)
  if (last) last.text += " "
  else readerTarget(state).push(readerText(" "))
  state.pending = false
}

// An open inline element is reopened in every block the chain crosses, so a
// sender who holds a hundred of them open turns each of a thousand paragraphs
// into a hundred thousand elements — a 24 KB message built a 4 MB document, on
// the GUI thread, before anything measured it and refused it. Real mail nests a
// handful of these, a link inside a bold inside a paragraph, and past that
// another one changes nothing anybody can see, so it is not opened at all: what
// was inside it is still walked and still drawn.
var MAX_READER_CHAIN = 8

function readerOpen(state, node) {
  if (state.chain.length >= MAX_READER_CHAIN) return false
  readerSpace(state)
  readerTarget(state).push(node)
  state.chain.push(node)
  return true
}

// A run of whitespace in the source is one space, which is what HTML says it is
// — and a space owed is carried rather than written, so the indentation of a
// template arrives as nothing instead of as a gap in the middle of a sentence.
// Characters that draw nothing go here too: mail is padded with soft hyphens
// and zero-width spaces to end the inbox preview line where the sender wants.
function readerAppendText(state, raw) {
  var value = String(raw).replace(UNDRAWN_CHARACTERS, "").replace(SOURCE_WHITESPACE, " ")
  if (value === "") return
  var core = value.replace(/^ +| +$/g, "")
  if (core === "") {
    if (state.filled) state.pending = true
    return
  }
  if (value.charAt(0) === " " && state.filled) state.pending = true
  var lead = state.pending && state.filled ? " " : ""
  var last = readerLastText(state)
  if (last) last.text += lead + core
  else readerTarget(state).push(readerText(lead + core))
  state.filled = true
  state.pending = value.charAt(value.length - 1) === " "
}

function readerAppendBreak(state) {
  // Not at the start of a block, and never two in a row: senders space things
  // out with runs of <br>, and the reader has its own spacing.
  if (!state.filled) return
  var target = readerTarget(state)
  var last = target.length > 0 ? target[target.length - 1] : null
  if (last && last.type === "element" && last.name === "br") return
  target.push(readerElement("br"))
  state.pending = false
}

// Whether a run of inline content says anything. A block holding only spacing —
// a spacer image already dropped, a stack of <br>, a cell of &nbsp; — is a
// block the reader does not draw, which is most of what a layout table is made
// of.
function readerMeaningful(nodes) {
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (node.type === "text") {
      if (decodeReferences(node.text).replace(/[\s\u00a0]+/g, "") !== "") return true
      continue
    }
    if (node.name === "img") return true
    if (node.name === "br" || node.name === "hr") continue
    if (readerMeaningful(node.children)) return true
  }
  return false
}

function readerEdgeless(node) {
  if (node.type === "text") return decodeReferences(node.text).replace(/[\s\u00a0]+/g, "") === ""
  return node.name === "br"
}

function readerTrimmed(nodes) {
  var from = 0
  var to = nodes.length
  while (from < to && readerEdgeless(nodes[from])) from++
  while (to > from && readerEdgeless(nodes[to - 1])) to--
  return from === 0 && to === nodes.length ? nodes : nodes.slice(from, to)
}

// How many characters a run of inline content draws, which is the question
// asked of anything about to become a heading.
function readerLength(nodes) {
  var total = 0
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (node.type === "text") total += decodeReferences(node.text).length
    // A picture is a word or two of the line it sits on, which is all this has
    // to be right about: the question is only whether a run is short.
    else if (node.name === "img") total += 8
    else total += readerLength(node.children)
  }
  return total
}

// Closes the open run into a block, then reopens the inline elements that were
// still open around it so the next block continues inside them.
function readerFlush(state, name) {
  var content = state.inline
  state.inline = []
  state.pending = false
  state.filled = false

  var reopened = []
  for (var i = 0; i < state.chain.length; i++) {
    var fresh = readerElement(state.chain[i].name)
    // Shared rather than copied: nothing mutates a reader element's attributes
    // once it is built, and a link wrapped around forty boxes is forty of these.
    fresh.attrs = state.chain[i].attrs
    if (reopened.length > 0) reopened[reopened.length - 1].children.push(fresh)
    else state.inline.push(fresh)
    reopened.push(fresh)
  }
  state.chain = reopened

  if (!readerMeaningful(content)) return
  var block = readerElement(name || "p")
  block.children = readerTrimmed(content)
  state.blocks.push(block)
}

// ------------------------------------------------------------ what is hidden
//
// display:none is one spelling of the email preheader and not the common one.
// A preheader has to reach the inbox preview line and not the message, so it is
// text set at one pixel, or clamped to no height, or at zero opacity — and Qt
// honours none of those, which is how it used to arrive as a smudge of
// unreadable characters above the message.
var READER_INVISIBLE_TYPE = /^\s*[0-2](\.\d+)?\s*(px|pt)?\s*$/i
var READER_ZERO_LENGTH = /^\s*0(\.0+)?\s*(px|pt|em|rem|%)?\s*$/i

function readerHiddenBy(declarations, leaf) {
  if (isHiddenBy(declarations)) return true
  var clipped = false
  var hidden = false
  for (var i = 0; i < declarations.length; i++) {
    var declaration = declarations[i]
    var name = declaration.name
    // Only where the text is. A container full of boxes writes "font-size:0" to
    // take out the space between them and every box inside sets a size of its
    // own — a whole message arrived empty because every cell of it said this.
    if (leaf && name === "font-size" && READER_INVISIBLE_TYPE.test(declaration.value)) return true
    if (name === "opacity" && /^\s*0(\.0+)?\s*$/.test(declaration.value)) return true
    // A box of no height hides nothing unless what overflows it is clipped, and
    // the preheader idiom always says both.
    if (name === "max-height" && READER_ZERO_LENGTH.test(declaration.value)) hidden = true
    if (name === "overflow" && /^\s*hidden\b/i.test(declaration.value)) clipped = true
  }
  return hidden && clipped
}

// "mso-hide:all" is deliberately not one of them. It hides from Outlook, which
// is the sender saying this is the version for everybody else — the Outlook one
// is in a conditional comment the parser drops. Reading it as "hidden" took the
// call to action out of a message and left nothing in its place.
function readerHidden(node) {
  if (attributeOf(node, "hidden") !== null) return true
  var style = attributeValue(node, "style")
  if (style === "") return false
  var leaf = true
  for (var i = 0; i < node.children.length; i++) {
    if (node.children[i].type !== "text") { leaf = false; break }
  }
  return readerHiddenBy(splitDeclarations(style), leaf)
}

// ------------------------------------------------------------- what it points at
//
// Stricter than the sanitiser's gate, and deliberately so. A reader document is
// built from an allow list rather than filtered, so the only addresses in it
// are mailto: and http(s) at a host on the public internet — a message must not
// be able to put a link to the machine this runs on, or to the network behind
// the user's front door, under the pointer. The formatted view keeps its own
// rule; this one is the reader's.
function readerHref(node) {
  var raw = attributeValue(node, "href")
  if (!safeHref(raw)) return ""
  var url = normalizedUrl(raw)
  if (!safeHref(url)) return ""
  if (/^\s*mailto:/i.test(url)) return raw
  return isPublicUrl(raw) ? raw : ""
}

// The picture's own words, which is what a blocked image leaves behind and what
// turns a styled button into a labelled link. Decoded and re-escaped rather
// than passed through: an attribute value is not markup, and alt="a<b" would
// otherwise serialise into a tag.
function readerAltText(node) {
  var attr = attributeOf(node, "alt")
  if (!attr || attr.value === null || attr.value === undefined) return ""
  return escapeText(decodeReferences(String(attr.value)))
    .replace(SOURCE_WHITESPACE, " ").replace(/^ +| +$/g, "")
}

// A sender's numeric size prevents Qt from expanding a source bitmap to its
// natural pixel width. The larger ceiling covers a bounded standalone logo or
// illustration; the smaller one below decides whether a picture may take part
// in an inline avatar or icon layout.
var MAX_READER_INLINE_IMAGE = 96
var MAX_READER_IMAGE_DIMENSION = 640

function readerImageDimension(node, name) {
  var raw = attributeValue(node, name)
  var value = /^\s*\d+(?:\.\d+)?\s*$/.test(raw) ? Number(raw) : 0
  if (!(value > 0)) {
    var declarations = splitDeclarations(attributeValue(node, "style"))
    for (var i = 0; i < declarations.length; i++) {
      if (declarations[i].name !== name) continue
      var match = String(declarations[i].value).match(/^\s*(\d+(?:\.\d+)?)px\s*$/i)
      if (match) value = Number(match[1])
    }
  }
  if (!isFinite(value) || value <= 2 || value > MAX_READER_IMAGE_DIMENSION) return 0
  return Math.max(3, Math.round(value))
}

function readerAppendImage(state, node, ctx) {
  // A beacon is not a picture, and a reader that left a placeholder where one
  // had been would be announcing the tracker rather than removing it.
  if (isTrackingPixel(node)) return
  var attr = attributeOf(node, "src")
  var source = attr && attr.value !== null && attr.value !== undefined ? String(attr.value) : ""
  var kind = attr === null ? "none" : imageSourceKind(source)

  var renderedSource = source
  if (kind === "remote" && ctx.imageData !== null) {
    renderedSource = Object.prototype.hasOwnProperty.call(ctx.imageData, source)
      ? String(ctx.imageData[source] || "") : ""
    if (!/^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i.test(renderedSource))
      renderedSource = ""
  }

  if (kind === "inline" || (kind === "remote" && ctx.allowImages
    && ctx.kept < ctx.limit && renderedSource !== "")) {
    if (kind === "remote") ctx.kept++
    readerSpace(state)
    var image = readerElement("img")
    image.attrs = [{ name: "src", value: renderedSource }]
    var width = readerImageDimension(node, "width")
    var height = readerImageDimension(node, "height")
    if (width > 0) image.attrs.push({ name: "width", value: String(width) })
    // A large picture can be narrowed again by the reading column's max-width.
    // Qt clamps that width without scaling an explicit height, which distorts
    // the picture. Small icons never meet that clamp and need both dimensions
    // to keep native high-resolution artwork at interface size.
    if (height > 0 && width > 0 && width <= MAX_READER_INLINE_IMAGE
      && height <= MAX_READER_INLINE_IMAGE)
      image.attrs.push({ name: "height", value: String(height) })
    readerTarget(state).push(image)
    state.filled = true
    state.pending = false
    return
  }
  if (kind === "remote") ctx.blocked++

  var alt = readerAltText(node)
  if (alt !== "") {
    readerAppendText(state, alt)
    return
  }
  // An alt the sender wrote and left empty is the sender saying this one is
  // decoration. One they never wrote at all is a picture with something in it,
  // and a reader that drew nothing there would leave unexplained blank space.
  if (kind === "remote" && attr !== null && attributeOf(node, "alt") === null)
    readerAppendText(state, "[image]")
}

// ------------------------------------------------------------------ headings
//
// Native h1-h6 are kept as themselves. The rest of the headings in mail are not
// elements at all — they are a cell with a font-size on it — so one is inferred
// from that size, and only from that size.
//
// Never from weight: half the lines in a newsletter are bold and none of them
// are headings. Never from a long line either: a paragraph the sender set large
// is still a paragraph, and promoting it puts a page of body copy in heading
// type. What survives both tests is a short line the sender made big, which is
// what a heading is.
// Which heading a declared type size stands for, or "" for a size that stands
// for nothing. Body copy in mail is fourteen to sixteen pixels, so twenty is
// already a sender reaching for a heading and twenty-eight is them reaching for
// the top one. Two levels is all that can honestly be read out of a number:
// there is no sixth heading hidden in a font-size.
function readerHeadingLevel(value) {
  var text = String(value).replace(/^\s+|\s+$/g, "").toLowerCase()
  var number = parseFloat(text)
  if (!isFinite(number)) return ""
  // In pixels, because that is the unit the thresholds are stated in and the
  // sender may have written any of the four. A percentage and an em are both
  // against a sixteen-pixel default: mail declares no root size of its own.
  var pixels = /px$/.test(text) ? number
    : (/pt$/.test(text) ? number * 4 / 3
      : (/r?em$/.test(text) ? number * 16
        : (/%$/.test(text) ? number * 0.16 : 0)))
  if (pixels === 0) return ""
  if (pixels >= 28) return "h2"
  return pixels >= 20 ? "h3" : ""
}

// The heading this element stands for, or "" if it is not one. The last
// declaration wins, the way it would in a browser.
function readerHeadingOf(node) {
  var style = attributeValue(node, "style")
  if (style === "") return ""
  if (style.toLowerCase().indexOf("font-size") < 0) return ""
  var declarations = splitDeclarations(style)
  var level = ""
  for (var i = 0; i < declarations.length; i++) {
    if (declarations[i].name !== "font-size") continue
    level = readerHeadingLevel(declarations[i].value)
  }
  return level
}

// `single` is set where the heading was inferred rather than written. A native
// <h1> holding two paragraphs is still the sender saying heading, so those are
// joined into one; a box holding two paragraphs is a card whatever type the
// sender set on it, and inferring a heading from that would swallow the card.
function readerHeading(node, state, ctx, tag, single) {
  readerFlush(state, "p")
  var blocks = readerBuild(node, ctx)
  var content = single === true && blocks.length > 1 ? null : []
  for (var i = 0; i < blocks.length && content !== null; i++) {
    if (blocks[i].name !== "p") {
      content = null
      break
    }
    if (content.length > 0) content.push(readerText(" "))
    for (var j = 0; j < blocks[i].children.length; j++) content.push(blocks[i].children[j])
  }
  // A sender who wrapped a whole card in an <h1>, or set a font size on the box
  // around one, did not write a heading. What is inside it is what the message
  // says, so it comes through as itself.
  if (content === null || content.length === 0
    || readerLength(content) > MAX_HEADING_CHARS) {
    for (var k = 0; k < blocks.length; k++) state.blocks.push(blocks[k])
    return
  }
  var heading = readerElement(tag)
  heading.children = content
  state.blocks.push(heading)
}

// ------------------------------------------------------------------- tables
//
// The same question the formatted view asks, for the same reason: a table in
// mail is either the sender's content or the sender's layout, and almost all of
// them are the layout. `isGrid` is that question — two rows that each hold more
// than one cell — and it is asked here rather than answered again.
//
// A grid becomes a table with no attributes on it. Everything else becomes the
// blocks its cells always were, in the order they were written, which is what
// keeps a receipt's labels and figures on separate lines instead of running
// them together.
// A column that is the same separator all the way down is not data, it is what
// the sender put between the things that are. A footer of links with a "|" in
// the cell beside each one is one column of links and one column of furniture,
// and once the furniture is gone a single column is not a grid at all — which
// is what turns "Online kaufen |" back into "Online kaufen".
var READER_SEPARATOR = /^[\s\u00a0]*[|\u00b7\u2022\u2013\u2014\/-]?[\s\u00a0]*$/

function readerFurniture(node) {
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") continue
    // A picture is content whatever it weighs in characters.
    if (child.name === "img") return false
    if (!readerFurniture(child)) return false
  }
  return READER_SEPARATOR.test(readerTextOf(node))
}

function readerTextOf(node) {
  var text = ""
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    text += child.type === "text" ? child.text : readerTextOf(child)
  }
  return text
}

function readerDataTable(node, ctx) {
  var rows = rowsOf(node, [])
  if (rows.length === 0 || rows.length > MAX_READER_TABLE_ROWS) return null

  // The whole shape is settled before a single cell is built, so refusing the
  // table costs no walk that the blocks it becomes instead would have to repeat.
  var grid = []
  for (var i = 0; i < rows.length; i++) {
    var cells = []
    for (var j = 0; j < rows[i].children.length; j++) {
      var cell = rows[i].children[j]
      if (cell.type === "text") continue
      if (cell.name === "td" || cell.name === "th") cells.push(cell)
    }
    if (cells.length > MAX_READER_TABLE_COLUMNS) return null
    if (cells.length > 0) grid.push(cells)
  }
  if (grid.length === 0) return null

  var columns = 0
  for (var g = 0; g < grid.length; g++) {
    if (grid[g].length > columns) columns = grid[g].length
  }
  for (var column = columns - 1; column >= 0; column--) {
    var furniture = true
    for (var r = 0; r < grid.length && furniture; r++) {
      if (column >= grid[r].length || !readerFurniture(grid[r][column])) furniture = false
    }
    if (!furniture) continue
    for (var w = 0; w < grid.length; w++) grid[w].splice(column, 1)
  }
  var widest = 0
  for (var h = 0; h < grid.length; h++) {
    if (grid[h].length > widest) widest = grid[h].length
  }
  // What is left of a grid once the furniture is out may not be one.
  if (widest < 2) return null

  var table = readerElement("table")
  // Nested grids inside a kept one are the scaffolding again. One level of
  // table is all the reader draws.
  ctx.tables = false
  for (var row = 0; row < grid.length; row++) {
    var line = readerElement("tr")
    for (var k = 0; k < grid[row].length; k++) {
      var out = readerElement(grid[row][k].name === "th" ? "th" : "td")
      out.children = readerInlineOrBlocks(readerBuild(grid[row][k], ctx))
      line.children.push(out)
    }
    table.children.push(line)
  }
  ctx.tables = true
  return table
}

// A row of a layout table is a line, not a stack.
//
// Every cell made into a block of its own is exactly what turns an avatar, a
// name and "moved 4 cards" into three paragraphs — the loose vertical stream a
// reading mode exists to stop producing. So a row whose cells each hold one
// short run of inline content becomes one line, and a row holding anything
// larger or more structured than that keeps the blocks, because at that size
// the cells really were the sender stacking things up.
//
// Both answers come out of one walk over the cells, and that is not a tidiness
// point. Building the cells to find out and then walking them again to lay them
// out doubles the work at every level of nesting, and a card in real mail is
// nine layout tables deep: measured, that was five hundred times the work and
// two and a half seconds on a large newsletter.
var MAX_ROW_CHARS = 160

// A cell that breaks its own line is already two lines, and joining it to the
// cell beside it puts the bottom half of one against the top half of the next:
// three cells reading "label / value" came out as "Kundennummer", then
// "1210617221 Rechnung Nr.", then "M26056185488 Rechnungsdatum".
function readerBroken(children) {
  for (var i = 0; i < children.length; i++) {
    var child = children[i]
    if (child.type === "text") continue
    if (child.name === "br") return true
    if (readerBroken(child.children)) return true
  }
  return false
}

function readerRow(node, state, ctx) {
  // Everything that can refuse a row is asked before anything is built.
  var cells = []
  for (var i = 0; i < node.children.length; i++) {
    var cell = node.children[i]
    if (cell.type === "text") continue
    if (cell.name !== "td" && cell.name !== "th") return false
    // A cell the sender set heading type on is a heading, and joining the row
    // would walk past the one piece of evidence there is for that.
    if (readerHeadingOf(cell) !== "") return false
    // The "|" between two links is the sender drawing a line, not something
    // anybody reads out. In a row of its own it is all that is left of one.
    if (readerFurniture(cell)) continue
    cells.push(cell)
  }

  var built = []
  for (var j = 0; j < cells.length; j++) built.push(readerBuild(cells[j], ctx))

  var line = []
  for (var k = 0; k < built.length && line !== null; k++) {
    var blocks = built[k]
    if (blocks.length === 0) continue
    if (blocks.length > 1 || blocks[0].name !== "p" || readerBroken(blocks[0].children)) {
      line = null
      break
    }
    if (line.length > 0) line.push(readerText(" "))
    for (var m = 0; m < blocks[0].children.length; m++) line.push(blocks[0].children[m])
  }

  readerFlush(state, "p")
  if (line !== null && readerLength(line) <= MAX_ROW_CHARS) {
    if (line.length > 0) {
      var joined = readerElement("p")
      joined.children = readerTrimmed(line)
      state.blocks.push(joined)
    }
    return true
  }
  for (var n = 0; n < built.length; n++) {
    for (var b = 0; b < built[n].length; b++) state.blocks.push(built[n][b])
  }
  return true
}

// A cell or a list item holding one paragraph holds inline content, not a
// paragraph: the paragraph's own spacing below it would be a gap inside a row.
function readerInlineOrBlocks(blocks) {
  if (blocks.length === 1 && blocks[0].name === "p") return blocks[0].children
  return blocks
}

function readerListItems(node, list, ctx) {
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") continue
    if (READER_DROPPED[child.name] === true) continue
    if (child.name !== "li") {
      readerListItems(child, list, ctx)
      continue
    }
    var item = readerElement("li")
    item.children = readerInlineOrBlocks(readerBuild(child, ctx))
    if (item.children.length === 0) continue
    list.children.push(item)
  }
}

// ------------------------------------------------------------------ the walk

function readerNode(child, state, ctx) {
  if (child.type === "text") {
    // Raw text is a stylesheet or a script, whose element is dropped anyway.
    if (!child.raw) readerAppendText(state, child.text)
    return
  }
  var name = child.name
  if (READER_DROPPED[name] === true) return
  if (readerHidden(child)) return

  if (name === "br") {
    readerAppendBreak(state)
    return
  }
  if (name === "img") {
    readerAppendImage(state, child, ctx)
    return
  }
  if (name === "hr") {
    readerFlush(state, "p")
    state.blocks.push(readerElement("hr"))
    return
  }

  if (name === "a") {
    var href = readerHref(child)
    // A link the reader will not follow is still a label the reader draws.
    if (href === "") {
      readerWalk(child, state, ctx)
      return
    }
    var link = readerElement("a")
    link.attrs = [{ name: "href", value: href }]
    var linked = readerOpen(state, link)
    readerWalk(child, state, ctx)
    if (linked) state.chain.pop()
    return
  }

  var inline = READER_INLINE[name]
  if (inline !== undefined) {
    var opened = readerOpen(state, readerElement(inline))
    readerWalk(child, state, ctx)
    if (opened) state.chain.pop()
    return
  }

  if (READER_HEADINGS[name] === true) {
    readerHeading(child, state, ctx, name)
    return
  }

  if (name === "pre") {
    readerFlush(state, "p")
    var preformatted = readerPreText(child, "").replace(/^\n+/, "").replace(/\s+$/, "")
    if (preformatted !== "") {
      var block = readerElement("pre")
      block.children = [readerText(preformatted)]
      state.blocks.push(block)
    }
    return
  }

  if (name === "ul" || name === "ol") {
    readerFlush(state, "p")
    var list = readerElement(name)
    readerListItems(child, list, ctx)
    if (list.children.length > 0) {
      state.blocks.push(list)
      return
    }
    // A list with no items is a box somebody spelled <ul>.
    readerWalk(child, state, ctx)
    readerFlush(state, "p")
    return
  }

  if (name === "blockquote") {
    readerFlush(state, "p")
    var quoted = readerBuild(child, ctx)
    if (quoted.length === 0) return
    var quote = readerElement("blockquote")
    quote.children = quoted
    state.blocks.push(quote)
    return
  }

  if (name === "table") {
    readerFlush(state, "p")
    if (ctx.tables) {
      var grid = isGrid(child) ? readerDataTable(child, ctx) : null
      if (grid !== null) {
        state.blocks.push(grid)
        return
      }
    }
    readerWalk(child, state, ctx)
    readerFlush(state, "p")
    return
  }

  // Only with nothing open around it, for the same reason the heading below
  // says so: joining a row recurses into a document of its own, and a link
  // opened outside it would not survive that.
  if (name === "tr" && state.chain.length === 0 && readerRow(child, state, ctx)) return

  if (TABLE_PARTS[name] === true || READER_BLOCK[name] === true) {
    // Only with nothing open around it. Inferring a heading recurses into a
    // document of its own, which a link opened outside would not survive — and
    // a link around a big-typed cell is the shape of every call to action in
    // mail.
    var inferred = state.chain.length === 0 ? readerHeadingOf(child) : ""
    if (inferred !== "") {
      readerHeading(child, state, ctx, inferred, true)
      return
    }
    readerFlush(state, "p")
    readerWalk(child, state, ctx)
    readerFlush(state, "p")
    return
  }

  // Anything unrecognised is a wrapper, and what it wraps is the message.
  readerWalk(child, state, ctx)
}

function readerWalk(node, state, ctx) {
  for (var i = 0; i < node.children.length; i++) readerNode(node.children[i], state, ctx)
}

// Preformatted text is the one place a run of spaces is content rather than the
// template's indentation.
function readerPreText(node, out) {
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i]
    if (child.type === "text") {
      if (!child.raw) out += child.text
      continue
    }
    if (READER_DROPPED[child.name] === true) continue
    if (child.name === "br") {
      out += "\n"
      continue
    }
    out = readerPreText(child, out)
  }
  return out
}

function readerBuild(node, ctx) {
  var state = readerState()
  readerWalk(node, state, ctx)
  readerFlush(state, "p")
  return state.blocks
}

// A rule with nothing above it separates the message from the top of the panel,
// and two in a row separate nothing from nothing.
function readerTidy(blocks) {
  var out = []
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i]
    if (block.name === "hr") {
      if (out.length === 0) continue
      if (out[out.length - 1].name === "hr") continue
    }
    var avatar = readerAvatarRow(block)
    if (avatar !== null) block = avatar
    // Responsive mail often spells a horizontal social strip as one table row
    // per icon. Once layout tables are flattened those rows are consecutive
    // paragraphs; join only paragraphs made entirely from bounded small images,
    // never ordinary picture-and-text content.
    if (block.name === "p" && readerSmallImageCount(block.children) > 0
      && out.length > 0 && out[out.length - 1].name === "p"
      && readerSmallImageCount(out[out.length - 1].children) > 0) {
      out[out.length - 1].children.push(readerText(" "))
      for (var joined = 0; joined < block.children.length; joined++)
        out[out.length - 1].children.push(block.children[joined])
      continue
    }
    out.push(block)
  }
  while (out.length > 0 && out[out.length - 1].name === "hr") out.pop()
  return out
}

// QTextDocument keeps an image in an ordinary paragraph on the text baseline,
// which leaves a small avatar visibly below the name it identifies. A leading
// bounded image followed by words is the one unambiguous identity-row shape.
// Build that row ourselves so Qt can use the vertical alignment it implements
// for table cells. Pure image strips stay paragraphs and continue to flow
// horizontally; pictures inside prose stay prose.
function readerAvatarRow(block) {
  if (block.name !== "p") return null
  var children = readerTrimmed(block.children)
  if (children.length < 2 || readerSmallImageCount([children[0]]) !== 1) return null
  var words = children.slice(1)
  if (!readerMeaningful(words) || readerContainsImage(words)) return null

  var table = readerElement("table")
  table.attrs = [{ name: "cellspacing", value: "0" }, { name: "cellpadding", value: "0" }]
  var row = readerElement("tr")
  var picture = readerElement("td")
  var text = readerElement("td")
  // These fixed styles override the document's data-table cell rhythm. Without
  // them that padding combines with cellspacing and leaves an avatar a full
  // character cell away from the name it identifies.
  picture.attrs = [{ name: "valign", value: "middle" },
    { name: "style", value: "padding:0px;padding-right:6px" }]
  text.attrs = [{ name: "valign", value: "middle" },
    { name: "style", value: "padding:0px" }]
  picture.children = [children[0]]
  text.children = words
  row.children = [picture, text]
  table.children = [row]
  return table
}

function readerContainsImage(nodes) {
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (node.type === "text") continue
    if (node.name === "img" || readerContainsImage(node.children)) return true
  }
  return false
}

function readerSmallImageCount(nodes) {
  var count = 0
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (node.type === "text") {
      if (decodeReferences(node.text).replace(/[\s\u00a0]+/g, "") !== "") return 0
      continue
    }
    if (node.name === "img") {
      var width = Number(attributeValue(node, "width"))
      var height = Number(attributeValue(node, "height"))
      if (width <= 2 || width > MAX_READER_INLINE_IMAGE
        || (height > 0 && height > MAX_READER_INLINE_IMAGE)) return 0
      count++
      continue
    }
    if (node.name !== "a" || readerSmallImageCount(node.children) === 0) return 0
    count += readerSmallImageCount(node.children)
  }
  return count
}

// The reader's document, built from the sender's parsed tree and never out of
// it. Reads that tree and does not touch it, which is what lets `sanitize` hand
// over the same parse it is about to clean for the formatted view.
function readerTree(root, options) {
  var settings = options || {}
  var ctx = {
    allowImages: settings.allowRemoteImages === true,
    limit: Math.max(0, Math.floor(settings.maxImages === undefined
      ? MAX_IMAGES : settings.maxImages)),
    tables: true,
    kept: 0,
    blocked: 0
  }
  ctx.imageData = settings.remoteImageData && typeof settings.remoteImageData === "object"
    ? settings.remoteImageData : null
  var document = { type: "root", children: readerTidy(readerBuild(root, ctx)) }
  var text = serialize(document)
  var size = { length: text.length, tags: 0, images: 0, tables: 0, tableDepth: 0 }
  size.tableDepth = measure(document, 0, size)
  return {
    document: document,
    html: text,
    images: ctx.kept,
    blockedImages: ctx.blocked,
    complexity: size,
    tooHeavy: isTooHeavy(size),
    // A message whose every word was in a picture has a reader document with
    // nothing in it, and the formatted view is the honest answer for it.
    empty: document.children.length === 0
  }
}

// The reader's document, as a string Qt is given. Every value in the stylesheet
// comes from the theme or from the reader's own font size, so the sender's
// contribution to how this looks is exactly nothing.
function readerDocumentFor(source, colors) {
  var palette = colors || {}
  var foreground = String(palette.foreground || "")
  var background = String(palette.background || "")
  var link = String(palette.link || foreground)
  var quote = String(palette.quote || foreground)
  var base = Math.max(8, Math.floor(Number(palette.fontSize) || 13))
  var maxImage = Math.floor(Number(palette.maxImageWidth) || 0)
  // One rhythm for the whole document, derived from the size it is read at, so
  // the spacing follows the zoom rather than standing still while the type
  // grows past it.
  var gap = Math.max(4, Math.round(base * 0.85))
  var rule = Math.max(2, Math.round(base * 0.5))
  // Reading mode rebuilds the document, so every indent and every column in it
  // is this file's own rather than the sender's — and every one of them is
  // written as a physical side, because that is the only kind Qt reads. A
  // right-to-left message read in a sheet whose lists indent from the left and
  // whose headers align left is the sender's own layout problem reproduced by
  // the view that exists to replace it.
  var direction = String(palette.direction || "")
  var startEdge = Direction.startEdge(direction)
  var endEdge = Direction.endEdge(direction)

  return "<html><head><style type=\"text/css\">"
    + "body{color:" + foreground + ";background-color:" + background + ";}"
    + "a{color:" + link + ";}"
    + "p{margin-top:0px;margin-bottom:" + gap + "px;}"
    + "h1{font-size:" + Math.round(base * 1.6) + "px;margin-top:" + (gap * 2)
      + "px;margin-bottom:" + rule + "px;}"
    + "h2{font-size:" + Math.round(base * 1.35) + "px;margin-top:" + (gap * 2)
      + "px;margin-bottom:" + rule + "px;}"
    + "h3{font-size:" + Math.round(base * 1.18) + "px;margin-top:" + Math.round(gap * 1.6)
      + "px;margin-bottom:" + rule + "px;}"
    + "h4,h5,h6{font-size:" + base + "px;margin-top:" + Math.round(gap * 1.4)
      + "px;margin-bottom:" + rule + "px;}"
    // Disable QTextDocument's own marker indent and provide one fixed
    // two-character column. Leaving both active doubled the indentation.
    + "ul,ol{margin-top:0px;margin-bottom:" + gap
      + "px;margin-" + startEdge + ":26px;-qt-list-indent:0;}"
    + "li{margin-bottom:" + rule + "px;}"
    + "blockquote{color:" + quote + ";margin-" + startEdge + ":" + rule
      + "px;padding-" + startEdge + ":" + gap
      + "px;margin-top:0px;margin-bottom:" + gap + "px;}"
    + "pre{margin-top:0px;margin-bottom:" + gap + "px;}"
    // The gutter goes after the cell's text, so a column keeps its gap from the
    // next one along rather than from the one it has already passed.
    + "td,th{padding-top:" + rule + "px;padding-bottom:" + rule
      + "px;padding-" + endEdge + ":" + gap + "px;}"
    + "th{font-weight:bold;text-align:" + startEdge + ";}"
    + (maxImage >= MIN_IMAGE_WIDTH ? "img{max-width:" + maxImage + "px;}" : "")
    + "</style></head><body" + baseDirectionAttribute(palette) + ">"
    + serialize(documentTree(source))
    + "</body></html>"
}

// ---------------------------------------------------------- which mode is on
//
// Three ways of reading a message and one preference across all of them, so a
// message that cannot be drawn the chosen way falls through to the one that
// can rather than showing an empty panel. The order is reader, then the
// sender's own formatting, then text.
var BODY_MODES = { reader: true, original: true, plain: true }
var HEAVY_MESSAGE_RENDERING_DEFAULT = "Show plain text first"
var HEAVY_MESSAGE_RENDERING_ALWAYS = "Always render"

function alwaysRenderHeavyMessages(value) {
  return value === HEAVY_MESSAGE_RENDERING_ALWAYS
}

function heavyMessageRendering(always) {
  return always === true ? HEAVY_MESSAGE_RENDERING_ALWAYS : HEAVY_MESSAGE_RENDERING_DEFAULT
}

// A stored preference, or anything else, read as one of the three. The fallback
// is what a window written before this existed meant.
function bodyModeOf(value, fallback) {
  var wanted = String(value === undefined || value === null ? "" : value)
  if (BODY_MODES[wanted] === true) return wanted
  var other = String(fallback === undefined || fallback === null ? "" : fallback)
  return BODY_MODES[other] === true ? other : "reader"
}

function resolveBodyMode(wanted, available) {
  var has = available || {}
  var want = BODY_MODES[wanted] === true ? wanted : "reader"
  // No markup at all: the text is not a fallback, it is the message.
  if (has.html !== true) return "plain"
  if (want === "plain") return "plain"
  if (want === "reader" && has.reader !== true) want = "original"
  var heavy = want === "reader" ? has.readerHeavy === true : has.originalHeavy === true
  // Qt lays rich text out on the GUI thread of the shell that draws the whole
  // desktop, so a document past the bounds gets the text instead — until
  // somebody insists.
  if (heavy && has.forced !== true) return "plain"
  return want
}

// Whether the plain text on screen is a refusal rather than a request, which is
// what the notice above the message is explaining.
// A different refusal, and one that used to happen in silence: the message had
// nothing in it to read, so the sender's own layout is what is on screen while
// the picker still says Reader. Without a word, the reader is left with one
// message that looks unlike every other and no way to know why.
function bodyModeEmptied(wanted, available) {
  var has = available || {}
  if (wanted !== "reader" || has.html !== true) return false
  return has.reader !== true && resolveBodyMode(wanted, available) === "original"
}

function bodyModeRefused(wanted, available) {
  var has = available || {}
  if (wanted === "plain" || has.html !== true) return false
  return resolveBodyMode(wanted, available) === "plain"
}

// ------------------------------------------------------------- the measure
//
// A reading column is bounded by how far the eye can travel and still find the
// start of the next line, which is sixty-five to seventy-five characters — the
// same rule a book obeys and the reason a browser's reading mode is a column
// rather than a window. `measured` is that many characters of the reader's own
// font, measured by Qt rather than guessed from the pixel size: a monospace
// face and a proportional one disagree about it by half.
function readingColumnWidth(available, measured) {
  var room = Math.max(80, Math.floor(Number(available) || 0))
  var ideal = Math.floor(Number(measured) || 0)
  // A narrow window has no width to give up, so the column is the window.
  return ideal > 0 ? Math.min(room, ideal) : room
}

// Centred in what is left over. The column is the message; the space either
// side of it belongs to neither the message nor the panel's own inset.
function readingColumnOffset(available, width) {
  var room = Math.max(0, Math.floor(Number(available) || 0))
  var column = Math.max(0, Math.floor(Number(width) || 0))
  return Math.max(0, Math.round((room - column) / 2))
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
    // Plain text has no indent of its own to mirror, so the direction is the
    // whole of what it takes. Qt resolves each line of a `<br>`-joined body
    // separately either way; the base direction is what the lines with nothing
    // strong in them fall back to.
    + "</style></head><body" + baseDirectionAttribute(palette) + ">"
    + body + "</body></html>"
}

// The index a marker link carries, or 0 when the link is something else.
function imageLinkIndex(url) {
  var text = String(url || "")
  if (text.indexOf(IMAGE_LINK_PREFIX) !== 0) return 0
  var index = Number(text.substring(IMAGE_LINK_PREFIX.length))
  return index > 0 ? Math.floor(index) : 0
}
