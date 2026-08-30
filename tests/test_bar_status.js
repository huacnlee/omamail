const assert = require("assert")
const { load, deepEqual } = require("./load")

const Status = load("bar/Status.js")

assert.strictEqual(Status.MAX_AGE_MS, 120000,
  "the QML stale window must match the host heartbeat contract")

deepEqual(Status.parse(""), {
  version: 1,
  unread: 0,
  running: false,
  updatedAt: 0
})
deepEqual(Status.parse("not json"), Status.empty())
deepEqual(Status.parse(JSON.stringify({
  version: 1,
  unread: 12.9,
  running: true,
  updatedAt: 1700000000000,
  account: "must not cross the companion boundary"
})), {
  version: 1,
  unread: 12,
  running: true,
  updatedAt: 1700000000000
})
assert.strictEqual(Status.parse('{"version":2,"unread":4}').unread, 0,
  "an unknown schema is not guessed")
assert.strictEqual(Status.parse('{"version":1,"unread":-4}').unread, 0)

deepEqual(Status.presentation('{"version":1,"unread":3,"running":true,"updatedAt":9000}',
  10000, 5000), { unread: 3, running: true, stale: false })
deepEqual(Status.presentation('{"version":1,"unread":3,"running":true,"updatedAt":1000}',
  10000, 5000), { unread: 0, running: false, stale: true })
deepEqual(Status.presentation('{"version":1,"unread":3,"running":true,"updatedAt":11000}',
  10000, 5000), { unread: 0, running: false, stale: true })
deepEqual(Status.presentation('', 10000, 5000),
  { unread: 0, running: false, stale: true })

assert.strictEqual(Status.snapshotPath('/state', '/home/alice'),
  '/state/omamail/status.json')
assert.strictEqual(Status.snapshotPath('', '/home/alice'),
  '/home/alice/.local/state/omamail/status.json')
assert.strictEqual(Status.snapshotPath('', ''), '')

deepEqual(Status.command("/opt/Omamail/bin/omamail", "open", ""),
  ["/opt/Omamail/bin/omamail", "--command", "open"])
deepEqual(Status.command("/opt/Omamail/bin/omamail", "compose-mailto", "mailto:a@example.com"),
  ["/opt/Omamail/bin/omamail", "--command", "compose-mailto", "--payload", "mailto:a@example.com"])
deepEqual(Status.command("/opt/Omamail/bin/omamail", "refresh", "ignored"),
  ["/opt/Omamail/bin/omamail", "--command", "refresh"])

// The exact bytes `write_companion_status` in src/lib.rs writes, trailing
// newline and all. The bar's entire contract with the standalone host is that
// this parses, so the two are pinned to each other here rather than left to
// agree by inspection.
deepEqual(Status.parse('{"version":1,"unread":7,"running":true,"updatedAt":1700000000123}\n'), {
  version: 1,
  unread: 7,
  running: true,
  updatedAt: 1700000000123
})

// The snapshot the host writes on its way out. Fresh, so not stale — the bar
// knows the application has gone rather than guessing from silence, and says
// nothing about a mailbox either way.
deepEqual(Status.presentation(
  '{"version":1,"unread":0,"running":false,"updatedAt":1700000000456}\n',
  1700000000500, Status.MAX_AGE_MS),
  { unread: 0, running: false, stale: false })

// One heartbeat is 60s and the stale window is 120s, so a snapshot that has
// missed two beats is a host that is no longer writing.
deepEqual(Status.presentation(
  '{"version":1,"unread":7,"running":true,"updatedAt":1700000000000}\n',
  1700000000000 + 121000, Status.MAX_AGE_MS),
  { unread: 0, running: false, stale: true })

console.log("test_bar_status.js ok")
