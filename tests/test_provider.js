const assert = require("assert")
const { load, deepEqual } = require("./load")

const provider = load("providers/Registry.js")

// ------------------------------------------------------------- the registry
//
// Four providers, and the ids are what an accounts.json holds — renaming one
// silently orphans every account already written with the old name.
//
// The order is the order the chooser lists them in: the two hosted mailboxes
// with a service of their own, then the two that are every other mailbox. IMAP
// is last because it is the catch-all, and JMAP goes in front of it because a
// server that speaks both is better read over JMAP.
deepEqual(provider.ids(), ["gmail", "outlook", "hey", "jmap", "imap"])
assert.strictEqual(provider.get("gmail").name, "Gmail")
assert.strictEqual(provider.get("outlook").name, "Outlook")
assert.strictEqual(provider.get("imap").name, "IMAP")
assert.strictEqual(provider.get("hey").name, "HEY")
assert.strictEqual(provider.get("jmap").name, "JMAP")
assert.strictEqual(provider.exists("jmap"), true)

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
assert.strictEqual(provider.can("outlook", "labels"), false)
assert.strictEqual(provider.can("gmail", "manageLabels"), true)
assert.strictEqual(provider.can("imap", "manageLabels"), true)
assert.strictEqual(provider.can("hey", "manageLabels"), false, "HEY's labels are HEY's own")

// Mail from or to an address, in each provider's own words.
assert.strictEqual(provider.addressQuery("gmail", "from", "ada@example.com"), "from:ada@example.com")
assert.strictEqual(provider.addressQuery("gmail", "to", " ada@example.com "), "to:ada@example.com")
assert.strictEqual(provider.addressQuery("gmail", "from", "a b"), "", "a space would end the operator")
assert.strictEqual(provider.addressQuery("imap", "from", "ada@example.com"), 'folder:INBOX FROM "ada@example.com"')
assert.strictEqual(provider.addressQuery("imap", "to", 'a"b'), 'folder:INBOX TO "a\\"b"')
assert.strictEqual(provider.addressQuery("hey", "to", "ada@example.com"), "search:ada@example.com")
assert.strictEqual(provider.addressQuery("imap", "from", ""), "")

// The operators people bring from webmail, in IMAP's words.
assert.strictEqual(provider.query("imap", "inbox", "from: ada@example.com", ""),
  'folder:INBOX FROM "ada@example.com"', "a webmail from: operator, space and all, becomes the IMAP criterion")
assert.strictEqual(provider.query("imap", "inbox", "to:*@example.com invoice", ""),
  'folder:INBOX TO "@example.com" TEXT "invoice"', "wildcards go: IMAP criteria already match substrings")
assert.strictEqual(provider.query("imap", "inbox", "plain words", ""),
  'folder:INBOX TEXT "plain words"', "words without an operator stay one TEXT criterion")
assert.strictEqual(provider.query("imap", "inbox", 'from:"Jane Doe" report', ""),
  'folder:INBOX FROM "Jane Doe" TEXT "report"', "a quoted operator value keeps its spaces")
assert.strictEqual(provider.query("imap", "inbox", "from:", ""),
  'folder:INBOX TEXT "from:"', "an operator with no value searches for what was typed, not for everything")
assert.strictEqual(provider.query("imap", "inbox", "from:*", ""),
  'folder:INBOX TEXT "from:*"', "a wildcard alone is not a criterion either")
assert.strictEqual(provider.query("imap", "inbox", "from:*** invoice", ""),
  'folder:INBOX TEXT "from:*** invoice"', "an operator that strips to nothing is not quietly dropped")
// Separate questions. `labels` is whether a message can carry several at once,
// which is what the reader's strip draws; `move` is whether the user gets to
// say where it goes. IMAP answers no and yes -- one folder per message is the
// very thing that makes a move the plain operation there.
assert.strictEqual(provider.can("gmail", "move"), true)
assert.strictEqual(provider.can("imap", "move"), true)
assert.strictEqual(provider.can("outlook", "move"), true)
assert.strictEqual(provider.can("hey", "move"), false, "HEY's destinations are its own")
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
assert.strictEqual(provider.can("outlook", "webBox"), false)

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

// Having a thread id and listing conversations are two questions. HEY's rows
// already are conversations, so the panel groups nothing; Gmail has the ids and
// still lists messages, because collapsing its list would cost a `threads.get`
// per thread; IMAP has neither.
assert.strictEqual(provider.can("hey", "conversations"), true, "a HEY row is a topic")
assert.strictEqual(provider.can("gmail", "conversations"), false,
  "Gmail has thread ids and still lists messages")
