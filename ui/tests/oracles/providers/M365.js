.pragma library

.import "../../../providers/M365.js" as Provider

// What the legacy provider functions say for a Microsoft 365 mailbox. The
// description is the real one; only the query function is restated here, because
// production has none: the backend resolves them.

var ID = Provider.ID
var NAME = Provider.NAME
var SUMMARY = Provider.SUMMARY
var AUTH = Provider.AUTH
var MAILBOXES = Provider.MAILBOXES

// A typed search runs against the whole mailbox: the words are the text filter.
function searchQuery(text) {
  var value = String(text === undefined || text === null ? "" : text).trim()
  return value === "" ? "" : "text:" + value
}
