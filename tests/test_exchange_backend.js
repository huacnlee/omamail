const assert = require("assert")
const fs = require("fs")
const vm = require("vm")
const { load } = require("../ui/tests/load")
const source = fs.readFileSync(require("path").join(__dirname, "../ui/providers/ExchangeClient.qml"), "utf8")
function method(name) {
  const start = source.indexOf("  function " + name + "(")
  assert(start >= 0, name)
  return source.slice(start, source.indexOf("\n  }", start) + 4)
}
const calls = []
const account = "exchange:synthetic@example.org"
const context = {
  auth: { accountId: account, loggedIn: true,
    settings: { ewsUrl: "https://mail.example.org/EWS/Exchange.asmx", username: "synthetic" } },
  backend: { ready: true, call(method, params, callback) { calls.push({ method, params: JSON.parse(JSON.stringify(params)), callback }) } },
  Exchange: load("providers/ExchangeProtocol.js"), Aliases: load("account/Aliases.js"),
  inFlight: 0, epoch: 0, sequence: 0, tokenPrefix: "test", credentialsRejected: false, verification: null,
  Qt: { callLater() {} }
}
context.root = context
vm.createContext(context)
for (const name of ["newHandle", "nativeRequest", "getMessages", "saveDraft", "deleteDraft", "verifyCredentials"])
  vm.runInContext(method(name), context)

// A read hands back what the backend answered; one cancelled before it answers publishes nothing.
let result
context.getMessages(["id1"], false, (value, error) => { result = { value, error } })
assert.strictEqual(calls[0].method, "exchange.messages")
assert.deepStrictEqual(Object.keys(calls[0].params).sort(), ["accountId", "full", "ids", "requestToken"])
calls[0].callback({ messages: [{ id: "id1" }], warning: null, continuation: null }, null)
assert.strictEqual(result.error, "")
assert.strictEqual(result.value[0].id, "id1")
const handle = context.getMessages(["id2"], true, () => assert.fail("aborted read must not publish"))
handle.aborted = true
calls[1].callback({ messages: [], warning: null, continuation: null }, null)

// Save goes to the server's Drafts and names the draft it replaces; a draft is deleted by its id.
let saved
context.saveDraft({ raw: "synthetic-mime", draftId: "old-draft" }, (value, error) => { saved = { value, error } })
assert.strictEqual(calls[2].method, "exchange.saveDraft")
assert.strictEqual(JSON.stringify(calls[2].params),
  JSON.stringify({ raw: "synthetic-mime", draftId: "old-draft", accountId: account }))
calls[2].callback({ saved: true, warning: "" }, null)
assert.deepStrictEqual([saved.value.saved, saved.error], [true, ""])
context.saveDraft({ raw: "synthetic-mime" }, () => {})
assert.strictEqual(calls[3].params.draftId, "", "a first save replaces nothing")
context.deleteDraft("old-draft", () => {})
assert.strictEqual(JSON.stringify(calls[4].params), JSON.stringify({ id: "old-draft", accountId: account }))
assert.strictEqual(calls[4].method, "exchange.deleteDraft")

// Only the sign-in check carries a password, and it names no account: the keyring has nothing yet.
context.verifyCredentials({ ewsUrl: "https://new.example.org/EWS/Exchange.asmx", username: "new" },
  "new@example.org", "synthetic-password", () => {})
const check = calls[calls.length - 1]
assert.strictEqual(check.method, "exchange.verify")
assert.strictEqual(check.params.accountId, undefined)
assert.strictEqual(check.params.secret, "synthetic-password")
assert.strictEqual(check.params.settings.ewsUrl, "https://new.example.org/EWS/Exchange.asmx")
assert(!/XMLHttpRequest|Authorization|NTLM|Process/.test(source), "the network and the credential are Rust's")
console.log("test_exchange_backend.js ok")
