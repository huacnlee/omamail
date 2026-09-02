.pragma library

.import "../account/Aliases.js" as Aliases

// The IMAP protocol, and nothing else. No transport lives here — `ImapClient.qml`
// owns the process that speaks to the server — and no message format lives here
// either: an RFC 822 message is `Message.js`'s subject, and this file hands one
// over as the raw bytes it arrived as.
//
// What this file does own is every string sent to a server and every decision
// about what came back, which is what the node tests can reach without a
// compositor or a mailbox.
//
// ## Why the responses arrive as a byte string
//
// IMAP measures a literal in octets:
//
//     * 1 FETCH (UID 42 BODY[] {2048}
//     <2048 bytes>)
//
// Read as UTF-8 text, 2048 octets of a message with an accent in it is fewer
// than 2048 characters, and the parser walks off the end of the literal into
// the middle of the next response. So the transport base64-encodes the whole
// conversation, and `decodeResponse` turns it back into a string with one
// character per octet. Counting characters is then exactly counting octets,
// binary attachment data survives the pipe, and nothing in the response can
// contain the newline the pipe splits on.

// ------------------------------------------------------------------ servers

var DEFAULT_IMAP_PORT = 993
var DEFAULT_SMTP_PORT = 465

// Known services, so the common case is an address and a password rather than
// four hostnames. The key is the mail domain; `presetFor` also matches the
// aliases, which is what makes hotmail.com find the Outlook entry.
//
// Every one of these is TLS on connect (imaps/smtps) rather than STARTTLS: the
// providers below all offer it, and a client that negotiates upward can be
// stripped back down by whatever is between it and the server.
var PRESETS = [
  {
    id: "gmail",
    name: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    imapHost: "imap.gmail.com", imapPort: 993,
    smtpHost: "smtp.gmail.com", smtpPort: 465,
    // Google turned off password sign-in for IMAP. An app password works only
    // with 2-Step Verification on, and that is the sentence users need to see
    // before they go looking for a setting that is not there.
    note: "Needs an app password, which Google only offers with 2-Step Verification on. "
      + "The Gmail provider signs in with Google directly and does not need one."
  },
  {
    id: "icloud",
    name: "iCloud",
    domains: ["icloud.com", "me.com", "mac.com"],
    imapHost: "imap.mail.me.com", imapPort: 993,
    smtpHost: "smtp.mail.me.com", smtpPort: 587,
    note: "Needs an app-specific password from appleid.apple.com."
  },
  {
    id: "fastmail",
    name: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm", "messagingengine.com"],
    imapHost: "imap.fastmail.com", imapPort: 993,
    smtpHost: "smtp.fastmail.com", smtpPort: 465,
    note: "Needs an app password from Settings → Privacy & Security."
  },
  {
    id: "outlook",
    name: "Outlook",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    imapHost: "outlook.office365.com", imapPort: 993,
    smtpHost: "smtp-mail.outlook.com", smtpPort: 587,
    note: "Microsoft has withdrawn password sign-in for personal accounts; "
      + "a work or school account may still allow it."
  },
  {
    id: "yahoo",
    name: "Yahoo",
    domains: ["yahoo.com", "ymail.com", "rocketmail.com"],
    imapHost: "imap.mail.yahoo.com", imapPort: 993,
    smtpHost: "smtp.mail.yahoo.com", smtpPort: 465,
    note: "Needs an app password from Account Security."
  },
  {
    id: "zoho",
    name: "Zoho",
    domains: ["zoho.com", "zohomail.com"],
    imapHost: "imap.zoho.com", imapPort: 993,
    smtpHost: "smtp.zoho.com", smtpPort: 465
  },
  {
    id: "gmx",
    name: "GMX",
    domains: ["gmx.com", "gmx.net", "gmx.de"],
    imapHost: "imap.gmx.com", imapPort: 993,
    smtpHost: "mail.gmx.com", smtpPort: 465
  },
  {
    id: "proton",
    name: "Proton Mail",
    domains: ["proton.me", "protonmail.com", "pm.me"],
    // Proton speaks IMAP only through the Bridge, which listens on loopback
    // in clear text because it is a process on this machine.
    imapHost: "127.0.0.1", imapPort: 1143,
    smtpHost: "127.0.0.1", smtpPort: 1025,
    insecure: true,
    note: "Only reachable through Proton Mail Bridge, which must be running."
  }
]

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function domainOf(address) {
  var at = trimmed(address).lastIndexOf("@")
  return at < 0 ? "" : trimmed(address).substring(at + 1).toLowerCase()
}

function presetFor(address) {
  var domain = domainOf(address)
  if (!domain) return null
  for (var i = 0; i < PRESETS.length; i++) {
    for (var j = 0; j < PRESETS[i].domains.length; j++) {
      if (PRESETS[i].domains[j] === domain) return PRESETS[i]
    }
  }
  return null
}

// What to put in the form before the user types anything. A domain nobody has
// heard of still gets a guess, because `imap.<domain>` is right far more often
// than an empty field is useful — and a wrong guess is visible and editable,
// which a blank one is not.
function suggestedSettings(address) {
  var preset = presetFor(address)
  var domain = domainOf(address)
  if (preset) {
    return {
      imapHost: preset.imapHost,
      imapPort: preset.imapPort,
      smtpHost: preset.smtpHost,
      smtpPort: preset.smtpPort,
      username: trimmed(address),
      insecure: preset.insecure === true,
      preset: preset.id,
      note: String(preset.note || "")
    }
  }
  return {
    imapHost: domain ? "imap." + domain : "",
    imapPort: DEFAULT_IMAP_PORT,
    smtpHost: domain ? "smtp." + domain : "",
    smtpPort: DEFAULT_SMTP_PORT,
    username: trimmed(address),
    insecure: false,
    preset: "",
    note: ""
  }
}

