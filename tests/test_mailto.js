const assert = require("assert")
const { load, deepEqual } = require("./load")

const mailto = load("message/Mailto.js")

function draft(to, cc, bcc, subject, body) {
  return { to: to, cc: cc, bcc: bcc, subject: subject, body: body }
}

// ------------------------------------------------------------------ parse

deepEqual(mailto.parse("mailto:jane@example.com"),
  draft("jane@example.com", "", "", "", ""),
  "a bare address is a new message to that person")
deepEqual(mailto.parse("MAILTO:jane@example.com"),
  draft("jane@example.com", "", "", "", ""),
  "the scheme is case-insensitive")
deepEqual(mailto.parse("mailto:jane@example.com?subject=Lunch&body=Tuesday"),
  draft("jane@example.com", "", "", "Lunch", "Tuesday"))
deepEqual(mailto.parse("mailto:a@example.com,b@example.com"),
  draft("a@example.com, b@example.com", "", "", "", ""),
  "several path recipients stay in To")
deepEqual(mailto.parse("mailto:a@example.com?to=b@example.com&cc=c@example.com"),
  draft("a@example.com, b@example.com", "c@example.com", "", "", ""),
  "query to= is appended, cc= is Cc")
deepEqual(mailto.parse("mailto:?bcc=hidden@example.com"),
  draft("", "", "hidden@example.com", "", ""),
  "a bcc-only link still opens a draft")

assert.strictEqual(mailto.parse("mailto:jane@example.com?subject=Stop+these").subject,
  "Stop these", "+ in a query string is a space")
assert.strictEqual(mailto.parse("mailto:jane@example.com?subject=%E4%B8%AD%E6%96%87").subject,
  "中文")
assert.strictEqual(mailto.parse("mailto:jane@example.com?body=line%0Abreak").body,
  "line\nbreak")
assert.strictEqual(mailto.parse("mailto:jane@example.com?body=line%0D%0Abreak").body,
  "line\nbreak", "CRLF in a body becomes a newline")

const injected = mailto.parse(
  "mailto:jane@example.com?subject=Stop%0D%0ABcc:%20victim@example.com")
assert.strictEqual(injected.subject.indexOf("\n"), -1)
assert.strictEqual(injected.subject.indexOf("\r"), -1)
assert.strictEqual(injected.subject, "Stop Bcc: victim@example.com")

assert.strictEqual(mailto.parse("https://example.com"), null)
assert.strictEqual(mailto.parse(""), null)
assert.strictEqual(mailto.parse(null), null)
deepEqual(mailto.parse("mailto:"), draft("", "", "", "", ""),
  "an empty mailto still opens compose")
deepEqual(mailto.parse("mailto:jane@example.com#ignored"),
  draft("jane@example.com", "", "", "", ""),
  "a fragment is not part of the message")

// A stray percent is not an escape. Losing the whole subject over one is worse
// than keeping it as written.
assert.strictEqual(mailto.parse("mailto:jane@example.com?subject=100%").subject, "100%")

assert.strictEqual(mailto.parse("mailto:?attach=/tmp/scan.pdf").attachments,
  undefined,
  "attach= in a mailto URL is not a file; a message body can name one")
assert.strictEqual(mailto.parse("mailto:?attach=/etc/passwd").attachments, undefined)
assert.strictEqual(mailto.parse("mailto:jane@example.com").attachments, undefined)

// --------------------------------------------------------- payload → draft

deepEqual(mailto.draftFromPayload({ mailto: "mailto:jane@example.com?subject=Hi" }),
  draft("jane@example.com", "", "", "Hi", ""))
deepEqual(mailto.draftFromPayload({
  compose: true,
  attachments: ["/tmp/scan.pdf"]
}).attachments, ["/tmp/scan.pdf"],
  "a summon payload can name files without a mailto URL")
deepEqual(mailto.draftFromPayload({
  compose: true,
  attachments: ["file:///tmp/scan.pdf"]
}).attachments, ["/tmp/scan.pdf"])
deepEqual(mailto.draftFromPayload({
  mailto: "mailto:?attach=/etc/passwd"
}).attachments, undefined,
  "attach= in the URL is not enough; the handler must list the file")
assert.strictEqual(mailto.draftFromPayload({
  compose: true,
  attachments: ["https://example.com/x.pdf"]
}).attachments, undefined)
assert.strictEqual(mailto.draftFromPayload({
  compose: true,
  attachments: ["relative.pdf"]
}).attachments, undefined)
deepEqual(mailto.draftFromPayload({ compose: true }),
  draft("", "", "", "", ""),
  "compose:true is a blank draft")
assert.strictEqual(mailto.draftFromPayload({}), null)
assert.strictEqual(mailto.draftFromPayload({ mailbox: "inbox" }), null)
assert.strictEqual(mailto.draftFromPayload({ mailto: "https://example.com" }), null)
assert.strictEqual(mailto.draftFromPayload(null), null)

console.log("test_mailto.js ok")
