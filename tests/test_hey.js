const assert = require("assert")
const { load, deepEqual } = require("./load")

const hey = load("providers/HeyCli.js")

// ------------------------------------------------------------- the id pair
//
// A HEY thread answers to two numbers and the commands disagree about which:
// `seen`, `move` and `trash` take the posting, `threads` and `reply` take the
// topic. Storing one of them would mean a round trip to find the other.

assert.strictEqual(hey.messageId(1235250884, 2106437143), "1235250884:2106437143")
assert.strictEqual(hey.postingIdOf("1235250884:2106437143"), "1235250884")
assert.strictEqual(hey.topicIdOf("1235250884:2106437143"), "2106437143")
assert.strictEqual(hey.messageId("", ""), "")

// Half an id is read as neither half. A bare number could be either, and
// guessing wrong opens somebody else's conversation or marks it seen.
assert.strictEqual(hey.topicIdOf("1235250884"), "")
assert.strictEqual(hey.postingIdOf(""), "")

// The topic id is read out of the posting's own app URL, which is the only
// place a box listing carries it.
assert.strictEqual(hey.topicIdFromUrl("https://app.hey.com/topics/2106437143"), "2106437143")
assert.strictEqual(hey.topicIdFromUrl("https://app.hey.com/imbox"), "")
assert.strictEqual(hey.topicIdFromUrl(""), "")

// -------------------------------------------------------------- the queries

deepEqual(hey.parseQuery("box:imbox"),
  { kind: "box", box: "imbox", label: "", text: "", unseen: false })
deepEqual(hey.parseQuery("box:imbox unseen"),
  { kind: "box", box: "imbox", label: "", text: "", unseen: true })
deepEqual(hey.parseQuery("label:4711"),
  { kind: "label", box: "", label: "4711", text: "", unseen: false })
deepEqual(hey.parseQuery("search:dentist"),
  { kind: "search", box: "", label: "", text: "dentist", unseen: false })
deepEqual(hey.parseQuery("box:trash"),
  { kind: "trash", box: "trash", label: "", text: "", unseen: false })
deepEqual(hey.parseQuery("drafts:"),
  { kind: "drafts", box: "", label: "", text: "", unseen: false })

// A search takes the rest of the string verbatim, so typing a mailbox name into
// the search field searches for those words rather than switching mailbox.
assert.strictEqual(hey.parseQuery("search:box:imbox").text, "box:imbox")

// A box HEY does not have, and a query from a newer build or a stale cache
// file, still have to open a window.
assert.strictEqual(hey.parseQuery("box:invented").box, "imbox")
assert.strictEqual(hey.parseQuery("").box, "imbox")
assert.strictEqual(hey.parseQuery("in:inbox").kind, "box")

// ------------------------------------------------------------- the commands

// No `--limit` on an ordinary listing, and this is not an oversight. The CLI
// reads pages until it has the number asked for, then truncates to it *and
// drops the cursor* — so a limited listing can never be continued, and Load
// more would be a button that could not work. HEY's own page comes back with
// its cursor intact instead, and the page size the user configured is applied
// to it here.
deepEqual(hey.listCommand(hey.parseQuery("box:imbox"), 25, ""),
  ["box", "imbox", "--json"])
deepEqual(hey.listCommand(hey.parseQuery("box:feedbox"), 10, "0|cursor-2"),
  ["box", "feedbox", "--json", "--page", "cursor-2"])
deepEqual(hey.listCommand(hey.parseQuery("label:4711"), 25, ""),
  ["label", "4711", "--json"])
deepEqual(hey.listCommand(hey.parseQuery("search:dentist"), 25, ""),
  ["search", "dentist", "--json"])
deepEqual(hey.listCommand(hey.parseQuery("box:trash"), 25, ""),
  ["search", "--in", "trash", "--json"])
deepEqual(hey.listCommand(hey.parseQuery("drafts:"), 25, ""),
  ["draft", "list", "--json"])
deepEqual(hey.listCommand(hey.parseQuery("drafts:"), 25, "0|draft-cursor-2"),
  ["draft", "list", "--json", "--page", "draft-cursor-2"])

