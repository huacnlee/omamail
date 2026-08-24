const assert = require("assert")
const { load, deepEqual } = require("./load")

const api = load("providers/JmapApi.js")

const mailboxes = [
  { id: "m-inbox", name: "Inbox", role: "inbox", sortOrder: 1, totalEmails: 7, unreadEmails: 2, unreadThreads: 2 },
  { id: "m-archive", name: "Archive", role: "archive", sortOrder: 2, totalEmails: 27, unreadEmails: 0, unreadThreads: 0 },
  { id: "m-trash", name: "Trash", role: "trash", sortOrder: 3, totalEmails: 95, unreadEmails: 1, unreadThreads: 1 },
  { id: "m-project", name: "Project A", role: null, sortOrder: 10, totalEmails: 3, unreadEmails: 1, unreadThreads: 1 }
]

// The initial session URL is the only endpoint fixed in source. Everything
// after it is accepted from the session document, including a regional host.
assert.strictEqual(api.SESSION_URL, "https://api.fastmail.com/jmap/session")
const session = api.validateSession({
  capabilities: {
    "urn:ietf:params:jmap:core": {},
    "urn:ietf:params:jmap:mail": {}
  },
  accounts: {
    account: {
      name: "reader@example.com",
      isReadOnly: true,
      accountCapabilities: { "urn:ietf:params:jmap:mail": {} }
    }
  },
  primaryAccounts: { "urn:ietf:params:jmap:mail": "account" },
  apiUrl: "https://phl.api.fastmail.com/jmap/api/",
  downloadUrl: "https://phl-www.fastmailusercontent.com/jmap/download/{accountId}/{blobId}/{name}?type={type}",
  state: "state-1"
})
assert.strictEqual(session.ok, true)
assert.strictEqual(session.accountId, "account")
assert.strictEqual(session.isReadOnly, true)
assert.strictEqual(session.apiUrl, "https://phl.api.fastmail.com/jmap/api/")
assert.strictEqual(api.validateSession({ capabilities: {}, apiUrl: "https://example.com" }).ok, false)
assert.strictEqual(api.validateSession({
  capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {} },
  accounts: { a: { accountCapabilities: { "urn:ietf:params:jmap:mail": {} } } },
  apiUrl: "http://127.0.0.1/jmap"
}).ok, false, "session endpoints must be HTTPS")

deepEqual(api.filterForQuery("role:inbox", mailboxes), {
  ok: true, error: "", filter: { inMailbox: "m-inbox" }
})
deepEqual(api.filterForQuery("role:inbox unread", mailboxes), {
  ok: true, error: "", filter: { inMailbox: "m-inbox", notKeyword: "$seen" }
})
deepEqual(api.filterForQuery("keyword:$flagged", mailboxes), {
  ok: true, error: "", filter: { hasKeyword: "$flagged" }
})
deepEqual(api.filterForQuery('mailbox:"m-project"', mailboxes), {
  ok: true, error: "", filter: { inMailbox: "m-project" }
})
deepEqual(api.filterForQuery('text:"quarterly \\"report\\""', mailboxes), {
  ok: true, error: "", filter: { text: 'quarterly "report"' }
})
assert.strictEqual(api.filterForQuery("role:sent", mailboxes).ok, false)

const calls = api.listCalls("account", { inMailbox: "m-inbox" }, 30, "0")
assert.strictEqual(calls.length, 2)
assert.strictEqual(calls[0][0], "Email/query")
assert.strictEqual(calls[0][1].calculateTotal, true)
assert.strictEqual(calls[0][1].limit, 30)
assert.strictEqual(calls[1][0], "Email/get")
deepEqual(calls[1][1]["#ids"], { resultOf: "query", name: "Email/query", path: "/ids" })

const email = {
  id: "e1",
  blobId: "raw-1",
  threadId: "t1",
  mailboxIds: { "m-inbox": true, "m-project": true },
  keywords: { "$flagged": true },
  size: 321,
  receivedAt: "2026-08-24T10:00:00Z",
  sentAt: "2026-08-24T09:59:00Z",
  preview: "Hello from the fixture",
  subject: "A subject",
  from: [{ name: "Ada", email: "ada@example.com" }],
  to: [{ name: null, email: "reader@example.com" }],
  messageId: ["<m1@example.com>"],
  bodyStructure: {
    partId: "1", type: "multipart/mixed", size: 50, subParts: [
      { partId: "1.1", type: "text/plain", charset: "utf-8", size: 12 },
      { partId: "1.2", blobId: "attachment-blob", type: "application/pdf", name: "report.pdf", disposition: "attachment", size: 1234 }
    ]
  },
  bodyValues: { "1.1": { value: "Hello, 世界" } }
}

const normalized = api.normalizeEmail(email, mailboxes)
assert.strictEqual(normalized.id, "e1")
assert.strictEqual(normalized.threadId, "t1")
assert.ok(normalized.labelIds.includes("INBOX"))
assert.ok(normalized.labelIds.includes("UNREAD"), "absence of $seen means unread")
assert.ok(normalized.labelIds.includes("STARRED"))
assert.ok(normalized.labelIds.includes("m-project"), "multi-mailbox membership survives normalization")
assert.strictEqual(normalized.payload.parts[0].body.data, "SGVsbG8sIOS4lueVjA")
assert.strictEqual(normalized.payload.parts[1].body.attachmentId, "attachment-blob")
assert.strictEqual(normalized.payload.headers[0].name, "From")
assert.strictEqual(normalized.payload.headers[0].value, '"Ada" <ada@example.com>')

const response = {
  methodResponses: [
    ["Email/query", { ids: ["e1"], position: 0, total: 2 }, "query"],
    ["Email/get", { list: [email] }, "messages"]
  ]
}
const page = api.parseListPage(response, mailboxes, 1)
assert.strictEqual(page.error, "")
deepEqual(page.page.ids, ["e1"])
deepEqual(page.page.threadIds, ["t1"])
assert.strictEqual(page.page.nextPageToken, "1")
assert.strictEqual(page.page.estimate, 2)
assert.strictEqual(page.messages[0].id, "e1")

deepEqual(api.keywordPatch(["STARRED"], ["UNREAD"]), {
  "keywords/$flagged": true,
  "keywords/$seen": true
})
deepEqual(api.keywordPatch(["UNREAD"], ["STARRED"]), {
  "keywords/$flagged": null,
  "keywords/$seen": null
})
const trash = api.movePatch(mailboxes, "trash")
assert.strictEqual(trash.ok, true)
assert.strictEqual(trash.patch["mailboxIds/m-trash"], true)
assert.strictEqual(trash.patch["mailboxIds/m-inbox"], null)

const labels = api.labelsFromMailboxes(mailboxes)
assert.strictEqual(labels[0].id, "m-inbox")
assert.strictEqual(labels[0].system, true)
assert.strictEqual(labels[3].rawName, "m-project")
deepEqual(api.labelCounts(mailboxes, "m-inbox"), {
  id: "m-inbox", unread: 2, total: 7, threadsUnread: 2
})

assert.strictEqual(api.downloadAddress(session.downloadUrl, "account", "b/1", "a b.pdf", "application/pdf"),
  "https://phl-www.fastmailusercontent.com/jmap/download/account/b%2F1/a%20b.pdf?type=application%2Fpdf")

console.log("JmapApi.js ok")
