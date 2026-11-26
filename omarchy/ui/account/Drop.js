.pragma library

// What dropping dragged emails on a sidebar row means. App.qml holds the drag;
// these rules decide which rows take a drop and which verb a mailbox runs.

var VERBS = { inbox: "unarchive", archive: "archive", trash: "trash", spam: "spam",
  starred: "star", unread: "markUnread" }

// `view` is the open mailbox: { mailboxKey, searchQuery, rawQuery, rawLabelId,
// canReportSpam }. `rows` are the dragged summaries.
function viewing(view) {
  return view.rawQuery === "" && view.searchQuery === ""
}

// False where a drop would change nothing, so the rail does not offer it.
// `star` toggles, so Starred and Unread take a drop only if it adds the flag.
function wouldAct(kind, key, view, rows) {
  if (rows.length === 0) return false
  if (kind === "mailbox") {
    if (!VERBS[key] && key !== "all") return false
    if (viewing(view) && view.mailboxKey === key) return false
    if (key === "spam" && view.canReportSpam === false) return false
    // All mail holds everything: Inbox archives into it and Trash restores to it.
    if (key === "all") return viewing(view) && (view.mailboxKey === "inbox" || view.mailboxKey === "trash")
    if (key === "unread") return rows.some(function(r) { return !r.unread })
    if (key === "starred") return rows.some(function(r) { return !r.starred })
    return true
  }
  if (view.rawQuery !== "" && view.rawLabelId === key) return false
  return rows.some(function(r) { return (r.labelIds || []).indexOf(key) < 0 })
}

// The verb a mailbox row runs, or "" for one that takes no drop.
function verbFor(key, view) {
  if (key === "all") return view.mailboxKey === "trash" ? "untrash" : "archive"
  return VERBS[key] || ""
}
