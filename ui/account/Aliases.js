.pragma library

// The send-as addresses a mailbox may write from, as the settings page shows
// them and as the account file stores them.
//
// This is one module rather than a copy in `Accounts.js` and another in
// `ImapProtocol.js` because the two ends have to agree exactly: the setup page
// parses what the user typed, the account file stores what came back, and an
// alias the first accepts and the second drops disappears between a save and
// the next start with nothing said. There is one parser, so there is one
// answer.
//
// It is also neither of those files' subject. An alias is not a string sent to
// a server, and it is not the shape of the account list — it is a small format
// the user types, which is why it has a file.

// ------------------------------------------------------------------ parsing

// Deliberately not the address grammar: this is the gate on what may become an
// envelope sender, so it wants a name, a dot and a plausible TLD rather than
// everything RFC 5321 permits.
var EMAIL_PATTERN = /^[^\s@]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

// Entries are comma- or newline-separated, but a display name may hold a comma
// of its own — `"Lee, Jason" <j@example.com>` is one alias, not two. So the
// split is a scan rather than a `split()`: a separator inside quotes or inside
// angle brackets is part of the value.
//
// Splitting on the comma regardless is what used to happen, and because the
// setup page re-formats the list every time it opens, the halves were written
// back apart — the name lost everything before its comma, permanently, without
// the user having touched the field.
function splitEntries(text) {
  var out = []
  var current = ""
  var quoted = false
  var angled = false
  for (var i = 0; i < text.length; i++) {
    var character = text.charAt(i)
    if (quoted) {
      // A backslash escapes the next character, including the closing quote.
      if (character === "\\" && i + 1 < text.length) {
        current += character + text.charAt(i + 1)
        i++
        continue
      }
      if (character === "\"") quoted = false
      current += character
      continue
    }
    if (character === "\"") {
      quoted = true
      current += character
      continue
    }
    if (character === "<") angled = true
    else if (character === ">") angled = false
    if (!angled && (character === "," || character === "\n" || character === "\r")) {
      out.push(current)
      current = ""
      continue
    }
    current += character
  }
  out.push(current)
  return out
}

// `"Lee, Jason"` is the quoted form; anything else is taken as written. The
// escapes are the two a quoted string can carry.
function unquoted(value) {
  var text = trimmed(value)
  if (text.length < 2 || text.charAt(0) !== "\"" || text.charAt(text.length - 1) !== "\"")
    return text
  return text.substring(1, text.length - 1).replace(/\\([\\"])/g, "$1")
}

// The default marker, in the spellings the settings field offers and the one
// `format` writes back. Only at an end, so a name that says "(default)" in the
// middle of itself is a name.
function withoutDefaultMarker(text) {
  var value = trimmed(text)
  var match = value.match(/^(.*?)\s*(?:\(default\)|\[default\])$/i)
  if (match) return { text: trimmed(match[1]), isDefault: true }
  if (/\*+$/.test(value)) return { text: value.replace(/\*+$/, "").trim(), isDefault: true }
  if (/^\*+/.test(value)) return { text: value.replace(/^\*+/, "").trim(), isDefault: true }
  return { text: value, isDefault: false }
}

function fromText(entry) {
  var marked = withoutDefaultMarker(entry)
  var text = marked.text
  var angle = text.match(/^(.*?)\s*<([^\s@<>]+@[^<>]+)>$/)
  if (angle) {
    return {
      email: trimmed(angle[2]).toLowerCase(),
      displayName: unquoted(angle[1]),
      isDefault: marked.isDefault
    }
  }
  return { email: text.toLowerCase(), displayName: "", isDefault: marked.isDefault }
}

function fromObject(item) {
  return {
    email: trimmed(item.email || item.sendAsEmail).toLowerCase(),
    displayName: trimmed(item.displayName || item.name),
    isDefault: item.isDefault === true || item.default === true || item.defaultFrom === true
  }
}

// One list, whether it arrives as the settings field's text or as the array
// the account file holds. Invalid addresses and repeats are dropped rather
// than reported: this runs on every load, and a mailbox that refused to open
// because one of its aliases has a typo in it would be worse than the alias
// being missing from the menu.
function parse(value) {
  if (!value) return []
  var raw = []
  if (Array.isArray(value)) raw = value
  else if (typeof value === "string") raw = splitEntries(value)
  else return []

  var out = []
  var seen = {}
  var haveDefault = false
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i]
    var parsed = typeof item === "string" ? fromText(item)
      : (item && typeof item === "object" ? fromObject(item) : null)
    if (!parsed) continue
    if (!parsed.email || !EMAIL_PATTERN.test(parsed.email)) continue
    if (seen[parsed.email]) continue
    seen[parsed.email] = true
    // The first marked one wins. Two defaults is not a state the composer can
    // act on, and silently keeping the earlier is what the settings field
    // shows back to the user.
    var isDefault = parsed.isDefault && !haveDefault
    if (isDefault) haveDefault = true
    out.push({
      email: parsed.email,
      displayName: parsed.displayName,
      isPrimary: false,
      isDefault: isDefault
    })
  }
  return out
}

// ---------------------------------------------------------------- formatting

// A name carrying either of the two characters the split reads is quoted, so
// what `format` writes is what `parse` reads back. Everything else is left as
// the user typed it, because a field full of quotation marks nobody asked for
// reads as the client having mangled the value.
function quotedName(name) {
  var text = trimmed(name)
  if (text === "") return ""
  if (!/[",]/.test(text)) return text
  return "\"" + text.replace(/([\\"])/g, "\\$1") + "\""
}

function format(aliases) {
  var list = parse(aliases)
  var entries = []
  for (var i = 0; i < list.length; i++) {
    var item = list[i]
    var text = item.displayName !== ""
      ? quotedName(item.displayName) + " <" + item.email + ">"
      : item.email
    if (item.isDefault) text += " (default)"
    entries.push(text)
  }
  return entries.join(", ")
}

// ------------------------------------------------------------- send-as list

// The identities a mailbox may write from, in the shape the composer reads —
// the same one Gmail's send-as settings arrive in, so nothing above the
// provider boundary has to know which kind of account it is looking at.
//
// The mailbox's own address is always first and is the primary one. It is also
// the default unless an alias claimed that, which is what makes "default" mean
// the address the composer opens on rather than merely a marked row.
//
// Here rather than in `ImapClient.qml` because it is a decision, and a
// decision in QML is one the node tests cannot reach.
function sendAsList(address, aliases) {
  var primary = trimmed(address)
  var list = []
  var seen = {}
  var rows = parse(aliases)
  var claimed = false
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].isDefault) {
      claimed = true
      break
    }
  }
  if (primary !== "") {
    seen[primary.toLowerCase()] = true
    list.push({
      email: primary,
      displayName: "",
      isPrimary: true,
      isDefault: !claimed
    })
  }
  for (var j = 0; j < rows.length; j++) {
    var row = rows[j]
    if (seen[row.email]) continue
    seen[row.email] = true
    list.push({
      email: row.email,
      displayName: row.displayName,
      isPrimary: false,
      isDefault: row.isDefault
    })
  }
  return list
}
