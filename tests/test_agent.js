const assert = require("assert")
const { load, deepEqual } = require("./load")

const agent = load("agent/Agent.js")

assert.strictEqual(agent.hasAgent("  "), false)
assert.strictEqual(agent.hasAgent("claude -p"), true)

// A listing that is not a listing is no jobs, and a row missing its identity
// is dropped rather than drawn on nothing.
deepEqual(agent.parseJobs("not json"), [])
deepEqual(agent.parseJobs('{"id":"x"}'), [])
deepEqual(agent.parseJobs('[{"id":"a","messageId":"1"},{"id":"b"},null,{"messageId":"2"}]'),
  [{ id: "a", messageId: "1" }])

const running = { id: "r", messageId: "m1", state: "running", created: 5, subject: "Invoice" }
const older = { id: "o", messageId: "m1", state: "done", created: 1, summary: "Filed it" }
const asked = { id: "q", messageId: "m2", state: "done", question: "Reply, or file?", created: 3 }
const failed = { id: "f", messageId: "m3", state: "failed", error: "exited 3", created: 2 }
const stopped = { id: "c", messageId: "m4", state: "cancelled", created: 2 }
const jobs = [older, running, asked, failed, stopped]

assert.strictEqual(agent.isActive(running), true)
assert.strictEqual(agent.isActive(older), false)
assert.strictEqual(agent.anyActive(jobs), true)
assert.strictEqual(agent.anyActive([older, asked]), false)

// The live job wins over an older finished one on the same message; with
// none live, the newest.
assert.strictEqual(agent.jobFor(jobs, "m1").id, "r")
assert.strictEqual(agent.jobFor([older, { id: "n", messageId: "m1", state: "done", created: 9 }], "m1").id, "n")
assert.strictEqual(agent.jobFor(jobs, "none"), null)
assert.strictEqual(agent.jobFor(jobs, ""), null)
const byMessage = agent.jobsByMessage(jobs)
assert.strictEqual(byMessage.m1.id, "r")
assert.strictEqual(byMessage.m2.id, "q")
assert.strictEqual(Object.keys(byMessage).length, 4)

assert.strictEqual(agent.glyphState(running), "running")
assert.strictEqual(agent.glyphState(asked), "question")
assert.strictEqual(agent.glyphState(older), "done")
assert.strictEqual(agent.glyphState(failed), "failed")
assert.strictEqual(agent.glyphState(stopped), "cancelled")
assert.strictEqual(agent.glyphState(null), "")
assert.strictEqual(agent.stateLabel(asked), "Has a question")
assert.strictEqual(agent.stateLabel(running), "Working")

assert.strictEqual(agent.detailText(asked), "Reply, or file?")
assert.strictEqual(agent.detailText(failed), "exited 3")
assert.strictEqual(agent.detailText(older), "Filed it")
assert.strictEqual(agent.detailText(null), "")

assert.strictEqual(agent.finishedNote({ state: "done", subject: "Invoice" }),
  "The agent finished with “Invoice”")
assert.strictEqual(agent.finishedNote(asked), "The agent has a question about the message")
assert.strictEqual(agent.finishedNote(running), "")

// Only a job seen running before and finished now is news.
const later = [Object.assign({}, running, { state: "done" }), asked, { id: "z", messageId: "m9", state: "done" }]
deepEqual(agent.newlyFinished(jobs, later).map(function (j) { return j.id }), ["r"])
deepEqual(agent.newlyFinished([], later), [], "a job never seen live is not news")

// The message as handed over: headers, a blank line, the text.
const summary = {
  id: "41:INBOX", subject: "Hello", fullTime: "Sat 5 Sep 2026 09:06", messageId: "<a@b>",
  from: { name: "Bob", email: "bob@example.com" },
  to: [{ name: "Ada", email: "ada@example.com" }, { email: "x@example.com" }],
  cc: []
}
assert.strictEqual(agent.messageText(summary, "Line one\nLine two"),
  "From: Bob <bob@example.com>\nTo: Ada <ada@example.com>, x@example.com\n"
  + "Date: Sat 5 Sep 2026 09:06\nSubject: Hello\nMessage-ID: <a@b>\n\nLine one\nLine two")
assert.strictEqual(agent.messageText({ from: { email: "e@x" } }, ""), "From: e@x\nSubject: \n\n")

// One line, whatever the body holds: the runner reads exactly one.
const line = agent.payload(summary, "A body\r\nwith lines", "ada@example.com", "INBOX", "claude -p", "  File it  ")
assert.strictEqual(line.indexOf("\n"), -1)
const parsed = JSON.parse(line)
assert.strictEqual(parsed.messageId, "41:INBOX")
assert.strictEqual(parsed.prompt, "File it")
assert.strictEqual(parsed.folder, "INBOX")
assert.strictEqual(parsed.command, "claude -p")
assert.ok(parsed.message.indexOf("with lines") > 0)

assert.strictEqual(agent.folderOf("41:INBOX", "inbox"), "INBOX")
assert.strictEqual(agent.folderOf("41:Archive/2026", "inbox"), "Archive/2026")
assert.strictEqual(agent.folderOf("18c2f0a9", "sent"), "sent", "a Gmail id has no folder")
assert.strictEqual(agent.folderOf("12:34", "inbox"), "inbox", "a HEY id is posting:topic, not a folder")

// The pane's jobs are the ones about a scope rather than a message.
const paneJob = { id: "p", scope: "all", messageId: "", state: "running", created: 7 }
assert.strictEqual(agent.isScopeJob(paneJob), true)
assert.strictEqual(agent.isScopeJob(running), false)
deepEqual(agent.scopeJobs([running, paneJob, asked]).map(function (j) { return j.id }), ["p"])
assert.strictEqual(agent.scopeOf(true, "a@x"), "all")
assert.strictEqual(agent.scopeOf(false, "a@x"), "account:a@x")
assert.strictEqual(agent.scopeLabel("all"), "Every mailbox")
assert.strictEqual(agent.scopeLabel("account:a@x", "Work"), "Work")
assert.strictEqual(agent.scopeLabel("account:a@x", ""), "a@x")
const scopeLine = agent.scopePayload(" Find invoices ", "all", "a@x", ["a@x", "b@y", "", "a@x"], "claude -p")
assert.strictEqual(scopeLine.indexOf("\n"), -1)
const scoped = JSON.parse(scopeLine)
assert.strictEqual(scoped.messageId, "")
assert.strictEqual(scoped.scope, "all")
deepEqual(scoped.accounts, ["a@x", "b@y"])
assert.strictEqual(scoped.prompt, "Find invoices")
deepEqual(agent.parseShown('{"job":{"id":"p"},"output":"one\\ntwo"}'), { job: { id: "p" }, output: "one\ntwo" })
assert.strictEqual(agent.parseShown("nope"), null)
assert.strictEqual(agent.parseShown('{"output":"x"}'), null)

console.log("test_agent.js ok")
