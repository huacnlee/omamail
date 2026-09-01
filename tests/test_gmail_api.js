const assert = require("assert")
const { load, deepEqual } = require("./load")

const api = load("providers/GmailApi.js")

// ----------------------------------------------------------------- URLs
//
// Every request path is built here, and every one is checked against the
// Gmail base before a token is attached to it.

assert.strictEqual(api.safeApiUrl("/users/me/profile"),
  "https://gmail.googleapis.com/gmail/v1/users/me/profile")
assert.strictEqual(api.safeApiUrl("users/me/profile"), "", "a relative path is refused")
assert.strictEqual(api.safeApiUrl("//evil.example/x"), "https://gmail.googleapis.com/gmail/v1//evil.example/x")
assert.strictEqual(api.safeApiUrl("/users/../../x"), "", "traversal is refused")
assert.strictEqual(api.safeApiUrl("/users/me?x=\"y\""), "", "quoting is refused")
assert.strictEqual(api.safeApiUrl(""), "")
assert.strictEqual(api.safeApiUrl(null), "")

// Repeated keys matter: metadataHeaders is how Gmail is told which headers to
// return, and joining them with a comma silently returns none of them.
assert.strictEqual(
  api.appendQuery("https://x/y", { format: "metadata", metadataHeaders: ["From", "Subject"] }),
  "https://x/y?format=metadata&metadataHeaders=From&metadataHeaders=Subject")
assert.strictEqual(api.appendQuery("https://x/y", { a: "", b: null, c: undefined }), "https://x/y")
assert.strictEqual(api.appendQuery("https://x/y?a=1", { b: "2" }), "https://x/y?a=1&b=2")
assert.strictEqual(api.appendQuery("https://x/y", null), "https://x/y")
assert.strictEqual(
  api.appendQuery("https://x/y", { q: "in:inbox is:unread" }),
  "https://x/y?q=in%3Ainbox%20is%3Aunread")

// Message ids are opaque Gmail strings, but the path builder encodes anyway so
// nothing from a response body can extend the path.
assert.strictEqual(api.messagePath("18f3a"), "/users/me/messages/18f3a")
assert.strictEqual(api.messagePath("a/b"), "/users/me/messages/a%2Fb")
assert.strictEqual(api.modifyPath("18f3a"), "/users/me/messages/18f3a/modify")
assert.strictEqual(api.trashPath("18f3a"), "/users/me/messages/18f3a/trash")
assert.strictEqual(api.labelPath("INBOX"), "/users/me/labels/INBOX")
assert.strictEqual(api.sendAsPath(), "/users/me/settings/sendAs")
assert.strictEqual(api.attachmentPath("m1", "a1"), "/users/me/messages/m1/attachments/a1")
assert.strictEqual(api.draftsPath(), "/users/me/drafts")
assert.strictEqual(api.draftPath("draft/a"), "/users/me/drafts/draft%2Fa")
deepEqual(api.draftListQuery("next page"), {
  maxResults: 500,
  pageToken: "next page"
})
assert.strictEqual(api.draftIdForMessage({ drafts: [
  { id: "resource-1", message: { id: "message-1" } },
  { id: "resource-2", message: { id: "message-2" } }
] }, "message-2"), "resource-2")
assert.strictEqual(api.draftIdForMessage({ drafts: [] }, "message-2"), "")
deepEqual(api.draftBody({ raw: "encoded", threadId: "thread-1" }), {
  message: { raw: "encoded", threadId: "thread-1" }
})

deepEqual(api.listQuery("in:inbox", 25, ""), { q: "in:inbox", maxResults: 25, pageToken: "" })
assert.strictEqual(api.listQuery("", 500).maxResults, 100, "Gmail caps maxResults at 100")
assert.strictEqual(api.listQuery("", 0).maxResults, 25)
assert.strictEqual(api.listQuery("  in:inbox  ").q, "in:inbox")

// --------------------------------------------------------------- errors
//
// The raw messages are written for a server log. These are the ones a user
// reads after clicking a button.

assert.strictEqual(api.responseError(401, null, "x"), "Google rejected the session. Sign in again")
assert.strictEqual(api.responseError(404, null, "x"), "That message is no longer in the mailbox")
assert.strictEqual(api.responseError(429, null, "x"), "Gmail is rate limiting this account. Try again shortly")
assert.strictEqual(api.responseError(0, null, "x"), "Could not reach Gmail. Check the network connection")
assert.strictEqual(api.responseError(503, null, "x"), "Gmail is having trouble right now. Try again shortly")

// The single most likely first-run failure: the client exists but nobody
// pressed Enable on the API. Google's own wording buries it in a paragraph.
assert.strictEqual(
  api.responseError(403, { error: { message: "Gmail API has not been used in project 42 before or it is disabled." } }, "x"),
  "The Gmail API is not enabled for this Google Cloud project")

assert.strictEqual(
  api.responseError(403, { error: { message: "Request had insufficient authentication scopes." } }, "x"),
  "Request had insufficient authentication scopes.")
assert.strictEqual(api.responseError(400, { error: { message: "Invalid id value" } }, "x"), "Invalid id value")
assert.strictEqual(api.responseError(400, null, "fallback"), "fallback")

// An error body that echoed a token back must not reach a label intact.
assert.strictEqual(
  api.responseError(400, { error: { message: "bad token ya29.abcDEF123" } }, "x"),
  "bad token [redacted]")

