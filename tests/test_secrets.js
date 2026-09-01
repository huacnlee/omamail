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

console.log("Secrets.js ok")
