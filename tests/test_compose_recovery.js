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

// A body still exactly as the compose window placed it is a window nobody
// wrote in. Recovering one would offer back a draft the user never started.
assert.strictEqual(recovery.hasMeaningfulDraft({
  body: "\n\nMaarten", placedBody: "\n\nMaarten"
}), false, "an untouched signed compose is not a draft")
assert.strictEqual(recovery.hasMeaningfulDraft({
  body: "Something\n\nMaarten", placedBody: "\n\nMaarten"
}), true, "a sentence above the sign-off is")
assert.strictEqual(recovery.hasMeaningfulDraft({
  body: "\n\nMaarten", placedBody: "\n\nMaarten", bodyWasEdited: true
}), true, "typing and deleting back to the sign-off is still an edit")

// A row written before placedBody existed has none, so any body at all differs
// from it and the draft is still offered back.
assert.strictEqual(recovery.hasMeaningfulDraft({ body: "\n\nMaarten" }), true)
// Kept verbatim rather than trimmed: what was placed begins with the blank
// lines the user types into, and a trimmed copy would never equal the body it
// is compared against.
assert.strictEqual(recovery.draft({ placedBody: "\n\nMaarten" }).placedBody, "\n\nMaarten")
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
