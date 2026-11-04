const assert = require("assert")
const { load } = require("./load.js")

const secrets = load("providers/Secrets.js")

// The bug this exists for: `secret-tool lookup` writes no trailing newline, so
// a reader that split on one never saw the value at all.
assert.strictEqual(secrets.fromKeyring("hunter2"), "hunter2")
assert.strictEqual(secrets.fromKeyring("hunter2\n"), "hunter2")

// One, and only at the end. A password may legitimately end in a space, and
// trimming it authenticates as a different string with no way to tell.
assert.strictEqual(secrets.fromKeyring("hunter2 \n"), "hunter2 ")
assert.strictEqual(secrets.fromKeyring(" hunter2"), " hunter2")
assert.strictEqual(secrets.fromKeyring("hunter2\n\n"), "hunter2\n")
assert.strictEqual(secrets.fromKeyring("two\nlines"), "two\nlines")

assert.strictEqual(secrets.fromKeyring(""), "")
assert.strictEqual(secrets.fromKeyring(null), "")
assert.strictEqual(secrets.fromKeyring(undefined), "")

// A store that is unavailable is worth asking again, but not in a tight loop:
// the wait doubles and then stays at five minutes.
assert.strictEqual(secrets.retryDelay(0), 5000)
assert.strictEqual(secrets.retryDelay(1), 10000)
assert.strictEqual(secrets.retryDelay(2), 20000)
assert.strictEqual(secrets.retryDelay(6), 300000)
assert.strictEqual(secrets.retryDelay(100), 300000)
assert.strictEqual(secrets.retryDelay(-1), 5000)
assert.strictEqual(secrets.retryDelay("2"), 20000)
assert.strictEqual(secrets.retryDelay(undefined), 5000)

console.log("Secrets.js ok")