// A hostname, not a URL and not a host:port pair. Everything here ends up in a
// URL handed to the transport, so a value carrying a slash, a space or an "@"
// could point the authenticated client somewhere else entirely.
function isValidHost(value) {
  var host = trimmed(value)
  if (host === "" || host.length > 253) return false
  if (/[\s/\\@:?#"'<>]/.test(host)) return false
  // An IP literal is legitimate — Proton Bridge is one.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host)
}

function normalizedPort(value, fallback) {
  var port = Math.floor(Number(value))
  var backup = Math.floor(Number(fallback)) || DEFAULT_IMAP_PORT
  if (!isFinite(port) || port < 1 || port > 65535) return backup
  return port
}

// A host name is case-insensitive, and lowercasing it here is what keeps every
// later reading of it the same one. `isLoopback` already compares lowercased,
// so a user who typed "LocalHost" was judged local up here and then failed to
// match the transport's own loopback patterns further down — which meant the
// local bridge, the one server that legitimately speaks plaintext, was the one
// refused for not offering TLS.
function normalizeSettings(raw) {
  var values = raw || {}
  return {
    imapHost: trimmed(values.imapHost).toLowerCase(),
    imapPort: normalizedPort(values.imapPort, DEFAULT_IMAP_PORT),
    smtpHost: trimmed(values.smtpHost).toLowerCase(),
    smtpPort: normalizedPort(values.smtpPort, DEFAULT_SMTP_PORT),
    username: trimmed(values.username),
    aliases: Aliases.parse(values.aliases),
    // Loopback only. A plaintext session to anywhere else is a password on the
    // wire, and the one legitimate case — a local bridge — never leaves the
    // machine.
    insecure: values.insecure === true && isLoopback(values.imapHost)
  }
}

function isLoopback(host) {
  var name = trimmed(host).toLowerCase()
  return name === "127.0.0.1" || name === "::1" || name === "localhost"
}

// Turn the setup form's visible fields into the same validated shape every
// client call consumes. The server, not the mailbox's email domain, decides
// whether this is a local bridge: Proton can serve addresses on custom domains
// that never select its address preset.
function setupSettings(raw) {
  var values = raw || {}
  return normalizeSettings({
    imapHost: values.imapHost,
    imapPort: values.imapPort,
    smtpHost: values.smtpHost,
    smtpPort: values.smtpPort,
    username: trimmed(values.username) || trimmed(values.address),
    aliases: values.aliases,
    insecure: isLoopback(values.imapHost)
  })
}

// Reported one at a time and in the order the form reads, so the message names
// the first field the user has to go back to rather than all of them at once.
function validateSettings(raw) {
  var settings = normalizeSettings(raw)
  if (settings.username === "") return { ok: false, error: "Add the username for this mailbox" }
  if (settings.imapHost === "") return { ok: false, error: "Add the IMAP server address" }
  if (!isValidHost(settings.imapHost)) return { ok: false, error: "That is not a valid IMAP server address" }
  if (settings.smtpHost !== "" && !isValidHost(settings.smtpHost))
    return { ok: false, error: "That is not a valid SMTP server address" }
  return { ok: true, error: "", settings: settings }
}

// The URL the transport connects with. Built here rather than in the shell
// script so the host has been through `isValidHost` on the way, and so the
// tests can see what a given account would dial.
// Which ports mean "connect in the clear, then upgrade". Naming the STARTTLS
// ports rather than the TLS ones is the whole of the difference between this
// and asking whether the port is 993: a server on 9993, or on whatever a
// hosting panel picked, speaks TLS from the first byte and has no STARTTLS to
// offer, so a client that inferred STARTTLS from "not 993" would simply stop
// connecting to it. These three are the ports the RFCs assign to the upgrade,
// and a server on any other one is dialled the way it was before this list
// existed.
//
// The upgrade is not optional once it is chosen: `mail-transport.sh` adds
// `ssl-reqd` to every non-loopback plaintext scheme, so a server that turns
// out not to offer STARTTLS is refused rather than spoken to in the clear.
var STARTTLS_IMAP_PORTS = [143]
var STARTTLS_SMTP_PORTS = [25, 587]

function usesStartTls(port, ports) {
  var value = Number(port)
  for (var i = 0; i < ports.length; i++) {
    if (ports[i] === value) return true
  }
  return false
}

function imapUrl(settings, folder) {
  var values = normalizeSettings(settings)
  if (!isValidHost(values.imapHost)) return ""
  var plain = values.insecure || usesStartTls(values.imapPort, STARTTLS_IMAP_PORTS)
  var scheme = plain ? "imap" : "imaps"
  var url = scheme + "://" + values.imapHost + ":" + values.imapPort
  var box = trimmed(folder)
  // The mailbox is a path segment, so anything that could end the segment or
  // start a query has to be percent-encoded. Gmail's "[Gmail]/All Mail" is the
  // everyday case with characters in it.
  if (box !== "") url += "/" + encodeURIComponent(box)
  return url
}

function smtpUrl(settings) {
  var values = normalizeSettings(settings)
  if (!isValidHost(values.smtpHost)) return ""
  // IMAP and SMTP may name different hosts. The shared local-transport flag
  // cannot let a loopback IMAP server downgrade a remote SMTP connection.
  var local = values.insecure && isLoopback(values.smtpHost)
  var plain = local || usesStartTls(values.smtpPort, STARTTLS_SMTP_PORTS)
  var scheme = plain ? "smtp" : "smtps"
  return scheme + "://" + values.smtpHost + ":" + values.smtpPort
}

// ------------------------------------------------------------- the query DSL
//
// `Provider.js` hands down strings like "folder:INBOX UNSEEN". They are opaque
// everywhere else — a cache key and nothing more — and this is the only reader.
//
// A folder may contain spaces ("[Gmail]/All Mail", "Sent Items"), so it is
// quoted when it does: folder:"Sent Items" UNSEEN.

function parseQuery(query) {
  var text = trimmed(query)
  var folder = "INBOX"
  var criteria = ""

  var match = text.match(/^folder:(?:"((?:[^"\\]|\\.)*)"|(\S*))\s*([\s\S]*)$/)
  if (match) {
    folder = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]
    criteria = trimmed(match[3])
  } else if (text !== "") {
    // Not addressed to a folder at all. Treating it as criteria against the
    // inbox is what a bare search term means, and is what the search box
    // produces before `Provider.searchQuery` has shaped it.
    criteria = text
  }

  return { folder: folder === "" ? "INBOX" : folder, criteria: criteria }
}

