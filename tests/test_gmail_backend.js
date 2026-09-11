const assert = require("assert")
const fs = require("fs")
const vm = require("vm")
const { load } = require("../ui/tests/load")
const source = fs.readFileSync(require("path").join(__dirname, "../ui/providers/GmailApiClient.qml"), "utf8")
function method(name) {
  const start = source.indexOf("  function " + name + "(")
  assert(start >= 0, name)
  return source.slice(start, source.indexOf("\n  }", start + 1) + 4)
}
const context = { Api: load("providers/GmailApi.js"), inFlight: 0,
  auth: { accountId: "a@example.org", loggedIn: true },
  backendEpoch: 0, backendAccount: "", Qt: { callLater: fn => fn() } }
context.root = context
vm.createContext(context)
for (const name of ["newHandle", "abortRequest", "listMessages", "getMessage", "getAttachment"])
  vm.runInContext(method(name), context)
// Load additional real helpers when present; the pre-migration implementation
// fails at the forbidden network path, not because a helper is missing.
for (const name of ["usesBackend", "invalidateBackend", "backendError", "backendRequest"])
  if (source.includes("  function " + name + "(")) vm.runInContext(method(name), context)
let pending, request, calls = 0
context.backend = { executable: "/test/omamail", call(method, params, cb) { calls++; request = { method, params }; pending = cb } }
context.request = () => assert.fail("configured backend must not issue QML HTTP")
context.listMessages("unread", 25, "cursor", (result, error) => { assert.strictEqual(error, ""); assert.strictEqual(result.ids[0], "one") })
assert.strictEqual(request.method, "gmail.list")
assert.strictEqual(request.params.accountId, "a@example.org")
assert.strictEqual(request.params.pageToken, "cursor")
assert.strictEqual(context.inFlight, 1)
pending({ ids: ["one"], threadIds: ["thread"], nextPageToken: "", estimate: 1 }, null)
assert.strictEqual(context.inFlight, 0)
context.listMessages("", 25.5, "", () => {})
assert.strictEqual(request.params.pageSize, 25)
pending({ ids: [], threadIds: [], nextPageToken: "", estimate: 0 }, null)
context.getMessage("one", false, (result, error) => assert.strictEqual(result.id, "one"))
assert.strictEqual(request.params.full, false)
pending({ id: "one" }, null)
context.getAttachment("one", "part", (data, error) => { assert.strictEqual(data, "YWJj"); assert.strictEqual(error, "") })
pending({ data: "YWJj" }, null)
const handle = context.getMessage("one", true, () => assert.fail("aborted callback"))
context.abortRequest(handle)
pending({}, null)
assert.strictEqual(context.inFlight, 0)
context.getMessage("one", true, () => assert.fail("stale session callback"))
const stale = pending
context.invalidateBackend()
assert.strictEqual(request.method, "gmail.invalidate")
assert.strictEqual(request.params.accountId, "a@example.org")
stale({}, null)
assert.strictEqual(context.inFlight, 0)
context.auth.loggedIn = false
const before = calls
context.getMessage("one", true, (result, error) => assert(error))
assert.strictEqual(calls, before)
context.auth.loggedIn = true
context.getMessage("one", true, (result, error) => { assert.strictEqual(result, null); assert(error) })
pending(null, { message: "unavailable" })
assert.strictEqual(context.inFlight, 0)
pending(null, { message: "duplicate delivery" })
assert.strictEqual(context.inFlight, 0)
context.getMessage("one", true, () => assert.fail("another account's result"))
context.auth.accountId = "b@example.org"
pending({ id: "one" }, null)
assert.strictEqual(context.inFlight, 0)
for (const name of ["getLabels", "getLabelCounts", "getProfile", "getSendAs"])
  vm.runInContext(method(name), context)
