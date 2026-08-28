const assert = require("assert")
const { load, deepEqual } = require("./load")

const provider = load("providers/Registry.js")

// ------------------------------------------------------------- the registry
//
// Three providers, and the ids are what an accounts.json holds — renaming one
// silently orphans every account already written with the old name.
//
// The order is the order the chooser lists them in: the two hosted mailboxes
// with a service of their own, then the one that is every other mailbox.
deepEqual(provider.ids(), ["gmail", "hey", "imap"])
assert.strictEqual(provider.get("gmail").name, "Gmail")
assert.strictEqual(provider.get("imap").name, "IMAP")
assert.strictEqual(provider.get("hey").name, "HEY")

// An id from a newer build, or a hand-edited file, still has to open a window.
assert.strictEqual(provider.get("nonesuch").id, "gmail")
assert.strictEqual(provider.get("").id, "gmail")
assert.strictEqual(provider.get(null).id, "gmail")
assert.strictEqual(provider.get(undefined).id, "gmail")
assert.strictEqual(provider.get("  GMAIL  ").id, "gmail", "ids are trimmed and folded")
assert.strictEqual(provider.exists("nonesuch"), false)
assert.strictEqual(provider.exists("imap"), true)

// ------------------------------------------------------------ capabilities
//
// A capability that is missing must read as "cannot". The panel hides buttons
// on these, so a typo that returned undefined would show a button that fails.

assert.strictEqual(provider.can("gmail", "labels"), true)
assert.strictEqual(provider.can("imap", "labels"), false)
assert.strictEqual(provider.can("gmail", "spam"), true)
assert.strictEqual(provider.can("imap", "spam"), false, "IMAP has no junk verb worth offering")
assert.strictEqual(provider.can("gmail", "threads"), true)
assert.strictEqual(provider.can("imap", "threads"), false)
assert.strictEqual(provider.can("imap", "star"), true, "\\Flagged is a star")
assert.strictEqual(provider.can("imap", "web"), false, "no web UI to open a message in")
assert.strictEqual(provider.can("gmail", "web"), true)

// Opening a message on the web and opening *this mailbox* on the web are two
// questions. HEY gives every thread an address of its own but has none for a
// search or a label, so the second answer is no — an "Open web inbox" there
// could only ever open the Imbox, whatever the user was looking at.
assert.strictEqual(provider.can("gmail", "webBox"), true)
assert.strictEqual(provider.can("hey", "web"), true)
assert.strictEqual(provider.can("hey", "webBox"), false)
assert.strictEqual(provider.can("imap", "webBox"), false)

// And the address builders agree with the capabilities, so a caller that asked
// anyway gets nothing rather than somewhere else's mailbox.
assert.strictEqual(provider.webMessageUrl("hey", "1:2"), "https://app.hey.com/topics/2")
assert.strictEqual(provider.webBoxUrl("hey", "box:feedbox"), "")
assert.strictEqual(provider.webBoxUrl("imap", "folder:INBOX"), "")
assert.strictEqual(provider.webBoxUrl("gmail", "in:inbox"),
  "https://mail.google.com/mail/u/0/#search/in%3Ainbox")
assert.strictEqual(provider.can("gmail", "invented"), false, "an unknown capability is a no")

// HEY's own shape. The two that are off are off because HEY has no such verb —
// a star that quietly moved a thread out of the Imbox, or an archive that filed
// it in Paper Trail, would be a promise the provider cannot keep.
assert.strictEqual(provider.can("hey", "send"), true)
assert.strictEqual(provider.can("hey", "search"), true)
assert.strictEqual(provider.can("hey", "spam"), true, "hey spam trains the filter")
assert.strictEqual(provider.can("hey", "threads"), true, "a topic is a conversation")
assert.strictEqual(provider.can("hey", "labels"), true)
assert.strictEqual(provider.can("hey", "star"), false, "HEY has no flag")
assert.strictEqual(provider.can("hey", "archive"), false, "HEY has no archive")

