const assert = require("assert")
const { load } = require("./load")
const Plain = load("backend/Plain.js")

// What Qt 6.12 hands a signal handler: a sequence is indexable, has a length
// and Array.prototype further up its chain, but `Array.isArray` says no; a
// reference object says what it is in its tag.
const qt = {
  sequence(items) {
    const s = Object.create(Object.create(Array.prototype))
    items.forEach((item, i) => { s[i] = item })
    Object.defineProperty(s, "length", { value: items.length })
    return s
  },
  reference(fields) {
    return Object.assign(Object.create({ [Symbol.toStringTag]: "V4ReferenceObject" }), fields)
  }
}

{
  const crossed = qt.sequence(["a", "b"])
  assert.strictEqual(Array.isArray(crossed), false, "the stand-in is what fails the libraries' checks")
  const list = Plain.plain(crossed)
  assert.strictEqual(Array.isArray(list), true, "a sequence comes back as an array")
  assert.deepStrictEqual(Array.from(list), ["a", "b"])
}

// Nested all the way down: a reference object holding a sequence of reference
// objects holding sequences, as a backend notification arrives.
{
  const snapshot = qt.reference({ accountId: "a", revision: 3,
    entries: qt.sequence([qt.reference({ id: "s1", tags: qt.sequence(["x"]) })]) })
  const copy = Plain.plain(snapshot)
  assert.strictEqual(Object.prototype.toString.call(copy), "[object Object]")
  assert.strictEqual(Array.isArray(copy.entries), true)
  assert.strictEqual(Array.isArray(copy.entries[0].tags), true)
  assert.strictEqual(copy.entries[0].id, "s1")
  assert.strictEqual(copy.revision, 3)
  assert.strictEqual(copy.accountId, "a")
}

// An object with a `length` field is an object, not a list.
{
  const copy = Plain.plain({ length: 2, 0: "a", name: "n" })
  assert.strictEqual(Array.isArray(copy), false)
  assert.deepStrictEqual(Object.keys(copy).sort(), ["0", "length", "name"])
  assert.strictEqual(copy.length, 2)
}

// Ordinary arrays and objects are copied too, and nothing else is touched.
{
  const nested = { list: [1, [2, { deep: ["d"] }]] }
  const copy = Plain.plain(nested)
  assert.notStrictEqual(copy, nested)
  assert.strictEqual(JSON.stringify(copy), JSON.stringify(nested))
  const when = new Date(0)
  const call = function() {}
  for (const value of [null, undefined, 0, 1.5, "", "text", true, false, when, call])
    assert.strictEqual(Plain.plain(value), value)
  const inside = Plain.plain({ when: when, call: call })
  assert.strictEqual(inside.when, when)
  assert.strictEqual(inside.call, call)
  const wrapped = Object.create({ kind: "value type" })
  assert.strictEqual(Plain.plain(wrapped), wrapped, "an object with a prototype of its own is not a record")
}

// A cycle ends at the depth bound instead of recursing for ever.
{
  const loop = { name: "loop" }
  loop.self = loop
  let copy = Plain.plain(loop)
  let depth = 0
  while (copy !== loop && depth < 1000) { copy = copy.self; depth++ }
  assert.strictEqual(copy, loop, "the copy hands back the original past the bound")
  assert.strictEqual(depth, Plain.MAX_DEPTH)
  const deep = []
  let cursor = deep
  for (let i = 0; i < 200; i++) { const next = []; cursor.push(next); cursor = next }
  assert.strictEqual(Array.isArray(Plain.plain(deep)), true)
}

console.log("test_backend_plain.js ok")
