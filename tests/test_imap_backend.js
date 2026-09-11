const assert = require("assert")
const fs = require("fs")
const vm = require("vm")
const source = fs.readFileSync(require("path").join(__dirname, "../ui/providers/ImapClient.qml"), "utf8")
function method(name) {
  const start = source.indexOf("  function " + name + "(")
  assert(start >= 0)
  const end = source.indexOf("\n  }", start) + 4
  return source.slice(start, end)
}
const calls = []
const context = {
  auth: { accountId: "imap:synthetic@example.org", settings: {username:"synthetic",imapHost:"private.example.org"} },
  backend: { ready:true, call(method,params,callback) {calls.push({method,params:JSON.parse(JSON.stringify(params)),callback})} },
  inFlight:0, oauthTransport:false, nativeRequestGeneration:0, nativeRequestPrefix:"test"
}
context.root = context
vm.createContext(context)
for (const name of ["newHandle","backendError","nativeRequest","getMessages","sendMessage","verifyCredentials"])
  vm.runInContext(method(name),context)
let result
context.getMessages(["7:INBOX"],false,(value,error)=>{result={value,error}})
assert.equal(calls[0].method,"imap.messages")
assert.equal(calls[0].params.accountId,"imap:synthetic@example.org")
for (const key of ["credential","settings","oauth","url","token"])
  assert.equal(calls[0].params[key],undefined)
calls[0].callback({messages:[{id:"7:INBOX",payload:{headers:[]}}]},null)
assert.equal(result.error,"")
assert.equal(result.value[0].id,"7:INBOX")
context.sendMessage({raw:"synthetic-mime"},()=>{})
assert.equal(calls[1].method,"imap.send")
assert.equal(calls[1].params.raw,"synthetic-mime")
assert.equal(calls[1].params.credential,undefined)
const handle=context.getMessages(["8:INBOX"],true,()=>assert.fail("aborted read must not publish"))
handle.aborted=true
calls[2].callback({messages:[]},null)
context.verifyCredentials({username:"new-user",imapHost:"new.example.org"},"new-user:synthetic",()=>{})
assert.equal(calls[3].method,"imap.folders")
assert.equal(calls[3].params.accountId,undefined)
assert.equal(calls[3].params.credential,"new-user:synthetic")
assert.equal(calls[3].params.settings.imapHost,"new.example.org")
assert(!source.includes("parseRfc822")&&!source.includes("ImapProtocol.js"))
console.log("test_imap_backend.js ok")
