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
    if (String(job.id || "") === "") continue
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
// Whose a job is. An IMAP id is a UID and a folder, unique only inside one
// account, so a job is matched to a message only inside the account that
// asked — by the id the service gives an account, `provider:address`,
// because an address alone does not tell two providers apart. A job that
// names no owner is nobody's message job: it is listed in the pane, and
// answers to no row.
function ownedBy(job, accountId) {
  var owner = String(accountId || "")
  return owner !== "" && !!job && String(job.accountId || "") === owner
}

function jobFor(jobs, messageId, accountId) {
  var list = Array.isArray(jobs) ? jobs : []
  var id = String(messageId || "")
  if (id === "") return null
  var newest = null
  for (var i = 0; i < list.length; i++) {
    if (!ownedBy(list[i], accountId) || isEventsJob(list[i])) continue
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

function jobsByMessage(jobs, accountId) {
  var list = Array.isArray(jobs) ? jobs : []
  var out = {}
  for (var i = 0; i < list.length; i++) {
    if (!ownedBy(list[i], accountId) || isEventsJob(list[i])) continue
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
  // A look for events was not asked for by name: it says something only
  // when it found something, and nothing at all when it found nothing.
  if (isEventsJob(job)) {
    var found = glyph === "done" && Array.isArray(job.events) ? job.events.length : 0
    return found > 0 ? "The agent found " + (found === 1 ? "an event" : found + " events") + " in " + about : ""
  }
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
function payload(summary, bodyText, account, folder, command, prompt, accountId) {
  var row = summary || {}
  return JSON.stringify({
    messageId: String(row.id || ""),
    accountId: String(accountId || ""),
    account: String(account || ""),
    folder: String(folder || ""),
    subject: String(row.subject || ""),
    command: String(command || ""),
    prompt: String(prompt || "").trim(),
    message: messageText(row, bodyText)
  })
}

// Where a message lives, for the prompt. An IMAP id is `<uid>:<folder>` and
// says so itself; a Gmail id carries no folder and a HEY id is two numbers,
// so for those the mailbox key is the nearest honest answer. The provider
// decides, not the shape of the id: an IMAP folder can be named "2026".
function folderOf(messageId, mailboxKey, providerId) {
  var id = String(messageId || "")
  var at = id.indexOf(":")
  if (String(providerId || "") === "imap" && at > 0 && at < id.length - 1) return id.slice(at + 1)
  return String(mailboxKey || "")
}

// ------------------------------------------------------------ the pane

// A pane job is about a scope rather than a message: one account by address,
// or every account. `scopeJobs` is what the pane lists, newest first as the
// runner listed them.
function isScopeJob(job) {
  return !!job && String(job.messageId || "") === "" && String(job.scope || "") !== ""
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
function scopePayload(prompt, scope, account, accounts, command, accountId) {
  var list = Array.isArray(accounts) ? accounts : []
  var addresses = []
  for (var i = 0; i < list.length; i++) {
    var address = String(list[i] || "")
    if (address !== "" && addresses.indexOf(address) < 0) addresses.push(address)
  }
  return JSON.stringify({
    messageId: "",
    scope: String(scope || ""),
    accountId: String(accountId || ""),
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
// new words cross — and the owner, which the runner inherits anyway, said
// again here so the job file and the window agree on whose it is.
function continuationPayload(parentJob, answer, command) {
  return JSON.stringify({
    parent: String(parentJob && parentJob.id ? parentJob.id : ""),
    accountId: String(parentJob && parentJob.accountId ? parentJob.accountId : ""),
    messageId: "",
    scope: "",
    subject: "",
    command: String(command || ""),
    prompt: String(answer || "").trim(),
    message: ""
  })
}

// One job over several messages: each as the agent receives it, in list order.
function selectionPayload(summaries, account, folder, command, prompt, accountId) {
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
    accountId: String(accountId || ""),
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
    look: "claude -p --model claude-haiku-4-5-20251001",
    note: "Non-interactive print mode; himalaya is the only tool allowed without asking." },
  { id: "codex", name: "Codex", binary: "codex",
    command: "codex exec --full-auto",
    look: "codex exec --sandbox read-only -m gpt-5.1-codex-mini",
    note: "Reads the prompt on stdin. Codex's sandbox may block network; use --sandbox danger-full-access if himalaya cannot reach the server." },
  { id: "gemini", name: "Gemini CLI", binary: "gemini",
    command: "gemini --yolo -p \"Act on the instructions above.\"",
    look: "gemini -m gemini-2.5-flash -p \"Act on the instructions above.\"",
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

// The command a background look runs — the search for events in a message
// nobody asked about by name. A look is small, frequent, and reads one
// message: it needs the harness's cheapest model and no tools at all. So
// where the default agent is a harness a preset knows — by the program it
// runs, whatever flags follow it — the look runs that preset's `look` line:
// the cheap model named in full, and no flag that lets a tool run without
// asking, which in print mode means no tool runs. A harness no preset
// knows runs as typed. An explicit look command wins over all of that.
function lookCommand(agentCommand, override) {
  var own = String(override || "").trim()
  if (own !== "") return own
  var command = String(agentCommand || "").trim()
  var program = commandProgram(command)
  for (var i = 0; i < PRESETS.length; i++) {
    if (PRESETS[i].binary !== "" && PRESETS[i].binary === program && PRESETS[i].look) return PRESETS[i].look
  }
  return command
}

// The program a command line runs: its first word, without the path in
// front of it, so `/usr/bin/claude -p` and `claude -p` are one harness.
function commandProgram(command) {
  var first = String(command || "").trim().split(/\s+/)[0] || ""
  return first.slice(first.lastIndexOf("/") + 1)
}

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

// ------------------------------------------------------------ attention

// A job that wants the owner: it asked a question, or it finished and nobody
// has looked yet. `seen` is the ids the owner has opened since — a popup or
// a card on screen counts as looking. Running is not attention; the glyph
// already says that.
function wantsAttention(job, seen) {
  if (!job) return false
  var looked = Array.isArray(seen) ? seen : []
  if (looked.indexOf(String(job.id)) >= 0) return false
  var glyph = glyphState(job)
  return glyph === "question" || glyph === "done" || glyph === "failed"
}

function anyAttention(jobs, seen) {
  var list = Array.isArray(jobs) ? jobs : []
  for (var i = 0; i < list.length; i++) if (!isEventsJob(list[i]) && wantsAttention(list[i], seen)) return true
  return false
}

// messageId -> true for every message whose newest job wants attention.
function attentionByMessage(jobs, seen, accountId) {
  var map = jobsByMessage(jobs, accountId)
  var out = {}
  for (var id in map) if (wantsAttention(map[id], seen)) out[id] = true
  return out
}

function markSeen(seen, jobId) {
  var list = Array.isArray(seen) ? seen.slice() : []
  var id = String(jobId || "")
  if (id !== "" && list.indexOf(id) < 0) list.push(id)
  return list
}

// ------------------------------------------------------------ the draft

// A job about the draft being written: the fields as the composer has them
// and the ask. No message, no scope; the answer is text for the draft.
function draftPayload(fields, ask, account, command, accountId) {
  var values = fields || {}
  return JSON.stringify({
    messageId: "",
    scope: "",
    accountId: String(accountId || ""),
    draft: {
      to: String(values.to || ""),
      subject: String(values.subject || ""),
      body: String(values.body || "")
    },
    account: String(account || ""),
    subject: String(values.subject || "").trim() === "" ? "Draft" : "Draft: " + String(values.subject).trim(),
    command: String(command || ""),
    prompt: String(ask || "").trim(),
    message: ""
  })
}

function isDraftJob(job) {
  return !!job && String(job.kind || "") === "draft"
}

// The composer's own jobs, newest first — what its pane shows.
// The open account's draft jobs, newest first: a draft is written from one
// account, and an answer for Ada's draft must not be offered to Bob's.
function draftJobs(jobs, accountId) {
  var list = Array.isArray(jobs) ? jobs : []
  var out = []
  for (var i = 0; i < list.length; i++) if (isDraftJob(list[i]) && ownedBy(list[i], accountId)) out.push(list[i])
  out.sort(function(a, b) { return Number(b.created || 0) - Number(a.created || 0) })
  return out
}

// The quick asks the composer offers. Each is a whole prompt, so what the
// agent is told is exactly what the button says.
var DRAFT_ASKS = [
  { id: "review", label: "Review", prompt: "Review this draft: is it clear, complete and right in tone for its recipient? Answer with your review, not a rewrite." },
  { id: "rewrite", label: "Rewrite", prompt: "Rewrite this draft so it reads clearly and naturally, keeping every fact and the owner's voice." },
  { id: "shorten", label: "Shorten", prompt: "Shorten this draft to the fewest words that still say everything it says." },
  { id: "expand", label: "Expand", prompt: "Expand this draft: fill in what a reader would need and the owner left implied, without inventing facts." },
  { id: "formal", label: "More formal", prompt: "Rewrite this draft in a more formal register, keeping every fact." },
  { id: "friendly", label: "Friendlier", prompt: "Rewrite this draft in a warmer, friendlier register, keeping every fact." },
  { id: "notes", label: "From notes", prompt: "The body is notes. Write the email they describe, to this recipient, in the owner's voice." }
]

function draftAsks() { return DRAFT_ASKS.slice() }

// What a draft job's answer is once it has one: the output minus a trailing
// QUESTION line, trimmed, and "" while the job runs or if it failed.
function draftAnswer(job, output) {
  if (!job || isActive(job) || glyphState(job) === "failed") return ""
  var text = String(output || "").replace(/\r\n/g, "\n")
  var lines = text.split("\n")
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()
  if (lines.length > 0 && lines[lines.length - 1].indexOf("QUESTION:") === 0) lines.pop()
  return lines.join("\n").trim()
}

// ------------------------------------------------------------ suggested events

// A message the owner opens is handed to the agent to look for calendar
// events in — a meeting, a dinner, a flight, a deadline — when the setting
// is on and the text so much as mentions a date or a time. The job is a
// background one: it draws no glyph, asks for no attention and answers to
// no row; its findings are the card the reader shows.
function isEventsJob(job) {
  return !!job && String(job.kind || "") === "events"
}

// Whether the text mentions a date or a time at all: a month or weekday by
// name, a numeric date, a clock time, or a day said relative to today.
// Generous on purpose, and cheap — it decides only whether the agent is
// worth asking. "May" and "March" alone are words; with a day number they
// are dates, and the short forms are read only beside a number.
var MONTHS = "january|february|april|june|july|august|september|october|november|december"
var MONTH_ANY = "january|february|march|april|may|june|july|august|september|october|november|december"
  + "|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec"
var DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday"
var DAY_ABBR = "mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun"
var DATE_HINTS = [
  new RegExp("\\b(" + MONTHS + ")\\b", "i"),
  new RegExp("\\b(" + MONTH_ANY + ")\\.?\\s+\\d{1,2}\\b", "i"),
  new RegExp("\\b\\d{1,2}(st|nd|rd|th)?\\s+(" + MONTH_ANY + ")\\b", "i"),
  new RegExp("\\b(" + DAYS + ")\\b", "i"),
  new RegExp("\\b(on|next|this|every|by)\\s+(" + DAY_ABBR + ")\\b", "i"),
  new RegExp("\\b(" + DAY_ABBR + ")\\.?,?\\s+\\d{1,2}\\b", "i"),
  /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}:\d{2}\b/,
  /\b\d{1,2}\s?(am|pm)\b/i,
  /\b(tomorrow|tonight|next (week|month)|this (week|weekend|evening|afternoon|morning))\b/i
]
function mentionsDate(text) {
  var value = String(text || "")
  if (value === "") return false
  for (var i = 0; i < DATE_HINTS.length; i++) if (DATE_HINTS[i].test(value)) return true
  return false
}

// A message from two months ago is about events that have passed; the
// agent is not asked about it. Nor about one whose date is unknown: a
// look costs an agent run, and "no idea when" is not a reason to spend one.
var EVENTS_MAX_AGE_MS = 60 * 24 * 3600 * 1000
function tooOldForEvents(messageMs, nowMs) {
  var when = Number(messageMs) || 0
  if (when <= 0) return true
  return Number(nowMs) - when > EVENTS_MAX_AGE_MS
}

// How many looks may run at once. Opening a mailbox's worth of mail one
// message after another must not fan out into one agent per message.
var EVENTS_IN_FLIGHT = 2
function activeEventsJobs(jobs) {
  var list = Array.isArray(jobs) ? jobs : []
  var count = 0
  for (var i = 0; i < list.length; i++) if (isEventsJob(list[i]) && isActive(list[i])) count++
  return count
}

// Whether a message was already looked at — running, or done. One look
// per message: the findings are kept with the job, and a second look would
// only cost another agent run for the same answer. A look that failed or
// was cancelled answered nothing, and may be taken again.
function hasEventsJob(jobs, messageId, accountId) {
  var list = Array.isArray(jobs) ? jobs : []
  var id = String(messageId || "")
  for (var i = 0; i < list.length; i++) {
    if (!isEventsJob(list[i]) || !ownedBy(list[i], accountId)) continue
    var state = String(list[i].state || "")
    if (messageIdsOf(list[i]).indexOf(id) >= 0 && state !== "cancelled" && state !== "failed") return true
  }
  return false
}

// What crosses to the runner: the message, whose it is, and the one fixed
// ask. The runner's rules for this kind say what to answer and how.
function eventsPayload(summary, bodyText, account, folder, command, accountId) {
  var row = summary || {}
  return JSON.stringify({
    messageId: String(row.id || ""),
    accountId: String(accountId || ""),
    account: String(account || ""),
    folder: String(folder || ""),
    subject: String(row.subject || ""),
    command: String(command || ""),
    prompt: "Find the calendar events in this message.",
    events: true,
    message: messageText(row, bodyText)
  })
}

function suggestionKey(jobId, index) {
  return String(jobId || "") + ":" + Math.max(0, Math.floor(Number(index) || 0))
}

// The events the newest finished look at the open message found, less the
// ones the owner has waved away this session, each with the key that names
// it. Read inside the owning account: a look at Ada's 42:INBOX says nothing
// about Bob's.
function eventSuggestions(jobs, accountId, messageId, dismissed) {
  var list = Array.isArray(jobs) ? jobs : []
  var id = String(messageId || "")
  var gone = Array.isArray(dismissed) ? dismissed : []
  if (id === "") return []
  var job = null
  for (var i = 0; i < list.length; i++) {
    var candidate = list[i]
    if (!isEventsJob(candidate) || !ownedBy(candidate, accountId)) continue
    if (String(candidate.state || "") !== "done" || messageIdsOf(candidate).indexOf(id) < 0) continue
    if (!job || Number(candidate.created || 0) > Number(job.created || 0)) job = candidate
  }
  if (!job) return []
  var events = Array.isArray(job.events) ? job.events : []
  var out = []
  for (var k = 0; k < events.length; k++) {
    var event = events[k] || {}
    var key = suggestionKey(job.id, k)
    if (gone.indexOf(key) >= 0) continue
    var startMs = Number(event.startMs) || 0
    if (String(event.title || "").trim() === "" || startMs <= 0) continue
    var endMs = Number(event.endMs) || 0
    out.push({
      key: key, jobId: String(job.id), index: k,
      title: String(event.title).trim(),
      startMs: startMs,
      endMs: endMs > startMs ? endMs : startMs + 3600000,
      allDay: event.allDay === true,
      location: String(event.location || "").trim(),
      notes: String(event.notes || "").trim()
    })
  }
  return out
}

// "Thu 12 Sep, 19:00–20:00", "Thu 12 Sep (all day)", "Fri 12 Sep 2027, 09:00 – Sat 13 Sep 2027, 17:00":
// the year only when it is not this one, the end only when it is not the
// hour after the start.
var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
function suggestionWhen(suggestion, nowMs) {
  var s = suggestion || {}
  var start = new Date(Number(s.startMs) || 0)
  if (!isFinite(start.getTime()) || start.getTime() <= 0) return ""
  var now = new Date(Number(nowMs) || Date.now())
  function two(n) { return n < 10 ? "0" + n : String(n) }
  function day(d) {
    var text = DAY_NAMES[d.getDay()] + " " + d.getDate() + " " + MONTH_NAMES[d.getMonth()]
    return d.getFullYear() !== now.getFullYear() ? text + " " + d.getFullYear() : text
  }
  function clock(d) { return two(d.getHours()) + ":" + two(d.getMinutes()) }
  var end = new Date(Number(s.endMs) || 0)
  if (s.allDay === true) {
    var lastDay = isFinite(end.getTime()) && end.getTime() > start.getTime() ? new Date(end.getTime() - 1) : start
    return day(start) + (day(lastDay) !== day(start) ? " – " + day(lastDay) : "") + " (all day)"
  }
  if (!isFinite(end.getTime()) || end.getTime() <= start.getTime()) return day(start) + ", " + clock(start)
  var sameDay = end.getFullYear() === start.getFullYear() && end.getMonth() === start.getMonth() && end.getDate() === start.getDate()
  if (sameDay) return day(start) + ", " + clock(start) + "–" + clock(end)
  return day(start) + ", " + clock(start) + " – " + day(end) + ", " + clock(end)
}

// What the composer opens with, and whose calendar. The composer creates
// timed events on one day, so a whole day opens as nine to ten and an
// event that runs past midnight ends at the day's last minute, with the
// notes saying what the message actually put — the owner reads the form
// before anything is written, which is the point of opening it.
function eventPrefill(suggestion, accountId) {
  var s = suggestion || {}
  var start = Number(s.startMs) || 0
  var end = Number(s.endMs) || 0
  var notes = String(s.notes || "")
  function add(line) { notes = (notes === "" ? "" : notes + "\n\n") + line }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  }
  if (s.allDay === true) {
    var at = new Date(start)
    var last = end > start ? new Date(end - 1) : at
    at.setHours(9, 0, 0, 0)
    start = at.getTime()
    end = start + 3600000
    add(sameDay(last, at) ? "All day, as the message put it."
      : "All day through " + suggestionWhen({ startMs: last.getTime(), endMs: last.getTime() }, Date.now()).split(",")[0] + ", as the message put it.")
  } else if (end > start && !sameDay(new Date(start), new Date(end))) {
    var dayEnd = new Date(start)
    dayEnd.setHours(23, 59, 0, 0)
    add("The message has it ending " + suggestionWhen({ startMs: end, endMs: end }, Date.now()) + ".")
    end = dayEnd.getTime()
  }
  return { title: String(s.title || ""), startMs: start, endMs: end > start ? end : start + 3600000,
    location: String(s.location || ""), description: notes, accountId: String(accountId || "") }
}
