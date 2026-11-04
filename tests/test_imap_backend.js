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
const dnsError = "Could not find the mail server. Check the server address and your internet connection."
let verification
context.verifyCredentials({username:"new-user",imapHost:"missing.example.invalid"},"new-user:synthetic",
  (ok,error)=>{verification={ok,error}})
const verificationCall=calls.pop()
assert.equal(verificationCall.method,"imap.folders")
verificationCall.callback(null,{message:"mail_dns_failed",data:"synthetic-secret"})
assert.equal(verification.ok,false)
assert.equal(verification.error,dnsError)
assert.equal(context.inFlight,0)
assert.equal(context.backendError({message:"unknown",data:"synthetic-secret"}),"Mail request failed")
assert.equal(context.backendError({message:"mail_auth_failed"}),"The server rejected the sign-in. Sign in again.")
assert.equal(context.backendError({message:"request_timed_out"}),"The mail server did not answer in time")
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
