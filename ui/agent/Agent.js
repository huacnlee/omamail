.pragma library

// UI labels, editable prompts and local composer/queue interaction.
// Job parsing, ownership, attention, history and payload construction live in
// Rust; their historical JS baselines are confined to tests/oracles/agent.

var ACTIVE = ["queued", "running"]

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

var MAIL_ASKS = [
  {label: "Summarize", prompt: "Summarize this mail and highlight its key points."},
  {label: "Explain", prompt: "Explain this mail in plain language, including any unfamiliar terms."},
  {label: "Action items", prompt: "List the requested actions, deadlines, and open questions in this mail."},
  {label: "Draft a reply", prompt: "Draft a reply to this mail. Flag any missing information instead of inventing facts."},
  {label: "Translate to Chinese", prompt: "Translate only the mail title and body into Chinese. Exclude sender, recipients, dates, metadata, and instructions."},
  {label: "Translate to English", prompt: "Translate only the mail title and body into English. Exclude sender, recipients, dates, metadata, and instructions."}
]

function isActive(job) {
  return !!job && ACTIVE.indexOf(String(job.state || "")) >= 0
}

function glyphState(job) {
  if (!job) return ""
  var state = String(job.state || "")
  if (state === "queued" || state === "running") return "running"
  if (state === "done") return String(job.question || "") !== "" ? "question" : "done"
  if (state === "failed") return "failed"
  if (state === "cancelled") return "cancelled"
  return ""
}

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

function detailText(job) {
  if (!job) return ""
  if (String(job.question || "") !== "") return String(job.question)
  if (String(job.error || "") !== "") return String(job.error)
  return String(job.summary || "")
}

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

function pluralizeMessages(count) {
  var n = Math.max(0, Math.floor(Number(count) || 0))
  return n === 1 ? "1 message" : n + " messages"
}

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

// Editor change indicator only; ownership remains accountId plus draftKey.
function draftFingerprint(fields) {
  var v = fields || {}
  var text = JSON.stringify([v.from || "", v.to || "", v.subject || "", v.body || ""])
  var hash = 2166136261
  for (var i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = (hash * 16777619) >>> 0 }
  return String(hash)
}

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

function historyLabel(job) {
  return new Date(Number(job.created || 0) * 1000).toLocaleString() + " · " + String(job.requestPreview || job.subject || "Conversation")
}

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
