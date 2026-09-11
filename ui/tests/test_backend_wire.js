const assert = require("assert")
const { load, deepEqual } = require("./load")
const wire = load("backend/Wire.js")
deepEqual(JSON.parse(wire.request("qml-1", "accounts.list", {})), {
  jsonrpc: "2.0", id: "qml-1", method: "accounts.list", params: {}
})
for (const reply of [
  { jsonrpc: "2.0", id: "qml-1", result: null },
  { jsonrpc: "2.0", id: "qml-2", error: { code: -32601, message: "Method not found" } }
]) deepEqual(wire.response(JSON.stringify(reply)), reply)
for (const line of ["not json", "[]", "null", '{}',
  '{"jsonrpc":"2.0","id":"qml-1"}',
  '{"jsonrpc":"2.0","id":"qml-1","result":1,"error":{}}',
  '{"jsonrpc":"2.0","id":"qml-1","error":"bad"}'
]) assert.strictEqual(wire.response(line), null)
console.log("test_backend_wire.js ok")

const upload = load("backend/Upload.js")
const bytes = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("")
assert.strictEqual(upload.chunk(bytes, 0, 256).data, Buffer.from(bytes, "latin1").toString("base64url"))
assert.strictEqual(upload.chunk("\u0100", 0, 1), null)

// Drive the real upload orchestration with asynchronous, one-at-a-time replies.
function runUpload(raw, options = {}) {
  const queue = []
  const calls = []
  let output
  let completions = 0
  upload.parse(raw, (method, params, done) => {
    calls.push({ method, params })
    queue.push(() => {
      if (method === "upload.begin") done({ upload: "u", chunkSize: options.chunkSize === undefined ? 65536 : options.chunkSize }, null)
      else if (method === "upload.append") {
        if (options.error) done(null, { code: -1, message: "Rejected" })
        else done({ offset: params.offset + Buffer.from(params.data, "base64url").length + (options.badOffset ? 1 : 0) }, null)
      } else if (method === "message.parseUpload") done({ mimeType: "text/plain" }, null)
      else if (method === "upload.discard") done({ discarded: true }, null)
      else assert.fail(method)
    })
  }, () => options.connected !== false, (result, error) => {
    completions++
    output = { result, error }
  })
  while (queue.length) {
    assert.strictEqual(queue.length, 1, "only one chunk may be outstanding")
    queue.shift()()
  }
  assert.strictEqual(completions, 1)
  return { calls, output }
}
const largeRaw = bytes.repeat(300)
const complete = runUpload(largeRaw)
assert.strictEqual(complete.output.error, null)
const parts = complete.calls.filter(call => call.method === "upload.append")
assert.strictEqual(parts.length, 2)
assert.strictEqual(Buffer.concat(parts.map(call => Buffer.from(call.params.data, "base64url"))).toString("latin1"), largeRaw)
assert.strictEqual(runUpload("").calls.at(-1).method, "message.parseUpload")
for (const options of [{ error: true }, { badOffset: true }]) {
  const failed = runUpload(bytes, options)
  assert(failed.output.error)
  assert.strictEqual(failed.calls.at(-1).method, "upload.discard")
  assert(!failed.calls.some(call => call.method === "message.parseUpload"))
}
assert(!runUpload(bytes, { error: true, connected: false }).calls.some(call => call.method === "upload.discard"))
assert.strictEqual(runUpload("\u0100").calls.at(-1).method, "upload.discard")
assert.strictEqual(runUpload(null).calls.length, 0)
assert.strictEqual(runUpload("x".repeat(upload.MAX_MESSAGE + 1)).calls.length, 0)
for (const chunkSize of [0, -1, 0.5, Infinity, "65536"]) {
  const failed = runUpload(bytes, { chunkSize })
  assert(failed.output.error)
  assert.strictEqual(failed.calls.at(-1).method, "upload.discard")
  assert(!failed.calls.some(call => call.method === "upload.append"))
}
assert.strictEqual(runUpload(largeRaw, { chunkSize: 1024 * 1024 }).calls.filter(call => call.method === "upload.append").length, 2)
console.log("backend upload tests ok")

const notification = { jsonrpc: "2.0", method: "mail.updated", params: { accountId: "a@example.org", sequence: 1 } }
assert.deepStrictEqual(JSON.parse(JSON.stringify(wire.notification(JSON.stringify(notification)))), notification)
for (const change of [{id:"x"}, {method:"other"}, {params:[]}, {result:{}}, {jsonrpc:"1.0"}])
  assert.strictEqual(wire.notification(JSON.stringify({...notification, ...change})), null)
const body = { text: "世界\n\u0000", source: "📨", html: "<p>مرحبا</p>" }
const uploaded = []
let committed
upload.putBody("a@example.org", "1:Inbox", body, (method, params, callback) => {
  if (method === "upload.begin") callback({upload:"body-1", chunkSize:7}, null)
  else if (method === "upload.append") {
    const bytes = Buffer.from(params.data, "base64url")
    uploaded.push(bytes)
    callback({offset:params.offset + bytes.length}, null)
  } else if (method === "cache.bodyPutUpload") {
    committed = params
    callback({stored:true}, null)
  } else throw new Error(method)
}, () => true, (result, error) => { assert.strictEqual(error, null); assert(result.stored) })
assert.deepStrictEqual(JSON.parse(Buffer.concat(uploaded).toString("utf8")), body)
assert.strictEqual(committed.accountId, "a@example.org")
assert.strictEqual(committed.id, "1:Inbox")

const changed = {jsonrpc:"2.0",method:"accounts.changed",params:{revision:"a".repeat(64)}}
assert.deepStrictEqual(JSON.parse(JSON.stringify(wire.notification(JSON.stringify(changed)))), changed)
for (const params of [{revision:""},{revision:"a".repeat(63)},{revision:"G".repeat(64)},{revision:42},{revision:"a".repeat(64),registry:{clientSecret:"forbidden"}}])
  assert.strictEqual(wire.notification(JSON.stringify({...changed,params})),null)