// A folder name from a query may be a SPECIAL-USE placeholder — "\Sent" rather
// than whatever this server calls its sent mail. `resolveFolder` swaps in the
// real name once a LIST has told us one.
function isSpecialUse(name) {
  return trimmed(name).charAt(0) === "\\"
}

// Falls back to the placeholder's bare word ("\Sent" → "Sent"), which is the
// right guess on a server that answered LIST without any SPECIAL-USE flags at
// all — most of them, still.
function resolveFolder(name, folders) {
  var wanted = trimmed(name)
  if (!isSpecialUse(wanted)) return wanted
  var map = folders || {}
  var attribute = wanted.toLowerCase()
  if (map[attribute]) return map[attribute]
  return wanted.substring(1)
}

// ------------------------------------------------------------- message ids
//
// Gmail's message id is unique across the whole mailbox. An IMAP UID is unique
// only within one folder, and is reissued by a server that has had its
// UIDVALIDITY reset — so "42" on its own names nothing, and two folders each
// holding a message 42 would collide in the body cache and in every list.
//
// The id therefore carries both. The UID is always digits, so splitting on the
// first colon is unambiguous however many colons a folder name contains.

function messageId(uid, folder) {
  var number = Math.floor(Number(uid))
  if (!isFinite(number) || number < 1) return ""
  return String(number) + ":" + trimmed(folder)
}

function parseMessageId(id) {
  var match = String(id === undefined || id === null ? "" : id).match(/^(\d+):([\s\S]*)$/)
  if (!match) return { uid: 0, folder: "" }
  return { uid: Math.floor(Number(match[1])), folder: match[2] }
}

// Grouped by folder, because every command this client sends operates on the
// folder the connection has selected: one round trip per folder rather than
// one per message, and a batch spanning two folders is two conversations.
function groupByFolder(ids, maxPerGroup) {
  var list = Array.isArray(ids) ? ids : []
  var order = []
  var groups = {}
  for (var i = 0; i < list.length; i++) {
    var parsed = parseMessageId(list[i])
    if (parsed.uid < 1) continue
    if (!groups[parsed.folder]) {
      groups[parsed.folder] = []
      order.push(parsed.folder)
    }
    groups[parsed.folder].push(parsed.uid)
  }
  var out = []
  var limit = Math.max(0, Math.floor(Number(maxPerGroup)) || 0)
  for (var j = 0; j < order.length; j++) {
    var folder = order[j]
    var uids = groups[folder]
    if (limit < 1) {
      out.push({ folder: folder, uids: uids })
      continue
    }
    for (var at = 0; at < uids.length; at += limit)
      out.push({ folder: folder, uids: uids.slice(at, at + limit) })
  }
  return out
}

// ----------------------------------------------------------------- quoting
//
// Every string that reaches a server goes through one of these. An unquoted
// folder name with a space in it is a syntax error; one with a quote in it is
// a way to end the argument early and append a command of somebody's choosing.

function quote(value) {
  return "\"" + String(value === undefined || value === null ? "" : value)
    // A backslash and a double quote are the only two characters IMAP escapes.
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    // CR and LF end a command. There is no escape for them inside a quoted
    // string — the protocol's answer is a literal — so they are dropped: a
    // folder name or a search term containing one is not a thing worth
    // refusing to search over.
    .replace(/[\r\n]+/g, " ") + "\""
}

// A sequence set: "1,2,3" or "1:10". Built from numbers only, so nothing that
// arrived in a response can extend a command.
function sequenceSet(uids) {
  var list = Array.isArray(uids) ? uids : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var uid = Math.floor(Number(list[i]))
    if (!isFinite(uid) || uid < 1) continue
    out.push(String(uid))
  }
  return out.join(",")
}

// ---------------------------------------------------------------- commands
//
// Each returns the command *without* a tag: the transport is curl, which sends
// one custom command per request and tags it itself.

// What a list row needs, and no more. BODY.PEEK rather than BODY so reading
// the list does not mark everything in it as seen — the single most common way
// a hand-rolled IMAP client ruins a mailbox.
var LIST_HEADERS = "HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REPLY-TO LIST-UNSUBSCRIBE)"

// curl holds one IMAP response line in a 64 KiB buffer. SEARCH answers with
// every matching UID on one line, so an unbounded `UID SEARCH ALL` fails with
// CURLE_TOO_LARGE once a folder has around ten thousand messages. FETCH puts
// each UID on its own response line instead, which makes this the stable
// snapshot every listing starts from.
function uidListCommand() {
  return "UID FETCH 1:* (UID)"
}

