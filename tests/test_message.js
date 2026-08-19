const assert = require("assert")
const { load, deepEqual } = require("./load")

const message = load("Message.js")

function b64url(text) {
  return Buffer.from(text, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// ------------------------------------------------------------- base64 core
//
// The QML JS engine has no atob/btoa, so these are hand-rolled and checked
// against node's Buffer rather than against themselves.

const samples = [
  "",
  "a",
  "ab",
  "abc",
  "hello world",
  "你好，世界",                       // three-byte UTF-8
  "Grüße aus München",               // two-byte UTF-8
  "emoji 😀 tail",                   // surrogate pair, four-byte UTF-8
  "line\r\nbreak\ttab",
  "~!@#$%^&*()_+`-={}|[]\\:\";'<>?,./"
]

for (const sample of samples) {
  const expected = Buffer.from(sample, "utf8").toString("base64")
  assert.strictEqual(message.encodeBase64(sample), expected, "encode " + JSON.stringify(sample))
  assert.strictEqual(message.encodeBase64Url(sample),
    expected.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    "encodeUrl " + JSON.stringify(sample))
  assert.strictEqual(message.decodeBase64Url(b64url(sample)), sample,
    "round trip " + JSON.stringify(sample))
  // Padded standard base64 has to decode too: Gmail pads some part bodies.
  assert.strictEqual(message.decodeBase64Url(expected), sample)
}

// Gmail wraps long part bodies with newlines inside the base64 payload.
assert.strictEqual(message.decodeBase64Url("aGVs\nbG8g\r\nd29ybGQ="), "hello world")
assert.strictEqual(message.decodeBase64Url(""), "")
assert.strictEqual(message.decodeBase64Url(null), "")

// ------------------------------------------------------- RFC 2047 headers
//
// Gmail decodes transfer encodings for part bodies but leaves headers exactly
// as they arrived, so every non-ASCII subject line arrives encoded.

assert.strictEqual(message.decodeHeaderValue("Plain subject"), "Plain subject")
assert.strictEqual(
  message.decodeHeaderValue("=?UTF-8?B?" + Buffer.from("你好，世界", "utf8").toString("base64") + "?="),
  "你好，世界")
assert.strictEqual(
  message.decodeHeaderValue("=?UTF-8?Q?Gr=C3=BC=C3=9Fe?= aus M=C3=BCnchen"),
  "Grüße aus M=C3=BCnchen", "only encoded words are decoded, not the rest")
assert.strictEqual(message.decodeHeaderValue("=?utf-8?q?two_words?="), "two words",
  "underscore is a space inside a Q-encoded word")
assert.strictEqual(
  message.decodeHeaderValue("Re: =?UTF-8?B?" + Buffer.from("发票", "utf8").toString("base64") + "?= (fwd)"),
  "Re: 发票 (fwd)")

// Long CJK subjects are split across several encoded words. The whitespace
// between adjacent words is defined to disappear — keeping it inserts spaces
// into the middle of Chinese sentences.
const half1 = Buffer.from("这是一封很长的", "utf8").toString("base64")
const half2 = Buffer.from("中文邮件标题", "utf8").toString("base64")
assert.strictEqual(
  message.decodeHeaderValue("=?UTF-8?B?" + half1 + "?= =?UTF-8?B?" + half2 + "?="),
  "这是一封很长的中文邮件标题")

// An unsupported charset must still yield readable ASCII rather than an error.
assert.ok(message.decodeHeaderValue("=?GB2312?B?1eLK1w==?=").length > 0)
assert.strictEqual(message.decodeHeaderValue(""), "")
assert.strictEqual(message.decodeHeaderValue(null), "")

// ------------------------------------------------------------- addresses

deepEqual(message.parseAddress("Jane Doe <jane@example.com>"),
  { name: "Jane Doe", email: "jane@example.com", display: "Jane Doe" })
deepEqual(message.parseAddress("<jane@example.com>"),
  { name: "jane", email: "jane@example.com", display: "jane" })
deepEqual(message.parseAddress("jane@example.com"),
  { name: "jane", email: "jane@example.com", display: "jane" })
deepEqual(message.parseAddress("\"Doe, Jane\" <jane@example.com>"),
  { name: "Doe, Jane", email: "jane@example.com", display: "Doe, Jane" })
deepEqual(message.parseAddress(""), { name: "", email: "", display: "" })
assert.strictEqual(
  message.parseAddress("=?UTF-8?B?" + Buffer.from("张三", "utf8").toString("base64") + "?= <z@example.com>").display,
  "张三")

// A comma inside a quoted display name is not a list separator.
const recipients = message.parseAddressList("\"Doe, Jane\" <jane@x.com>, bob@y.com, Carl <carl@z.com>")
assert.strictEqual(recipients.length, 3)
assert.strictEqual(recipients[0].display, "Doe, Jane")
assert.strictEqual(recipients[2].email, "carl@z.com")
assert.strictEqual(message.parseAddressList("").length, 0)

assert.strictEqual(message.formatAddressList(recipients, 2), "Doe, Jane, bob, +1")
assert.strictEqual(message.formatAddressList(recipients, 5), "Doe, Jane, bob, Carl")
assert.strictEqual(message.formatAddressList([], 3), "")

// ------------------------------------------------------------------ bodies

const multipart = {
  mimeType: "multipart/alternative",
  parts: [
    { mimeType: "text/plain; charset=UTF-8", body: { data: b64url("plain body 你好") } },
    { mimeType: "text/html; charset=UTF-8", body: { data: b64url("<p>html body</p>") } }
  ]
}
deepEqual(message.extractBody(multipart), { text: "plain body 你好", source: "plain" })

// text/plain wins even when it is nested deeper than the html alternative.
const nested = {
  mimeType: "multipart/mixed",
  parts: [
    { mimeType: "text/html", body: { data: b64url("<p>outer html</p>") } },
    {
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/plain", body: { data: b64url("inner plain") } }]
    }
  ]
}
assert.strictEqual(message.extractBody(nested).text, "inner plain")

const htmlOnly = { mimeType: "text/html", body: { data: b64url("<p>Hi<br>there</p><script>x()</script>") } }
deepEqual(message.extractBody(htmlOnly), { text: "Hi\nthere", source: "html" })

// A text/plain attachment is a file, not the message body.
const withAttachment = {
  mimeType: "multipart/mixed",
  parts: [
    { mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "att1", size: 2048, data: b64url("file") } },
    { mimeType: "text/plain", body: { data: b64url("real body") } }
  ]
}
assert.strictEqual(message.extractBody(withAttachment).text, "real body")
deepEqual(message.attachments(withAttachment),
  [{ filename: "notes.txt", mimeType: "text/plain", size: 2048, attachmentId: "att1" }])
deepEqual(message.extractBody({ mimeType: "image/png", body: {} }), { text: "", source: "" })
deepEqual(message.extractBody(null), { text: "", source: "" })

assert.strictEqual(message.htmlToText("<p>a&nbsp;&amp;&nbsp;b</p>"), "a & b")
assert.strictEqual(message.htmlToText("<div>one</div><div>two</div>"), "one\ntwo")
assert.strictEqual(message.htmlToText("<!-- gone -->kept"), "kept")
assert.strictEqual(message.htmlToText("&#20320;&#22909;"), "你好")
assert.strictEqual(message.htmlToText("<style>p{}</style>text"), "text")

assert.strictEqual(message.formatSize(512), "512 B")
assert.strictEqual(message.formatSize(2048), "2.0 KB")
assert.strictEqual(message.formatSize(2 * 1024 * 1024), "2.0 MB")

// -------------------------------------------------------------------- time

const now = new Date("2026-08-19T15:00:00Z")
function ago(ms) { return new Date(now.getTime() - ms) }

assert.strictEqual(message.relativeTime(ago(30 * 1000), now), "now")
assert.strictEqual(message.relativeTime(ago(5 * 60000), now), "5m")
assert.strictEqual(message.relativeTime(ago(59 * 60000), now), "59m")
// Past an hour a clock time is more useful than "3h", and it matches how
// Gmail's own list reads.
assert.ok(/^\d\d:\d\d$/.test(message.relativeTime(ago(3 * 3600 * 1000), now)))
assert.ok(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(message.relativeTime(ago(3 * 86400000), now)))
assert.ok(/^[A-Z][a-z]{2} \d+$/.test(message.relativeTime(ago(40 * 86400000), now)))
assert.ok(/^[A-Z][a-z]{2} \d+, \d{4}$/.test(message.relativeTime(ago(500 * 86400000), now)))
assert.strictEqual(message.relativeTime(null, now), "")
// A message dated in the future must not render as a negative age.
assert.strictEqual(message.relativeTime(new Date(now.getTime() + 60000), now), "now")

// --------------------------------------------------------------- summarize

const resource = {
  id: "18f3a",
  threadId: "18f39",
  labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
  snippet: "Your receipt is attached &amp; ready",
  internalDate: String(now.getTime() - 10 * 60000),
  sizeEstimate: 4096,
  payload: {
    headers: [
      { name: "From", value: "=?UTF-8?B?" + Buffer.from("李四", "utf8").toString("base64") + "?= <li@example.com>" },
      { name: "To", value: "me@example.com" },
      { name: "Subject", value: "  Invoice   for   August  " },
      { name: "Date", value: "Wed, 19 Aug 2026 14:50:00 +0000" }
    ]
  }
}

const summary = message.summarize(resource, now)
assert.strictEqual(summary.id, "18f3a")
assert.strictEqual(summary.threadId, "18f39")
assert.strictEqual(summary.from.display, "李四")
assert.strictEqual(summary.from.email, "li@example.com")
assert.strictEqual(summary.subject, "Invoice for August", "runs of whitespace collapse")
assert.strictEqual(summary.snippet, "Your receipt is attached & ready")
assert.strictEqual(summary.time, "10m")
assert.strictEqual(summary.unread, true)
assert.strictEqual(summary.starred, false)
assert.strictEqual(summary.important, true)
assert.strictEqual(summary.inInbox, true)
assert.strictEqual(summary.inTrash, false)

assert.strictEqual(message.summarize({ payload: { headers: [] } }, now).subject, "(no subject)")
assert.strictEqual(message.summarize({}, now).id, "")

// A message with no internalDate falls back to the Date header.
const headerDated = message.summarize({
  payload: { headers: [{ name: "Date", value: "Wed, 19 Aug 2026 14:00:00 +0000" }] }
}, now)
assert.strictEqual(headerDated.date.getUTCHours(), 14)

assert.strictEqual(message.headerValue(resource, "subject"), "  Invoice   for   August  ",
  "header lookup is case-insensitive")
assert.strictEqual(message.headerValue(resource, "Reply-To"), "")

// A reply goes to Reply-To when the sender set one, and to From otherwise.
// The list rows are fetched with the metadata format and simply have neither.
assert.strictEqual(summary.replyTo.email, "")
assert.strictEqual(summary.messageId, "")
const withReplyTo = message.summarize({
  payload: { headers: [
    { name: "From", value: "noreply@example.com" },
    { name: "Reply-To", value: "Support <help@example.com>" },
    { name: "Message-ID", value: "<abc@mail.example.com>" }
  ] }
}, now)
assert.strictEqual(withReplyTo.replyTo.email, "help@example.com")
assert.strictEqual(withReplyTo.messageId, "<abc@mail.example.com>")

// ------------------------------------------------------------ composition

assert.strictEqual(message.replySubject("Invoice"), "Re: Invoice")
assert.strictEqual(message.replySubject("Re: Invoice"), "Re: Invoice", "Re: is not stacked")
assert.strictEqual(message.replySubject("RE: Invoice"), "RE: Invoice")
assert.strictEqual(message.replySubject(""), "Re: (no subject)")

const raw = message.buildRawMessage({
  to: "jane@example.com",
  subject: "你好",
  body: "Hi Jane,\n\nThanks!",
  inReplyTo: "<abc@mail.gmail.com>"
})

assert.ok(raw.indexOf("To: jane@example.com\r\n") >= 0)
// A non-ASCII subject has to go back out as an encoded word or Gmail rejects
// the whole raw message.
assert.ok(raw.indexOf("Subject: =?UTF-8?B?" + Buffer.from("你好", "utf8").toString("base64") + "?=") >= 0)
assert.ok(raw.indexOf("In-Reply-To: <abc@mail.gmail.com>\r\n") >= 0)
assert.ok(raw.indexOf("References: <abc@mail.gmail.com>\r\n") >= 0)
assert.ok(raw.indexOf("Content-Transfer-Encoding: base64\r\n") >= 0)

const rawBody = raw.split("\r\n\r\n")[1]
assert.strictEqual(Buffer.from(rawBody.replace(/\r\n/g, ""), "base64").toString("utf8"), "Hi Jane,\n\nThanks!")
for (const line of rawBody.split("\r\n")) {
  assert.ok(line.length <= 76, "base64 body lines are wrapped at 76 characters")
}

const payload = message.buildSendPayload({ to: "a@b.com", subject: "s", body: "b", threadId: "t1" })
assert.strictEqual(payload.threadId, "t1")
assert.strictEqual(
  Buffer.from(payload.raw, "base64url").toString("utf8").indexOf("To: a@b.com"), 0)
assert.strictEqual(message.buildSendPayload({ to: "a@b.com" }).threadId, undefined)

const quoted = message.quoteBody(summary, "line one\nline two")
assert.ok(quoted.indexOf("> line one\n> line two") > 0)
assert.ok(quoted.indexOf("李四 wrote:") > 0)

// The reader wants the markup; the list row wants the flattened text. Both
// walks must find the same part, and neither may return an attachment.
assert.strictEqual(message.extractHtml(multipart), "<p>html body</p>")
assert.strictEqual(message.extractHtml(nested), "<p>outer html</p>")
assert.strictEqual(message.extractHtml({ mimeType: "text/plain", body: { data: b64url("x") } }), "")
assert.strictEqual(message.extractHtml(null), "")
assert.strictEqual(message.extractHtml({
  mimeType: "multipart/mixed",
  parts: [{ mimeType: "text/html", filename: "page.html", body: { attachmentId: "a1", data: b64url("<p>file</p>") } }]
}), "", "an html attachment is a file, not the body")


// An image becomes a numbered marker, so the reader can offer the picture
// itself when the marker is clicked.
{
  assert.strictEqual(
    message.htmlToText("<div>Hello</div><img src=\"a.png\"><br><img src='b.png' width=600><p>Bye</p>"),
    "Hello\n[image 1]\n[image 2]Bye")
  assert.strictEqual(message.htmlToText("<p>none</p>"), "none", "text without images is unchanged")
}

console.log("test_message.js ok")