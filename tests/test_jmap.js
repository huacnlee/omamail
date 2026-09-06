const assert = require("assert")
const { load, deepEqual } = require("./load")

const jmap = load("providers/JmapProtocol.js")

// -------------------------------------------------------------------- hosts

assert.strictEqual(jmap.normalizeHost("Fastmail.com"), "fastmail.com")
assert.strictEqual(jmap.normalizeHost("https://api.fastmail.com/jmap/session"), "api.fastmail.com",
  "a pasted session URL is the same server as the bare host")
assert.strictEqual(jmap.normalizeHost("mail.example.net:443"), "mail.example.net")
assert.strictEqual(jmap.normalizeHost("  "), "")

assert.ok(jmap.isValidHost("mail.example.net"))
assert.ok(!jmap.isValidHost("localhost"), "a name with no dot is not a server we can reach")
assert.ok(!jmap.isValidHost("not a host"))

assert.strictEqual(jmap.presetFor("fastmail.com").id, "fastmail")
assert.strictEqual(jmap.presetFor("api.fastmail.com").id, "fastmail", "a subdomain resolves to its parent")
assert.strictEqual(jmap.presetFor("mail.example.net"), null)
assert.strictEqual(jmap.presetFor("notfastmail.com"), null,
  "a suffix match must not swallow a different domain")

// Mail arrives at fastmail.com; the API does not live there.
assert.strictEqual(jmap.sessionUrl("fastmail.com"), "https://api.fastmail.com/jmap/session")
assert.strictEqual(jmap.sessionUrl("mail.example.net"), "https://mail.example.net/jmap/session")
assert.strictEqual(jmap.sessionUrl(""), "")

// ------------------------------------------------------------------ session

const CORE = "urn:ietf:params:jmap:core"
const MAIL = "urn:ietf:params:jmap:mail"
const SUBMISSION = "urn:ietf:params:jmap:submission"

function session(extra) {
  const base = {
    capabilities: { [CORE]: { maxCallsInRequest: 32 }, [MAIL]: {} },
    primaryAccounts: { [MAIL]: "u123" },
    apiUrl: "https://api.fastmail.com/jmap/api/",
    eventSourceUrl: "https://api.fastmail.com/jmap/event/",
    username: "lee@example.com",
    state: "abc"
  }
  return Object.assign(base, extra || {})
}

const good = jmap.parseSession(session(), "api.fastmail.com")
assert.ok(good.ok)
assert.strictEqual(good.accountId, "u123")
assert.strictEqual(good.maxCallsInRequest, 32)
assert.strictEqual(good.canPush, true)
assert.strictEqual(good.junkTrains, true, "Fastmail learns from its Junk mailbox")

// A token without the submission scope must not leave a Send button on screen.
assert.strictEqual(good.canSend, false)
assert.strictEqual(jmap.parseSession(session({
  capabilities: { [CORE]: {}, [MAIL]: {}, [SUBMISSION]: {} }
}), "api.fastmail.com").canSend, true)

// A server with no push at all is why the polling path stays.
assert.strictEqual(jmap.parseSession(session({ eventSourceUrl: "" }), "x.example").canPush, false)
assert.strictEqual(jmap.parseSession(session(), "mail.example.net").junkTrains, false,
  "a verb is only offered on a host known to honour it")

// Failures name the missing thing rather than reporting a generic error.
assert.strictEqual(jmap.parseSession(null, "x").ok, false)
assert.ok(/no access to mail/i.test(jmap.parseSession(session({
  capabilities: { [CORE]: {} }
}), "x").error))
assert.ok(/names no mail account/i.test(jmap.parseSession(session({
  primaryAccounts: {}
}), "x").error))

assert.strictEqual(jmap.parseSession(session(), "x").maxCallsInRequest, 32)
assert.strictEqual(jmap.parseSession(session({ capabilities: { [CORE]: {}, [MAIL]: {} } }), "x").maxCallsInRequest, 16,
  "a server that states no ceiling gets a conservative one")

// ------------------------------------------------------------------ queries

