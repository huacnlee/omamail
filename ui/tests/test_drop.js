const assert = require("assert")
const { load } = require("./load")

const drop = load("account/Drop.js")

const inbox = { mailboxKey: "inbox", searchQuery: "", rawQuery: "", rawLabelId: "", canReportSpam: true }
const plain = { id: "1", unread: false, starred: false, labelIds: ["INBOX"] }

// Inbox is where the email already is; Archive, Trash and Spam are not.
assert.strictEqual(drop.wouldAct("mailbox", "inbox", inbox, [plain]), false)
assert.strictEqual(drop.wouldAct("mailbox", "archive", inbox, [plain]), true)
assert.strictEqual(drop.wouldAct("mailbox", "trash", inbox, [plain]), true)

// A provider with no junk verb offers no Spam row.
assert.strictEqual(drop.wouldAct("mailbox", "spam", Object.assign({}, inbox, { canReportSpam: false }), [plain]), false)

// Star toggles, so a drop on Starred must only ever add the star.
assert.strictEqual(drop.wouldAct("mailbox", "starred", inbox, [plain]), true)
assert.strictEqual(drop.wouldAct("mailbox", "starred", inbox, [Object.assign({}, plain, { starred: true })]), false)
assert.strictEqual(drop.wouldAct("mailbox", "unread", inbox, [Object.assign({}, plain, { unread: true })]), false)
assert.strictEqual(drop.wouldAct("mailbox", "unread", inbox, [plain]), true)

// All mail archives from the Inbox and restores from the Trash, and is no
// target anywhere else.
assert.strictEqual(drop.verbFor("all", inbox), "archive")
assert.strictEqual(drop.verbFor("all", Object.assign({}, inbox, { mailboxKey: "trash" })), "untrash")
assert.strictEqual(drop.wouldAct("mailbox", "all", Object.assign({}, inbox, { mailboxKey: "sent" }), [plain]), false)
assert.strictEqual(drop.wouldAct("mailbox", "all", inbox, [plain]), true)

// Sent and Drafts take nothing.
assert.strictEqual(drop.verbFor("sent", inbox), "")
assert.strictEqual(drop.wouldAct("mailbox", "sent", inbox, [plain]), false)

// A label is refused when every email already has it, or when it is open.
assert.strictEqual(drop.wouldAct("label", "Label_1", inbox, [plain]), true)
assert.strictEqual(drop.wouldAct("label", "INBOX", inbox, [plain]), false)
assert.strictEqual(drop.wouldAct("label", "Label_1", Object.assign({}, inbox, { rawQuery: "label:x", rawLabelId: "Label_1" }), [plain]), false)

// Nothing dragged, nothing to drop.
assert.strictEqual(drop.wouldAct("label", "Label_1", inbox, []), false)

console.log("drop ok")
