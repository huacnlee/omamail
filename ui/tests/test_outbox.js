const assert = require("assert")
const { load, deepEqual } = require("./load")

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

deepEqual(outbox.schedule({ subject: "Hello" }, 1000, 10), {
  payload: { subject: "Hello" },
  dueAt: 11000
})
assert.strictEqual(outbox.schedule({}, 1000, 0), null,
  "an immediate send does not create a pending item")

assert.strictEqual(outbox.remainingSeconds(11000, 1000), 10)
assert.strictEqual(outbox.remainingSeconds(11000, 1001), 10,
  "the countdown must not show nine immediately")
assert.strictEqual(outbox.remainingSeconds(11000, 10000), 1)
assert.strictEqual(outbox.remainingSeconds(11000, 10999), 1)
assert.strictEqual(outbox.remainingSeconds(11000, 11000), 0)
assert.strictEqual(outbox.remainingSeconds(11000, 12000), 0)

console.log("test_outbox.js ok")