deepEqual(jmap.parseQuery("role:inbox"),
  { role: "inbox", mailbox: "", unread: false, flagged: false, text: "" })
deepEqual(jmap.parseQuery("role:inbox unread"),
  { role: "inbox", mailbox: "", unread: true, flagged: false, text: "" })
deepEqual(jmap.parseQuery("role:inbox flagged"),
  { role: "inbox", mailbox: "", unread: false, flagged: true, text: "" })
deepEqual(jmap.parseQuery("role:trash"),
  { role: "trash", mailbox: "", unread: false, flagged: false, text: "" })

// A mailbox chosen in the sidebar is not a search for its name.
deepEqual(jmap.parseQuery('mailbox:"Receipts 2026"'),
  { role: "", mailbox: "Receipts 2026", unread: false, flagged: false, text: "" })
deepEqual(jmap.parseQuery('mailbox:"say \\"what\\""').mailbox, 'say "what"',
  "an escaped quote inside a mailbox name survives")

deepEqual(jmap.parseQuery('role:inbox text "quarterly report"'),
  { role: "inbox", mailbox: "", unread: false, flagged: false, text: "quarterly report" })
deepEqual(jmap.parseQuery('role:inbox unread text "invoice"'),
  { role: "inbox", mailbox: "", unread: true, flagged: false, text: "invoice" })

// An empty query is the inbox, which is where a list with nothing selected goes.
deepEqual(jmap.parseQuery(""),
  { role: "inbox", mailbox: "", unread: false, flagged: false, text: "" })

// ------------------------------------------------------------------ filters

const boxes = { roles: { inbox: "m1", trash: "m9" }, names: { "Receipts 2026": "m4" } }

deepEqual(jmap.filterFor(jmap.parseQuery("role:inbox"), boxes), { inMailbox: "m1" })
deepEqual(jmap.filterFor(jmap.parseQuery('mailbox:"Receipts 2026"'), boxes), { inMailbox: "m4" })

// Unread is the absence of a keyword, not a field.
deepEqual(jmap.filterFor(jmap.parseQuery("role:inbox unread"), boxes),
  { operator: "AND", conditions: [{ inMailbox: "m1" }, { notKeyword: "$seen" }] })
deepEqual(jmap.filterFor(jmap.parseQuery("role:inbox flagged"), boxes),
  { operator: "AND", conditions: [{ inMailbox: "m1" }, { hasKeyword: "$flagged" }] })
deepEqual(jmap.filterFor(jmap.parseQuery('role:inbox text "hello"'), boxes),
  { operator: "AND", conditions: [{ inMailbox: "m1" }, { text: "hello" }] })

// A mailbox this account does not have is an empty list, not a rejected filter.
assert.strictEqual(jmap.filterFor(jmap.parseQuery("role:archive"), boxes), null)
assert.strictEqual(jmap.filterFor(jmap.parseQuery('mailbox:"Nope"'), boxes), null)

// "all" is every mailbox, so it constrains nothing.
deepEqual(jmap.filterFor(jmap.parseQuery("role:all"), boxes), {})

// ------------------------------------------------------------ method calls

const page = jmap.pageRequest("u123", { inMailbox: "m1" }, 25, 0)
assert.strictEqual(page.methodCalls.length, 3)
assert.strictEqual(page.methodCalls[0][0], "Mailbox/get")
assert.strictEqual(page.methodCalls[1][0], "Email/query")
assert.strictEqual(page.methodCalls[2][0], "Email/get")

// The point of the provider: the fetch names the query's result instead of
// waiting for it, so a page is one round trip.
deepEqual(page.methodCalls[2][1]["#ids"],
  { resultOf: "query", name: "Email/query", path: "/ids" })
assert.ok(page.using.indexOf(MAIL) >= 0)
assert.strictEqual(page.methodCalls[1][1].limit, 25)
assert.strictEqual(page.methodCalls[1][1].sort[0].property, "receivedAt")
assert.strictEqual(page.methodCalls[1][1].sort[0].isAscending, false)