// Every provider here can be connected to. The `unavailable` seam is kept for
// the next one that cannot be, which is what HEY was until `hey` shipped.
assert.strictEqual(provider.isConnectable("gmail"), true)
assert.strictEqual(provider.isConnectable("imap"), true)
assert.strictEqual(provider.isConnectable("hey"), true)

assert.strictEqual(provider.unavailableReason("gmail"), "")
assert.strictEqual(provider.unavailableReason("imap"), "")
assert.strictEqual(provider.unavailableReason("hey"), "")

// --------------------------------------------------------------- mailboxes

// The glyphs ActionIcon actually draws. A mailbox naming anything else renders
// as nothing at all.
const DRAWN = ["inbox", "unread", "star", "send", "archive", "trash", "reply", "pin", "label", "compose"]

// Every provider's first mailbox is its inbox: `mailboxFor` falls back to it,
// which is what a key belonging to another provider lands on mid-switch.
const ids = provider.ids()
for (const id of ids) {
  const boxes = provider.mailboxes(id)
  assert.ok(boxes.length > 0, id + " has mailboxes")
  assert.ok(boxes[0].key === "inbox" || boxes[0].key === "imbox",
    id + " leads with its inbox")
  for (const box of boxes) {
    // The sidebar is icon-first and collapses to a strip of glyphs, so a
    // mailbox whose icon ActionIcon cannot draw is an invisible row.
    assert.ok(DRAWN.indexOf(box.icon) >= 0,
      id + "/" + box.key + " has no drawable icon: " + box.icon)
    assert.ok(box.label !== "", id + "/" + box.key + " needs a label for its tooltip")
  }
}

// A mutation of the returned list must not reach the provider definition.
const boxes = provider.mailboxes("gmail")
boxes.push({ key: "invented" })
assert.strictEqual(provider.mailboxes("gmail").length, boxes.length - 1,
  "the mailbox list is copied on the way out")

assert.strictEqual(provider.hasMailbox("gmail", "all"), true)
assert.strictEqual(provider.hasMailbox("imap", "all"), false, "IMAP has Archive, not All mail")
assert.strictEqual(provider.hasMailbox("imap", "archive"), true)
assert.strictEqual(provider.hasMailbox("gmail", "drafts"), true)
assert.strictEqual(provider.hasMailbox("hey", "drafts"), true)
assert.strictEqual(provider.hasMailbox("imap", "drafts"), true)
assert.strictEqual(provider.mailboxFor("gmail", "nonesuch").key, "inbox",
  "an unknown mailbox key falls back to the inbox rather than to undefined")
assert.strictEqual(provider.mailboxFor("imap", "starred").label, "Flagged",
  "IMAP calls it what the protocol calls it")

// ----------------------------------------------------------------- queries

// Gmail's queries are its own search operators, unchanged from what shipped.
assert.strictEqual(provider.query("gmail", "inbox", "", ""), "in:inbox")
assert.strictEqual(provider.query("gmail", "starred", "", ""), "is:starred")
assert.strictEqual(provider.query("gmail", "trash", "", ""), "in:trash")
assert.strictEqual(provider.query("gmail", "drafts", "", ""), "in:drafts")

// IMAP's are the folder DSL.
assert.strictEqual(provider.query("imap", "inbox", "", ""), "folder:INBOX")
assert.strictEqual(provider.query("imap", "unread", "", ""), "folder:INBOX UNSEEN")
assert.strictEqual(provider.query("imap", "sent", "", ""), "folder:\\Sent")
assert.strictEqual(provider.query("imap", "drafts", "", ""), "folder:\\Drafts")

// A typed search wins over everything, and is shaped by the provider.
assert.strictEqual(provider.query("gmail", "trash", "from:jane", ""), "from:jane",
  "Gmail takes the user's search operators verbatim")
assert.strictEqual(provider.query("imap", "trash", "invoice", ""),
  "folder:INBOX TEXT \"invoice\"")