for (const [name, rpc, params, result] of [
  ["getLabels", "gmail.labels", [], [{ id: "INBOX", name: "Inbox", unread: 3 }]],
  ["getLabelCounts", "gmail.labelCounts", ["INBOX"], { id: "INBOX", unread: 3, total: 10 }],
  ["getProfile", "gmail.profile", [], { email: "b@example.org", messagesTotal: 10 }],
  ["getSendAs", "gmail.sendAs", [], [{ email: "b@example.org", isPrimary: true }]]
]) {
  let received
  context[name](...params, (value, error) => { assert.strictEqual(error, ""); received = value })
  assert.strictEqual(request.method, rpc)
  assert.strictEqual(request.params.accountId, "b@example.org")
  if (name === "getLabelCounts") assert.strictEqual(request.params.id, "INBOX")
  pending(result, null)
  assert.strictEqual(received, result, "backend owns result normalization")
  context[name](...params, (value, error) => {
    assert(error)
    if (name === "getLabels" || name === "getSendAs") assert.strictEqual(value.length, 0)
    else assert.strictEqual(value, null)
  })
  pending(null, { message: "unavailable" })
}
context.backend = null
let legacy = 0
context.request = () => { legacy++ }
context.getMessage("one", true, () => {})
context.listMessages("", 25, "", () => {})
context.getAttachment("one", "part", () => {})
assert.strictEqual(legacy, 0)
assert(!source.includes("XMLHttpRequest"), "Gmail transport must remain native")
context.backend = { executable: "/test/omamail", call(method, params, cb) { request = { method, params }; pending = cb } }
for (const name of ["modifyMessage", "batchModify", "createLabel", "renameLabel", "deleteLabel", "sendMessage", "saveDraft", "updateDraft", "deleteDraft"])
  vm.runInContext(method(name), context)
for (const [name, rpc, args] of [
  ["modifyMessage", "gmail.modify", ["id", ["STARRED"], []]],
  ["batchModify", "gmail.batchModify", [["id"], [], ["UNREAD"]]],
  ["createLabel", "gmail.createLabel", ["Work"]],
  ["renameLabel", "gmail.renameLabel", ["label", "Work/new"]],
  ["deleteLabel", "gmail.deleteLabel", ["label"]],
  ["sendMessage", "gmail.send", [{raw:"YQ",threadId:"thread"}]],
  ["saveDraft", "gmail.saveDraft", [{raw:"YQ"}]],
  ["saveDraft", "gmail.updateDraft", [{raw:"YQ",draftId:"message"}]],
  ["deleteDraft", "gmail.deleteDraft", ["message"]]
]) {
  let received
  context[name](...args,(body,error) => { assert.strictEqual(error, ""); received = body })
  assert.strictEqual(request.method,rpc)
  assert.strictEqual(request.params.accountId,"b@example.org")
  const reply = {id:"updated"}
  pending(reply,null)
  assert.strictEqual(received,reply)
}
console.log("test_gmail_backend.js ok")

vm.runInContext(method("getProfile"), context)
context.auth = {loggedIn:true, accountId:"", signedInProfile:{emailAddress:"new@example.org",messagesTotal:2,threadsTotal:1}}
const beforeBootstrap = calls
context.getProfile((profile,error) => { assert.strictEqual(error, ""); assert.strictEqual(profile.email, "new@example.org") })
assert.strictEqual(calls, beforeBootstrap, "initial identity comes from the native completed grant before registry creation")

// A later UI selection cannot retarget an already captured destructive action.
for (const name of ['trashMessage','untrashMessage','trashEach'])
  vm.runInContext(method(name),context)
const trashRequests=[]
context.auth={loggedIn:true,accountId:'synthetic@example.org'}
context.backend={executable:'/test/omamail',call(method,params,callback){trashRequests.push({method,params,callback})}}
context.selectedId='first'
context.trashMessage('first',()=>{})
context.selectedId='second'
assert.strictEqual(trashRequests[0].method,'gmail.trash')
assert.strictEqual(trashRequests[0].params.id,'first')
assert.strictEqual(trashRequests[0].params.accountId,'synthetic@example.org')
context.trashMessage('second',()=>{})
assert.strictEqual(trashRequests[1].params.id,'second')
console.log('Gmail trash adapter preserves exact captured message IDs')
for (const [code,status] of [['gmail_forbidden','403'],['gmail_length_required','411'],['gmail_rate_limited','429']]) {
  const shown=context.backendError({message:code,body:'synthetic-secret'},'gmail.trash')
  assert(shown.includes(status))
  assert(!shown.includes('synthetic-secret'))
}
