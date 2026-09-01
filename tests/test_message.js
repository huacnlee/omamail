const assert = require("assert")
const { load, deepEqual } = require("./load")

const message = load("message/Message.js")

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
// And the way back: an id names the part it was listed from, which is how a
// caller holding only an id gets at what the server said about it.
assert.strictEqual(message.partForAttachment(withAttachment, "att1"),
  withAttachment.parts[0])
assert.strictEqual(message.partForAttachment(withAttachment, "nosuch"), null)
assert.strictEqual(message.partForAttachment(withAttachment, ""), null)
assert.strictEqual(message.partForAttachment(null, "att1"), null)
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
assert.strictEqual(message.formatCount(1, "original attachment"), "1 original attachment")
assert.strictEqual(message.formatCount(2, "original attachment"), "2 original attachments")

// A forwarded file is a real MIME attachment, not only a label in the draft.
// Its provider data is already base64url, including arbitrary binary bytes.
const forwardRaw = message.buildRawMessage({
  from: "me@example.com",
  to: "you@example.com",
  subject: "Fwd: report",
  body: "See the original file.",
  boundary: "=_forward_test",
  attachments: [{
    filename: "report.pdf",
    mimeType: "application/pdf",
    size: 4,
    data: "AP_-AQ"
  }]
})
assert.ok(forwardRaw.includes('Content-Type: multipart/mixed; boundary="=_forward_test"'))
assert.ok(forwardRaw.includes('Content-Disposition: attachment; filename="report.pdf"'))
assert.ok(forwardRaw.includes("AP/+AQ=="), "attachment bytes remain intact")
assert.strictEqual(message.attachments(message.parseRfc822(forwardRaw))[0].filename,
  "report.pdf")
const emptyForward = message.buildRawMessage({
  to: "you@example.com", body: "Empty file attached", boundary: "=_empty_test",
  attachments: [{ filename: "empty.txt", mimeType: "text/plain", size: 0, data: "" }]
})
assert.ok(emptyForward.includes('filename="empty.txt"'), "a zero-byte attachment is still attached")

// -------------------------------------------------------------------- time

// Local, not UTC. relativeTime reads local calendar fields to decide whether a
// message arrived today, so a UTC-anchored fixture is only "15:00 on the 19th"
// for a reader west of UTC+9. From UTC+9 to UTC+11 it is already past local
// midnight, three hours before it falls on the previous local day, and the
// clock-time assertion below sees a weekday instead. Anchoring the fixture the
// same way the function reads it makes the day boundary the same everywhere.
const now = new Date(2026, 7, 19, 15, 0, 0)
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
      { name: "Cc", value: "team@example.com, work@example.net" },
      { name: "Bcc", value: "hidden@example.org" },
      { name: "Subject", value: "  Invoice   for   August  " },
      { name: "In-Reply-To", value: "<earlier@example.net>" },
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
assert.strictEqual(summary.cc.length, 2, "Cc is carried: a reply picks its alias out of it")
assert.strictEqual(summary.cc[1].email, "work@example.net")
deepEqual(summary.bcc || [], [{ name: "hidden", email: "hidden@example.org",
  display: "hidden" }], "Bcc is carried when a stored draft is reopened")
assert.strictEqual(summary.inReplyTo, "<earlier@example.net>")
assert.strictEqual(message.summarize({ payload: { headers: [] } }, now).cc.length, 0)
assert.strictEqual(message.summarize({ payload: { headers: [] } }, now).bcc.length, 0)
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

assert.strictEqual(typeof message.draftFields, "function",
  "stored messages need one provider-neutral path back into compose")
deepEqual(message.draftFields({
  from: { email: "me@example.com" },
  to: [{ email: "first@example.com" }, { email: "second@example.com" }],
  cc: [{ email: "copy@example.com" }],
  bcc: [{ email: "hidden@example.com" }],
  subject: "Saved subject",
  threadId: "thread-7",
  inReplyTo: "<earlier@example.com>"
}, "Saved body"), {
  mode: "draft",
  from: "me@example.com",
  to: "first@example.com, second@example.com",
  cc: "copy@example.com",
  bcc: "hidden@example.com",
  subject: "Saved subject",
  body: "Saved body",
  threadId: "thread-7",
  inReplyTo: "<earlier@example.com>"
})
assert.strictEqual(message.draftFields({ subject: "(no subject)" }, "").subject, "")

