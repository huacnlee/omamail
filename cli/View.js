.pragma library

.import "Cli.js" as Cli

// How a result is printed. JSON is the agent contract; the table is for a
// person at a terminal. Nothing here talks to a mailbox.

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function terminalText(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
}

function terminalInline(value) {
  return terminalText(value).replace(/[\n\t]+/g, " ")
}

function isoDate(value) {
  if (value === undefined || value === null || value === "") return ""
  if (typeof value === "number" && isFinite(value) && value > 0)
    return new Date(value).toISOString()
  var stamp = Date.parse(String(value))
  if (isFinite(stamp) && stamp > 0) return new Date(stamp).toISOString()
  return String(value)
}

function addressObject(value) {
  var raw = value || {}
  return {
    name: trimmed(raw.name),
    email: trimmed(raw.email),
    display: trimmed(raw.display) || trimmed(raw.name) || trimmed(raw.email)
  }
}

function addressList(values) {
  var list = Array.isArray(values) ? values : []
  var out = []
  for (var i = 0; i < list.length; i++) out.push(addressObject(list[i]))
  return out
}

function pad(text, width) {
  var value = String(text === undefined || text === null ? "" : text)
  if (value.length >= width) return value.substring(0, width)
  var extra = ""
  for (var i = value.length; i < width; i++) extra += " "
  return value + extra
}

function flagsOf(row) {
  var summary = row || {}
  var flags = ""
  if (summary.unread) flags += "u"
  if (summary.starred) flags += "s"
  return flags
}

function fromLabel(row) {
  var from = (row && row.from) || {}
  return trimmed(from.display) || trimmed(from.name) || trimmed(from.email)
}

function messageRecord(row) {
  var summary = row || {}
  var date = summary.date
  var millis = 0
  if (date && typeof date.getTime === "function") millis = date.getTime()
  else if (typeof date === "number") millis = date
  else if (typeof summary.internalDate === "string" && summary.internalDate !== "")
    millis = Number(summary.internalDate)
  return {
    id: trimmed(summary.id),
    threadId: trimmed(summary.threadId),
    from: addressObject(summary.from),
    to: addressList(summary.to),
    cc: addressList(summary.cc),
    subject: trimmed(summary.subject),
    snippet: trimmed(summary.snippet),
    date: isoDate(millis || date),
    unread: summary.unread === true,
    starred: summary.starred === true,
    time: trimmed(summary.time)
  }
}

function accountRecord(account) {
  var entry = account || {}
  return {
    id: trimmed(entry.id),
    email: trimmed(entry.email),
    provider: trimmed(entry.provider) || "gmail",
    label: trimmed(entry.label)
  }
}

function mailboxRecord(entry) {
  var box = entry || {}
  return {
    key: trimmed(box.key),
    label: trimmed(box.label),
    query: trimmed(box.query)
  }
}

function encodeJson(value, pretty) {
  if (pretty === true) return JSON.stringify(value, null, 2)
  return JSON.stringify(value)
}

function wrapPayload(account, data) {
  var payload = data && typeof data === "object" ? data : {}
  if (account) payload.account = accountRecord(account)
  return payload
}

function formatAccounts(accounts, activeId, json, pretty) {
  var list = Array.isArray(accounts) ? accounts : []
  var rows = []
  for (var i = 0; i < list.length; i++) {
    var row = accountRecord(list[i])
    row.active = trimmed(row.id) !== "" && trimmed(row.id) === trimmed(activeId)
    rows.push(row)
  }
  if (json) return encodeJson({ accounts: rows }, pretty)
  if (rows.length === 0) return "No mailbox is signed in."
  var lines = [pad("ACTIVE", 8) + pad("PROVIDER", 10) + pad("ADDRESS", 32) + "ID"]
  for (var j = 0; j < rows.length; j++) {
    var mark = rows[j].active ? "*" : ""
    lines.push(pad(mark, 8) + pad(rows[j].provider, 10)
      + pad(rows[j].email, 32) + rows[j].id)
  }
  return lines.join("\n")
}

