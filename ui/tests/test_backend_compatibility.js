const assert = require("assert")
const { load } = require("./load")

const compatibility = load("backend/Compatibility.js")
assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.0" }, "0.9.0", 1), true)
for (const version of ["0.8.2", "0.9.1", "1.0.0"])
  assert.strictEqual(compatibility.accepts({ protocol: 1, version }, version, 1), false)
assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.0" }, "0.9.0", 2), false)
assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.0" }, "0.9.1", 1), false)
for (const apiVersion of [null, "1", 2, 0])
  assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.0", apiVersion }, "0.9.0", 1), false)
for (const expectedApiVersion of [undefined, "1", 0, 1.5, Infinity])
  assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.0", apiVersion: expectedApiVersion }, "0.9.0", expectedApiVersion), false)

assert.strictEqual(
  compatibility.accepts({ apiVersion: 1, protocol: 1, version: "0.8.2" }, "0.8.2", 1), true,
  "the UI accepts the backend built from its exact application version")
assert.strictEqual(
  compatibility.accepts({ protocol: 2, version: "0.8.2" }, "0.8.2", 1), false,
  "a different protocol cannot become ready")
assert.strictEqual(
  compatibility.accepts({ version: "0.8.2" }, "0.8.2", 1), false,
  "a backend without a protocol cannot become ready")
assert.strictEqual(
  compatibility.accepts({ apiVersion: 1, protocol: 1, version: "0.8.1" }, "0.8.2", 1), false,
  "a different application version cannot become ready")
assert.strictEqual(
  compatibility.accepts({ apiVersion: 1, protocol: 1, version: "0.8.2" }, "", 1), false,
  "an unversioned UI cannot accept a backend")
assert.strictEqual(
  compatibility.accepts({ apiVersion: 1, protocol: 1 }, "0.8.2", 1), false,
  "an unversioned backend cannot become ready")

assert.strictEqual(
  compatibility.dispatchError(true, false, false, "gmail.sendAs", false),
  "Backend is not ready",
  "a configured process cannot send provider work before its handshake")
assert.strictEqual(
  compatibility.dispatchError(true, false, false, "system.info", false),
  "Backend is not ready",
  "callers cannot bypass the gate by naming the handshake method")
assert.strictEqual(
  compatibility.dispatchError(true, false, false, "system.info", true), null,
  "the backend may issue its own handshake request before becoming ready")
assert.strictEqual(
  compatibility.dispatchError(true, true, false, "gmail.sendAs", false), null,
  "business work can begin after a compatible handshake")
assert.strictEqual(
  compatibility.dispatchError(true, true, true, "gmail.sendAs", false),
  "Backend is shutting down",
  "shutdown refuses new business work")
assert.strictEqual(
  compatibility.dispatchError(true, false, true, "system.quit", true), null,
  "shutdown may ask a drained backend to exit")
assert.strictEqual(
  compatibility.dispatchError(false, false, false, "system.info", true),
  "Backend unavailable",
  "even an internal request needs a running backend")

assert.strictEqual(
  compatibility.shouldRequestQuit(true, 1, false), false,
  "shutdown drains an accepted request before asking the process to exit")
assert.strictEqual(
  compatibility.shouldRequestQuit(true, 0, false), true,
  "shutdown asks the backend to exit as soon as the accepted work drains")
assert.strictEqual(
  compatibility.shouldRequestQuit(true, 0, true), false,
  "shutdown sends at most one quit request")

assert.strictEqual(
  compatibility.isCleanShutdown(true, true, 0, false, 0), true,
  "a drained acknowledged quit with a zero exit status is clean")
assert.strictEqual(
  compatibility.isCleanShutdown(true, true, 0, true, 0), false,
  "a failed quit response cannot become clean when its pending entry is removed")
assert.strictEqual(
  compatibility.isCleanShutdown(true, true, 0, false, 1), false,
  "a backend crash after the quit request is not a clean shutdown")

console.log("backend compatibility tests passed")

// The step ahead of the pin: what the connected binary speaks, whether the
// checkout is ahead of it, and the refusal a call to the step gets.
assert.strictEqual(compatibility.connectedApiVersion({ protocol: 1, version: "0.9.0" }), 1, "0.9.0 predates the field")
assert.strictEqual(compatibility.connectedApiVersion({ protocol: 1, version: "0.9.1" }), 0)
assert.strictEqual(compatibility.connectedApiVersion({ protocol: 1, version: "0.10.0", apiVersion: 2 }), 2)
assert.strictEqual(compatibility.connectedApiVersion(null), 0)
assert.strictEqual(compatibility.needsUpdate({ apiVersion: 1, protocol: 1, version: "0.9.0" }, 2), true)
assert.strictEqual(compatibility.needsUpdate({ apiVersion: 2, protocol: 1, version: "0.10.0" }, 2), false)
assert.strictEqual(compatibility.needsUpdate({ apiVersion: 1, protocol: 1, version: "0.9.0" }, 1), false)
assert.strictEqual(compatibility.needsUpdate(null, 2), false, "nothing connected, nothing to update")
assert.strictEqual(compatibility.needsUpdate({ apiVersion: 1, protocol: 1, version: "0.9.0" }, "2"), false)
assert.deepEqual(compatibility.unreleasedRefusal("message.new", ["message.new"], true), { code: -32012, message: "backend_needs_update" })
assert.strictEqual(compatibility.unreleasedRefusal("message.new", ["message.new"], false), null, "the binary has it")
assert.strictEqual(compatibility.unreleasedRefusal("message.old", ["message.new"], true), null, "released methods go through")
assert.strictEqual(compatibility.unreleasedRefusal("message.new", null, true), null)
assert.strictEqual(compatibility.NEEDS_UPDATE, "backend_needs_update")

// A local build of the unreleased step is accepted beside the pinned binary;
// an older API, a second step, or a step without the pin's version is not.
assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.0", apiVersion: 2 }, "0.9.0", 1, 2), true, "the one step ahead")
assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.0", apiVersion: 1 }, "0.9.0", 1, 2), true, "the pinned binary still")
assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.0", apiVersion: 2 }, "0.9.0", 1), false, "no step declared, no step accepted")
assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.0", apiVersion: 3 }, "0.9.0", 1, 3), false, "two steps is not a step")
assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.0", apiVersion: 2 }, "0.9.0", 1, "2"), false)
assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.1", apiVersion: 2 }, "0.9.0", 1, 2), false, "the version is still the pin's")
assert.strictEqual(compatibility.accepts({ protocol: 1, version: "0.9.0", apiVersion: 0 }, "0.9.0", 1, 2), false)
