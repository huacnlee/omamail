.pragma library

// Presentation adapters over generated native mail facts. Dynamic query and
// message URL construction uses providers.resolve; no provider DSL runs here.

.import "NativeDomain.js" as NativeDomain
.import "Gmail.js" as Gmail
.import "Outlook.js" as Outlook
.import "Imap.js" as Imap
.import "Hey.js" as Hey
.import "Jmap.js" as Jmap

function capabilities(values) {
  var raw = values || {}
  return {
    labels: raw.labels === true,
    move: raw.move === true,
    threads: raw.threads === true,
    conversations: raw.conversations === true,
    archive: raw.archive === true,
    spam: raw.spam === true,
    star: raw.star === true,
    batch: raw.batch === true,
    web: raw.web === true,
    webBox: raw.webBox === true,
    search: raw.search === true,
    manageLabels: raw.manageLabels === true,
    send: raw.send === true
  }
}

function mailbox(raw) {
  var entry = raw || {}
  return {
    key: String(entry.key || ""),
    label: String(entry.label || ""),
    icon: String(entry.icon || ""),
    query: String(entry.query || ""),
    optional: entry.optional === true
  }
}

function define(source) {
  var raw = source || {}
  var facts = NativeDomain.FACTS[String(raw.ID || "")] || {}
  var boxes = []
  var list = Array.isArray(raw.MAILBOXES) ? raw.MAILBOXES : []
  for (var i = 0; i < list.length; i++) {
    var box = mailbox(list[i])
    box.query = String((facts.queries || {})[box.key] || "")
    boxes.push(box)
  }
  return {
    id: String(raw.ID || ""),
    name: String(raw.NAME || ""),
    summary: String(raw.SUMMARY || ""),
    auth: String(raw.AUTH || "none"),
    nativeSync: facts.nativeSync === true,
    mark: String(raw.MARK || ""),
    logo: String(raw.LOGO || raw.MARK || ""),
    unavailable: String(raw.UNAVAILABLE || ""),
    capabilities: capabilities(facts.capabilities),
    addressSearch: facts.addressSearch === true,
    inheritedDefault: String(facts.inheritedDefault || ""),
    mailboxes: boxes,
    webHomeUrl: function() { return String(facts.webHomeUrl || "") },
    clientUrl: String(raw.CLIENT_URL || ""),
    detail: typeof raw.detail === "function" ? raw.detail : function() { return "" }
  }
}

var ALL = [define(Gmail), define(Outlook), define(Hey), define(Jmap), define(Imap)]

var DEFAULT_ID = "gmail"

function ids() {
  var out = []
  for (var i = 0; i < ALL.length; i++) out.push(ALL[i].id)
  return out
}

function get(id) {
  var wanted = String(id === undefined || id === null ? "" : id).trim().toLowerCase()
  for (var i = 0; i < ALL.length; i++) {
    if (ALL[i].id === wanted) return ALL[i]
  }
  return ALL[0]
}

function exists(id) {
  var wanted = String(id === undefined || id === null ? "" : id).trim().toLowerCase()
  for (var i = 0; i < ALL.length; i++) {
    if (ALL[i].id === wanted) return true
  }
  return false
}

function isConnectable(id) {
  return !get(id).unavailable
}

function unavailableReason(id) {
  return String(get(id).unavailable || "")
}

function refuses(refusals, capability) {
  if (!refusals) return false
  var reason = refusals[String(capability)]
  return reason !== undefined && reason !== null
}

function can(id, capability, refusals) {
  if (get(id).capabilities[String(capability)] !== true) return false
  return !refuses(refusals, capability)
}

function refusal(id, capability, refusals) {
  if (get(id).capabilities[String(capability)] !== true) return ""
  if (!refuses(refusals, capability)) return ""
  return String(refusals[String(capability)])
}

function mailboxes(id, absent) {
  var list = get(id).mailboxes
  var missing = Array.isArray(absent) ? absent : []
  var drop = []
  for (var i = 0; i < missing.length; i++) drop.push(String(missing[i]))
  var out = []
  for (var j = 0; j < list.length; j++) {
    if (drop.indexOf(list[j].key) < 0) out.push(list[j])
  }
  return out
}

function mailboxIndex(id, key) {
  var list = get(id).mailboxes
  var wanted = String(key === undefined || key === null ? "" : key)
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === wanted) return i
  }
  return 0
}

function mailboxFor(id, key) {
  var list = get(id).mailboxes
  return list[mailboxIndex(id, key)]
}

function hasMailbox(id, key) {
  var list = get(id).mailboxes
  var wanted = String(key === undefined || key === null ? "" : key)
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === wanted) return true
  }
  return false
}

function unreadQuery(id) {
  return mailboxFor(id, "unread").query
}

function badge(id) {
  return get(id).name
}

function summary(id) {
  return String(get(id).summary || "")
}

function detail(id, account) {
  return String(get(id).detail(account) || "")
}

function mark(id) {
  return String(get(id).mark || "")
}

function logo(id) {
  return String(get(id).logo || "")
}

function authKind(id) {
  return String(get(id).auth || "none")
}

function usesOAuth(id) {
  return authKind(id) === "oauth"
}

function usesPassword(id) {
  return authKind(id) === "password"
}

function usesCli(id) {
  return authKind(id) === "cli"
}

function webHomeUrl(id) {
  return get(id).webHomeUrl()
}

function clientUrl(id) {
  return String(get(id).clientUrl || "")
}

function nativeSync(id) {
  return get(id).nativeSync === true
}