// An interactive search does not need every UID before it can begin. This one
// short FETCH learns the immutable upper boundary of the mailbox; an empty
// mailbox answers with no FETCH row at all.
function uidCeilingCommand() {
  return "UID FETCH *:* (UID)"
}

// A SEARCH over a known UID snapshot can be split without using message
// sequence numbers. UIDs do not move when another client expunges a message,
// and a message delivered after the snapshot has a UID above its last one.
//
// 4096 UIDs per response. A UID is at most ten digits, so the matching SEARCH
// line stays below 45 KiB even when every UID in the batch matches. The range
// endpoints may be far apart in a sparse mailbox, but the snapshot proves that
// at most 4096 existing messages lie between them.
var SEARCH_WINDOW = 4096

// One newest-first numeric UID range for an interactive search. A UID range of
// width 4096 can contain at most 4096 messages, so its one-line SEARCH answer
// stays bounded without first downloading the UID of every message. UIDs do
// not move when another client expunges mail, and the ceiling was read before
// the first range, so new delivery cannot enter it either.
function searchWindow(criteria, highestUid) {
  var text = trimmed(criteria)
  var last = Math.floor(Number(highestUid))
  if (text === "" || !isFinite(last) || last < 1)
    return { command: "", nextUid: 0 }
  var first = Math.max(1, last - SEARCH_WINDOW + 1)
  return {
    command: "UID SEARCH UID " + first + ":" + last + " " + text,
    nextUid: first - 1
  }
}

function sortedUids(values) {
  var list = Array.isArray(values) ? values : []
  var found = {}
  var out = []
  for (var i = 0; i < list.length; i++) {
    var uid = Math.floor(Number(list[i]))
    if (!isFinite(uid) || uid < 1 || found[uid]) continue
    found[uid] = true
    out.push(uid)
  }
  out.sort(function(a, b) { return a - b })
  return out
}

function searchCommands(criteria, snapshot, highestUid) {
  var text = trimmed(criteria)
  var uids = sortedUids(snapshot)
  var commands = []
  if (text === "" || uids.length === 0) return commands

  // The first numeric window of an interactive search has already settled.
  // When it did not fill the page, its next lower UID is handed in here so the
  // snapshot fallback neither searches nor reports that newest prefix twice.
  var ceiling = Math.floor(Number(highestUid))
  if (isFinite(ceiling) && ceiling > 0) {
    var below = []
    for (var i = 0; i < uids.length; i++) {
      if (uids[i] <= ceiling) below.push(uids[i])
    }
    uids = below
  }
  if (uids.length === 0) return commands

  // Interactive search can paint a page before every window has answered only
  // if no later answer can put a newer message in front of it. UIDs grow with
  // delivery, so walking the stable snapshot backwards makes every completed
  // window a final prefix of the result rather than a provisional one.
  var last = uids.length - 1
  while (last >= 0) {
    var first = Math.max(0, last - SEARCH_WINDOW + 1)
    commands.push("UID SEARCH UID " + uids[first] + ":" + uids[last] + " " + text)
    last = first - 1
  }
  return commands
}

// The visible page after some or all SEARCH windows have answered. During a
// streamed search `hasUnscanned` keeps pagination alive even if the rows found
// so far happen to end exactly at the page boundary. The estimate is then a
// lower bound — Model already calls provider totals "about" for this reason.
function searchPage(uids, offset, maxResults, hasUnscanned) {
  var ordered = sortedUids(uids)
  ordered.reverse()
  var start = Math.max(0, Math.floor(Number(offset)) || 0)
  var limit = Math.max(1, Math.floor(Number(maxResults)) || 25)
  var page = ordered.slice(start, start + limit)
  var more = hasUnscanned === true || start + limit < ordered.length
  return {
    uids: page,
    nextOffset: more ? String(start + limit) : "",
    estimate: more ? Math.max(ordered.length, start + limit + 1) : ordered.length
  }
}

function summaryFetchCommand(uids) {
  var set = sequenceSet(uids)
  if (set === "") return ""
  return "UID FETCH " + set + " (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[" + LIST_HEADERS + "])"
}

// Takes one UID or a list of them, because opening a message and refilling a
// page of bodies from the cache are the same request at different sizes.
function fullFetchCommand(uids) {
  var set = sequenceSet(Array.isArray(uids) ? uids : [uids])
  if (set === "") return ""
  return "UID FETCH " + set + " (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])"
}

function storeCommand(uids, addFlags, removeFlags) {
  var set = sequenceSet(uids)
  if (set === "") return ""
  var add = Array.isArray(addFlags) ? addFlags : []
  var remove = Array.isArray(removeFlags) ? removeFlags : []
  // One command each way. IMAP has no "add these and remove those" STORE, and
  // the transport runs them in order on the same connection.
  var commands = []
  if (add.length > 0) commands.push("UID STORE " + set + " +FLAGS.SILENT (" + add.join(" ") + ")")
  if (remove.length > 0) commands.push("UID STORE " + set + " -FLAGS.SILENT (" + remove.join(" ") + ")")
  return commands
}

function copyCommand(uids, folder) {
  var set = sequenceSet(uids)
  if (set === "") return ""
  return "UID COPY " + set + " " + quote(folder)
}

// MOVE (RFC 6851) where the server has it, COPY + \Deleted + EXPUNGE where it
// does not. The caller decides which by asking `hasCapability`.
function moveCommand(uids, folder) {
  var set = sequenceSet(uids)
  if (set === "") return ""
  return "UID MOVE " + set + " " + quote(folder)
}