// Headers only. A get with no properties returns every body structure too.
assert.ok(page.methodCalls[2][1].properties.indexOf("preview") >= 0)
assert.ok(page.methodCalls[2][1].properties.indexOf("threadId") >= 0,
  "threads are the reason this provider exists")
assert.strictEqual(page.methodCalls[2][1].properties.indexOf("bodyValues"), -1)

assert.strictEqual(jmap.pageRequest("u1", {}, 0, -5).methodCalls[1][1].limit, 25,
  "a nonsense limit falls back rather than asking for none")

// A cold client must learn the mailbox ids before a role can become a filter.
const boxesOnly = jmap.mailboxesRequest("u123")
assert.strictEqual(boxesOnly.methodCalls.length, 1)
assert.strictEqual(boxesOnly.methodCalls[0][0], "Mailbox/get")
assert.strictEqual(boxesOnly.methodCalls[0][1].ids, null, "every mailbox, not a subset")
assert.strictEqual(boxesOnly.methodCalls[0][2], "mailboxes",
  "the same call id the page request uses, so one reader serves both")

const changes = jmap.changesRequest("u123", "s1")
assert.strictEqual(changes.methodCalls[0][0], "Email/changes")
assert.strictEqual(changes.methodCalls[0][1].sinceState, "s1")
deepEqual(changes.methodCalls[1][1]["#ids"],
  { resultOf: "changes", name: "Email/changes", path: "/created" })

// ---------------------------------------------------------------- responses

const body = {
  methodResponses: [
    ["Email/get", { list: [{ id: "e1" }] }, "messages"],
    ["Mailbox/get", { list: [] }, "mailboxes"]
  ]
}
assert.strictEqual(jmap.responseFor(body, "messages").payload.list[0].id, "e1")
assert.strictEqual(jmap.responseFor(body, "mailboxes").name, "Mailbox/get",
  "responses are found by call id, because order is not promised")
assert.strictEqual(jmap.responseFor(body, "absent"), null)
assert.strictEqual(jmap.responseFor(null, "messages"), null)

// A 200 whose body contains a failed call is a failure.
assert.strictEqual(jmap.methodError(body), "")
assert.ok(/does not support/i.test(jmap.methodError({
  methodResponses: [["error", { type: "unknownMethod" }, "c0"]]
})))
assert.ok(/rate limiting/i.test(jmap.methodError({
  methodResponses: [["error", { type: "rateLimit" }, "c0"]]
})))
assert.strictEqual(jmap.methodError({
  methodResponses: [["error", { type: "weird", description: "Bad in a new way" }, "c0"]]
}), "Bad in a new way")

// A batch can half succeed, and the list has to know which half.
deepEqual(jmap.setFailures({ notUpdated: { e2: { type: "forbidden", description: "no" } } }),
  [{ id: "e2", type: "forbidden", description: "no" }])
deepEqual(jmap.setFailures({}), [])

assert.ok(/revoked/i.test(jmap.responseError(401, {}, "")))
assert.ok(/scope/i.test(jmap.responseError(403, {}, "")))
assert.ok(/No JMAP service/i.test(jmap.responseError(404, {}, "")))
assert.ok(/rate limiting/i.test(jmap.responseError(429, {}, "")))
assert.strictEqual(jmap.responseError(0, {}, "Timed out"), "Timed out",
  "an aborted request reports what the client knows, since there is no status")
assert.ok(/500/.test(jmap.responseError(500, {}, "")))


// ----------------------------------------------------------------- messages

const roles = { m1: "inbox", m9: "trash", m7: "junk", m5: "sent", m3: "drafts" }

const email = {
  id: "e1", blobId: "b1", threadId: "t1", size: 4096,
  receivedAt: "2026-09-05T10:00:00Z",
  mailboxIds: { m1: true },
  keywords: { "$flagged": true },
  from: [{ name: "Jane Roe", email: "jane@example.com" }],
  to: [{ email: "lee@example.com" }],
  subject: "Quarterly report",
  preview: "Here is the report you asked for",
  messageId: ["abc@example.com"],
  hasAttachment: true
}