function formatMailboxes(mailboxes, json, pretty, account) {
  var list = Array.isArray(mailboxes) ? mailboxes : []
  var rows = []
  for (var i = 0; i < list.length; i++) rows.push(mailboxRecord(list[i]))
  if (json) return encodeJson(wrapPayload(account, { mailboxes: rows }), pretty)
  if (rows.length === 0) return "This account has no mailboxes."
  var lines = [pad("KEY", 12) + "LABEL"]
  for (var j = 0; j < rows.length; j++)
    lines.push(pad(rows[j].key, 12) + rows[j].label)
  return lines.join("\n")
}

function formatList(messages, meta, json, pretty, account) {
  var list = Array.isArray(messages) ? messages : []
  var info = meta || {}
  var rows = []
  for (var i = 0; i < list.length; i++) rows.push(messageRecord(list[i]))
  if (json) {
    return encodeJson(wrapPayload(account, {
      mailbox: trimmed(info.mailbox),
      query: trimmed(info.query),
      estimate: Math.max(0, Math.floor(Number(info.estimate) || 0)),
      nextPageToken: trimmed(info.nextPageToken),
      messages: rows
    }), pretty)
  }
  if (rows.length === 0) return "No messages."
  var lines = [pad("FLAGS", 6) + pad("FROM", 22) + pad("SUBJECT", 40)
    + pad("DATE", 16) + "ID"]
  for (var j = 0; j < rows.length; j++) {
    var row = rows[j]
    lines.push(pad(flagsOf(list[j]), 6)
      + pad(terminalInline(fromLabel(list[j])), 22)
      + pad(terminalInline(row.subject), 40)
      + pad(terminalInline(row.time || row.date), 16)
      + terminalInline(row.id))
  }
  var next = trimmed(info.nextPageToken)
  if (next !== "") lines.push("\nNext page: --page-token " + next)
  return lines.join("\n")
}

function formatRead(summary, body, json, pretty, account) {
  var row = messageRecord(summary)
  row.body = String(body === undefined || body === null ? "" : body)
  if (summary && Array.isArray(summary.to) === false) row.to = addressList(summary.to)
  if (json) return encodeJson(wrapPayload(account, { message: row }), pretty)
  var lines = []
  lines.push("From: " + terminalInline(fromLabel(summary)))
  var to = addressList(summary && summary.to)
  if (to.length > 0) {
    var names = []
    for (var i = 0; i < to.length; i++) names.push(terminalInline(to[i].display))
    lines.push("To: " + names.join(", "))
  }
  lines.push("Subject: " + terminalInline(row.subject))
  if (row.date) lines.push("Date: " + terminalInline(row.date))
  lines.push("Id: " + terminalInline(row.id))
  if (row.threadId) lines.push("Thread: " + terminalInline(row.threadId))
  lines.push("")
  lines.push(terminalText(row.body))
  if (row.body !== "" && row.body.charAt(row.body.length - 1) !== "\n")
    return lines.join("\n") + "\n"
  return lines.join("\n")
}

function formatStatus(info, json, pretty) {
  var source = info || {}
  var payload = {
    account: accountRecord(source.account),
    unread: Math.max(0, Math.floor(Number(source.unread) || 0)),
    mailbox: trimmed(source.mailbox) || "inbox"
  }
  if (json) return encodeJson(payload, pretty)
  var label = payload.account.email || payload.account.id || "(none)"
  return payload.account.provider + "  " + label + "  unread " + payload.unread
}

function formatSend(result, json, pretty, account) {
  var source = result || {}
  var payload = {
    id: trimmed(source.id),
    threadId: trimmed(source.threadId)
  }
  if (json) return encodeJson(wrapPayload(account, payload), pretty)
  if (payload.id !== "") return "Sent " + payload.id
  return "Sent"
}

function formatAction(verb, ids, json, pretty, account) {
  var list = Array.isArray(ids) ? ids : []
  var names = []
  for (var i = 0; i < list.length; i++) {
    var id = trimmed(list[i])
    if (id !== "") names.push(id)
  }
  if (json) return encodeJson(wrapPayload(account, { action: verb, ids: names }), pretty)
  var noun = names.length === 1 ? "message" : "messages"
  return Cli.canonicalVerb(verb) + " " + names.length + " " + noun
}

function formatError(error, json, pretty, code) {
  var message = trimmed(error) || "Something went wrong"
  if (json) return encodeJson({ ok: false, error: message, code: trimmed(code) }, pretty)
  return "omamail: " + message
}