function expungeCommand(uids) {
  var set = sequenceSet(uids)
  // UID EXPUNGE (RFC 4315) removes only what was named. Plain EXPUNGE removes
  // every \Deleted message in the folder, including ones another client marked
  // — which is somebody else's mail disappearing because this one archived.
  return set === "" ? "" : "UID EXPUNGE " + set
}

function draftReplacementCommands(id, draftsFolder) {
  var parsed = parseMessageId(id)
  if (parsed.uid < 1 || parsed.folder !== String(draftsFolder || "")) return []
  return [
    "UID STORE " + parsed.uid + " +FLAGS.SILENT (\\Deleted)",
    expungeCommand([parsed.uid])
  ]
}

function draftReplacementPlan(id, draftsFolder) {
  var commands = draftReplacementCommands(id, draftsFolder)
  return {
    commands: commands,
    warning: commands.length > 0 ? ""
      : "The updated draft was saved, but the old copy could not be identified"
  }
}

function draftSaveResult(replaceError) {
  var detail = trimmed(replaceError)
  return {
    saved: true,
    warning: detail === "" ? ""
      : "The updated draft was saved, but the old copy could not be removed: " + detail
  }
}

function statusCommand(folder) {
  return "STATUS " + quote(folder) + " (MESSAGES UNSEEN)"
}

function listCommand() {
  return "LIST \"\" \"*\""
}

// Asked alongside the folder listing rather than on its own: it costs nothing
// extra on a connection that is already open, and the one answer acted on —
// whether the server has MOVE — decides between one command and three.
function capabilityCommand() {
  return "CAPABILITY"
}

// ------------------------------------------------------- search translation

// The criteria a mailbox query carries are already IMAP's own words (UNSEEN,
// FLAGGED). A typed search arrives as TEXT "..." from `Provider.searchQuery`,
// already JSON-quoted — which is the same escaping IMAP uses for a quoted
// string, with one exception this fixes: JSON escapes a newline as \n, and
// IMAP has no such escape.
function normalizeCriteria(criteria) {
  var text = trimmed(criteria)
  if (text === "") return ""
  return text.replace(/\\n|\\r|\\t/g, " ")
}

// ------------------------------------------------------------- the response
//
// A tokenizer rather than a set of patterns, for the same reason `Html.js` is
// one: where a literal ends is the one thing this cannot be wrong about, and no
// regular expression can count octets.

function decodeResponse(base64Text, base64ToBytes, bytesToLatin1) {
  if (typeof base64ToBytes !== "function" || typeof bytesToLatin1 !== "function") return ""
  return bytesToLatin1(base64ToBytes(String(base64Text || "")))
}

// One IMAP response line, with any literals folded into it. Returns a list of
// lines, each of which is a complete untagged or tagged response — so the
// callers below can look at "* 1 FETCH (...)" as a single string however many
// literals it ran through.
function splitResponse(text) {
  var input = String(text || "")
  var lines = []
  var current = ""
  var index = 0

  while (index < input.length) {
    var newline = input.indexOf("\r\n", index)
    var end = newline < 0 ? input.length : newline
    var line = input.substring(index, end)
    index = newline < 0 ? input.length : newline + 2

    // A line ending in a literal count continues into the next `count` octets,
    // whatever they contain — including CRLFs of their own.
    var literal = line.match(/\{(\d+)\+?\}$/)
    if (literal) {
      var size = Math.floor(Number(literal[1]))
      var payload = input.substr(index, size)
      index += size
      current += line + "\r\n" + payload
      // curl removes the tagged completion and closing syntax around a custom
      // IMAP request. With --next, another untagged FETCH can therefore begin
      // at the exact byte after the literal. The literal size is the boundary;
      // do not fold that next response into this one.
      if (input.substr(index, 2) === "* ") {
        lines.push(current)
        current = ""
      }
      continue
    }

    current += line
    lines.push(current)
    current = ""
  }

  if (current !== "") lines.push(current)
  return lines
}

// `* SEARCH 1 4 9` — and nothing else, because a server may answer with no
// SEARCH line at all when nothing matched.
function parseSearch(text) {
  var lines = splitResponse(text)
  var uids = []
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\*\s+(?:SEARCH|ESEARCH)\b([\s\S]*)$/i)
    if (!match) continue
    var numbers = match[1].match(/\d+/g) || []
    for (var j = 0; j < numbers.length; j++) {
      var uid = Math.floor(Number(numbers[j]))
      if (isFinite(uid) && uid > 0) uids.push(uid)
    }
  }
  return sortedUids(uids)
}

// `UID FETCH 1:* (UID)` returns one FETCH response per message. The UID is the
// only data item it carries; sorting and de-duplicating here makes the snapshot
// independent of the order in which a server chose to report those responses.
function parseUidList(text) {
  var entries = parseFetch(text)
  var uids = []
  for (var i = 0; i < entries.length; i++) uids.push(entries[i].uid)
  return sortedUids(uids)
}

// Reads the value of one FETCH data item out of a response line. The items are
// unordered and a server may send ones nobody asked for, so each is found by
// name rather than by position.
function fetchItem(line, name) {
  var index = line.indexOf(name)
  if (index < 0) return ""
  var rest = line.substring(index + name.length)
  var match = rest.match(/^\s*("(?:[^"\\]|\\.)*"|[^()\s]+)/)
  return match ? match[1] : ""
}

