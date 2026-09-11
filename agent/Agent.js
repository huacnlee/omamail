.pragma library

// The message agent's rules: what a job file means, which job a message has,
// what the row and the popup say about it, and what the runner is handed.
// The process itself lives in `AgentRunner.qml` and `scripts/agent-job.py`;
// nothing here starts anything, so all of it runs under node.

var ACTIVE = ["queued", "running"]


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
    if (!ownedBy(list[i], accountId)) continue
    if (messageIdsOf(list[i]).indexOf(id) < 0) continue
    if (isActive(list[i])) return list[i]
    if (!newest || createdOrder(list[i]) > createdOrder(newest)) newest = list[i]
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
    if (!ownedBy(list[i], accountId)) continue
    var ids = messageIdsOf(list[i])
    for (var k = 0; k < ids.length; k++) {
      var id = ids[k]
      var current = out[id]
      if (!current || isActive(list[i])
          || (!isActive(current) && createdOrder(list[i]) > createdOrder(current)))
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
function workingText(job, now, preparationStarted) {
  var active = isActive(job)
  var start = active && Number(job.created) > 0 ? Number(job.created) * 1000 : preparationStarted
  var seconds = Math.max(0, Math.floor((now - start) / 1000))
  var duration = Math.floor(seconds / 60) + "m " + (seconds % 60) + "s"
  return "• " + (active ? "Working" : "Preparing") + " (" + duration
    + (active ? " • Esc to interrupt" : "") + " • / show commands)"
}

function progressText(job) {
  if (!job || !isActive(job)) return ""
  return String(job.progress || "").trim()
}

// Why a running job is not moving, in words, or "".
function stallText(job) {
  if (!job || !isActive(job)) return ""
  if (String(job.stall || "") === "permission")
    return "Continue in the system AI terminal."
  return ""
}

function stateLabel(job) {
  var glyph = glyphState(job)
  if (job && job.resultReady) return "Ready"
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
  if (glyph === "cancelled") return "The AI session for " + about + " was closed"
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
function payload(summary, bodyText, account, folder, prompt, accountId) {
  var row = summary || {}
  return JSON.stringify({
    messageId: String(row.id || ""),
    accountId: String(accountId || ""),
    account: String(account || ""),
    folder: String(folder || ""),
    subject: String(row.subject || ""),
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

function pluralizeMessages(count) {
  var n = Math.max(0, Math.floor(Number(count) || 0))
  return n === 1 ? "1 message" : n + " messages"
}

// A continuation: the answer to a job's question, or a follow-up ask. The
// runner rebuilds the prompt from the parent, so only the parent id and the
// new words cross — and the owner, which the runner inherits anyway, said
// again here so the job file and the window agree on whose it is.
function continuationPayload(parentJob, answer) {
  return JSON.stringify({ parent: String(parentJob && parentJob.id || ""), prompt: String(answer || "").trim() })
}

// One job over several messages: each as the agent receives it, in list order.
function selectionPayload(summaries, account, folder, prompt, accountId) {
  var rows = Array.isArray(summaries) ? summaries : []
  var messages = []
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i] || String(rows[i].id || "") === "") continue
    messages.push({ messageId: String(rows[i].id), message: messageText(rows[i], rows[i].bodyText || "") })
  }
  return JSON.stringify({
    messageId: "",
    messages: messages,
    accountId: String(accountId || ""),
    account: String(account || ""),
    folder: String(folder || ""),
    subject: pluralizeMessages(messages.length),
    prompt: String(prompt || "").trim(),
    message: ""
  })
}

// The pane's listing of one job's output, from `agent-job.py show`.
function parseShown(text) {
  var parsed = null
  try { parsed = JSON.parse(String(text || "")) } catch (e) { parsed = null }
  if (!parsed || typeof parsed !== "object" || !parsed.job) return null
  return { job: parsed.job, output: String(parsed.output || ""), transcript: chatEntries(parsed.transcript) }
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
  return !!job.resultReady || glyph === "question" || glyph === "done" || glyph === "failed"
}

function anyAttention(jobs, seen) {
  var list = Array.isArray(jobs) ? jobs : []
  for (var i = 0; i < list.length; i++) if (wantsAttention(list[i], seen)) return true
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
function draftPayload(fields, ask, account, accountId) {
  var values = fields || {}
  return JSON.stringify({
    messageId: "",
    accountId: String(accountId || ""),
    draftKey: String(values.draftKey || ""),
    draftFingerprint: draftFingerprint(values),
    draft: {
      from: String(values.from || account || ""),
      to: String(values.to || ""),
      subject: String(values.subject || ""),
      body: String(values.body || "")
    },
    account: String(account || ""),
    subject: String(values.subject || "").trim() === "" ? "Draft" : "Draft: " + String(values.subject).trim(),
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
function draftJobs(jobs, accountId, draftKey) {
  var list = Array.isArray(jobs) ? jobs : []
  var out = []
  for (var i = 0; i < list.length; i++) if (isDraftJob(list[i]) && ownedBy(list[i], accountId) && String(draftKey || "") !== "" && String(list[i].draftKey || "") === String(draftKey)) out.push(list[i])
  out.sort(function(a, b) { return createdOrder(b) - createdOrder(a) })
  return out
}

// Draft scenarios fill the editable prompt before the owner submits it.
var DRAFT_ASKS = [
  { id: "review", label: "Review", prompt: "Review this draft: is it clear, complete and right in tone for its recipient? Answer with your review, not a rewrite." },
  { id: "rewrite", label: "Rewrite", prompt: "Rewrite this draft so it reads clearly and naturally, keeping every fact and the owner's voice." },
  { id: "shorten", label: "Shorten", prompt: "Shorten this draft to the fewest words that still say everything it says." },
  { id: "expand", label: "Expand", prompt: "Expand this draft: fill in what a reader would need and the owner left implied, without inventing facts." },
  { id: "formal", label: "More formal", prompt: "Rewrite this draft in a more formal register, keeping every fact." },
  { id: "friendly", label: "Friendlier", prompt: "Rewrite this draft in a warmer, friendlier register, keeping every fact." },
  { id: "notes", label: "From notes", prompt: "The body is notes. Write the email they describe, to this recipient, in the owner's voice." }
]

var MAIL_TRANSFORM_FORMAT = "Use exactly this reply layout: Title: <mail title>, then a blank line, then Body: on its own line followed by the mail body. Do not include any other headers or commentary."
function draftAsks() {
  var out = []
  for (var i = 0; i < DRAFT_ASKS.length; i++) {
    var ask = DRAFT_ASKS[i]
    var prompt = ask.prompt + " Work only on the mail title and body; do not rewrite addresses, dates, metadata, or this instruction."
    if (ask.id !== "review") prompt = prompt.replace("Answer with your review, not a rewrite.", "") + " " + MAIL_TRANSFORM_FORMAT
    out.push({id: ask.id, label: ask.label, prompt: prompt})
  }
  return out
}

// Explicit plaintext results are preserved exactly; incomplete or failed jobs
// cannot supply draft text. A ready result can arrive before the terminal exits.
function draftAnswer(job, output, transcript) {
  if (!job || (isActive(job) && !job.resultReady) || glyphState(job) === "failed" || job.question) return ""
  var text = String(output || "")
  var rows = Array.isArray(transcript) ? transcript : []
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].role === "user" && rows[i].text.indexOf(MAIL_TRANSFORM_FORMAT) >= 0) {
      var body = /^Title: [^\r\n]*\r?\n\r?\nBody:\r?\n([\s\S]*)$/.exec(text)
      return body ? body[1] : ""
    }
  }
  return text
}

// A change indicator, never an authorization check. Ownership is draftKey + account.
function draftFingerprint(fields) {
  var v = fields || {}
  var text = JSON.stringify([v.from || "", v.to || "", v.subject || "", v.body || ""])
  var hash = 2166136261
  for (var i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = (hash * 16777619) >>> 0 }
  return String(hash)
}

function selectionJob(jobs, ids, accountId) {
  var wanted = (Array.isArray(ids) ? ids.slice() : []).sort()
  if (wanted.length === 0) return null
  var newest = null
  var list = Array.isArray(jobs) ? jobs : []
  for (var i = 0; i < list.length; i++) {
    var job = list[i]
    if (!ownedBy(job, accountId)) continue
    var actual = messageIdsOf(job).sort()
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) continue
    if (isActive(job)) return job
    if (!newest || createdOrder(job) > createdOrder(newest)) newest = job
  }
  return newest
}

// Choosing a scenario fills the editable request; only Ask starts a session.
var MAIL_ASKS = [
  {label: "Summarize", prompt: "Summarize this mail and highlight its key points."},
  {label: "Explain", prompt: "Explain this mail in plain language, including any unfamiliar terms."},
  {label: "Action items", prompt: "List the requested actions, deadlines, and open questions in this mail."},
  {label: "Draft a reply", prompt: "Draft a reply to this mail. Flag any missing information instead of inventing facts."},
  {label: "Translate to Chinese", prompt: "Translate only the mail title and body into Chinese. Exclude sender, recipients, dates, metadata, and instructions."},
  {label: "Translate to English", prompt: "Translate only the mail title and body into English. Exclude sender, recipients, dates, metadata, and instructions."}
]
function mailAsks(multiple) {
  var asks = []
  for (var i = 0; i < MAIL_ASKS.length; i++) {
    var ask = MAIL_ASKS[i]
    asks.push({label: ask.label, prompt: ask.prompt + " Work only from the mail title and body."
      + (ask.label.indexOf("Translate") === 0 ? " " + MAIL_TRANSFORM_FORMAT : "")})
  }
  asks.push({id: "rewrite", label: "Rewrite", prompt: "Rewrite only the mail title and body for clarity, preserving facts. Exclude addresses, dates, metadata and instructions. " + MAIL_TRANSFORM_FORMAT})
  if (multiple) asks.unshift({label: "Compare mails", prompt: "Compare these mails, summarize what changed, and list shared action items and unresolved questions."})
  return asks
}

function chatEntries(value) {
  var rows = Array.isArray(value) ? value : []
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var entry = rows[i]
    if (!entry || ["user", "assistant", "status"].indexOf(entry.role) < 0 || typeof entry.text !== "string") continue
    out.push({role: entry.role, text: entry.text})
  }
  return out
}

function createdOrder(job) {
  return Number(job && job.createdOrder || Number(job && job.created || 0) * 1000000000)
}

function commandSuggestions(text, choices) {
  var value = String(text || "")
  var match = /(?:^|\n)\/([a-z-]*)$/.exec(value)
  if (!match) return {start: -1, items: []}
  var items = []
  for (var i = 0; i < choices.length; i++) {
    var choice = choices[i]
    var command = String(choice.id || choice.label.toLowerCase().replace(/ /g, "-"))
    if (command.indexOf(match[1]) === 0 || choice.label.toLowerCase().indexOf(match[1]) === 0)
      items.push({command: command, label: choice.label, prompt: choice.prompt})
  }
  return {start: value.lastIndexOf("/"), items: items}
}

function historyFor(jobs, accountId, ids, draftKey) {
  var rows = Array.isArray(jobs) ? jobs : []
  var wanted = (Array.isArray(ids) ? ids.slice() : []).sort().join("\u001f")
  var groups = {}
  for (var i = 0; i < rows.length; i++) {
    var job = rows[i]
    if (!ownedBy(job, accountId)) continue
    if (draftKey) { if (!isDraftJob(job) || job.draftKey !== draftKey) continue }
    else if (isDraftJob(job) || messageIdsOf(job).sort().join("\u001f") !== wanted || wanted === "") continue
    var key = String(job.conversationId || job.id)
    if (!groups[key] || createdOrder(job) > createdOrder(groups[key])) groups[key] = job
  }
  var result = []
  for (var key in groups) if (Object.prototype.hasOwnProperty.call(groups, key)) result.push(groups[key])
  result.sort(function(a,b) { return createdOrder(b) - createdOrder(a) })
  return result
}
function historyLabel(job) {
  return new Date(Number(job.created || 0) * 1000).toLocaleString() + " · " + String(job.requestPreview || job.subject || "Conversation")
}

// Queue policy is independent of views and never matches a different conversation.
function pendingJob(jobs, currentJob, scopeMatches, conversationId, previousId) {
  var rows = Array.isArray(jobs) ? jobs : []
  if (!rows.length && scopeMatches && currentJob) rows = [currentJob]
  var result = null
  for (var i = 0; i < rows.length; i++) {
    var job = rows[i]
    if (conversationId === "") {
      if (!scopeMatches || !currentJob || job.id !== currentJob.id || String(job.id) === previousId) continue
    } else if (String(job.conversationId || job.id) !== conversationId) continue
    if (!result || createdOrder(job) > createdOrder(result)) result = job
  }
  return result
}
function pendingLimit(messages, text) {
  if (messages.length >= 20) return "The queue is full. Wait for a reply or remove a pending message."
  var size = text.length
  for (var i = 0; i < messages.length; i++) size += messages[i].length
  if (text.length > 65536 || size > 262144) return "This pending message is too long. Shorten it before sending."
  return ""
}