assert.strictEqual(provider.query("imap", "inbox", "say \"hi\"", ""),
  "folder:INBOX TEXT \"say \\\"hi\\\"\"", "a quote in a search term is escaped")

// The configured default is described as a default *search*, so it applies to
// the inbox and to nothing else — filtering Trash is not what it promised.
assert.strictEqual(provider.query("gmail", "inbox", "", "in:inbox -category:promotions"),
  "in:inbox -category:promotions")
assert.strictEqual(provider.query("gmail", "trash", "", "in:inbox -category:promotions"),
  "in:trash", "the default query does not leak into other mailboxes")
assert.strictEqual(provider.query("gmail", "inbox", "urgent", "in:inbox -category:promotions"),
  "urgent", "a typed search beats the default")
assert.strictEqual(provider.query("gmail", "inbox", "   ", ""), "in:inbox",
  "whitespace is not a search")
// The plugin-wide default is Gmail syntax. It must not become an IMAP SEARCH
// command after a password-provider account signs in, or the first list
// request is rejected and the mailbox stays empty.
assert.strictEqual(provider.query("imap", "inbox", "", "in:inbox"), "folder:INBOX")
assert.strictEqual(provider.query("hey", "inbox", "", "in:inbox"), "box:imbox")

// HEY's own queries, which the client reads back as commands.
assert.strictEqual(provider.query("hey", "inbox", "", ""), "box:imbox")
assert.strictEqual(provider.query("hey", "feed", "", ""), "box:feedbox")
assert.strictEqual(provider.query("hey", "trash", "", ""), "box:trash")
assert.strictEqual(provider.query("hey", "drafts", "", ""), "drafts:")
assert.strictEqual(provider.query("hey", "inbox", "dentist", ""), "search:dentist")

// A cached preview may only draw rows the provider's live search could return.
assert.strictEqual(provider.cachedSummaryInSearch("gmail", "in:inbox",
  { labelIds: ["INBOX"] }), true)
assert.strictEqual(provider.cachedSummaryInSearch("gmail", "in:trash",
  { labelIds: ["TRASH"] }), false)
assert.strictEqual(provider.cachedSummaryInSearch("gmail", "in:inbox",
  { labelIds: ["SPAM"] }), false)
assert.strictEqual(provider.cachedSummaryInSearch("imap", "folder:INBOX UNSEEN", {}), true)
assert.strictEqual(provider.cachedSummaryInSearch("imap", "folder:\\Sent", {}), false)
assert.strictEqual(provider.cachedSummaryInSearch("imap", "folder:\"Project Mail\"", {}), false)
assert.strictEqual(provider.cachedSummaryInSearch("hey", "box:feedbox", {}), true)
assert.strictEqual(provider.cachedSummaryInSearch("hey", "box:laterbox", {}), true)
assert.strictEqual(provider.cachedSummaryInSearch("hey", "box:asidebox", {}), true)
assert.strictEqual(provider.cachedSummaryInSearch("hey", "label:4711", {}), true)

// The badge counts what the Unread mailbox holds, by lookup rather than by a
// second definition that could drift from the first.
assert.strictEqual(provider.unreadQuery("gmail"),
  "in:inbox is:unread -category:promotions -category:social -category:forums")
assert.strictEqual(provider.unreadQuery("imap"), "folder:INBOX UNSEEN")
assert.strictEqual(provider.unreadQuery("hey"), "box:imbox unseen")

// Named by exclusion on purpose, and the reason is which way it fails. Asking
// for `category:primary` was a positive scope, and a positive scope that stops
// matching — the label is CATEGORY_PERSONAL, the API has never documented
// `category:` at all, and Smart features being off stops the labels being
// applied — leaves the mailbox and the badge empty while unread mail piles up
// behind them. The negation degrades the other way, to every unread message in
// the inbox, which is noisier and nothing worse.
assert.ok(provider.unreadQuery("gmail").indexOf("category:primary") === -1,
  "the Unread scope is not a positive category filter; it fails closed")
