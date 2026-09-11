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
for (const patch of [{index: 0}, {index: 2}, {transfer: "2"}, {size: 33554433}, {total: 1025}, {data: "x".repeat(65537)}, {index: 1.1}]) {
  const invalid = { ...frames[1], params: { ...frames[1].params, ...patch } }
  assert(chunks.accept(first(), JSON.stringify(invalid)).error)
}
assert(chunks.accept(null, JSON.stringify(frames[1])).error)
assert(chunks.accept(first(), '{"jsonrpc":"2.0","id":"other","result":null}').error)
assert(chunks.accept(null, "x".repeat(1048576)).error)
assert.strictEqual(chunks.accept(null, '{"jsonrpc":"2.0","id":"other","result":null}').state, null)
console.log("test_backend_chunks.js ok")
