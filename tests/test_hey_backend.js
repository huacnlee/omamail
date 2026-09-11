const assert = require("assert")
const fs = require("fs")
const vm = require("vm")
const { load } = require("../ui/tests/load")
const source = fs.readFileSync(require("path").join(__dirname, "../ui/providers/HeyClient.qml"), "utf8")
function method(name) {
  const start = source.indexOf("  function " + name + "(")
  const end = source.indexOf("\n  function ", start + 1)
  assert(start >= 0)
  return source.slice(start, end)
}
const context = {
  Cli: load("providers/HeyCli.js"), messageResources: {}, rows: {}, inFlight: 0,
  Qt: { callLater: fn => fn() },
  auth: { loggedIn: true, accountId: "hey:me@example.org", heyPath: "/bin/hey" }
}
context.root = context
vm.createContext(context)
for (const name of ["newHandle", "abortRequest", "usesBackend", "backendRead", "rememberResource", "listMessages", "getMessages", "getMessage", "forget"])
  vm.runInContext(method(name), context)
let pending, request
context.backend = { executable: "/bin/omamail", call(method, params, callback) {
  request = { method, params }; pending = callback
} }
const resource = { id: "1:2", payload: { headers: [{ name: "Subject", value: "Known" }] }, labelIds: ["UNREAD"], snippet: "Preview", internalDate: "1" }
let listed = false
context.listMessages("", 25, "", (result, error) => { assert.strictEqual(error, ""); listed = true })
assert.strictEqual(context.inFlight, 1)
assert.strictEqual(request.params.accountId, "hey:me@example.org")
assert.strictEqual(request.params.program, "/bin/hey")
pending({ messages: [resource], ids: ["1:2"] }, null)
assert(listed)
assert.strictEqual(context.inFlight, 0)
context.getMessages(["1:2"], false, (messages, error) => { assert.strictEqual(error, ""); assert.strictEqual(messages[0], resource) })
context.getMessage("1:2", true, (result, error) => { assert.strictEqual(error, ""); assert.strictEqual(JSON.stringify(result.payload.headers), JSON.stringify(resource.payload.headers)); assert.strictEqual(result.snippet, "Preview") })
pending({ payload: { headers: [], body: {} } }, null)
const handle = context.getMessage("1:2", true, () => assert.fail("aborted response"))
context.abortRequest(handle)
pending({}, null)
assert.strictEqual(context.inFlight, 0)
context.getMessage("1:2", true, (result, error) => { assert.strictEqual(result, null); assert(error.includes("changed")) })
context.auth.accountId = "hey:other@example.org"
pending({}, null)
context.auth.accountId = ""
context.backend.call = () => assert.fail("unidentified account must not reach backend")
context.getMessage("1:2", true, (result, error) => assert(error.includes("configured")))
context.forget("markRead", ["1:2"])
assert.strictEqual(context.messageResources["1:2"].labelIds.length, 0)
context.Mail = load("message/Message.js")
for (const name of ["act", "modifyMessage", "batchModify", "messageParams", "sendMessage"])
  vm.runInContext(method(name), context)
context.auth.accountId = "hey:me@example.org"
let rpcCalls = 0
context.backend.call = (method, params, callback) => {
  rpcCalls++; request = { method, params }; pending = callback
}
context.run = () => assert.fail("configured backend must not spawn a HEY command")
context.modifyMessage("1:2", ["UNREAD"], [], (result, error) => assert.strictEqual(error, ""))
assert.strictEqual(request.method, "hey.act")
assert.strictEqual(request.params.verb, "markUnread")
assert.strictEqual(context.messageResources["1:2"].labelIds.length, 0)
pending({ ok: true }, null)
assert.strictEqual(context.messageResources["1:2"].labelIds[0], "UNREAD")
context.act("markRead", ["1:2"], (result, error) => assert(error))
pending(null, { message: "Unavailable" })
assert.strictEqual(context.messageResources["1:2"].labelIds[0], "UNREAD")
const raw = Buffer.from("To: me@example.org\r\nCc: cc@example.org\r\nSubject: Hello\r\n\r\nPrivate body\r\nSecond line").toString("base64url")
context.sendMessage({ raw }, (result, error) => { assert(error); assert.strictEqual(result, null) })
assert.strictEqual(request.method, "hey.send")
assert.strictEqual(request.params.raw, raw)
const beforeFailure = rpcCalls
pending(null, { message: "Backend unavailable" })
assert.strictEqual(rpcCalls, beforeFailure)
context.sendMessage({ raw, threadId: "1:2" }, (result, error) => assert.strictEqual(error, ""))
assert.strictEqual(request.params.threadId, "1:2")
pending({ ok: true }, null)
context.sendMessage({ raw, attachments: ["/tmp/file"] }, () => {})
assert.strictEqual(request.params.attachments[0], "/tmp/file")
context.backend = null
context.sendMessage({ raw }, (result, error) => assert(error.includes("unavailable")))
context.act("trash", ["1:2"], (result, error) => assert(error.includes("unavailable")))
assert(!source.includes("Process {"))
assert(!source.includes("Mail.parseRfc822"))
console.log("test_hey_backend.js ok")
