const assert = require("assert")
const { load, deepEqual } = require("./load")

const provider = load("providers/Registry.js")

// ------------------------------------------------------------- the registry
//
// Three providers, and the ids are what an accounts.json holds — renaming one
// silently orphans every account already written with the old name.

deepEqual(provider.ids(), ["gmail", "imap", "hey"])
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
assert.strictEqual(provider.can("gmail", "invented"), false, "an unknown capability is a no")
assert.strictEqual(provider.can("hey", "send"), false, "HEY has nothing behind it")

// HEY is present as a future integration, but cannot connect until its client
// exists.
assert.strictEqual(provider.isConnectable("gmail"), true)
assert.strictEqual(provider.isConnectable("imap"), true)
assert.strictEqual(provider.isConnectable("hey"), false)

assert.strictEqual(provider.unavailableReason("gmail"), "")
assert.strictEqual(provider.unavailableReason("imap"), "")

// --------------------------------------------------------------- mailboxes

// The glyphs ActionIcon actually draws. A mailbox naming anything else renders
// as nothing at all.
const DRAWN = ["inbox", "unread", "star", "send", "archive", "trash"]

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
assert.strictEqual(provider.mailboxFor("gmail", "nonesuch").key, "inbox",
  "an unknown mailbox key falls back to the inbox rather than to undefined")
assert.strictEqual(provider.mailboxFor("imap", "starred").label, "Flagged",
  "IMAP calls it what the protocol calls it")

// ----------------------------------------------------------------- queries

// Gmail's queries are its own search operators, unchanged from what shipped.
assert.strictEqual(provider.query("gmail", "inbox", "", ""), "in:inbox")
assert.strictEqual(provider.query("gmail", "starred", "", ""), "is:starred")
assert.strictEqual(provider.query("gmail", "trash", "", ""), "in:trash")

// IMAP's are the folder DSL.
assert.strictEqual(provider.query("imap", "inbox", "", ""), "folder:INBOX")
assert.strictEqual(provider.query("imap", "unread", "", ""), "folder:INBOX UNSEEN")
assert.strictEqual(provider.query("imap", "sent", "", ""), "folder:\\Sent")

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

// The badge counts what the Unread mailbox holds, by lookup rather than by a
// second definition that could drift from the first.
assert.strictEqual(provider.unreadQuery("gmail"), "in:inbox is:unread category:primary")
assert.strictEqual(provider.unreadQuery("imap"), "folder:INBOX UNSEEN")

// Selecting a label in the sidebar is a different act from typing in the search
// box, even though both end in a query. Routing it through `query` would wrap an
// IMAP folder in a TEXT search — which looks for the folder's own name inside
// the inbox rather than opening it.
assert.strictEqual(provider.labelQuery("gmail", "Receipts"), "label:Receipts")
assert.strictEqual(provider.labelQuery("imap", "Receipts"), "folder:\"Receipts\"")
assert.strictEqual(provider.labelQuery("imap", "Old Mail"), "folder:\"Old Mail\"",
  "a folder name with a space has to arrive quoted")
assert.strictEqual(provider.labelQuery("hey", "Anything"), "")
assert.strictEqual(provider.labelQuery("imap", ""), "")
assert.strictEqual(provider.labelQuery("imap", "   "), "")

// And the result must be a folder query the DSL can read back, not a search.
assert.ok(provider.labelQuery("imap", "Old Mail").indexOf("TEXT") < 0)

// ------------------------------------------------------------------- auth

assert.strictEqual(provider.authKind("gmail"), "oauth")
assert.strictEqual(provider.authKind("imap"), "password")
assert.strictEqual(provider.authKind("hey"), "none")
assert.strictEqual(provider.usesOAuth("gmail"), true)
assert.strictEqual(provider.usesOAuth("imap"), false)
assert.strictEqual(provider.usesPassword("imap"), true)
assert.strictEqual(provider.usesPassword("gmail"), false)

assert.strictEqual(provider.badge("imap"), "IMAP")
assert.ok(provider.summary("imap").length > 0)
assert.strictEqual(provider.DEFAULT_ID, "gmail",
  "an account written before providers existed is a Gmail account")

console.log("Provider.js ok")