assert.strictEqual(provider.can("imap", "conversations"), false)
assert.strictEqual(provider.can("gmail", "threads"), true,
  "and the two answers are independent of each other")

// ---------------------------------------------------------- refusals
//
// A provider's list is a ceiling, not a promise every account of that kind can
// keep: one server has an Archive folder and trains on its Junk, the next has
// neither. So an account may withdraw a capability its provider declares — and
// may never add one, which is what keeps the button rule above from being
// argued back open one account at a time.

// No third argument, and null, answer exactly as the ceiling does. That is what
// makes the hook provider-neutral: Gmail, HEY and IMAP expose no refusals at
// all and nothing about them changes.
assert.strictEqual(provider.can("gmail", "archive"), true)
assert.strictEqual(provider.can("gmail", "archive", null), true)
assert.strictEqual(provider.can("gmail", "archive", undefined), true)
assert.strictEqual(provider.can("gmail", "archive", {}), true,
  "an object with no key for it says nothing about it")

// A refused capability is a no, whatever the ceiling said.
const refusals = {
  archive: "This account has no Archive mailbox",
  spam: "This server is not known to learn from its Junk mailbox"
}
assert.strictEqual(provider.can("gmail", "archive", refusals), false)
assert.strictEqual(provider.can("gmail", "spam", refusals), false)
assert.strictEqual(provider.can("gmail", "star", refusals), true,
  "a refusal takes away only the keys it names")

// And a refusal cannot hand an account something its provider does not have.
// The one direction this seam runs in is the whole of its safety argument.
assert.strictEqual(provider.can("hey", "archive", { archive: "" }), false)
assert.strictEqual(provider.can("imap", "spam", { spam: "" }), false)
assert.strictEqual(provider.can("hey", "star", { star: "of course it can" }), false)

// The reason, for the note shown when a key reaches an action the account
// cannot honour. Empty where nothing was refused — including where the ceiling
// never offered it, since there is nothing there to withdraw and the provider's
// own wording is the honest answer.
assert.strictEqual(provider.refusal("gmail", "archive", refusals),
  "This account has no Archive mailbox")
assert.strictEqual(provider.refusal("gmail", "spam", refusals),
  "This server is not known to learn from its Junk mailbox")
assert.strictEqual(provider.refusal("gmail", "star", refusals), "")
assert.strictEqual(provider.refusal("gmail", "archive", null), "")
assert.strictEqual(provider.refusal("gmail", "archive"), "")
assert.strictEqual(provider.refusal("hey", "archive", { archive: "not this way" }), "",
  "a ceiling that never offered it has nothing to explain")

// Every provider here can be connected to. The `unavailable` seam is kept for
// the next one that cannot be, which is what HEY was until `hey` shipped.
assert.strictEqual(provider.isConnectable("gmail"), true)
assert.strictEqual(provider.isConnectable("imap"), true)
assert.strictEqual(provider.isConnectable("hey"), true)
assert.strictEqual(provider.isConnectable("outlook"), true)

assert.strictEqual(provider.unavailableReason("gmail"), "")
assert.strictEqual(provider.unavailableReason("imap"), "")
assert.strictEqual(provider.unavailableReason("hey"), "")

// --------------------------------------------------------------- mailboxes

// The glyphs ActionIcon actually draws. A mailbox naming anything else renders
// as nothing at all.
const DRAWN = ["inbox", "unread", "star", "sent", "archive", "trash", "spam", "reply", "pin", "label", "compose"]

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

// Spam is reachable on the rail rather than only by knowing to type `in:spam`.
// HEY is left out on purpose: `hey spam` moves a thread and trains the filter,
// but the CLI serves no spam box to list, and a mailbox that cannot be opened
// is worse than none.
for (const id of ["gmail", "imap"]) {
  const spam = provider.mailboxes(id).filter(box => box.key === "spam")
  assert.strictEqual(spam.length, 1, id + " has one spam mailbox")
  assert.ok(spam[0].optional, id + "/spam yields the strip before the inbox does")
}
assert.strictEqual(provider.mailboxes("hey").filter(box => box.key === "spam").length, 0)

// A mutation of the returned list must not reach the provider definition.
const boxes = provider.mailboxes("gmail")
boxes.push({ key: "invented" })
assert.strictEqual(provider.mailboxes("gmail").length, boxes.length - 1,
  "the mailbox list is copied on the way out")