deepEqual(hey.parseDraftListing([
  { id: 101, summary: "Agenda and decisions", subject: "Quarterly planning",
    updated_at: "2026-08-20T09:30:00Z" }
]), [{
  id: "draft:101", draftId: "101", subject: "Quarterly planning",
  snippet: "Agenda and decisions", from: { name: "", email: "" }, to: [],
  date: "2026-08-20T09:30:00Z", seen: true, box: "", appUrl: "", isDraft: true
}])
deepEqual(hey.draftShowCommand("draft:101"), ["draft", "show", "101", "--json"])
deepEqual(hey.parseDraft({ id: 101, subject: "Quarterly planning", body: "Agenda",
  to: ["maria@example.com"], cc: ["team@example.com"], bcc: [],
  updated_at: "2026-08-20T09:30:00Z" }), {
  id: "draft:101", draftId: "101", subject: "Quarterly planning", body: "Agenda",
  to: [{ name: "", email: "maria@example.com" }],
  cc: [{ name: "", email: "team@example.com" }], bcc: [],
  date: "2026-08-20T09:30:00Z", isDraft: true
})

// The one query that does name a number. Filtering on unseen happens here
// rather than on the server, so a page of one would find at most one unseen
// message however many are waiting — and that number is the unread badge, which
// asks for a page of one.
deepEqual(hey.listCommand(hey.parseQuery("box:imbox unseen"), 1, ""),
  ["box", "imbox", "--json", "--limit", String(hey.UNSEEN_SCAN)])
assert.strictEqual(hey.scanLimit(hey.parseQuery("box:imbox")), 0)
assert.strictEqual(hey.scanLimit(hey.parseQuery("box:imbox unseen")), hey.UNSEEN_SCAN)

// An offset into HEY's page, and HEY's own cursor for it.
assert.strictEqual(hey.pageToken(25, "abc"), "25|abc")
assert.strictEqual(hey.pageToken(0, ""), "", "the first page needs no token")
assert.strictEqual(hey.tokenOffset("25|abc"), 25)
assert.strictEqual(hey.tokenCursor("25|abc"), "abc")
assert.strictEqual(hey.tokenOffset(""), 0)
assert.strictEqual(hey.tokenCursor(""), "")
// A cursor is opaque and may hold anything but a leading offset, so only the
// first bar separates the two.
assert.strictEqual(hey.tokenCursor("0|ey|J9"), "ey|J9")

// Reading a thread takes the topic half, and asks for both optional flags.
deepEqual(hey.threadCommand("1:2"), ["threads", "2", "--allow-partial", "--html"])
deepEqual(hey.threadCommand("1"), [], "half an id names no thread")

// A release older than a flag this plugin asks for refuses the whole command,
// so the flag is dropped and the command asked again. Every optional flag is
// boolean, which is what makes dropping the token alone correct — a flag that
// took a value would leave its value behind as a positional argument.
assert.strictEqual(hey.unknownFlag('{"ok":false,"code":"usage","error":"unknown flag: --allow-partial"}'),
  "--allow-partial")
assert.strictEqual(hey.unknownFlag("Error: unknown flag: --html"), "--html")
assert.strictEqual(hey.unknownFlag('{"ok":false,"error":"Resource not found"}'), "")
assert.strictEqual(hey.unknownFlag(""), "")
deepEqual(hey.withoutFlag(["threads", "2", "--allow-partial", "--html"], "--allow-partial"),
  ["threads", "2", "--html"])
assert.strictEqual(hey.hasFlag(["threads", "2", "--html"], "--html"), true)
assert.strictEqual(hey.hasFlag(["threads", "2"], "--html"), false)

// The verbs act on the posting half, and several threads are one invocation.
deepEqual(hey.actionCommand("markRead", ["1:2", "3:4"]), ["seen", "1", "3"])
deepEqual(hey.actionCommand("markUnread", "1:2"), ["unseen", "1"])
deepEqual(hey.actionCommand("trash", ["1:2"]), ["trash", "1"])
deepEqual(hey.actionCommand("spam", ["1:2"]), ["spam", "1"])
deepEqual(hey.actionCommand("untrash", ["1:2"]), ["move", "1", "--to", "imbox"])