const m = jmap.messageFrom(email, roles)
assert.strictEqual(m.id, "e1")
assert.strictEqual(m.threadId, "t1", "the server's own conversation id")
assert.strictEqual(m.sizeEstimate, 4096)
assert.strictEqual(m.snippet, "Here is the report you asked for",
  "JMAP sends a preview, so nothing has to be built from a body that was not fetched")
assert.strictEqual(m.internalDate, Date.parse("2026-09-05T10:00:00Z"))
assert.strictEqual(m.hasAttachment, true)

// Unread is the ABSENCE of $seen — the one inversion in the mapping.
deepEqual(m.labelIds.sort(), ["INBOX", "STARRED", "UNREAD"])
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true }, mailboxIds: { m1: true } }, roles).sort(),
  ["INBOX"])
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true }, mailboxIds: { m9: true } }, roles).sort(),
  ["TRASH"])
deepEqual(jmap.labelIdsFor({ keywords: { "$seen": true }, mailboxIds: { m7: true } }, roles).sort(),
  ["SPAM"])
deepEqual(jmap.labelIdsFor({ keywords: {}, mailboxIds: {} }, roles), ["UNREAD"])

// Headers are synthesised so Message.js reads them exactly as it reads IMAP's.
function header(msg, name) {
  const hit = msg.payload.headers.filter(function (h) { return h.name === name })[0]
  return hit ? hit.value : ""
}
assert.strictEqual(header(m, "From"), '"Jane Roe" <jane@example.com>')
assert.strictEqual(header(m, "To"), "lee@example.com", "no display name, no quoting")
assert.strictEqual(header(m, "Subject"), "Quarterly report")
assert.strictEqual(header(m, "Message-ID"), "<abc@example.com>")
assert.strictEqual(header(m, "Cc"), "", "an absent header is omitted, not empty")

assert.strictEqual(jmap.addressText([{ name: 'Say "what"', email: "a@b.c" }]),
  '"Say \\"what\\"" <a@b.c>', "a quote in a display name is escaped")
assert.strictEqual(jmap.addressText([{ email: "a@b.c" }, { email: "d@e.f" }]), "a@b.c, d@e.f")
assert.strictEqual(jmap.addressText(null), "")

// A message with no threadId is its own thread rather than an empty one.
assert.strictEqual(jmap.messageFrom({ id: "x" }, roles).threadId, "x")
assert.strictEqual(jmap.messagesFrom([email, email], roles).length, 2)

// ------------------------------------------------------------------ actions

const R = { inbox: "m1", archive: "m2", trash: "m9", junk: "m7" }

deepEqual(jmap.actionPlan("read", R).keywords, { "$seen": true })
deepEqual(jmap.actionPlan("unread", R).keywords, { "$seen": null })
deepEqual(jmap.actionPlan("star", R).keywords, { "$flagged": true })
deepEqual(jmap.actionPlan("unstar", R).keywords, { "$flagged": null })
assert.strictEqual(jmap.actionPlan("archive", R).moveTo, "m2")
assert.strictEqual(jmap.actionPlan("trash", R).moveTo, "m9")
assert.strictEqual(jmap.actionPlan("spam", R).moveTo, "m7")
assert.strictEqual(jmap.actionPlan("nonsense", R).moveTo, "", "an unknown verb changes nothing")

// A keyword patch is a JSON pointer, so one keyword changes without the rest
// being sent back.
const starred = jmap.updateRequest("u1", ["e1", "e2"], jmap.actionPlan("star", R))
assert.strictEqual(starred.methodCalls[0][0], "Email/set")
deepEqual(starred.methodCalls[0][1].update.e1, { "keywords/$flagged": true })
deepEqual(starred.methodCalls[0][1].update.e2, { "keywords/$flagged": true })

// A move replaces mailboxIds outright: a patch that only added Archive would
// leave the message in the inbox too.
const archived = jmap.updateRequest("u1", ["e1"], jmap.actionPlan("archive", R))
deepEqual(archived.methodCalls[0][1].update.e1, { mailboxIds: { m2: true } })

