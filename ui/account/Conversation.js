.pragma library
.import "../message/Message.js" as Mail

// Compatibility accessors used by Model.js's row presentation helpers.
// Selection, summary organization and rail projections run in Rust.
var MINIMUM_MEMBERS = 2
function blockOf(value) {
  if (!value || typeof value !== "object") return null
  return Mail.normalizeThread(value, "")
}
function holdsMember(block, id) {
  var thread = blockOf(block)
  return !!thread && thread.memberIds.indexOf(String(id || "").trim()) >= 0
}
function memberHasLabel(summary, label) {
  if (!summary || typeof summary !== "object") return false
  var wanted = String(label || "").trim().toUpperCase()
  if (Array.isArray(summary.labelIds)) return summary.labelIds.indexOf(wanted) >= 0
  return wanted === "UNREAD" ? summary.unread === true
    : wanted === "STARRED" && summary.starred === true
}
