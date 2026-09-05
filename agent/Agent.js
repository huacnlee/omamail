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
    if (messageIdsOf(list[i]).indexOf(id) < 0) continue
    if (isActive(list[i])) return list[i]
    if (!newest || Number(list[i].created || 0) > Number(newest.created || 0)) newest = list[i]
  }
  return newest
}

// messageId -> job, for a list that asks per row without walking the whole
// job list per row.
// Every message a job is about: the one it names, or the several.
function messageIdsOf(job) {
  if (!job) return []
  var many = Array.isArray(job.messageIds) ? job.messageIds : []
  var out = []
  for (var i = 0; i < many.length; i++) if (String(many[i] || "") !== "") out.push(String(many[i]))
  var one = String(job.messageId || "")
  if (one !== "" && out.indexOf(one) < 0) out.push(one)
  return out
}

function jobsByMessage(jobs) {
  var list = Array.isArray(jobs) ? jobs : []
  var out = {}
  for (var i = 0; i < list.length; i++) {
    var ids = messageIdsOf(list[i])
    for (var k = 0; k < ids.length; k++) {
      var id = ids[k]
      var current = out[id]
      if (!current || isActive(list[i])
          || (!isActive(current) && Number(list[i].created || 0) > Number(current.created || 0)))
        out[id] = list[i]
    }
  }
  return out
}

// Every job about a message, newest first — what the pane shows when it is
// opened from a row.
function jobsForMessage(jobs, messageId) {
  var list = Array.isArray(jobs) ? jobs : []
  var id = String(messageId || "")
  var out = []
  for (var i = 0; i < list.length; i++) if (messageIdsOf(list[i]).indexOf(id) >= 0) out.push(list[i])
  out.sort(function(a, b) { return Number(b.created || 0) - Number(a.created || 0) })
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

// What the agent last wrote while it works, or "" — the listing carries it
// for a running job, so a row and a popup can show movement.
function progressText(job) {
  if (!job || !isActive(job)) return ""
  return String(job.progress || "").trim()
}

// Why a running job is not moving, in words, or "".
function stallText(job) {
  if (!job || !isActive(job)) return ""
  if (String(job.stall || "") === "permission")
    return "The agent stopped to ask for permission it cannot be given here. Cancel it and give the harness its tools up front — see the presets in Settings."
  return ""
}

function stateLabel(job) {
  var glyph = glyphState(job)
  if (glyph === "running") return String(job.stall || "") === "permission" ? "Stopped to ask" : "Working"
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

// What a pane card says it is about: the message's subject for a message
// job, the mailbox or every mailbox for a scope job.
function jobAboutLabel(job, accountLabel) {
  if (!job) return ""
  var many = Array.isArray(job.messageIds) ? job.messageIds.length : 0
  if (many > 1) return pluralizeMessages(many)
  if (String(job.messageId || "") !== "" || many === 1) {
    var subject = String(job.subject || "").trim()
    return subject === "" ? "A message" : "\u201C" + subject + "\u201D"
  }
  return scopeLabel(job.scope, accountLabel)
}

function pluralizeMessages(count) {
  var n = Math.max(0, Math.floor(Number(count) || 0))
  return n === 1 ? "1 message" : n + " messages"
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

// A continuation: the answer to a job's question, or a follow-up ask. The
// runner rebuilds the prompt from the parent, so only the parent id and the
// new words cross.
function continuationPayload(parentJob, answer, command) {
  return JSON.stringify({
    parent: String(parentJob && parentJob.id ? parentJob.id : ""),
    messageId: "",
    scope: "",
    subject: "",
    command: String(command || ""),
    prompt: String(answer || "").trim(),
    message: ""
  })
}

// One job over several messages: each as the agent receives it, in list order.
function selectionPayload(summaries, account, folder, command, prompt) {
  var rows = Array.isArray(summaries) ? summaries : []
  var messages = []
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i] || String(rows[i].id || "") === "") continue
    messages.push({ messageId: String(rows[i].id), message: messageText(rows[i], "") })
  }
  return JSON.stringify({
    messageId: "",
    messages: messages,
    scope: "",
    account: String(account || ""),
    folder: String(folder || ""),
    subject: pluralizeMessages(messages.length),
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

// ------------------------------------------------------------ presets

// Command lines for the harnesses people actually run, each of which reads
// the prompt on stdin and runs without a terminal to answer prompts on. The
// tool flags are the ones that let the agent call himalaya without stopping
// to ask; a preset is a starting point the field keeps editable, not a lock.
// `binary` is what has to be on PATH for the preset to work, so Settings can
// say which ones are installed.
var PRESETS = [
  { id: "claude", name: "Claude Code", binary: "claude",
    command: "claude -p --allowedTools \"Bash(himalaya:*)\"",
    note: "Non-interactive print mode; himalaya is the only tool allowed without asking." },
  { id: "codex", name: "Codex", binary: "codex",
    command: "codex exec --full-auto",
    note: "Reads the prompt on stdin. Codex's sandbox may block network; use --sandbox danger-full-access if himalaya cannot reach the server." },
  { id: "gemini", name: "Gemini CLI", binary: "gemini",
    command: "gemini --yolo -p \"Act on the instructions above.\"",
    note: "Headless mode; the -p text is appended to the prompt on stdin, and --yolo approves tool calls." },
  { id: "grok", name: "Grok Build", binary: "grok",
    command: "grok --always-approve -p \"$(cat)\"",
    note: "Single-turn headless mode; --always-approve lets it run himalaya without asking. The shell reads the prompt on stdin into the argument." },
  { id: "opencode", name: "OpenCode", binary: "opencode",
    command: "opencode run \"$(cat)\"",
    note: "Takes the prompt as an argument, so the shell reads stdin into it." },
  { id: "custom", name: "Custom command", binary: "",
    command: "",
    note: "Anything that reads a prompt on stdin and writes its answer on stdout." }
]

function presets() { return PRESETS.slice() }

function presetById(id) {
  for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === String(id || "")) return PRESETS[i]
  return null
}

// Which preset a command line is, or "custom" for one nobody shipped. Matched
// on the exact text, so an edited preset is honestly reported as custom.
function presetFor(command) {
  var text = String(command || "").trim()
  if (text === "") return ""
  for (var i = 0; i < PRESETS.length; i++) {
    if (PRESETS[i].command !== "" && PRESETS[i].command === text) return PRESETS[i].id
  }
  return "custom"
}

// The preset list as a dropdown wants it, with the binaries found on PATH
// deciding the label. `found` is the list of binary names present.
function presetOptions(found) {
  var present = Array.isArray(found) ? found : []
  var out = []
  for (var i = 0; i < PRESETS.length; i++) {
    var preset = PRESETS[i]
    var label = preset.name
    if (preset.binary !== "" && present.indexOf(preset.binary) < 0) label += " (not installed)"
    out.push({ value: preset.id, label: label })
  }
  return out
}

// The names on PATH, from one line per name as `command -v` prints them.
function foundBinaries(text) {
  var lines = String(text || "").split("\n")
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var name = lines[i].trim()
    if (name === "") continue
    var slash = name.lastIndexOf("/")
    if (slash >= 0) name = name.slice(slash + 1)
    if (out.indexOf(name) < 0) out.push(name)
  }
  return out
}

function presetBinaries() {
  var out = []
  for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].binary !== "") out.push(PRESETS[i].binary)
  return out
}