deepEqual(jmap.updateRequest("u1", [], jmap.actionPlan("star", R)).methodCalls[0][1].update, {})


// Gmail's vocabulary, which MailAccount speaks to every client, translated.
deepEqual(jmap.planFromLabels([], ["UNREAD"], R).keywords, { "$seen": true },
  "marking read removes the UNREAD label, which sets $seen")
deepEqual(jmap.planFromLabels(["UNREAD"], [], R).keywords, { "$seen": null })
deepEqual(jmap.planFromLabels(["STARRED"], [], R).keywords, { "$flagged": true })
assert.strictEqual(jmap.planFromLabels([], ["INBOX"], R).moveTo, "m2", "leaving the inbox is archiving")
assert.strictEqual(jmap.planFromLabels(["TRASH"], [], R).moveTo, "m9")
assert.strictEqual(jmap.planFromLabels(["SPAM"], [], R).moveTo, "m7")
assert.strictEqual(jmap.planFromLabels([], ["TRASH"], R).moveTo, "m1", "untrashing returns to the inbox")
// A move is exclusive, so an ambiguous request resolves the visible way.
assert.strictEqual(jmap.planFromLabels(["TRASH", "SPAM"], ["INBOX"], R).moveTo, "m9")

assert.ok(jmap.planIsEmpty({ keywords: {}, moveTo: "" }))
assert.ok(jmap.planIsEmpty(jmap.planFromLabels([], [], R)))
assert.ok(!jmap.planIsEmpty(jmap.actionPlan("star", R)))
assert.ok(!jmap.planIsEmpty(jmap.actionPlan("archive", R)))


// The download URL is a template, so every value has to be put in and escaped.
const sess = {
  accountId: "u 1", downloadUrl:
    "https://x.example/jmap/download/{accountId}/{blobId}/{name}?type={type}"
}
assert.strictEqual(jmap.downloadUrlFor(sess, "b/1", "text/plain", "a b.txt"),
  "https://x.example/jmap/download/u%201/b%2F1/a%20b.txt?type=text%2Fplain")
assert.strictEqual(jmap.downloadUrlFor(sess, "", "", ""), "", "no blob, no URL")
assert.strictEqual(jmap.downloadUrlFor({}, "b1", "", ""), "")

const got = jmap.getRequest("u1", ["e1", "e2"])
assert.strictEqual(got.methodCalls[0][0], "Email/get")
deepEqual(got.methodCalls[0][1].ids, ["e1", "e2"])
assert.ok(got.methodCalls[0][1].properties.indexOf("threadId") >= 0)
deepEqual(jmap.getRequest("u1", ["e1"], ["id", "blobId"]).methodCalls[0][1].properties,
  ["id", "blobId"])


// ------------------------------------------------------------------ sending

assert.strictEqual(jmap.uploadUrlFor({ accountId: "u 1",
  uploadUrl: "https://x.example/jmap/upload/{accountId}/" }),
  "https://x.example/jmap/upload/u%201/")
assert.strictEqual(jmap.uploadUrlFor({}), "")

const ids = jmap.identitiesRequest("u1")
assert.strictEqual(ids.methodCalls[0][0], "Identity/get")
assert.ok(ids.using.indexOf("urn:ietf:params:jmap:submission") >= 0,
  "Identity is a submission method, so the capability has to be asked for")

const idents = [{ id: "i1", email: "other@example.com" }, { id: "i2", email: "you@example.com" }]
assert.strictEqual(jmap.pickIdentity(idents, "you@example.com").id, "i2",
  "the mailbox's own address wins")
assert.strictEqual(jmap.pickIdentity(idents, "nobody@example.com").id, "i1", "else the first that can send")
assert.strictEqual(jmap.pickIdentity([], "a@b.c"), null)
deepEqual(jmap.identitiesFrom(idents)[0], { id: "i1", email: "other@example.com", name: "", isDefault: true, isPrimary: true })
deepEqual(jmap.identitiesFrom([{ id: "x", email: "" }]), [], "an identity with no address is not one")