assert.strictEqual(api.rateLimitSuffix("30"), " (retry in 30s)")
assert.strictEqual(api.rateLimitSuffix("120"), " (retry in 2 min)")
assert.strictEqual(api.rateLimitSuffix(""), "")
assert.strictEqual(api.rateLimitSuffix(null), "")

// -------------------------------------------------------------- parsing

const list = api.parseMessageList({
  messages: [{ id: "a", threadId: "t1" }, { id: "b", threadId: "t2" }, { threadId: "t3" }],
  nextPageToken: "PAGE2",
  resultSizeEstimate: 201
})
deepEqual(list.ids, ["a", "b"])
deepEqual(list.threadIds, ["t1", "t2"])
assert.strictEqual(list.nextPageToken, "PAGE2")
assert.strictEqual(list.estimate, 201)

// An empty mailbox comes back without a `messages` key at all rather than with
// an empty array, which is the case that crashes naive callers.
deepEqual(api.parseMessageList({ resultSizeEstimate: 0 }).ids, [])
deepEqual(api.parseMessageList(null).ids, [])

const labels = api.parseLabels({
  labels: [
    { id: "INBOX", name: "INBOX", type: "system", messagesUnread: 7, messagesTotal: 120, threadsUnread: 5 },
    { id: "Label_12", name: "Receipts", type: "user", messagesUnread: 0, messagesTotal: 9 },
    { name: "no id" }
  ]
})
assert.strictEqual(labels.length, 2)
// The system label's name is the shouty raw id; the panel shows "Inbox".
assert.strictEqual(labels[0].name, "Inbox")
assert.strictEqual(labels[0].rawName, "INBOX")
assert.strictEqual(labels[0].system, true)
assert.strictEqual(labels[0].unread, 7)
assert.strictEqual(labels[1].name, "Receipts")
assert.strictEqual(labels[1].system, false)

const counts = api.parseLabelCounts({ id: "INBOX", messagesUnread: 3, messagesTotal: 40, threadsUnread: 2 })
assert.strictEqual(counts.unread, 3)
assert.strictEqual(counts.threadsUnread, 2)
assert.strictEqual(api.parseLabelCounts(null).unread, 0)

const profile = api.parseProfile({ emailAddress: "me@example.com", messagesTotal: 5, historyId: "9912" })
assert.strictEqual(profile.email, "me@example.com")
assert.strictEqual(profile.historyId, "9912")
assert.strictEqual(api.parseProfile(null).email, "")

const aliases = api.parseSendAs({
  sendAs: [
    {
      sendAsEmail: "me@example.com", displayName: "Me", isPrimary: true,
      isDefault: false, verificationStatus: "accepted"
    },
    {
      sendAsEmail: "work@example.net", displayName: "Me at work", isPrimary: false,
      isDefault: true, verificationStatus: "accepted"
    },
    {
      sendAsEmail: "waiting@example.org", displayName: "Waiting", isPrimary: false,
      isDefault: false, verificationStatus: "pending"
    },
    // A Workspace alternate address needs no verification, so Gmail sends the
    // field back unset. Requiring "accepted" hid exactly these.
    { sendAsEmail: "alt@example.net", displayName: "Alternate", isPrimary: false },
    { displayName: "missing address", verificationStatus: "accepted" }
  ]
})
assert.strictEqual(aliases.length, 3, "pending and malformed aliases are not selectable")
assert.strictEqual(aliases[0].email, "me@example.com")
assert.strictEqual(aliases[1].displayName, "Me at work")
assert.strictEqual(aliases[2].email, "alt@example.net",
  "an alias that never needed verifying is still a choice")
assert.strictEqual(api.parseSendAs(null).length, 0)

assert.strictEqual(api.preferredSendAs(aliases, [{ email: "WORK@example.net" }]).email,
  "work@example.net", "a reply uses the alias to which the original was addressed")
assert.strictEqual(api.preferredSendAs(aliases, []).email, "work@example.net",
  "new mail uses Gmail's default send-as address")
assert.strictEqual(api.preferredSendAs([
  { email: "first@example.com" }, { email: "primary@example.com", isPrimary: true }
], []).email, "primary@example.com")
assert.strictEqual(api.preferredSendAs([{ email: "only@example.com" }], []).email,
  "only@example.com")
assert.strictEqual(api.preferredSendAs([], []), null)
assert.strictEqual(api.isSendAsAllowed(aliases, "WORK@example.net"), true)
assert.strictEqual(api.isSendAsAllowed(aliases, "waiting@example.org"), false)

// The display name that goes on the message is read back off the list, so it
// is looked up by address and never carried alongside it.
assert.strictEqual(api.sendAsFor(aliases, "WORK@example.net").displayName, "Me at work")
assert.strictEqual(api.sendAsFor(aliases, "waiting@example.org"), null)
assert.strictEqual(api.sendAsFor(aliases, ""), null)
assert.strictEqual(api.sendAsFor(null, "me@example.com"), null)

// -------------------------------------------------------------- browsing

assert.strictEqual(api.webMessageUrl("18f3a", 0), "https://mail.google.com/mail/u/0/#all/18f3a")
assert.strictEqual(api.webMessageUrl("18f3a", 2), "https://mail.google.com/mail/u/2/#all/18f3a")
assert.strictEqual(api.webMessageUrl("18f3a", -1), "https://mail.google.com/mail/u/0/#all/18f3a")
assert.strictEqual(api.webSearchUrl("from:jane", 0), "https://mail.google.com/mail/u/0/#search/from%3Ajane")

console.log("test_gmail_api.js ok")