// A verb HEY does not have is nothing to do rather than something close to it.
// The panel already hides these buttons; this is the second line of defence.
deepEqual(hey.actionCommand("star", ["1:2"]), [])
deepEqual(hey.actionCommand("archive", ["1:2"]), [])
deepEqual(hey.actionCommand("markRead", []), [])

// `MailAccount` speaks Gmail's vocabulary to every provider, so the label ids
// arrive here and become HEY's verbs.
assert.strictEqual(hey.verbForLabels([], ["UNREAD"]), "markRead")
assert.strictEqual(hey.verbForLabels(["UNREAD"], []), "markUnread")
assert.strictEqual(hey.verbForLabels(["SPAM"], ["INBOX"]), "spam")
assert.strictEqual(hey.verbForLabels(["STARRED"], []), "", "HEY has no flag")
assert.strictEqual(hey.verbForLabels([], ["INBOX"]), "", "HEY has no archive")

// Sending. A reply names its thread and nothing else — HEY answers the same
// people it would have in its own app, which is not a decision to reimplement.
deepEqual(hey.composeCommand({ threadId: "2106437143" }), ["reply", "2106437143"])
deepEqual(hey.composeCommand({ to: "jane@example.com", subject: "Lunch" }),
  ["compose", "--to", "jane@example.com", "--subject", "Lunch"])
deepEqual(hey.composeCommand({ to: "a@b.com", cc: "c@d.com", subject: "Hi" }),
  ["compose", "--to", "a@b.com", "--subject", "Hi", "--cc", "c@d.com"])
deepEqual(hey.composeCommand({ subject: "Nobody" }), [], "a new message needs a recipient")
deepEqual(hey.composeCommand({
  to: "jane@example.com",
  subject: "Lunch",
  attachments: [{ path: "/tmp/menu.pdf" }]
}), [
  "compose", "--to", "jane@example.com", "--subject", "Lunch",
  "--attach", "/tmp/menu.pdf"
])
deepEqual(hey.draftCommand({ subject: "Nobody yet" }),
  ["compose", "--subject", "Nobody yet", "--draft"],
  "a draft may be saved before it has a recipient")
deepEqual(hey.draftCommand({
  threadId: "2106437143",
  attachments: [{ path: "/tmp/menu.pdf" }]
}), ["reply", "2106437143", "--draft", "--attach", "/tmp/menu.pdf"])
deepEqual(hey.draftEditCommand("draft:42", {
  to: "jane@example.com",
  cc: "",
  bcc: "hidden@example.com",
  subject: "Revised",
  body: "New body",
  attachments: [{ path: "/tmp/revised.pdf" }]
}), [
  "draft", "edit", "42",
  "--to", "jane@example.com",
  "--cc", "",
  "--bcc", "hidden@example.com",
  "--subject", "Revised",
  "--message", "New body",
  "--attach", "/tmp/revised.pdf"
])
assert.strictEqual(hey.isDroppableFlag("--attach"), false)
assert.strictEqual(hey.isDroppableFlag("--html"), true)

// -------------------------------------------------------------- the answers

// The envelope is checked rather than the exit status: `hey` reports some
// refusals in JSON and still exits 0.
deepEqual(hey.payload('{"ok":true,"data":[1,2]}'), { ok: true, data: [1, 2], error: "" })
assert.strictEqual(hey.payload('{"ok":false,"error":"Resource not found"}').ok, false)
assert.strictEqual(hey.payload('{"ok":false,"error":"Resource not found"}').error,
  "Resource not found")
assert.strictEqual(hey.payload("not json at all").ok, false)
assert.strictEqual(hey.payload("").ok, false)

// A box listing, as HEY actually answers one. Trimmed, but every field this
// reads is present exactly as the real payload carries it.
const BOX = {
  kind: "imbox",
  name: "Imbox",
  next_page: "cursor-2",
  postings: [
    {
      id: 1235250884,
      app_url: "https://app.hey.com/topics/2106437143",
      name: "New sign-in to your HEY account",
      summary: "A new device just signed in…",
      active_at: "2026-08-22T11:34:50Z",
      alternative_sender_name: "The HEY Team",
      creator: { name: "The HEY Team", email_address: "support@hey.com" },
      addressed_contacts: [{ name: "huacnlee", email_address: "huacnlee@hey.com" }]
    },
    {
      id: 1234602519,
      app_url: "https://app.hey.com/topics/2105331139",
      name: "Secure your email",
      summary: "Two-factor…",
      active_at: "2026-08-21T03:23:25Z",
      seen: true,
      creator: { name: "The HEY Team", email_address: "support@hey.com" }
    }
  ]
}