// A draft keeps $draft; something about to be sent does not, so a failed send
// is not left looking like a message that was never written.
const asDraft = jmap.importRequest("u1", "b1", "mDrafts", true)
assert.strictEqual(asDraft.methodCalls[0][0], "Email/import")
deepEqual(asDraft.methodCalls[0][1].emails.draft.keywords, { "$seen": true, "$draft": true })
deepEqual(asDraft.methodCalls[0][1].emails.draft.mailboxIds, { mDrafts: true })
deepEqual(jmap.importRequest("u1", "b1", "mDrafts", false).methodCalls[0][1].emails.draft.keywords,
  { "$seen": true })

// The submission files the sent copy and clears $draft in the same request, so
// there is no window where a sent message is still in Drafts.
const sub = jmap.submitRequest("u1", "i2", "e9", "mSent")
assert.strictEqual(sub.methodCalls[0][0], "EmailSubmission/set")
assert.strictEqual(sub.methodCalls[0][1].create.send.emailId, "e9")
assert.strictEqual(sub.methodCalls[0][1].create.send.identityId, "i2")
deepEqual(sub.methodCalls[0][1].onSuccessUpdateEmail["#send"],
  { "keywords/$draft": null, "keywords/$seen": true, mailboxIds: { mSent: true } })
assert.ok(sub.using.indexOf("urn:ietf:params:jmap:submission") >= 0)
// A server with no Sent mailbox still sends; it just files nothing.
assert.strictEqual(sub.methodCalls[0][1].onSuccessUpdateEmail["#send"].mailboxIds.mSent, true)
deepEqual(jmap.submitRequest("u1", "i2", "e9", "").methodCalls[0][1].onSuccessUpdateEmail["#send"],
  { "keywords/$draft": null, "keywords/$seen": true })

deepEqual(jmap.destroyRequest("u1", ["e1"]).methodCalls[0][1].destroy, ["e1"])

assert.strictEqual(jmap.createdId({ created: { draft: { id: "e5" } } }, "draft"), "e5")
assert.strictEqual(jmap.createdId({}, "draft"), "")

assert.ok(/may send from/i.test(jmap.createError({ notCreated: { send: { type: "forbiddenFrom" } } }, "send")))
assert.ok(/too large/i.test(jmap.createError({ notCreated: { send: { type: "tooLarge" } } }, "send")))
assert.strictEqual(jmap.createError({ notCreated: { send: { type: "odd", description: "Nope" } } }, "send"), "Nope")
assert.strictEqual(jmap.createError({ created: { send: { id: "s1" } } }, "send"), "",
  "a create that worked has no error")


// --------------------------------------------------------------------- push

const pushSession = { eventSourceUrl:
  "https://x.example/jmap/event/?types={types}&closeafter={closeafter}&ping={ping}" }
assert.strictEqual(jmap.pushUrlFor(pushSession, 300),
  "https://x.example/jmap/event/?types=Email%2CMailbox&closeafter=no&ping=300")
assert.ok(/ping=300/.test(jmap.pushUrlFor(pushSession, 5)), "a nonsense ping falls back")
assert.strictEqual(jmap.pushUrlFor({}, 300), "", "a server with no event source has no URL")

// Only data lines carry anything; the rest is framing.
assert.strictEqual(jmap.pushChange("event: state", "u1").isData, false)
assert.strictEqual(jmap.pushChange(": keepalive", "u1").isData, false)
assert.strictEqual(jmap.pushChange("", "u1").isData, false)

const change = jmap.pushChange(
  'data:{"@type":"StateChange","changed":{"u1":{"Email":"s99","Mailbox":"s98"}}}', "u1")
assert.ok(change.isData)
assert.ok(change.changed)
assert.strictEqual(change.state, "s99")

// A ping is a data line too, and carries no changed at all.
assert.strictEqual(jmap.pushChange('data:{"@type":"ping","interval":300}', "u1").changed, false)
// Another account on the same connection is not this mailbox's business.
assert.strictEqual(jmap.pushChange(
  'data:{"changed":{"other":{"Email":"s1"}}}', "u1").changed, false)