function unquoteImap(value) {
  var text = String(value || "").trim()
  if (text.length >= 2 && text.charAt(0) === "\"" && text.charAt(text.length - 1) === "\"")
    return text.substring(1, text.length - 1).replace(/\\(.)/g, "$1")
  return text
}

// The flag list of one FETCH response: FLAGS (\Seen \Flagged).
function parseFlags(line) {
  var match = String(line || "").match(/FLAGS\s*\(([^)]*)\)/i)
  if (!match) return []
  var flags = match[1].split(/\s+/)
  var out = []
  for (var i = 0; i < flags.length; i++) {
    if (trimmed(flags[i]) !== "") out.push(trimmed(flags[i]))
  }
  return out
}

// The body of a FETCH item that arrived as a literal. Everything this client
// asks for — headers and whole messages — comes back that way, because servers
// send anything with a CRLF in it as a literal.
function parseLiteralBody(line) {
  var match = String(line || "").match(/BODY\[[^\]]*\]\s*(?:<\d+>)?\s*\{(\d+)\+?\}\r\n([\s\S]*)$/)
  if (!match) {
    // A short body may arrive as a quoted string instead.
    var quoted = String(line || "").match(/BODY\[[^\]]*\]\s*("(?:[^"\\]|\\.)*")/)
    return quoted ? unquoteImap(quoted[1]) : ""
  }
  var size = Math.floor(Number(match[1]))
  var payload = match[2]
  // The closing ")" of the FETCH response follows the literal. Cutting to the
  // declared size is what leaves it out — and is why the octet count had to
  // survive the transport intact.
  return payload.substring(0, size)
}

function parseInternalDate(line) {
  var value = unquoteImap(fetchItem(line, "INTERNALDATE"))
  if (value === "") return 0
  // "17-Jul-2026 09:02:11 +0800" is not a format Date parses anywhere, so it
  // is rearranged into one that is.
  var match = value.match(/^(\d{1,2})-(\w{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/)
  if (!match) {
    var loose = new Date(value)
    return isNaN(loose.getTime()) ? 0 : loose.getTime()
  }
  var rebuilt = match[2] + " " + match[1] + ", " + match[3] + " "
    + match[4] + ":" + match[5] + ":" + match[6] + " " + (match[7] || "+0000")
  var parsed = new Date(rebuilt)
  return isNaN(parsed.getTime()) ? 0 : parsed.getTime()
}

// One entry per message in a FETCH response, in the order the server sent
// them. The UID is what everything upstream calls an id: a sequence number
// changes when anything ahead of the message is expunged, so a client that
// keyed on one would act on whichever message had slid into that position.
function parseFetch(text) {
  var lines = splitResponse(text)
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (!/^\*\s+\d+\s+FETCH\s/i.test(line)) continue
    var uid = Math.floor(Number(fetchItem(line, "UID")))
    if (!isFinite(uid) || uid < 1) continue
    out.push({
      uid: uid,
      flags: parseFlags(line),
      internalDate: parseInternalDate(line),
      size: Math.max(0, Math.floor(Number(fetchItem(line, "RFC822.SIZE"))) || 0),
      raw: parseLiteralBody(line)
    })
  }
  return out
}

// `* STATUS "INBOX" (MESSAGES 42 UNSEEN 3)`
function parseStatus(text) {
  var lines = splitResponse(text)
  var result = { messages: 0, unseen: 0 }
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\*\s+STATUS\s+[^(]*\(([^)]*)\)/i)
    if (!match) continue
    var messages = match[1].match(/MESSAGES\s+(\d+)/i)
    var unseen = match[1].match(/UNSEEN\s+(\d+)/i)
    if (messages) result.messages = Math.floor(Number(messages[1])) || 0
    if (unseen) result.unseen = Math.floor(Number(unseen[1])) || 0
  }
  return result
}

// A mailbox name arrives quoted, as an atom, or — when it holds a character the
// server would rather not quote — as a literal, which `splitResponse` has
// already folded into the same string. All three have to end up as the name.
function folderName(value) {
  var text = trimmed(value)
  var literal = text.match(/^\{(\d+)\+?\}\r\n([\s\S]*)$/)
  if (literal) return literal[2].substring(0, Math.floor(Number(literal[1])))
  return unquoteImap(text)
}

// `* LIST (\HasNoChildren \Sent) "/" "Sent Items"`
function parseList(text) {
  var lines = splitResponse(text)
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\*\s+(?:LIST|LSUB|XLIST)\s+\(([^)]*)\)\s+(NIL|"(?:[^"\\]|\\.)*"|\S+)\s+([\s\S]*)$/i)
    if (!match) continue
    var flags = []
    var rawFlags = match[1].split(/\s+/)
    for (var j = 0; j < rawFlags.length; j++) {
      if (trimmed(rawFlags[j]) !== "") flags.push(trimmed(rawFlags[j]))
    }
    var name = folderName(match[3])
    if (name === "") continue
    out.push({
      name: name,
      delimiter: match[2] === "NIL" ? "" : unquoteImap(match[2]),
      flags: flags,
      // \Noselect marks a container that holds folders but no mail — Gmail's
      // "[Gmail]" is one, and selecting it is an error.
      selectable: flags.join(" ").toLowerCase().indexOf("\\noselect") < 0
    })
  }
  return out
}

// The SPECIAL-USE attributes this plugin cares about, mapped to the folder the
// server named. A server that advertises none leaves the map empty and
// `resolveFolder` falls back to the plain word.
var SPECIAL_USE = ["\\sent", "\\drafts", "\\trash", "\\junk", "\\archive", "\\all", "\\flagged"]

