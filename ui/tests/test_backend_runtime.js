const assert = require("assert")
const { load } = require("./load")
const runtime = load("backend/Runtime.js")
function status(overrides) {
  return JSON.stringify(Object.assign({ state: "ready", requiredVersion: "0.8.2", requiredApiVersion: 1,
    installedVersion: "0.8.2", executable: "/plugin/runtime/bin/omamail", error: "" }, overrides))
}
assert.strictEqual(runtime.decode(status()).state, "ready")
assert.strictEqual(runtime.decode(status()).requiredApiVersion, 1)
for (const requiredApiVersion of [undefined, null, "1", 0, 1.5, 2147483648])
  assert.strictEqual(runtime.decode(status({ requiredApiVersion })).state, "error")
assert.strictEqual(runtime.decode(status()).cliInstalled, false)
assert.strictEqual(runtime.decode(status({ cliInstalled: true })).cliInstalled, true)
for (const cliInstalled of ["true", 1, null])
  assert.strictEqual(runtime.decode(status({ cliInstalled })).cliInstalled, false)
assert.strictEqual(runtime.decode(status({ cliInstalled: true, state: "missing" })).cliInstalled, false)
assert.strictEqual(runtime.decode(status({ cliInstalled: true, development: true })).cliInstalled, false)
assert.strictEqual(runtime.decode(status({ installedVersion: "0.8.1" })).state, "error")
assert.strictEqual(runtime.decode(status({ executable: "relative" })).executable, "")
assert.strictEqual(runtime.decode("not json").state, "error")
for (const state of ["missing", "mismatch", "unsupported", "error"]) {
  assert.strictEqual(runtime.decode(status({ state })).executable, "")
}
assert.strictEqual(runtime.decode(status({ development: true,
  executable: "/tmp/dev/omamail" })).executable, "/tmp/dev/omamail")
assert.strictEqual(runtime.canInstall("missing", false, false), true)
assert.strictEqual(runtime.canInstall("mismatch", false, false), true)
assert.strictEqual(runtime.canInstall("error", false, false), true)
assert.strictEqual(runtime.canInstall("missing", true, false), false)
assert.strictEqual(runtime.canInstall("missing", false, true), false)
assert.strictEqual(runtime.canInstall("unsupported", false, false), false)
console.log("backend runtime tests passed")

// The step ahead of the pin travels with the status, and only as a step:
// absent, malformed, or more than one ahead reads as no step at all.
assert.strictEqual(runtime.decode(status()).latestApiVersion, 1)
assert.deepEqual(runtime.decode(status()).unreleasedMethods, [])
assert.strictEqual(runtime.decode(status({ latestApiVersion: 2, unreleasedMethods: ["message.new"] })).latestApiVersion, 2)
assert.deepEqual(runtime.decode(status({ latestApiVersion: 2, unreleasedMethods: ["message.new", 7, ""] })).unreleasedMethods, ["message.new"])
for (const latestApiVersion of [undefined, "2", 3, 0, 1.5])
  assert.strictEqual(runtime.decode(status({ latestApiVersion, unreleasedMethods: ["message.new"] })).latestApiVersion, 1, String(latestApiVersion))
assert.deepEqual(runtime.decode(status({ latestApiVersion: 1, unreleasedMethods: ["message.new"] })).unreleasedMethods, [],
  "no step, no unreleased methods")
assert.strictEqual(runtime.decode("not json").latestApiVersion, 0)