// A type we did not ask to be woken for does not wake us.
assert.strictEqual(jmap.pushChange(
  'data:{"changed":{"u1":{"CalendarEvent":"s1"}}}', "u1").changed, false)
assert.strictEqual(jmap.pushChange("data:not json", "u1").changed, false)

// The real wire format has a space after the colon, which JSON.parse tolerates
// as leading whitespace. Measured against Fastmail's own stream.
const real = 'data: {"@type":"StateChange","type":"connect","changed":' +
  '{"u1234abcd":{"AddressBook":"53","Mailbox":"J5832","Email":"J5832","Thread":"J5832"}}}'
assert.ok(jmap.pushChange(real, "u1234abcd").changed, "the space after data: must not break it")
assert.strictEqual(jmap.pushChange(real, "u1234abcd").state, "J5832")
assert.strictEqual(jmap.pushChange(real, "someoneelse").changed, false)

assert.strictEqual(jmap.pushBackoffMs(1), 2000)
assert.strictEqual(jmap.pushBackoffMs(2), 4000)
assert.strictEqual(jmap.pushBackoffMs(3), 8000)
assert.strictEqual(jmap.pushBackoffMs(99), 300000, "capped, so a dead server is not hammered")
assert.strictEqual(jmap.pushBackoffMs(0), 2000)


// --- a move this account cannot make is not "nothing to do" -----------------
//
// The fault this guards: an archive on a server with no Archive mailbox left
// moveTo empty, planIsEmpty said true, and the caller reported success having
// sent nothing — the row leaves the list and the note says "Archived" for a
// request no server ever saw. AGENTS.md records the same fault against HEY.

const NO_ARCHIVE = { inbox: "m1", trash: "m9" }

const stranded = jmap.planFromLabels([], ["INBOX"], NO_ARCHIVE)
assert.strictEqual(stranded.moveRole, "archive", "the role asked for is recorded")
assert.strictEqual(stranded.moveTo, "", "and could not be resolved")
assert.ok(jmap.planIsEmpty(stranded), "it still looks empty, which is the trap")
assert.ok(jmap.planUnresolved(stranded), "so this is what callers must check first")

const landed = jmap.planFromLabels([], ["INBOX"], R)
assert.strictEqual(landed.moveTo, "m2")
assert.ok(!jmap.planUnresolved(landed), "a move that resolved is not unresolved")

// A keyword-only change asks for no move at all, so it is neither.
const starOnly = jmap.planFromLabels(["STARRED"], [], NO_ARCHIVE)
assert.strictEqual(starOnly.moveRole, "")
assert.ok(!jmap.planUnresolved(starOnly))
assert.ok(!jmap.planIsEmpty(starOnly))

// Every verb that moves records which role it wanted, resolvable or not.
assert.strictEqual(jmap.actionPlan("archive", NO_ARCHIVE).moveRole, "archive")
assert.strictEqual(jmap.actionPlan("trash", NO_ARCHIVE).moveRole, "trash")
assert.strictEqual(jmap.actionPlan("spam", NO_ARCHIVE).moveRole, "junk")
assert.strictEqual(jmap.actionPlan("untrash", NO_ARCHIVE).moveRole, "inbox")
assert.strictEqual(jmap.actionPlan("star", NO_ARCHIVE).moveRole, "", "a keyword is not a move")
assert.ok(jmap.planUnresolved(jmap.actionPlan("spam", NO_ARCHIVE)), "no Junk mailbox, no junk verb")
assert.ok(!jmap.planUnresolved(jmap.actionPlan("trash", NO_ARCHIVE)), "this server does have Trash")

// The note the user reads names the mailbox they have not got.
assert.strictEqual(jmap.roleName("archive"), "Archive")
assert.strictEqual(jmap.roleName("junk"), "Junk")
assert.strictEqual(jmap.roleName("whatever"), "whatever")
assert.strictEqual(jmap.roleName(""), "")

console.log("test_jmap.js: ok")
