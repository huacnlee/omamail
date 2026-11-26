.pragma library

// A mailto: URL is a draft, not a page. The desktop hands one over when
// something outside this window asks to write a message, and a link in a
// message body can be the same shape. Everything here decides what goes in
// the compose fields; nothing here sends.
//
// RFC 6068: `mailto:` [ to ] [ "?" hfields ]. Headers in the query are not
// trusted: a subject holding a newline is how a stranger writes a Bcc of
// their own, so those values lose their line breaks before they reach a
// field. The body is allowed them — that is what a body is.

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

function headerSafe(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim()
}

function bodyText(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function appendAddresses(list, value) {
  var parts = String(value || "").split(",")
  var i
  for (i = 0; i < parts.length; i++) {
    var address = parts[i].trim()
    if (address !== "") list.push(address)
  }
}

function emptyDraft() {
  return { to: "", cc: "", bcc: "", subject: "", body: "" }
}

function parse(entry) {
  var text = String(entry || "").trim()
  if (!/^mailto:/i.test(text)) return null
  var rest = text.substring(7)
  var hash = rest.indexOf("#")
  if (hash >= 0) rest = rest.substring(0, hash)
  var mark = rest.indexOf("?")
  var path = headerSafe(percentDecode(mark < 0 ? rest : rest.substring(0, mark)))
  var to = []
  var cc = []
  var bcc = []
  var subject = ""
  var body = ""
  appendAddresses(to, path)
  if (mark >= 0) {
    var pairs = rest.substring(mark + 1).split("&")
    var i
    for (i = 0; i < pairs.length; i++) {
      var equals = pairs[i].indexOf("=")
      if (equals < 0) continue
      var key = pairs[i].substring(0, equals).toLowerCase()
      var raw = percentDecode(pairs[i].substring(equals + 1))
      if (key === "to") appendAddresses(to, headerSafe(raw))
      else if (key === "cc") appendAddresses(cc, headerSafe(raw))
      else if (key === "bcc") appendAddresses(bcc, headerSafe(raw))
      else if (key === "subject") subject = headerSafe(raw)
      else if (key === "body") body = bodyText(raw)
    }
  }
  return {
    to: to.join(", "),
    cc: cc.join(", "),
    bcc: bcc.join(", "),
    subject: subject,
    body: body
  }
}

// What App.open should put in the compose form. A mailto that is not one
// leaves the window alone rather than opening a blank draft over a listing
// the user already had.
function draftFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null
  if (payload.mailto) return parse(payload.mailto)
  if (payload.compose === true) return emptyDraft()
  return null
}
