const assert = require("assert")
const fs = require("fs")
const vm = require("vm")
const { load } = require("../ui/tests/load")
const source = fs.readFileSync(require("path").join(__dirname, "../ui/providers/ImapClient.qml"), "utf8")
function method(name) {
  const start = source.indexOf("  function " + name + "(")
  assert(start >= 0)
  const end = source.indexOf("\n  function ", start + 1)
  return source.slice(start, end < 0 ? undefined : end)
}
const context = {
  Mail: load("message/Message.js"), Imap: load("providers/ImapProtocol.js"),
  special: {}, Qt: { callLater: fn => fn() }
}
vm.createContext(context)
vm.runInContext(method("parseMessages") + method("toMessage"), context)
context.root = context
const entries = [{ uid: "1", raw: "Subject: one\r\n\r\nbody", flags: [], internalDate: "1", size: 10 }]
let calls = 0
context.backend = { executable: "/test/backend", parseMessage(raw, callback) {
  calls++
  callback({ mimeType: "text/plain", headers: [], body: { size: 0 }, parts: [] }, null)
} }
context.parseMessages(entries, "INBOX", false, { aborted: false }, (messages, error) => {
  assert.strictEqual(error, "")
  assert.strictEqual(messages.length, 1)
  assert.strictEqual(messages[0].id, "1:INBOX")
})
assert.strictEqual(calls, 1)
context.backend.parseMessage = (raw, callback) => callback(null, { code: -1 })
context.parseMessages(entries, "INBOX", false, { aborted: false }, (messages, error) => {
  assert.strictEqual(messages.length, 0)
  assert(error)
})
const handle = { aborted: false }
let pending
context.backend.parseMessage = (raw, callback) => { pending = callback }
context.parseMessages(entries, "INBOX", false, handle, () => assert.fail("aborted parse must not publish"))
handle.aborted = true
pending({}, null)
context.backend = null
context.parseMessages(entries, "INBOX", false, { aborted: false }, (messages, error) => {
  assert.strictEqual(error, "")
  assert.strictEqual(messages[0].payload.headers[0].value, "one")
})
console.log("test_imap_backend.js ok")
