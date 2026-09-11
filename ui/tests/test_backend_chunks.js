const assert = require("assert")
const { load } = require("./load")
const chunks = load("backend/Chunks.js")
const response = JSON.stringify({ jsonrpc: "2.0", id: "qml-1", result: "📨\n\"\\مرحبا".repeat(100000) })
const parts = []
for (let offset = 0; offset < response.length; offset += 60000) parts.push(response.slice(offset, offset + 60000))
const frames = parts.map((data, index) => ({ jsonrpc: "2.0", method: "transport.chunk", params: { transfer: "1", index, total: parts.length, size: response.length, data } }))
let state = null
let decoded
for (const frame of frames) {
  decoded = chunks.accept(state, JSON.stringify(frame))
  assert(!decoded.error)
  state = decoded.state
}
assert.strictEqual(decoded.line, response)
assert.strictEqual(state, null)
const first = () => chunks.accept(null, JSON.stringify(frames[0])).state
for (const patch of [{index: 0}, {index: 2}, {transfer: "2"}, {size: 67108865}, {total: 1026}, {data: "x".repeat(65537)}, {index: 1.1}]) {
  const invalid = { ...frames[1], params: { ...frames[1].params, ...patch } }
  assert(chunks.accept(first(), JSON.stringify(invalid)).error)
}
assert(chunks.accept(null, JSON.stringify(frames[1])).error)
assert(chunks.accept(first(), '{"jsonrpc":"2.0","id":"other","result":null}').error)
assert(chunks.accept(null, "x".repeat(1048576)).error)
assert.strictEqual(chunks.accept(null, '{"jsonrpc":"2.0","id":"other","result":null}').state, null)

// Large valid MIME replies can exceed the old 32 MiB ceiling.
const large = { ...frames[0], params: { ...frames[0].params, size: 40 * 1024 * 1024, total: 640 } }
assert(!chunks.accept(null, JSON.stringify(large)).error)
const oversized = { ...large, params: { ...large.params, size: 67108865 } }
assert(chunks.accept(null, JSON.stringify(oversized)).error)

// Exercise the exact Unicode boundary shape produced by Rust: 65535-byte
// chunks of three-byte scalars need one extra chunk near the byte ceiling.
const unicodePiece = "€".repeat(21845)
const unicodeParts = Array(1024).fill(unicodePiece).concat(["€"])
let unicodeState = null
let unicodeReply
for (let i = 0; i < unicodeParts.length; i++) {
  unicodeReply = chunks.accept(unicodeState, JSON.stringify({jsonrpc:"2.0",method:"transport.chunk",params:{
    transfer:"3",index:i,total:1025,size:21845*1024+1,data:unicodeParts[i]
  }}))
  assert(!unicodeReply.error)
  unicodeState = unicodeReply.state
}
assert.strictEqual(unicodeReply.line.length,21845*1024+1)
assert.strictEqual(unicodeState,null)

assert(chunks.accept(null, JSON.stringify({ ...large, params: { ...large.params, total: 1026 } })).error)
console.log("test_backend_chunks.js ok")