// Whether a folder is one of the ones the mailbox row already offers. The
// sidebar lists the rest underneath, so getting this wrong either hides every
// folder the user made or shows Sent and Trash twice.
//
// Judged on SPECIAL-USE and the name, never on the structural flags: every
// server sends \HasNoChildren on almost everything, so treating any flag as
// "system" hides the whole folder tree.
function isSpecialFolder(folder, special) {
  var entry = folder || {}
  var name = trimmed(entry.name)
  if (name.toLowerCase() === "inbox") return true

  var flags = Array.isArray(entry.flags) ? entry.flags : []
  for (var i = 0; i < flags.length; i++) {
    if (SPECIAL_USE.indexOf(String(flags[i]).toLowerCase()) >= 0) return true
  }

  // A server with no SPECIAL-USE at all still had its folders matched by name
  // in `specialFolders`, and those are the same ones the mailbox row shows.
  var map = special || {}
  for (var key in map) {
    if (map[key] && map[key].toLowerCase() === name.toLowerCase()) return true
  }
  return false
}

function specialFolders(folders) {
  var list = Array.isArray(folders) ? folders : []
  var map = {}
  for (var i = 0; i < list.length; i++) {
    var flags = list[i].flags || []
    for (var j = 0; j < flags.length; j++) {
      var flag = String(flags[j]).toLowerCase()
      if (SPECIAL_USE.indexOf(flag) < 0) continue
      if (!map[flag]) map[flag] = list[i].name
    }
  }
  // Gmail's IMAP predates SPECIAL-USE on some accounts and answers with
  // "[Gmail]/Sent Mail" and friends under XLIST-style names instead. Matching
  // on the name is a guess, so it only fills gaps the flags left.
  for (var k = 0; k < list.length; k++) {
    var name = String(list[k].name || "")
    var leaf = name.split(/[\/.]/).pop().toLowerCase()
    if (!map["\\sent"] && /^sent( mail| items| messages)?$/.test(leaf)) map["\\sent"] = name
    if (!map["\\trash"] && /^(trash|deleted( items| messages)?)$/.test(leaf)) map["\\trash"] = name
    if (!map["\\drafts"] && /^drafts?$/.test(leaf)) map["\\drafts"] = name
    if (!map["\\junk"] && /^(junk|spam|bulk mail)$/.test(leaf)) map["\\junk"] = name
    if (!map["\\archive"] && /^(archive|all mail)$/.test(leaf)) map["\\archive"] = name
  }
  return map
}

// ------------------------------------------------------------ flags ↔ labels
//
// Everything above `MailAccount` reads a message through `Message.summarize`,
// which asks for Gmail label ids. Rather than teach every view a second
// vocabulary, an IMAP message is given the label ids its flags and its folder
// amount to — so a row, a star and an unread dot work unchanged.

function labelIdsFor(flags, folder, special) {
  var list = Array.isArray(flags) ? flags : []
  var lowered = []
  for (var i = 0; i < list.length; i++) lowered.push(String(list[i]).toLowerCase())

  var ids = []
  // Unread is the *absence* of \Seen, which is the one inversion in the whole
  // mapping and the easiest thing to get backwards.
  if (lowered.indexOf("\\seen") < 0) ids.push("UNREAD")
  if (lowered.indexOf("\\flagged") >= 0) ids.push("STARRED")
  if (lowered.indexOf("\\draft") >= 0) ids.push("DRAFT")
  if (lowered.indexOf("\\deleted") >= 0) ids.push("TRASH")

  var map = special || {}
  var name = trimmed(folder)
  var key = name.toLowerCase()
  if (key === "inbox") ids.push("INBOX")
  if (map["\\sent"] && map["\\sent"].toLowerCase() === key) ids.push("SENT")
  if (map["\\trash"] && map["\\trash"].toLowerCase() === key && ids.indexOf("TRASH") < 0) ids.push("TRASH")
  if (map["\\drafts"] && map["\\drafts"].toLowerCase() === key && ids.indexOf("DRAFT") < 0) ids.push("DRAFT")
  if (map["\\junk"] && map["\\junk"].toLowerCase() === key) ids.push("SPAM")
  return ids
}

// The other direction: what an action asks the server to change. Returns the
// flags to add and remove, plus a folder to move to where the action is a move
// rather than a flag — which is the whole difference between IMAP and Gmail.
function actionPlan(action, special) {
  var map = special || {}
  var verb = String(action || "")

  if (verb === "markRead") return { add: ["\\Seen"], remove: [], move: "" }
  if (verb === "markUnread") return { add: [], remove: ["\\Seen"], move: "" }
  if (verb === "star") return { add: ["\\Flagged"], remove: [], move: "" }
  if (verb === "unstar") return { add: [], remove: ["\\Flagged"], move: "" }
  // Archive is a move on IMAP. Without an archive folder there is nowhere for
  // the message to go, and the caller turns the button off rather than
  // silently deleting it.
  if (verb === "archive") return { add: [], remove: [], move: map["\\archive"] || "" }
  if (verb === "unarchive") return { add: [], remove: [], move: "INBOX" }
  if (verb === "trash") return { add: [], remove: [], move: map["\\trash"] || "" }
  if (verb === "untrash") return { add: [], remove: ["\\Deleted"], move: "INBOX" }
  return null
}

