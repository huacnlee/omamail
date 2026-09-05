.pragma library

// The message agent's rules: what a job file means, which job a message has,
// what the row and the popup say about it, and what the runner is handed.
// The process itself lives in `AgentRunner.qml` and `scripts/agent-job.py`;
// nothing here starts anything, so all of it runs under node.

var ACTIVE = ["queued", "running"]

function hasAgent(command) {
  return String(command === undefined || command === null ? "" : command).trim() !== ""
}

// The runner's own listing, or nothing: a directory that is not there yet and
// a line that is not JSON both mean "no jobs", not an error worth a notice.
function parseJobs(text) {
  var parsed = null
  try { parsed = JSON.parse(String(text || "")) } catch (e) { parsed = null }
  if (!Array.isArray(parsed)) return []
  var out = []
  for (var i = 0; i < parsed.length; i++) {
    var job = parsed[i]
    if (!job || typeof job !== "object") continue
    if (String(job.id || "") === "" || String(job.messageId || "") === "") continue
    out.push(job)
  }
  return out
}

function isActive(job) {
  return !!job && ACTIVE.indexOf(String(job.state || "")) >= 0
}

function anyActive(jobs) {
  var list = Array.isArray(jobs) ? jobs : []
  for (var i = 0; i < list.length; i++) if (isActive(list[i])) return true
  return false
}

// The job a message shows: the one still running if there is one, else the
// newest. A message can have been asked about twice; the row has one glyph.
function jobFor(jobs, messageId) {
  var list = Array.isArray(jobs) ? jobs : []
  var id = String(messageId || "")
  if (id === "") return null
  var newest = null
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].messageId || "") !== id) continue
    if (isActive(list[i])) return list[i]
    if (!newest || Number(list[i].created || 0) > Number(newest.created || 0)) newest = list[i]
  }
  return newest
}

// messageId -> job, for a list that asks per row without walking the whole
// job list per row.
function jobsByMessage(jobs) {
  var list = Array.isArray(jobs) ? jobs : []
  var out = {}
  for (var i = 0; i < list.length; i++) {
    var id = String(list[i].messageId || "")
    var current = out[id]
    if (!current || isActive(list[i])
        || (!isActive(current) && Number(list[i].created || 0) > Number(current.created || 0)))
      out[id] = list[i]
  }
  return out
}

// What the row's glyph means, or "" for a message with nothing to show.
function glyphState(job) {
  if (!job) return ""
  var state = String(job.state || "")
  if (state === "queued" || state === "running") return "running"
  if (state === "done") return String(job.question || "") !== "" ? "question" : "done"
  if (state === "failed") return "failed"
  if (state === "cancelled") return "cancelled"
  return ""
}

function stateLabel(job) {
  var glyph = glyphState(job)
  if (glyph === "running") return "Working"
  if (glyph === "question") return "Has a question"
  if (glyph === "done") return "Done"
  if (glyph === "failed") return "Failed"
  if (glyph === "cancelled") return "Cancelled"
  return ""
}

// What the popup shows under the state: the question if there is one, the
// error if it failed, and otherwise the agent's own last line.
function detailText(job) {
  if (!job) return ""
  if (String(job.question || "") !== "") return String(job.question)
  if (String(job.error || "") !== "") return String(job.error)
  return String(job.summary || "")
}

// The one-line note when a job the window was watching finishes.
function finishedNote(job) {
  var glyph = glyphState(job)
  var subject = String(job && job.subject ? job.subject : "").trim()
  var about = subject === "" ? "the message" : "“" + subject + "”"
  if (glyph === "question") return "The agent has a question about " + about
  if (glyph === "done") return "The agent finished with " + about
  if (glyph === "failed") return "The agent failed on " + about
  if (glyph === "cancelled") return "Agent actions on " + about + " were cancelled"
  return ""
}

// Which jobs crossed from active to finished between two listings: the ones
// worth a note. Keyed by id, so a job that finished and was replaced by a new
// one on the same message is still reported.
function newlyFinished(before, after) {
  var was = {}
  var earlier = Array.isArray(before) ? before : []
  for (var i = 0; i < earlier.length; i++) was[String(earlier[i].id)] = isActive(earlier[i])
  var out = []
  var later = Array.isArray(after) ? after : []
  for (var j = 0; j < later.length; j++) {
    var id = String(later[j].id)
    if (was[id] === true && !isActive(later[j])) out.push(later[j])
  }
  return out
}

