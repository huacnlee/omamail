const assert = require("assert")
const { load } = require("./load")

const cache = load("account/RenderCache.js")

let entries = cache.create(2)
const one = { html: "one" }
const two = { html: "two" }
const three = { html: "three" }

cache.put(entries, "m1", "<p>one</p>", true, one)
cache.put(entries, "m2", "<p>two</p>", false, two)

assert.strictEqual(cache.get(entries, "m1", "<p>one</p>", true), one,
  "the same message, source and plain-text mode hit")
assert.strictEqual(cache.get(entries, "m1", "<p>changed</p>", true), null,
  "changed source misses")
assert.strictEqual(cache.get(entries, "m1", "<p>one</p>", false), null,
  "a different plain-text request misses")

// Reading m1 made it newest, so inserting m3 evicts m2.
cache.put(entries, "m3", "<p>three</p>", true, three)
assert.strictEqual(cache.get(entries, "m2", "<p>two</p>", false), null)
assert.strictEqual(cache.get(entries, "m1", "<p>one</p>", true), one)
assert.strictEqual(cache.get(entries, "m3", "<p>three</p>", true), three)

// Replacing an id does not consume another slot and the old source stops
// matching immediately.
const replaced = { html: "new one" }
cache.put(entries, "m1", "<p>new one</p>", true, replaced)
assert.strictEqual(cache.get(entries, "m1", "<p>one</p>", true), null)
assert.strictEqual(cache.get(entries, "m1", "<p>new one</p>", true), replaced)

entries = cache.create(0)
cache.put(entries, "m1", "x", false, one)
assert.strictEqual(cache.get(entries, "m1", "x", false), null,
  "a disabled cache retains nothing")

console.log("render cache tests passed")
