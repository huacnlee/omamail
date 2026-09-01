const assert = require("assert")
const { load, deepEqual } = require("./load")

const recovery = load("compose/Recovery.js")

const draft = {
  accountId: "me@example.com",
  sourceDraftId: "draft-7",
  mode: "reply",
  threadId: "thread-7",
  inReplyTo: "<message-7@example.com>",
  fromEmail: "alias@example.com",
  to: "jane@example.com",
  cc: "copy@example.com",
  bcc: "",
  subject: "Quarterly plan",
  body: "First draft",
  ccVisible: true,
  bccVisible: false,
  fromWasChosen: true,
  replyRecipients: [{ email: "jane@example.com" }],
  originalAttachments: [],
  forwardedAttachments: [],
  draftAttachments: [{
    filename: "plan.txt", mimeType: "text/plain", size: 10,
    path: "/tmp/plan.txt", owned: true
  }]
}

deepEqual(recovery.parse(""), recovery.empty())
deepEqual(recovery.parse("not json"), recovery.empty())
deepEqual(recovery.parse('{"version":2,"active":true}'), recovery.empty())
deepEqual(recovery.parse('{"version":1,"active":false}'), recovery.empty())

const encoded = recovery.serialize("reader", draft)
const parsed = recovery.parse(encoded)
assert.strictEqual(parsed.active, true)
assert.strictEqual(parsed.returnView, "reader")
assert.strictEqual(parsed.draft.sourceDraftId, "draft-7")
deepEqual(parsed.draft, recovery.draft(draft))
assert.strictEqual(parsed.draft.draftAttachments[0].data, "",
  "a file path is durable, so autosave does not rewrite its base64 on every key")

assert.strictEqual(recovery.hasMeaningfulDraft({ subject: " Plan " }), true)
assert.strictEqual(recovery.hasMeaningfulDraft({ body: "\n\n" }), false)
assert.strictEqual(recovery.hasMeaningfulDraft({
  draftAttachments: [{ filename: "plan.txt" }]
}), true)
assert.strictEqual(recovery.serialize("list", { body: "  " }), "")

const unsafe = JSON.parse(encoded)
unsafe.draft.extra = "drop me"
unsafe.draft.draftAttachments[0].extra = "drop me"
const cleaned = recovery.parse(JSON.stringify(unsafe))
assert.strictEqual(cleaned.draft.extra, undefined)
assert.strictEqual(cleaned.draft.draftAttachments[0].extra, undefined)