const rows = hey.parseListing(BOX)
assert.strictEqual(rows.length, 2)
assert.strictEqual(rows[0].id, "1235250884:2106437143")
assert.strictEqual(rows[0].subject, "New sign-in to your HEY account")
assert.strictEqual(rows[0].from.email, "support@hey.com")
assert.strictEqual(rows[0].box, "imbox")
deepEqual(rows[0].to, [{ name: "huacnlee", email: "huacnlee@hey.com" }])

// The name HEY signs a machine-sent message with is the one the row should
// carry: it is what its own list shows and what the reader would recognise.
assert.strictEqual(rows[0].from.name, "The HEY Team")

// Unseen is the absence of a seen. HEY's JSON omits an empty field, so a
// posting nobody has read carries no `seen` key at all — reading that as
// "unknown" would leave every new message looking read.
assert.strictEqual(rows[0].seen, false)
assert.strictEqual(rows[1].seen, true)

// Only the unseen filter narrows anything; every other query is served by the
// command that ran.
assert.strictEqual(hey.filterRows(hey.parseQuery("box:imbox unseen"), rows).length, 1)
assert.strictEqual(hey.filterRows(hey.parseQuery("box:imbox"), rows).length, 2)

// One of HEY's pages, cut to the size the user asked for. Load more re-reads
// the same page at a higher offset until it is used up, and only then moves on
// to HEY's next one — which is what keeps a page size and a cursor that cannot
// both be asked for from losing messages between them.
const wide = [rows[0], rows[1], rows[0], rows[1]]
const firstHalf = hey.pageOf(hey.parseQuery("box:imbox"), BOX, wide, 2, "")
assert.strictEqual(firstHalf.rows.length, 2)
assert.strictEqual(firstHalf.nextPageToken, "2|", "further into the page HEY already served")
assert.strictEqual(firstHalf.total, 4)

const secondHalf = hey.pageOf(hey.parseQuery("box:imbox"), BOX, wide, 2, "2|")
assert.strictEqual(secondHalf.rows.length, 2)
assert.strictEqual(secondHalf.nextPageToken, "0|cursor-2", "and then on to HEY's next page")

// A box pages by cursor and a search by number, and both are opaque above the
// provider — they are handed back to the client that produced them.
assert.strictEqual(hey.pageOf(hey.parseQuery("box:imbox"), BOX, rows, 25, "").nextPageToken,
  "0|cursor-2")
assert.strictEqual(hey.pageOf(hey.parseQuery("search:x"), [], rows, 25, "").nextPageToken, "0|2")
assert.strictEqual(hey.pageOf(hey.parseQuery("search:x"), [], rows, 25, "0|2").nextPageToken, "0|3")
assert.strictEqual(hey.pageOf(hey.parseQuery("search:x"), [], [], 25, "").nextPageToken, "",
  "an empty search page has no next")
// A scan that filtered on unseen read a fixed window rather than a page, so
// past its end there is nothing to continue with: paging the box would page it
// while the filter kept discarding.
assert.strictEqual(hey.pageOf(hey.parseQuery("box:imbox unseen"), BOX, rows, 25, "").nextPageToken, "")
// Within that window it still pages, because the rows are already in hand.
assert.strictEqual(hey.pageOf(hey.parseQuery("box:imbox unseen"), BOX, wide, 2, "").nextPageToken, "2|")

// A search answers with a flat list of threads instead of a box and its
// postings, and both end up as the same rows.
const HITS = [
  {
    id: 1235250884,
    topic_id: 2106437143,
    subject: "New sign-in to your HEY account",
    updated_at: "2026-08-22T11:34:50Z",
    messages: [{ summary: "A new device…", created_at: "2026-08-22T11:34:50Z",
      creator: { name: "The HEY Team", email_address: "support@hey.com" } }]
  }
]
const hits = hey.parseListing(HITS)
assert.strictEqual(hits.length, 1)
assert.strictEqual(hits[0].id, "1235250884:2106437143")
assert.strictEqual(hits[0].subject, "New sign-in to your HEY account")
// A search says nothing about what has been read, so a row from one claims to
// be read rather than inventing a bold line the Imbox would then disagree with.
assert.strictEqual(hits[0].seen, true)

