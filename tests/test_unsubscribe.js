const assert = require("assert")
const { load, deepEqual } = require("./load")

const unsub = load("message/Unsubscribe.js")

function headers(pairs) {
  return Object.keys(pairs).map(function(name) {
    return { name: name, value: pairs[name] }
  })
}

// ----------------------------------------------------------- header entries

deepEqual(unsub.entries("<https://example.com/u/1>, <mailto:bye@example.com>"),
  ["https://example.com/u/1", "mailto:bye@example.com"])
deepEqual(unsub.entries(" <https://example.com/u/1> "), ["https://example.com/u/1"])
deepEqual(unsub.entries(""), [])
deepEqual(unsub.entries("https://example.com/u/1"), [],
  "an entry outside brackets is not one the RFC defines")

// The brackets delimit, not the comma: a mailto body may hold one, and reading
// it as a separator turns one address into two broken ones.
deepEqual(unsub.entries("<mailto:bye@example.com?body=one,two>"),
  ["mailto:bye@example.com?body=one,two"])

// A header long enough to be an attack rather than a list is not walked at all.
deepEqual(unsub.entries("<https://a.example.com/" + new Array(4000).join("x") + ">"), [])

// ------------------------------------------------------------------ mailto

deepEqual(unsub.parseMailto("mailto:bye@example.com"),
  { to: "bye@example.com", subject: "Unsubscribe", body: "Unsubscribe" })
deepEqual(unsub.parseMailto("mailto:bye@example.com?subject=Stop%20these&body=please"),
  { to: "bye@example.com", subject: "Stop these", body: "please" })
// "+" is a space in a query string, which is where these live.
assert.strictEqual(unsub.parseMailto("mailto:bye@example.com?subject=Stop+these").subject,
  "Stop these")
// Several recipients: the first is the one that unambiguously belongs here.
assert.strictEqual(unsub.parseMailto("mailto:a@example.com,b@example.com").to, "a@example.com")
assert.strictEqual(unsub.parseMailto("mailto:not-an-address"), null)
assert.strictEqual(unsub.parseMailto("https://example.com"), null)

// This value goes into a message this plugin builds. A newline in it is how a
// list gets to write its own Bcc, so it never survives.
const injected = unsub.parseMailto(
  "mailto:bye@example.com?subject=Stop%0D%0ABcc:%20victim@example.com")
assert.strictEqual(injected.subject.indexOf("\n"), -1)
assert.strictEqual(injected.subject.indexOf("\r"), -1)
assert.strictEqual(injected.subject, "Stop Bcc: victim@example.com")
assert.strictEqual(unsub.parseMailto("mailto:bye@example.com?subject=%E4%B8%AD%E6%96%87").subject,
  "中文", "a percent-encoded subject decodes as UTF-8")
// A stray percent is not an escape, and losing the whole subject over one is
// worse than keeping it as written.
assert.strictEqual(unsub.parseMailto("mailto:bye@example.com?subject=100%").subject, "100%")

// --------------------------------------------------------------------- URLs

assert.strictEqual(unsub.isPublicWebUrl("https://list.example.com/u/1"), true)
assert.strictEqual(unsub.isPublicWebUrl("http://list.example.com/u/1"), true)
assert.strictEqual(unsub.isPublicWebUrl("https://127.0.0.1/u/1"), false)
assert.strictEqual(unsub.isPublicWebUrl("https://localhost/u/1"), false)
assert.strictEqual(unsub.isPublicWebUrl("https://192.168.1.1/u/1"), false)
assert.strictEqual(unsub.isPublicWebUrl("https://[::1]/u/1"), false)
assert.strictEqual(unsub.isPublicWebUrl("https://router.local/u/1"), false)
assert.strictEqual(unsub.isPublicWebUrl("javascript:alert(1)"), false)
assert.strictEqual(unsub.isPublicWebUrl("file:///etc/passwd"), false)

// A POST carries the fact that this address reads this mail. Over plain http
// that is a postcard to a host the sender chose.
assert.strictEqual(unsub.isPostableUrl("https://list.example.com/u/1"), true)
assert.strictEqual(unsub.isPostableUrl("http://list.example.com/u/1"), false)
assert.strictEqual(unsub.isPostableUrl("https://10.0.0.5/u/1"), false)

// ------------------------------------------------------------- the decision

const oneClick = unsub.from(
  "<https://list.example.com/u/1>, <mailto:bye@example.com?subject=unsub>",
  "List-Unsubscribe=One-Click")