// ------------------------------------------------------------ composition

assert.strictEqual(message.replySubject("Invoice"), "Re: Invoice")
assert.strictEqual(message.replySubject("Re: Invoice"), "Re: Invoice", "Re: is not stacked")
assert.strictEqual(message.replySubject("RE: Invoice"), "RE: Invoice")
assert.strictEqual(message.replySubject(""), "Re: (no subject)")

const raw = message.buildRawMessage({
  from: "work@example.net",
  to: "jane@example.com",
  subject: "你好",
  body: "Hi Jane,\n\nThanks!",
  inReplyTo: "<abc@mail.gmail.com>"
})

assert.ok(raw.indexOf("From: work@example.net\r\n") === 0)

// A display name is a phrase and encodes as one. Quoted when it is ASCII —
// an unquoted comma or dot would split the address list — and an encoded word
// when it is not, which may never be wrapped in quotes of its own.
assert.ok(message.buildRawMessage({
  from: "work@example.net", fromName: "Jason Lee", to: "jane@example.com"
}).indexOf('From: "Jason Lee" <work@example.net>\r\n') === 0)
assert.ok(message.buildRawMessage({
  from: "work@example.net", fromName: 'Lee, Jason "JL"', to: "jane@example.com"
}).indexOf('From: "Lee, Jason \\"JL\\"" <work@example.net>\r\n') === 0,
  "a quote inside the name is escaped rather than ending it")
assert.ok(message.buildRawMessage({
  from: "work@example.net", fromName: "李四", to: "jane@example.com"
}).indexOf("From: =?UTF-8?B?" + Buffer.from("李四", "utf8").toString("base64")
  + "?= <work@example.net>\r\n") === 0)
assert.ok(message.buildRawMessage({
  from: "work@example.net", fromName: "   ", to: "jane@example.com"
}).indexOf("From: work@example.net\r\n") === 0, "an empty name leaves a bare address")
assert.ok(raw.indexOf("To: jane@example.com\r\n") >= 0)
assert.ok(message.buildRawMessage({
  to: "jane@example.com", bcc: "hidden@example.com", body: "x"
}).indexOf("Bcc: hidden@example.com\r\n") >= 0,
  "a mailto bcc has to leave as a Bcc header or it is not blind")
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

