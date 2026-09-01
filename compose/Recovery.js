.pragma library

var VERSION = 1

function empty() {
  return { active: false, returnView: "", draft: null }
}

function text(value) {
  return String(value || "")
}

function person(value) {
  var row = value && typeof value === "object" ? value : ({})
  return { email: text(row.email), display: text(row.display) }
}

function people(value) {
  var rows = Array.isArray(value) ? value : []
  var out = []
  for (var i = 0; i < rows.length; i++) out.push(person(rows[i]))
  return out
}

function attachment(value) {
  var row = value && typeof value === "object" ? value : ({})
  var path = text(row.path)
  return {
    filename: text(row.filename),
    mimeType: text(row.mimeType),
    size: Math.max(0, Math.floor(Number(row.size) || 0)),
    data: path === "" ? text(row.data) : "",
    path: path,
    owned: row.owned === true,
    attachmentId: text(row.attachmentId),
    partId: text(row.partId)
  }
}

function attachments(value) {
  var rows = Array.isArray(value) ? value : []
  var out = []
  for (var i = 0; i < rows.length; i++) out.push(attachment(rows[i]))
  return out
}

function draft(value) {
  var row = value && typeof value === "object" ? value : ({})
  return {
    to: text(row.to),
    cc: text(row.cc),
    bcc: text(row.bcc),
    subject: text(row.subject),
    body: text(row.body),
    accountId: text(row.accountId),
    sourceDraftId: text(row.sourceDraftId),
    mode: text(row.mode) || "new",
    threadId: text(row.threadId),
    inReplyTo: text(row.inReplyTo),
    ccVisible: row.ccVisible === true,
    bccVisible: row.bccVisible === true,
    fromEmail: text(row.fromEmail),
    replyRecipients: people(row.replyRecipients),
    fromWasChosen: row.fromWasChosen === true,
    originalAttachments: attachments(row.originalAttachments),
    forwardedAttachments: attachments(row.forwardedAttachments),
    draftAttachments: attachments(row.draftAttachments)
  }
}

function hasMeaningfulDraft(value) {
  var row = value && typeof value === "object" ? value : ({})
  if (text(row.to).trim() !== "") return true
  if (text(row.cc).trim() !== "") return true
  if (text(row.bcc).trim() !== "") return true
  if (text(row.subject).trim() !== "") return true
  if (text(row.body).trim() !== "") return true
  if (Array.isArray(row.forwardedAttachments) && row.forwardedAttachments.length > 0)
    return true
  return Array.isArray(row.draftAttachments) && row.draftAttachments.length > 0
}

function returnView(value) {
  var view = text(value)
  return view === "reader" || view === "calendar" ? view : "list"
}

function parse(raw) {
  var value
  try { value = JSON.parse(text(raw)) } catch (error) { return empty() }
  if (!value || typeof value !== "object" || value.version !== VERSION
      || value.active !== true) return empty()
  var saved = draft(value.draft)
  if (!hasMeaningfulDraft(saved)) return empty()
  return { active: true, returnView: returnView(value.returnView), draft: saved }
}

function serialize(view, value) {
  var saved = draft(value)
  if (!hasMeaningfulDraft(saved)) return ""
  return JSON.stringify({
    version: VERSION,
    active: true,
    returnView: returnView(view),
    draft: saved
  }) + "\n"
}
