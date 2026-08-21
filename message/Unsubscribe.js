.pragma library

.import "Html.js" as Html

// Getting off a mailing list, out of the headers the list already sends.
//
// `List-Unsubscribe` has been in every newsletter since RFC 2369, and RFC 8058
// added the one line that makes a single click enough: a sender that also sends
// `List-Unsubscribe-Post` has promised that one POST removes the address, with
// no page to visit and no form to fill in. That is the whole of the fast path,
// and it is the same promise Gmail's own "Unsubscribe" button relies on.
//
// Everything here decides; nothing here fetches. Which URL may be posted to is
// the one question worth being careful about, and it is answered in one place.

// A header long enough to be an attack rather than a list. Real ones are two
// entries.
var MAX_HEADER_LENGTH = 2048
var MAX_ENTRIES = 8

// ------------------------------------------------------------------ header

// Entries are bracketed rather than separated, because a mailto's query string
// legitimately holds the comma the RFC also uses as the separator. Scanning for
// the brackets is what stops "<mailto:a@b?body=one,two>" being read as two.
function entries(value) {
  var text = String(value || "")
  if (text.length > MAX_HEADER_LENGTH) return []
  var found = []
  var open = -1
  for (var i = 0; i < text.length && found.length < MAX_ENTRIES; i++) {
    var character = text.charAt(i)
    if (character === "<") {
      open = i
      continue
    }
    if (character !== ">" || open < 0) continue
    var entry = text.substring(open + 1, i).trim()
    if (entry !== "") found.push(entry)
    open = -1
  }
  return found
}

// ------------------------------------------------------------------ mailto

function percentDecode(value) {
  var text = String(value || "").replace(/\+/g, " ")
  try {
    return decodeURIComponent(text)
  } catch (e) {
    // A stray percent that is not an escape. The raw text is still closer to
    // what the sender meant than nothing is.
    return text
  }
}

// Anything that could start a header of its own is removed rather than escaped.
// This value is going into a message this plugin builds, and a subject holding
// a newline is how a list gets to write its own Bcc.
function headerSafe(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim()
}

function parseMailto(entry) {
  var text = String(entry || "")
  if (!/^mailto:/i.test(text)) return null
  var rest = text.substring(7)
  var mark = rest.indexOf("?")
  var to = headerSafe(percentDecode(mark < 0 ? rest : rest.substring(0, mark)))
  // One recipient. A List-Unsubscribe naming several is unusual, and sending to
  // the first is the one that unambiguously belongs to this list.
  to = to.split(",")[0].trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return null

  var subject = ""
  var body = ""
  if (mark >= 0) {
    var pairs = rest.substring(mark + 1).split("&")
    for (var i = 0; i < pairs.length; i++) {
      var equals = pairs[i].indexOf("=")
      if (equals < 0) continue
      var key = pairs[i].substring(0, equals).toLowerCase()
      var raw = percentDecode(pairs[i].substring(equals + 1))
      if (key === "subject") subject = headerSafe(raw)
      else if (key === "body") body = String(raw)
    }
  }
  // A list that asked for nothing still needs a message with something in it:
  // `send` refuses an empty body, and an empty subject reads as a mistake in
  // the sent folder.
  return {
    to: to,
    subject: subject !== "" ? subject : "Unsubscribe",
    body: body !== "" ? body : "Unsubscribe"
  }
}

// --------------------------------------------------------------------- URL

// The sender chose this address and this plugin is about to send a request to
// it, so the question is not whether it parses but where it points.
// `Html.imageSourceKind` is already the one place that separates a host on the
// public internet from loopback, a private range, a link-local address and a
// single-label name — the same judgement that decides whether a message may
// load a picture, for the same reason.
function isPublicWebUrl(value) {
  var text = String(value || "").trim()
  if (!/^https?:\/\//i.test(text)) return false
  return Html.imageSourceKind(text) === "remote"
}

// A one-click POST is https only. RFC 8058 says so, and the reason is that
// this request carries the fact that this address reads this mail — over
// plain http that is a postcard, sent to a host chosen by the sender.
function isPostableUrl(value) {
  return /^https:\/\//i.test(String(value || "").trim()) && isPublicWebUrl(value)
}

// ------------------------------------------------------------------ result

function empty() {
  return { available: false, oneClick: false, url: "", postUrl: "", mail: null }
}

// What this message offers, out of its own two headers.
//
// `oneClick` is not "there is an https URL". It is the sender having said, in
// `List-Unsubscribe-Post`, that posting to it is enough — without that line a
// POST would be a guess at somebody else's API, and the honest thing is to
// open the page and let the user finish there.
function from(listHeader, postHeader) {
  var result = empty()
  var list = entries(listHeader)
  if (list.length === 0) return result

  for (var i = 0; i < list.length; i++) {
    var entry = list[i]
    if (/^mailto:/i.test(entry)) {
      if (!result.mail) result.mail = parseMailto(entry)
      continue
    }
    if (result.url === "" && isPublicWebUrl(entry)) result.url = entry
  }

  var declared = String(postHeader || "")
  var oneClick = /List-Unsubscribe\s*=\s*One-Click/i.test(declared)
  if (oneClick && isPostableUrl(result.url)) {
    result.oneClick = true
    result.postUrl = result.url
  }

  result.available = result.oneClick || !!result.mail || result.url !== ""
  return result
}

// The Gmail message resource shape, which is what both providers hand back.
function fromMessage(message) {
  var headers = message && message.payload && Array.isArray(message.payload.headers)
    ? message.payload.headers
    : (message && Array.isArray(message.headers) ? message.headers : [])
  return fromHeaders(headers)
}

function fromHeaders(headers) {
  var list = Array.isArray(headers) ? headers : []
  var listHeader = ""
  var postHeader = ""
  for (var i = 0; i < list.length; i++) {
    var name = String(list[i].name || "").toLowerCase()
    if (name === "list-unsubscribe" && listHeader === "") listHeader = String(list[i].value || "")
    else if (name === "list-unsubscribe-post" && postHeader === "") postHeader = String(list[i].value || "")
  }
  return from(listHeader, postHeader)
}

// ------------------------------------------------------------------- plan

// How the button behaves, decided once so no view branches on a header.
//
// The order is how little the user has to do, not how much this plugin would
// enjoy doing it. A declared one-click POST finishes without leaving the
// window; a mailto finishes without leaving it either, on any account that can
// send; a page has to be opened and read, so it goes last and its label says
// so with a trailing "...".
function plan(info, canSend) {
  var found = info || empty()
  if (found.oneClick && found.postUrl !== "") return "post"
  if (found.mail && canSend === true) return "mail"
  if (found.url !== "") return "browser"
  if (found.mail) return "mail"
  return ""
}

// A page is the only one of the three that leaves the window, and the label
// has to say that before it is pressed.
function label(info, canSend) {
  var how = plan(info, canSend)
  if (how === "") return ""
  return how === "browser" ? "Unsubscribe..." : "Unsubscribe"
}

// The sentence beside the button. It says what pressing it does, because
// "unsubscribe" means three different amounts of work here and the user is
// entitled to know which one they are agreeing to.
function explanation(info, canSend) {
  var how = plan(info, canSend)
  if (how === "post") return "This sender accepts a one-click unsubscribe"
  if (how === "mail") return "Unsubscribing sends a message to this list"
  if (how === "browser") return "Unsubscribing opens this sender's page in a browser"
  return ""
}

// The body of an RFC 8058 POST. Fixed by the standard, and the whole of it.
function postBody() {
  return "List-Unsubscribe=One-Click"
}

function postContentType() {
  return "application/x-www-form-urlencoded"
}