assert.strictEqual(oneClick.available, true)
assert.strictEqual(oneClick.oneClick, true)
assert.strictEqual(oneClick.postUrl, "https://list.example.com/u/1")
assert.strictEqual(oneClick.mail.to, "bye@example.com")
assert.strictEqual(unsub.plan(oneClick, true), "post")
assert.strictEqual(unsub.plan(oneClick, false), "post",
  "a one-click POST needs nothing from the provider")
assert.strictEqual(unsub.label(oneClick, true), "Unsubscribe")

// Without the header there is no promise that a POST is enough, and posting
// anyway would be a guess at somebody else's API.
const linkOnly = unsub.from("<https://list.example.com/u/1>", "")
assert.strictEqual(linkOnly.oneClick, false)
assert.strictEqual(linkOnly.postUrl, "")
assert.strictEqual(linkOnly.url, "https://list.example.com/u/1")
assert.strictEqual(unsub.plan(linkOnly, true), "browser")
assert.strictEqual(unsub.label(linkOnly, true), "Unsubscribe...",
  "a label that opens a browser says so before it is pressed")

// The header claims one-click over plain http, which RFC 8058 does not allow.
const insecure = unsub.from("<http://list.example.com/u/1>", "List-Unsubscribe=One-Click")
assert.strictEqual(insecure.oneClick, false)
assert.strictEqual(unsub.plan(insecure, true), "browser")

// A URL nobody should be asked to fetch leaves only the mailto standing.
const privateHost = unsub.from(
  "<https://192.168.0.1/u/1>, <mailto:bye@example.com>", "List-Unsubscribe=One-Click")
assert.strictEqual(privateHost.url, "")
assert.strictEqual(privateHost.oneClick, false)
assert.strictEqual(unsub.plan(privateHost, true), "mail")

const mailOnly = unsub.from("<mailto:bye@example.com>", "")
assert.strictEqual(unsub.plan(mailOnly, true), "mail")
// A mailbox that cannot send still has something to offer, and it is the last
// resort rather than a button that fails after it is pressed.
assert.strictEqual(unsub.plan(unsub.from("<mailto:bye@example.com>, <https://list.example.com/u/1>", ""), false),
  "browser")
assert.strictEqual(unsub.plan(mailOnly, false), "mail",
  "with nothing else on offer the mail is still the answer")

const nothing = unsub.from("", "")
assert.strictEqual(nothing.available, false)
assert.strictEqual(unsub.plan(nothing, true), "")
assert.strictEqual(unsub.label(nothing, true), "")
assert.strictEqual(unsub.explanation(nothing, true), "")

// The sentence beside the button says which of the three amounts of work the
// user is agreeing to.
assert.strictEqual(unsub.explanation(oneClick, true),
  "This sender accepts a one-click unsubscribe")
assert.strictEqual(unsub.explanation(mailOnly, true),
  "Unsubscribing sends a message to this list")
assert.strictEqual(unsub.explanation(linkOnly, true),
  "Unsubscribing opens this sender's page in a browser")

// ---------------------------------------------------------- out of a mail

const found = unsub.fromHeaders(headers({
  "From": "News <news@example.com>",
  "List-Unsubscribe": "<https://list.example.com/u/9>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
}))
assert.strictEqual(found.oneClick, true)
assert.strictEqual(found.postUrl, "https://list.example.com/u/9")

// Header names are case-insensitive on the wire and both providers pass them
// through as the server wrote them.
assert.strictEqual(unsub.fromHeaders(headers({
  "list-unsubscribe": "<mailto:bye@example.com>"
})).mail.to, "bye@example.com")

assert.strictEqual(unsub.fromHeaders(headers({ "From": "a@b.com" })).available, false)
assert.strictEqual(unsub.fromHeaders([]).available, false)
assert.strictEqual(unsub.fromHeaders(null).available, false)

// The whole message resource, which is what the reader holds.
assert.strictEqual(unsub.fromMessage({
  payload: { headers: headers({ "List-Unsubscribe": "<mailto:bye@example.com>" }) }
}).mail.to, "bye@example.com")
assert.strictEqual(unsub.fromMessage(null).available, false)

// ------------------------------------------------------------------- POST

assert.strictEqual(unsub.postBody(), "List-Unsubscribe=One-Click")
assert.strictEqual(unsub.postContentType(), "application/x-www-form-urlencoded")

console.log("test_unsubscribe.js ok")
