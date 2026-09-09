const assert = require("assert")
const fs = require("fs")
const path = require("path")
const vm = require("vm")
const { load } = require("./load")
const Calendar = load("message/Calendar.js")
const source = fs.readFileSync(path.join(__dirname, "../account/MailAccount.qml"), "utf8")
function method(name, next) {
  return source.slice(source.indexOf("  function " + name + "("),
    source.indexOf(next, source.indexOf("  function " + name + "(")))
}
const methods = method("select", "  // Mark the message the dwell")
  + method("loadInvite", "  // The one place `selectedHtml`")
const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT",
  "UID:meeting@example.org", "DTSTART:20260910T100000Z", "DTEND:20260910T110000Z",
  "SUMMARY:Meeting", "ORGANIZER:mailto:organiser@example.org",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.org", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n")
const data = Buffer.from(ics).toString("base64url")
for (const [order, inline] of [["cda", false], ["dca", false], ["dac", false],
    ["cd", true], ["dc", true], ["cd", false]]) {
  const callbacks = {}, writes = []
  const host = {
    Calendar, Mail: load("message/Message.js"), Model: load("account/Model.js"),
    Conversation: load("account/Conversation.js"), Unsub: load("message/Unsubscribe.js"),
    detailSerial: 0, detailHandle: null, inviteHandle: null, alwaysShowImages: false,
    imageFetchSerial: 0, imageFetchProcess: null, selectedThread: null,
    messages: [], previewMessages: [], receivedAsAddress: "me@example.org",
    abortRequest() {}, summaryOf() { return null }, loadMembers() {}, rememberMember() {},
    fail(error) { throw new Error(error) }, renderSource(html) { host.sourceHtml = html; return {} },
    bodyCache: {
      read(id, callback) { callbacks.c = callback }, touch() {},
      put(id, record) { writes.push(JSON.parse(JSON.stringify(record))) }
    },
    api: {
      getMessage(id, full, callback) { callbacks.d = callback; return null },
      getAttachment(id, part, callback) { callbacks.a = callback; return null }
    }
  }
  host.root = host
  vm.createContext(host)
  vm.runInContext(methods, host)
  const part = { mimeType: "text/calendar", body: inline ? { data }
    : { attachmentId: "calendar", size: ics.length } }
  const cached = { text: "", source: "plain", html: "", attachments: [], images: [],
    invite: Calendar.withResponse(Calendar.fromAttachment(part, data), "me@example.org", "accepted"),
    unsubscribe: null }
  assert(cached.invite)
  host.select("message", true)
  for (let i = 0; i < order.length; i++) {
    const step = order[i]
    if (step === "c") callbacks.c(cached)
    if (step === "d") callbacks.d({ id: "message", payload: { mimeType: "multipart/mixed",
      headers: [{ name: "To", value: "me@example.org" }], parts: [part] } }, "")
    if (step === "a") callbacks.a(data, "")
    if (!order.slice(0, i + 1).includes("c")) assert.equal(writes.length, 0)
  }
  assert.equal(Calendar.responseOf(host.selectedInvite, "me@example.org"), "accepted", order)
  assert(writes.length > 0)
  for (const record of writes)
    assert.equal(Calendar.responseOf(record.invite, "me@example.org"), "accepted", order)
}
console.log("Invitation refresh: six cache, detail, and attachment arrival orders passed")