// `MailAccount` does not know which provider it is driving: it asks for a
// label change, in Gmail's vocabulary, because that is the vocabulary every
// view already speaks. This is where that request becomes IMAP.
//
// Two of the mappings are not flags at all. Gmail archives by removing the
// INBOX label — one message, many labels — while IMAP has one folder per
// message, so the same request is a move.
function flagPlanForLabels(addLabelIds, removeLabelIds, special) {
  var added = Array.isArray(addLabelIds) ? addLabelIds : []
  var removed = Array.isArray(removeLabelIds) ? removeLabelIds : []
  var map = special || {}
  var plan = { add: [], remove: [], move: "" }

  function has(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).toUpperCase() === id) return true
    }
    return false
  }

  // The inversion again: Gmail's UNREAD is a label you add, IMAP's \Seen is a
  // flag you remove. Getting this backwards marks read what the user just
  // marked unread.
  if (has(added, "UNREAD")) plan.remove.push("\\Seen")
  if (has(removed, "UNREAD")) plan.add.push("\\Seen")
  if (has(added, "STARRED")) plan.add.push("\\Flagged")
  if (has(removed, "STARRED")) plan.remove.push("\\Flagged")

  if (has(removed, "INBOX")) plan.move = map["\\archive"] || ""
  if (has(added, "INBOX")) plan.move = "INBOX"
  if (has(added, "TRASH")) plan.move = map["\\trash"] || ""
  if (has(added, "SPAM")) plan.move = map["\\junk"] || ""
  return plan
}

// -------------------------------------------------------------- the errors
//
// A server's own text is written for whoever reads its logs. These are the
// four sentences a user can act on.

function responseError(status, detail, fallback) {
  var text = trimmed(detail)
  var code = Math.floor(Number(status)) || 0

  // curl's own exit codes, which is what a transport failure arrives as.
  if (code === 6) return "Could not find that mail server. Check the server address"
  if (code === 7) return "Could not reach the mail server. Check the address, the port, and the network"
  if (code === 28) return "The mail server did not answer in time"
  if (code === 35) return "A secure connection to the mail server could not be established"
  if (code === 60 || code === 51)
    return "The mail server's security certificate could not be verified"
  if (code === 67 || /AUTHENTICATIONFAILED|invalid credentials|login failed/i.test(text))
    return "The server rejected that username or password"
  if (/\[ALERT\]/i.test(text)) {
    var alert = text.replace(/^[\s\S]*\[ALERT\]\s*/i, "").split(/[\r\n]/)[0]
    if (alert) return alert
  }
  if (/\[TRYCREATE\]/i.test(text)) return "That folder does not exist on the server"
  if (/\[OVERQUOTA\]/i.test(text)) return "The mailbox is over its storage quota"
  if (/\[INUSE\]/i.test(text)) return "The mailbox is busy. Try again shortly"
  if (/NONEXISTENT|Unknown Mailbox|Mailbox doesn't exist/i.test(text))
    return "That folder is no longer on the server"
  if (text !== "") return redact(text)
  return fallback || "The mail server could not complete this request"
}

// A password can end up in a curl error line, in a server's echo of a failed
// LOGIN, or in a URL. Nothing that could carry one reaches a label without
// passing through here — the same gate `OAuth.redact` is for Google.
function redact(text) {
  return String(text === undefined || text === null ? "" : text)
    // "LOGIN user pass" and "AUTHENTICATE PLAIN <base64>", whichever the
    // server chose to quote back.
    .replace(/\b(LOGIN)\s+\S+\s+\S+/gi, "$1 [redacted]")
    .replace(/\b(AUTHENTICATE)\s+\w+\s+\S+/gi, "$1 [redacted]")
    // A password inside a URL's userinfo, which is how curl prints one.
    .replace(/(imaps?|smtps?):\/\/[^\s/@]*:[^\s/@]*@/gi, "$1://[redacted]@")
    .replace(/(password|pass|pwd)\s*[=:]\s*\S+/gi, "$1=[redacted]")
}

// Whether a tagged completion said NO or BAD. This has to inspect parsed IMAP
// responses rather than search the whole byte string: a FETCH response holds
// the message as a literal, and an ordinary message header such as
// `X-Spam-Flag: NO` is not the server refusing the command.
function failureCompletion(text) {
  var lines = splitResponse(text)
  for (var i = 0; i < lines.length; i++) {
    // A response containing a literal includes the literal's own lines in this
    // string. Only its first protocol line can be a completion, and spaces or
    // tabs — not \s, which also crosses a newline — separate its fields.
    var first = String(lines[i] || "").split(/\r?\n/)[0]
    var match = first.match(/^([^+*\s]\S*)[ \t]+(NO|BAD)(?:[ \t]+(.*))?$/i)
    if (match) return { detail: trimmed(match[3]) }
  }
  return null
}

function isFailure(text) {
  return failureCompletion(text) !== null
}

function failureDetail(text) {
  var completion = failureCompletion(text)
  return completion ? completion.detail : ""
}

// ------------------------------------------------------------- capabilities

// `* CAPABILITY IMAP4rev1 MOVE UIDPLUS ...`, which decides whether an archive
// is one round trip or three.
function parseCapabilities(text) {
  // Bounded to the line. `[\s\S]*` with the multiline flag is greedy across
  // newlines, which swallowed the tagged completion that follows and reported
  // "A1" and "OK" as capabilities.
  var match = String(text || "").match(/^\*\s+CAPABILITY\s+([^\r\n]*)/im)
  if (!match) return []
  var words = match[1].split(/\s+/)
  var out = []
  for (var i = 0; i < words.length; i++) {
    var word = trimmed(words[i]).toUpperCase()
    if (word !== "") out.push(word)
  }
  return out
}

function hasCapability(capabilities, name) {
  var list = Array.isArray(capabilities) ? capabilities : []
  return list.indexOf(String(name || "").toUpperCase()) >= 0
}