assert.ok(provider.unreadQuery("gmail").indexOf("-category:updates") === -1,
  "Updates carries receipts, deliveries and GitHub's notifications; it stays in")

// Selecting a label in the sidebar is a different act from typing in the search
// box, even though both end in a query. Routing it through `query` would wrap an
// IMAP folder in a TEXT search — which looks for the folder's own name inside
// the inbox rather than opening it.
assert.strictEqual(provider.labelQuery("gmail", "Receipts"), "label:Receipts")
assert.strictEqual(provider.labelQuery("imap", "Receipts"), "folder:\"Receipts\"")
assert.strictEqual(provider.labelQuery("imap", "Old Mail"), "folder:\"Old Mail\"",
  "a folder name with a space has to arrive quoted")
// HEY addresses a label by the id `hey labels` gave, which is what the sidebar
// carries as a label's `rawName` — `hey label` takes nothing else.
assert.strictEqual(provider.labelQuery("hey", "4711"), "label:4711")
assert.strictEqual(provider.labelQuery("hey", ""), "")
assert.strictEqual(provider.labelQuery("imap", ""), "")
assert.strictEqual(provider.labelQuery("imap", "   "), "")

// And the result must be a folder query the DSL can read back, not a search.
assert.ok(provider.labelQuery("imap", "Old Mail").indexOf("TEXT") < 0)

// ------------------------------------------------------------- the web home

// A third web question, and the reason it is its own: HEY has a front door even
// though it has no address for an arbitrary mailbox, so the settings row can
// link out where the "Open web inbox" row cannot.
assert.strictEqual(provider.webHomeUrl("gmail"), "https://mail.google.com/mail/u/0/")
assert.strictEqual(provider.webHomeUrl("hey"), "https://app.hey.com")
assert.strictEqual(provider.webHomeUrl("imap"), "", "an IMAP server is not a website")

// ------------------------------------------------------------------ logos

// A file in `assets/`, so the setup page says which mailbox it is about before
// any of its words do. IMAP has none on purpose: it is a protocol rather than a
// brand, and no mark would be honest about the server being connected to.
// The square icon a list row wants, and the lockup a page about the service
// opens with. HEY's differ — its wordmark is more than twice as wide as it is
// tall — and a provider with only one file uses it for both.
assert.strictEqual(provider.mark("gmail"), "gmail.png")
assert.strictEqual(provider.logo("gmail"), "gmail.png", "one square mark serves both")
assert.strictEqual(provider.mark("hey"), "hey-mark.png")
assert.strictEqual(provider.logo("hey"), "hey.png")
assert.strictEqual(provider.mark("imap"), "")
assert.strictEqual(provider.logo("imap"), "")

// ------------------------------------------------------------------- auth

assert.strictEqual(provider.authKind("gmail"), "oauth")
assert.strictEqual(provider.authKind("imap"), "password")
// A sign-in this plugin does not perform itself: `hey` owns the browser, the
// token and the keyring entry it lives in.
assert.strictEqual(provider.authKind("hey"), "cli")
assert.strictEqual(provider.usesCli("hey"), true)
assert.strictEqual(provider.usesCli("gmail"), false)
assert.strictEqual(provider.usesOAuth("hey"), false)
assert.strictEqual(provider.usesPassword("hey"), false)
assert.strictEqual(provider.usesOAuth("gmail"), true)
assert.strictEqual(provider.usesOAuth("imap"), false)
assert.strictEqual(provider.usesPassword("imap"), true)
assert.strictEqual(provider.usesPassword("gmail"), false)

assert.strictEqual(provider.badge("imap"), "IMAP")
assert.ok(provider.summary("imap").length > 0)
assert.strictEqual(provider.DEFAULT_ID, "gmail",
  "an account written before providers existed is a Gmail account")

console.log("Provider.js ok")