// ------------------------------------------- the direction a message states
//
// The compose field is resolved by Qt from the text in it, so the writer sees
// their own paragraph the right way round. None of that leaves with the
// message: a `text/plain` part states no direction, and a client with nothing
// to read assumes left-to-right. An HTML twin beside the plain text is the
// only thing every client honours, so a right-to-left message grows one.
{
  const persian = "سلام، عرض ادب\n\nبا تشکر"
  const raw = message.buildRawMessage({
    to: "you@example.com", subject: "سلام", body: persian, boundary: "FABOUND"
  })

  const parsed = message.parseRfc822(raw)
  assert.strictEqual(parsed.mimeType, "multipart/alternative")
  assert.strictEqual(parsed.parts.length, 2)
  // Least preferred first: a client showing one alternative shows the last it
  // understands, and the twin is the part carrying the direction.
  assert.strictEqual(parsed.parts[0].mimeType, "text/plain")
  assert.strictEqual(message.decodePart(parsed.parts[0]), persian,
    "the plain part is the message as written, unchanged")
  assert.strictEqual(parsed.parts[1].mimeType, "text/html")
  assert.ok(message.decodePart(parsed.parts[1]).indexOf('<body dir="rtl">') > 0)

  // Line breaks are what a plain body says with, so they have to survive the
  // crossing into markup.
  assert.ok(message.decodePart(parsed.parts[1]).indexOf("<br>") > 0)

  // The body is a person's typing, not markup, and may not become markup on
  // the way out.
  const escaped = message.parseRfc822(message.buildRawMessage({
    to: "a@b.com", body: "سلام <b>&x</b>", boundary: "ESCB"
  }))
  assert.strictEqual(message.decodePart(escaped.parts[1]),
    '<html><body dir="rtl">سلام &lt;b&gt;&amp;x&lt;/b&gt;</body></html>')

  // Left-to-right is what a bare text/plain already means, so saying it would
  // make every message ever sent multipart in order to repeat the default.
  const latin = message.buildRawMessage({ to: "a@b.com", body: "Hi Jane,\n\nThanks!" })
  assert.ok(latin.indexOf("Content-Type: text/plain; charset=UTF-8") > 0)
  assert.ok(latin.indexOf("multipart") < 0,
    "a left-to-right message keeps the shape it has always had")

  // A forced setting is not consulted here: the direction is read off the body
  // by the same rule the reader uses, so what arrives matches what was typed.
  assert.ok(message.buildRawMessage({
    to: "a@b.com", body: "Hello سلام"
  }).indexOf("multipart") < 0, "first strong character decides, as it does everywhere")

  // An Arabic-Indic number is not a strong character, so an English message
  // that opens with a price or a date pasted out of one does not become a
  // right-to-left message on the way out. It did: the digits sit inside the
  // Arabic block, and the scan asked which block before it asked which class.
  assert.ok(message.buildRawMessage({
    to: "a@b.com", body: "١٢٣ Smith Street\nThe report is attached."
  }).indexOf("multipart") < 0,
    "an English body opening with an Arabic-Indic number stays plain text")

  // With an attachment the pair moves one level in. The inner boundary may not
  // begin with the outer one: `splitMultipart` finds a delimiter by searching
  // for "--" + boundary anywhere in the body, so a suffixed inner boundary
  // would be found by the outer scan too and the message would come apart at
  // the wrong line.
  const attached = message.buildRawMessage({
    to: "a@b.com", body: "سلام دوست من", boundary: "OUTER",
    attachments: [{ filename: "f.txt", mimeType: "text/plain", data: "aGk=" }]
  })
  const withFile = message.parseRfc822(attached)
  assert.strictEqual(withFile.mimeType, "multipart/mixed")
  assert.strictEqual(withFile.parts.length, 2)
  assert.strictEqual(withFile.parts[0].mimeType, "multipart/alternative")
  assert.strictEqual(withFile.parts[0].parts.length, 2)
  assert.strictEqual(withFile.parts[0].parts[0].mimeType, "text/plain")
  assert.strictEqual(withFile.parts[0].parts[1].mimeType, "text/html")
  assert.strictEqual(message.decodePart(withFile.parts[1]), "hi",
    "the attachment survives the extra nesting")
  const inner = attached.match(/boundary="(alt_[^"]+)"/)[1]
  assert.ok(("--" + inner).indexOf("--OUTER") < 0,
    "the inner delimiter cannot be read as the outer one")
}