// Which rail rows exist is a fact about the provider; which of them this
// account actually has a mailbox for is a fact about the account. A row with
// nothing behind it is dropped rather than drawn dead — and because the number
// keys are positional, the rows below it move up.
const imapKeys = provider.mailboxes("imap").map(box => box.key)
deepEqual(provider.mailboxes("imap", null).map(box => box.key), imapKeys,
  "no absent list is the whole list")
deepEqual(provider.mailboxes("imap", []).map(box => box.key), imapKeys)
deepEqual(provider.mailboxes("imap", "archive").map(box => box.key), imapKeys,
  "and so is anything that is not a list")

const withoutArchive = provider.mailboxes("imap", ["archive"])
assert.strictEqual(withoutArchive.filter(box => box.key === "archive").length, 0)
assert.strictEqual(withoutArchive.length, imapKeys.length - 1)
assert.strictEqual(withoutArchive.indexOf(withoutArchive.filter(box => box.key === "spam")[0]),
  imapKeys.indexOf("spam") - 1, "Junk moves up when Archive is not there")

deepEqual(provider.mailboxes("imap", ["archive", "spam", "trash"]).map(box => box.key),
  imapKeys.filter(key => key !== "archive" && key !== "spam" && key !== "trash"))
deepEqual(provider.mailboxes("imap", ["nonesuch"]).map(box => box.key), imapKeys,
  "a key this provider never had drops nothing")

// The copy rule survives the argument.
const dropped = provider.mailboxes("imap", ["archive"])
dropped.push({ key: "invented" })
assert.strictEqual(provider.mailboxes("imap", ["archive"]).length, dropped.length - 1)

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
assert.strictEqual(provider.query("outlook", "unread", "", ""), "folder:INBOX UNSEEN")

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
assert.strictEqual(provider.query("outlook", "inbox", "", "in:inbox"), "folder:INBOX")

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
assert.strictEqual(provider.unreadQuery("outlook"), "folder:INBOX UNSEEN")
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
assert.strictEqual(provider.webHomeUrl("outlook"), "https://outlook.live.com/mail/")

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
assert.strictEqual(provider.logo("outlook"), "")

// ------------------------------------------------------------------- auth

assert.strictEqual(provider.authKind("gmail"), "oauth")
assert.strictEqual(provider.authKind("outlook"), "oauth")
assert.strictEqual(provider.authKind("imap"), "password")
// A sign-in this plugin does not perform itself: `hey` owns the browser, the
// token and the keyring entry it lives in.
assert.strictEqual(provider.authKind("hey"), "cli")
assert.strictEqual(provider.usesCli("hey"), true)
assert.strictEqual(provider.usesCli("gmail"), false)
assert.strictEqual(provider.usesOAuth("hey"), false)
assert.strictEqual(provider.usesPassword("hey"), false)
assert.strictEqual(provider.usesOAuth("gmail"), true)
assert.strictEqual(provider.usesOAuth("outlook"), true)
assert.strictEqual(provider.usesOAuth("imap"), false)
assert.strictEqual(provider.usesPassword("imap"), true)
assert.strictEqual(provider.usesPassword("gmail"), false)

assert.strictEqual(provider.badge("imap"), "IMAP")
assert.strictEqual(provider.badge("jmap"), "JMAP", "the switcher badge is the protocol, no host")
assert.ok(provider.summary("imap").length > 0)

// One more line about a particular mailbox, for the row that lists them. Only
// the provider with something to add answers, and it answers from the account
// entry rather than from anything the panel holds.
assert.strictEqual(provider.detail("gmail", { email: "ada@gmail.com" }), "")
assert.strictEqual(provider.detail("hey", {}), "")
assert.strictEqual(provider.detail("imap", { imap: { imapHost: "imap.example.org" } }), "")
assert.strictEqual(
  provider.detail("jmap", { jmap: { sessionUrl: "https://mail.example.org/jmap/session" } }),
  "JMAP · mail.example.org")
assert.strictEqual(provider.detail("jmap", {}), "JMAP",
  "a mailbox that has not signed in yet still says what kind it is")
assert.strictEqual(provider.detail("jmap", null), "JMAP")
assert.strictEqual(provider.DEFAULT_ID, "gmail",
  "an account written before providers existed is a Gmail account")

console.log("Provider.js ok")
