const assert = require("assert")
const { load } = require("./load")

const outbox = load("message/Outbox.js")

assert.strictEqual(outbox.normalizeDelay(undefined), 10,
  "the default undo window is ten seconds")
assert.strictEqual(outbox.normalizeDelay(null), 10)
assert.strictEqual(outbox.normalizeDelay("not a number"), 10)
assert.strictEqual(outbox.normalizeDelay(0), 0,
  "zero disables delayed sending")
assert.strictEqual(outbox.normalizeDelay(17.9), 17)
assert.strictEqual(outbox.normalizeDelay(-4), 0)
assert.strictEqual(outbox.normalizeDelay(90), 60,
  "the setting cannot leave mail queued for more than one minute")

console.log("test_outbox.js ok")