// ------------------------------------------------------------- a calendar
//
// An RSVP is an ordinary mail with a `text/calendar` part beside the sentence
// a person would read. Checked by parsing the message back with the adapter
// the IMAP client uses, because "the shape is right" only means anything if
// the readers agree.
{
  const ics = "BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nUID:u1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
  const raw = message.buildRawMessage({
    from: "me@example.com",
    to: "organiser@example.com",
    subject: "Accepted: Weekly sync",
    body: "Jason has accepted this invitation.",
    calendar: { method: "REPLY", text: ics },
    boundary: "TESTBOUNDARY"
  })

  assert.ok(raw.indexOf('Content-Type: multipart/alternative; boundary="TESTBOUNDARY"') > 0)
  assert.ok(raw.indexOf("From: me@example.com\r\n") >= 0,
    "a reply names the address it answers for, which is the one the ATTENDEE line claims")
  assert.ok(raw.indexOf("Content-Type: text/calendar; charset=UTF-8; method=REPLY") > 0)
  assert.ok(raw.indexOf("--TESTBOUNDARY--") > 0, "the closing boundary is there")

  const parsed = message.parseRfc822(raw)
  assert.strictEqual(parsed.mimeType, "multipart/alternative")
  assert.strictEqual(parsed.parts.length, 2)
  assert.strictEqual(parsed.parts[0].mimeType, "text/plain")
  assert.strictEqual(message.decodePart(parsed.parts[0]), "Jason has accepted this invitation.")
  assert.strictEqual(parsed.parts[1].mimeType, "text/calendar")
  assert.strictEqual(message.decodePart(parsed.parts[1]), ics)

  // The transfer encoding is base64, so no part body can contain the boundary
  // however long the calendar file gets.
  const bigRaw = message.buildRawMessage({
    to: "a@b.com", body: "x",
    calendar: { method: "REPLY", text: "BEGIN:VCALENDAR\r\nX-PAD:" + "y".repeat(5000) + "\r\nEND:VCALENDAR\r\n" },
    boundary: "TESTBOUNDARY"
  })
  assert.strictEqual(bigRaw.split("--TESTBOUNDARY").length - 1, 3,
    "two openers and one closer, and nothing that looks like a third opener")

  // The method comes out of a file somebody else wrote, so it may not end the
  // header early or add one of its own.
  const hostile = message.buildRawMessage({
    to: "a@b.com", body: "x",
    calendar: { method: 'REPLY"\r\nBcc: attacker@example.net', text: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" },
    boundary: "TESTBOUNDARY"
  })
  assert.ok(hostile.indexOf("Bcc") < 0)
  const methodLine = hostile.split("\r\n").filter(function(line) {
    return line.indexOf("Content-Type: text/calendar") === 0
  })[0]
  assert.ok(/^Content-Type: text\/calendar; charset=UTF-8; method=[A-Z]+$/.test(methodLine),
    "the method is letters only: " + JSON.stringify(methodLine))

  // No calendar, no change: an ordinary reply is still one flat text/plain.
  assert.strictEqual(message.parseRfc822(
    message.buildRawMessage({ to: "a@b.com", body: "hi" })).mimeType, "text/plain")

  // A boundary the caller did not name is generated, and is still a boundary
  // the message parses against.
  const generated = message.parseRfc822(message.buildRawMessage({
    to: "a@b.com", body: "hi", calendar: { method: "REPLY", text: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" }
  }))
  assert.strictEqual(generated.mimeType, "multipart/alternative")
  assert.strictEqual(generated.parts.length, 2)
}

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
  // A ">" inside an alt text does not end the tag — Html.imageSources numbers
  // the pictures with the same walk, and a disagreement puts every marker after
  // it on the wrong one.
  assert.strictEqual(
    message.htmlToText("<img alt=\"a>b\" src=\"x.png\"><p>after</p><img src='y.png'>"),
    "[image 1]after\n[image 2]")
}

// -------------------------------------------------------- header injection
//
// In-Reply-To carries a Message-ID, and a Message-ID is whatever the sender
// wrote in theirs. A line break in one would end the header and let the rest be
// read as another — a Bcc in a reply the user typed no Bcc into.
{
  const raw = message.buildRawMessage({
    to: "friend@example.com",
    subject: "Re: hello",
    inReplyTo: "<a@b>\r\nBcc: attacker@example.net",
    body: "hi"
  })
  const headerNames = (text) => text.split("\r\n\r\n")[0].split("\r\n")
    .map((line) => line.split(":")[0])
  assert.ok(headerNames(raw).indexOf("Bcc") < 0, "a Message-ID must not become a second header")
  assert.ok(raw.indexOf("In-Reply-To: <a@b> Bcc: attacker@example.net") > 0,
    "the value survives as one header line")

  const folded = message.buildRawMessage({
    from: "me@example.com\r\nBcc: attacker@example.net",
    fromName: "Me\r\nBcc: attacker@example.net",
    to: "friend@example.com\r\nBcc: attacker@example.net",
    subject: "hello\nX-Injected: 1",
    body: "hi"
  })
  assert.ok(headerNames(folded).indexOf("Bcc") < 0)
  assert.ok(headerNames(folded).indexOf("X-Injected") < 0)
  // Every header a message must carry is still there, and the body still
  // starts after exactly one blank line.
  assert.ok(folded.indexOf("\r\n\r\n") > 0)

  // A reference that is nothing but a line break leaves the header out
  // altogether rather than emitting an empty one.
  assert.ok(message.buildRawMessage({ to: "a@b.com", inReplyTo: "\r\n", body: "x" })
    .indexOf("In-Reply-To") < 0)
}

// ------------------------------------------------------ RFC 822 → payload
//
// The adapter that lets an IMAP message drive the same reader a Gmail message
// does. Everything here is checked through the *existing* readers —
// extractBody, extractHtml, attachments, summarize — because "the shape is
// right" only means anything if those still work on it.
{
  // A byte string: one character per octet, the shape Imap.decodeResponse
  // produces and the only shape these counts are correct in.
  const bytes = (text) => Buffer.from(text, "utf8").toString("latin1")

  // --- the simplest possible message

  const plain = message.parseRfc822(bytes(
    "From: Jane <jane@example.org>\r\n" +
    "Subject: Hello\r\n" +
    "\r\n" +
    "Just a line.\r\n"))

  assert.strictEqual(plain.mimeType, "text/plain",
    "no Content-Type at all is text/plain, which is what the RFC says")
  deepEqual(message.extractBody(plain), { text: "Just a line.\n", source: "plain" })
  assert.strictEqual(message.headerValue({ payload: plain }, "Subject"), "Hello")

  // Bare LF, which a surprising number of senders emit, has to parse too.
  const bareLf = message.parseRfc822("Subject: X\n\nbody text\n")
  assert.strictEqual(message.extractBody(bareLf).text, "body text\n")

  // --- folded headers
  //
  // Unfolding must happen before anything looks for a ":", or a wrapped
  // Subject becomes a header named after its own second line.

  const foldedHeaders = message.parseRfc822(bytes(
    "Subject: a very long subject that the sender\r\n" +
    " wrapped across two lines\r\n" +
    "From: jane@example.org\r\n" +
    "\r\n" +
    "x"))
  assert.strictEqual(
    message.headerValue({ payload: foldedHeaders }, "Subject"),
    "a very long subject that the sender wrapped across two lines")
  assert.strictEqual(message.headerValue({ payload: foldedHeaders }, "From"), "jane@example.org",
    "the header after a folded one is still found")

  // --- transfer encodings

  const quotedPrintable = message.parseRfc822(bytes(
    "Content-Type: text/plain; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: quoted-printable\r\n" +
    "\r\n" +
    "Caf=C3=A9 cr=C3=A8me and a soft=\r\n break\r\n"))
  assert.strictEqual(message.extractBody(quotedPrintable).text, "Café crème and a soft break\n",
    "=XX decodes, a trailing = is a soft break that disappears, and an underscore is literal")

  // The encoded-word form of quoted-printable turns "_" into a space; the body
  // form must not, or every snake_case word in a message loses its underscores.
  const underscores = message.parseRfc822(bytes(
    "Content-Transfer-Encoding: quoted-printable\r\n\r\nsnake_case_name\r\n"))
  assert.strictEqual(message.extractBody(underscores).text, "snake_case_name\n")

  const base64Body = message.parseRfc822(bytes(
    "Content-Type: text/plain; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n" +
    "\r\n" +
    Buffer.from("你好，世界", "utf8").toString("base64") + "\r\n"))
  assert.strictEqual(message.extractBody(base64Body).text, "你好，世界")

  // A charset that is not UTF-8 still has to come out right.
  const latin1 = message.parseRfc822(
    "Content-Type: text/plain; charset=ISO-8859-1\r\n\r\n" +
    Buffer.from("Café", "latin1").toString("latin1"))
  assert.strictEqual(message.extractBody(latin1).text, "Café",
    "the declared charset decides, not a guess")

  // --- multipart/alternative: plain wins, html is the fallback

  const alternative = message.parseRfc822(bytes(
    "Content-Type: multipart/alternative; boundary=\"XYZ\"\r\n" +
    "\r\n" +
    "This is the preamble, for clients that predate MIME.\r\n" +
    "--XYZ\r\n" +
    "Content-Type: text/plain; charset=UTF-8\r\n" +
    "\r\n" +
    "the plain one\r\n" +
    "--XYZ\r\n" +
    "Content-Type: text/html; charset=UTF-8\r\n" +
    "\r\n" +
    "<p>the html one</p>\r\n" +
    "--XYZ--\r\n" +
    "This is the epilogue.\r\n"))

  assert.strictEqual(alternative.mimeType, "multipart/alternative")
  assert.strictEqual(alternative.parts.length, 2, "preamble and epilogue are not parts")
  deepEqual(message.extractBody(alternative), { text: "the plain one", source: "plain" })
  assert.strictEqual(message.extractHtml(alternative), "<p>the html one</p>")
  // The CRLF before a delimiter belongs to the delimiter. A part that keeps it
  // gains a trailing blank line — and a base64 part gains bytes.
  assert.ok(!/\n$/.test(message.extractHtml(alternative)))

  // --- nested multipart/mixed → alternative, which is the everyday newsletter

  const nested = message.parseRfc822(bytes(
    "Content-Type: multipart/mixed; boundary=OUTER\r\n\r\n" +
    "--OUTER\r\n" +
    "Content-Type: multipart/alternative; boundary=INNER\r\n\r\n" +
    "--INNER\r\n" +
    "Content-Type: text/plain\r\n\r\n" +
    "nested plain\r\n" +
    "--INNER\r\n" +
    "Content-Type: text/html\r\n\r\n" +
    "<b>nested html</b>\r\n" +
    "--INNER--\r\n" +
    "--OUTER\r\n" +
    "Content-Type: application/pdf; name=\"invoice.pdf\"\r\n" +
    "Content-Disposition: attachment; filename=\"invoice.pdf\"\r\n" +
    "Content-Transfer-Encoding: base64\r\n\r\n" +
    Buffer.from("%PDF-1.4 fake", "utf8").toString("base64") + "\r\n" +
    "--OUTER--\r\n"))

  assert.strictEqual(message.extractBody(nested).text, "nested plain")
  assert.strictEqual(message.extractHtml(nested), "<b>nested html</b>")

  const found = message.attachments(nested)
  assert.strictEqual(found.length, 1, "the attachment is listed and the text parts are not")
  assert.strictEqual(found[0].filename, "invoice.pdf")
  assert.strictEqual(found[0].mimeType, "application/pdf")
  assert.strictEqual(found[0].size, 13, "the size is the decoded size, not the base64 size")
  assert.strictEqual(found[0].attachmentId, "part:2",
    "the id is the IMAP part path, which is what a later FETCH would ask for")

  // An attachment must never be mistaken for the body.
  assert.ok(message.extractBody(nested).text.indexOf("PDF") < 0)

  // --- an encoded filename

  const encodedName = message.parseRfc822(bytes(
    "Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
    "--B\r\n" +
    "Content-Disposition: attachment; filename=\"=?UTF-8?B?5oql5ZGKLnBkZg==?=\"\r\n\r\n" +
    "x\r\n" +
    "--B--\r\n"))
  assert.strictEqual(message.attachments(encodedName)[0].filename, "报告.pdf")

  // --- a multipart whose boundary never appears
  //
  // Broken, and sent every day. Falling through to the body keeps the message
  // readable instead of showing an empty reader.

  const brokenBoundary = message.parseRfc822(bytes(
    "Content-Type: multipart/alternative; boundary=NOPE\r\n\r\nthe body anyway\r\n"))
  assert.strictEqual(message.extractBody(brokenBoundary).text, "the body anyway\n")

  // The same repair has to reach the reader, not just the text: a broken
  // multipart carrying markup is relabelled html so the reader still renders
  // it, while one carrying prose stays plain and keeps its angle brackets.
  const brokenHtml = message.parseRfc822(bytes(
    "Content-Type: multipart/alternative; boundary=NOPE\r\n\r\n" +
    "<p>markup anyway</p>\r\n"))
  assert.strictEqual(message.extractHtml(brokenHtml), "<p>markup anyway</p>\r\n")
  assert.strictEqual(
    message.extractHtml(message.parseRfc822(bytes(
      "Content-Type: multipart/mixed; boundary=NOPE\r\n\r\n" +
      "a < b and c > d\r\n"))),
    "", "prose that merely contains brackets is not promoted to markup")

  // --- depth is bounded
  //
  // Everything downstream walks this tree by recursion, in the process that
  // draws the whole desktop.

  let deep = "deep body"
  for (let i = 0; i < 40; i++) {
    deep = "Content-Type: multipart/mixed; boundary=B" + i + "\r\n\r\n" +
      "--B" + i + "\r\n" + deep + "\r\n--B" + i + "--\r\n"
  }
  const bounded = message.parseRfc822(bytes(deep))
  let depth = 0
  let node = bounded
  while (node && node.parts && node.parts.length > 0) {
    node = node.parts[0]
    depth++
  }
  assert.ok(depth <= 12, "a deeply nested message is not an unbounded recursion (was " + depth + ")")

  // --- the whole round trip, as summarize sees it

  const summary = message.summarize({
    id: "42",
    labelIds: ["UNREAD", "INBOX"],
    internalDate: Date.UTC(2026, 6, 17, 9, 0, 0),
    payload: message.parseRfc822(bytes(
      "From: =?UTF-8?B?55Sw5Lit?= <tanaka@example.jp>\r\n" +
      "To: jane@example.org\r\n" +
      "Subject: =?UTF-8?Q?Re=3A_caf=C3=A9?=\r\n" +
      "Message-ID: <abc@example.jp>\r\n" +
      "\r\n" +
      "body"))
  }, new Date(Date.UTC(2026, 6, 17, 9, 5, 0)))

  assert.strictEqual(summary.from.name, "田中", "an encoded display name decodes")
  assert.strictEqual(summary.from.email, "tanaka@example.jp")
  assert.strictEqual(summary.subject, "Re: café")
  assert.strictEqual(summary.messageId, "<abc@example.jp>")
  assert.strictEqual(summary.unread, true)
  assert.strictEqual(summary.inInbox, true)
  assert.strictEqual(summary.time, "5m")

  // --- snippets, which IMAP does not send and this has to make

  assert.strictEqual(message.buildSnippet("  lots   of\n\nwhitespace  "), "lots of whitespace")
  assert.strictEqual(message.buildSnippet("x".repeat(400)).length, 200)
  assert.strictEqual(message.buildSnippet(""), "")
  assert.strictEqual(message.buildSnippet(null), "")

  // --- nothing at all

  deepEqual(message.extractBody(message.parseRfc822("")), { text: "", source: "" })
  deepEqual(message.attachments(message.parseRfc822("")), [])
}

// A header value is not a header line. `fromHeader` writes the whole `From:`
// field; a provider composing a `To:` needs the address on its own, and pasting
// one into the other produced `To: From: "Name" <a@b.com>` — which parses back
// as a display name of `From: "Name"`.
assert.strictEqual(message.addressHeader("jane@example.com", "Jane Roe"),
  '"Jane Roe" <jane@example.com>')
assert.strictEqual(message.addressHeader("jane@example.com", ""), "jane@example.com")
assert.strictEqual(message.fromHeader("jane@example.com", "Jane Roe"),
  'From: "Jane Roe" <jane@example.com>')
assert.strictEqual(message.parseAddress(message.addressHeader("jane@example.com", "Jane Roe")).name,
  "Jane Roe", "what is written comes back")

console.log("test_message.js ok")