// Labels are addressed by id, so the id is what the sidebar carries as a
// label's `rawName` — it is the only thing `hey label` takes.
deepEqual(hey.parseLabels([{ id: 4711, name: "Receipts" }]),
  [{ id: "4711", name: "Receipts", rawName: "4711", system: false,
    unread: 0, total: 0, threadsUnread: 0 }])
deepEqual(hey.parseLabels(null), [])
deepEqual(hey.parseLabels([{ id: 1 }]), [], "a label with no name is not a label")

// The account list holds an "all" row that is a filter rather than an account.
assert.strictEqual(hey.parseAccountAddress([
  { id: "all", name: "All Accounts", active: true },
  { id: "887847", name: "huacnlee", email: "huacnlee@hey.com" }
]), "huacnlee@hey.com")
assert.strictEqual(hey.parseAccountAddress([{ id: "all", name: "All Accounts" }]), "")
assert.strictEqual(hey.parseAccountAddress(null), "")

assert.strictEqual(hey.isAuthenticated({ authenticated: true, expired: false }), true)
assert.strictEqual(hey.isAuthenticated({ authenticated: true, expired: true }), false)
assert.strictEqual(hey.isAuthenticated({ authenticated: false }), false)
assert.strictEqual(hey.isAuthenticated(null), false)

// --------------------------------------------------------------- the thread

// `--html` writes the sender's own markup, which is what the reader is built
// for. A build of `hey` without it answers with the ordinary envelope, whose
// `body` carries the same message as text — so one invocation covers both and
// the richer reading arrives by itself when the CLI gains it.
assert.strictEqual(hey.isHtmlDocument("<!doctype html><article>hi</article>"), true)
assert.strictEqual(hey.isHtmlDocument('{"ok":true}'), false)
assert.strictEqual(hey.isHtmlDocument(""), false)

const asHtml = hey.parseThread("<article><p>Hello</p></article>")
assert.strictEqual(asHtml.html, "<article><p>Hello</p></article>")
assert.strictEqual(asHtml.text, "")

const asText = hey.parseThread(JSON.stringify({
  ok: true,
  data: [{ id: 1, body: "First" }, { id: 2, body: "Second" }]
}))
assert.strictEqual(asText.html, "")
assert.strictEqual(asText.text, "First\n\n───\n\nSecond")

assert.strictEqual(hey.parseThread('{"ok":false,"error":"Resource not found"}').error,
  "Resource not found")

// ------------------------------------------------------------------ the web

assert.strictEqual(hey.webMessageUrl("1:2106437143"), "https://app.hey.com/topics/2106437143")
assert.strictEqual(hey.webMessageUrl(""), "https://app.hey.com")
// And no box address at all: HEY has a URL per box and none for a search or a
// label, so anything here would answer the Imbox for every mailbox that is not
// the Imbox. The `webBox` capability is off instead.
assert.strictEqual(typeof hey.webBoxUrl, "undefined")

// ---------------------------------------------------------------- the safety

// `hey` prints no credential in the ordinary course of things, but a verbose
// failure could — and a notice is a place a stranger can read.
assert.ok(hey.redact("token=abc123").indexOf("abc123") < 0)
assert.ok(hey.redact("Authorization: Bearer sk-live-1").indexOf("sk-live-1") < 0)
assert.strictEqual(hey.redact(""), "")

// The envelope's own message when there is one, stderr when there is not, and
// the exit code only when there is neither.
assert.strictEqual(hey.commandError(1, '{"ok":false,"error":"Not found"}', "", "fallback"),
  "Not found")
assert.strictEqual(hey.commandError(1, "", "hey: connection refused", "fallback"),
  "hey: connection refused")
assert.strictEqual(hey.commandError(127, "", "", "Could not run hey"),
  "Could not run hey (exit 127)")

console.log("test_hey.js ok")