function addressLine(list) {
  var rows = Array.isArray(list) ? list : []
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || {}
    var email = String(row.email || "")
    var name = String(row.name || row.display || "")
    if (email === "") { if (name !== "") out.push(name); continue }
    out.push(name !== "" && name !== email ? name + " <" + email + ">" : email)
  }
  return out.join(", ")
}

// The message as the agent receives it: the headers a reader would want,
// then the text body. Text only — a stranger's HTML has no business in a
// prompt, and the reader already has the plain text of every message.
function messageText(summary, bodyText) {
  var row = summary || {}
  var from = row.from || {}
  var lines = []
  var sender = String(from.email || "")
  var senderName = String(from.name || from.display || "")
  lines.push("From: " + (senderName !== "" && senderName !== sender
    ? senderName + " <" + sender + ">" : sender))
  var to = addressLine(row.to)
  if (to !== "") lines.push("To: " + to)
  var cc = addressLine(row.cc)
  if (cc !== "") lines.push("Cc: " + cc)
  if (String(row.fullTime || "") !== "") lines.push("Date: " + String(row.fullTime))
  lines.push("Subject: " + String(row.subject || ""))
  if (String(row.messageId || "") !== "") lines.push("Message-ID: " + String(row.messageId))
  lines.push("")
  lines.push(String(bodyText === undefined || bodyText === null ? "" : bodyText))
  return lines.join("\n")
}

// What crosses to the runner: one JSON object on one line. JSON escapes every
// newline, so a body or a prompt of any shape is one line to `read`.
function payload(summary, bodyText, account, folder, command, prompt) {
  var row = summary || {}
  return JSON.stringify({
    messageId: String(row.id || ""),
    account: String(account || ""),
    folder: String(folder || ""),
    subject: String(row.subject || ""),
    command: String(command || ""),
    prompt: String(prompt || "").trim(),
    message: messageText(row, bodyText)
  })
}

// Where an IMAP id says its message lives, for the prompt: `<uid>:<folder>`.
// A Gmail id carries no folder and a HEY id is `<posting>:<topic>`, two
// numbers; for both the mailbox key is the nearest honest answer.
function folderOf(messageId, mailboxKey) {
  var id = String(messageId || "")
  var at = id.indexOf(":")
  if (at > 0 && at < id.length - 1 && /^\d+$/.test(id.slice(0, at))
      && !/^\d+$/.test(id.slice(at + 1))) return id.slice(at + 1)
  return String(mailboxKey || "")
}

// ------------------------------------------------------------ the pane

// A pane job is about a scope rather than a message: one account by address,
// or every account. `scopeJobs` is what the pane lists, newest first as the
// runner listed them.
function isScopeJob(job) {
  return !!job && String(job.messageId || "") === "" && String(job.scope || "") !== ""
}

function scopeJobs(jobs) {
  var list = Array.isArray(jobs) ? jobs : []
  var out = []
  for (var i = 0; i < list.length; i++) if (isScopeJob(list[i])) out.push(list[i])
  return out
}

function scopeOf(all, email) {
  return all ? "all" : "account:" + String(email || "")
}

function scopeLabel(scope, accountLabel) {
  var value = String(scope || "")
  if (value === "all") return "Every mailbox"
  var name = String(accountLabel || "")
  if (name !== "") return name
  return value.indexOf("account:") === 0 ? value.slice("account:".length) : value
}

// What crosses to the runner for a pane job: no message, a scope, and every
// address the agent may be asked to look in.
function scopePayload(prompt, scope, account, accounts, command) {
  var list = Array.isArray(accounts) ? accounts : []
  var addresses = []
  for (var i = 0; i < list.length; i++) {
    var address = String(list[i] || "")
    if (address !== "" && addresses.indexOf(address) < 0) addresses.push(address)
  }
  return JSON.stringify({
    messageId: "",
    scope: String(scope || ""),
    account: String(account || ""),
    accounts: addresses,
    subject: "",
    command: String(command || ""),
    prompt: String(prompt || "").trim(),
    message: ""
  })
}

// The pane's listing of one job's output, from `agent-job.py show`.
function parseShown(text) {
  var parsed = null
  try { parsed = JSON.parse(String(text || "")) } catch (e) { parsed = null }
  if (!parsed || typeof parsed !== "object" || !parsed.job) return null
  return { job: parsed.job, output: String(parsed.output || "") }
}
