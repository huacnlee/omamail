.pragma library

.import "../../../providers/Exchange.js" as Provider

// What the legacy provider functions would say for an Exchange mailbox, for the
// tests that still ask them; `tests/provider_domain_parity.json` holds the
// backend to these. Without this file the oracle registry answers for an id it
// does not know the way Gmail would.

var ID = Provider.ID
var NAME = Provider.NAME
var SUMMARY = Provider.SUMMARY
var AUTH = Provider.AUTH
var MAILBOXES = Provider.MAILBOXES

// A typed search is the text filter and nothing else, so a phrase, an
// apostrophe and a colon reach the server unaltered.
function searchQuery(text) {
  var value = String(text === undefined || text === null ? "" : text).trim()
  return value === "" ? "" : "text:" + value
}

// A row known to be in Junk or Trash is outside the search being previewed.
function cachedSummaryInSearch(sourceQuery, summary) {
  var labels = summary && Array.isArray(summary.labelIds) ? summary.labelIds : []
  for (var i = 0; i < labels.length; i++) {
    var label = String(labels[i] || "").toUpperCase()
    if (label === "SPAM" || label === "TRASH") return false
  }
  return !/(^|\s)role:(junk|trash)(\s|$)/.test(String(sourceQuery || "").trim().toLowerCase())
}

// No folders of its own, no addresses to search by, and no web UI.
function labelQuery(name) { return "" }
function addressQuery(field, address) { return "" }
function webMessageUrl(id) { return "" }
function webBoxUrl(query) { return "" }

function detail(account) {
  return Provider.detail(account)
}
