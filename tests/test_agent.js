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

// Presets: a starting command for each harness, matched back honestly.
{
  const presets = agent.presets()
  assert.ok(presets.length >= 4)
  assert.ok(presets.every(function (p) { return p.id && p.name && typeof p.command === "string" }))
  assert.strictEqual(agent.presetById("claude").binary, "claude")
  assert.strictEqual(agent.presetById("nope"), null)
  assert.strictEqual(agent.presetById("grok").command.indexOf("--always-approve") > 0, true)
  assert.strictEqual(agent.presetFor(agent.presetById("codex").command), "codex")
  assert.strictEqual(agent.presetFor("codex exec --full-auto --model o3"), "custom", "an edited preset is custom")
  assert.strictEqual(agent.presetFor(""), "")
  const options = agent.presetOptions(["claude", "gemini"])
  assert.strictEqual(options[0].label, "Claude Code")
  assert.strictEqual(options[1].label, "Codex (not installed)")
  assert.strictEqual(options[options.length - 1].label, "Custom command", "custom needs no binary")
  deepEqual(agent.foundBinaries("/usr/bin/claude\n/home/x/.local/bin/gemini\n\ngemini\n"), ["claude", "gemini"])
  deepEqual(agent.foundBinaries(""), [])
  assert.ok(agent.presetBinaries().indexOf("claude") >= 0)
  assert.ok(agent.presetBinaries().indexOf("") < 0)
}
assert.strictEqual(agent.jobAboutLabel({ messageId: "1", subject: "Invoice" }), "\u201CInvoice\u201D")
assert.strictEqual(agent.jobAboutLabel({ messageId: "1" }), "A message")
assert.strictEqual(agent.jobAboutLabel({ scope: "all" }), "Every mailbox")
// A job about several messages answers to every one of them.
{
  const many = { id: "s", messageIds: ["m1", "m2"], state: "running", created: 9 }
  deepEqual(agent.messageIdsOf(many), ["m1", "m2"])
  deepEqual(agent.messageIdsOf({ messageId: "m3" }), ["m3"])
  deepEqual(agent.messageIdsOf(null), [])
  const map = agent.jobsByMessage([older, many])
  assert.strictEqual(map.m1.id, "s", "the live selection job wins on a message it names")
  assert.strictEqual(map.m2.id, "s")
  assert.strictEqual(agent.jobFor([older, many], "m2").id, "s")
  deepEqual(agent.jobsForMessage([older, many, asked], "m1").map(function (j) { return j.id }), ["s", "o"])
  assert.strictEqual(agent.jobAboutLabel(many), "2 messages")
  assert.strictEqual(agent.jobAboutLabel({ messageIds: ["m1"], subject: "One" }), "\u201COne\u201D")

  assert.strictEqual(agent.progressText({ state: "running", progress: " Reading it " }), "Reading it")
  assert.strictEqual(agent.progressText({ state: "done", progress: "x" }), "", "a finished job has a summary, not progress")
  assert.strictEqual(agent.stallText({ state: "running", stall: "permission" }).indexOf("stopped to ask") > 0, true)
  assert.strictEqual(agent.stallText({ state: "running" }), "")
  assert.strictEqual(agent.stateLabel({ state: "running", stall: "permission" }), "Stopped to ask")

  const cont = JSON.parse(agent.continuationPayload({ id: "q1" }, "  Yes, reply  ", "claude -p"))
  assert.strictEqual(cont.parent, "q1")
  assert.strictEqual(cont.prompt, "Yes, reply")
  assert.strictEqual(cont.messageId, "")
  const sel = JSON.parse(agent.selectionPayload(
    [{ id: "a1", subject: "One", from: { email: "x@y" } }, { id: "", subject: "skip" }, { id: "a2", subject: "Two", from: {} }],
    "ada@example.com", "INBOX", "codex exec", "File these"))
  assert.strictEqual(sel.messages.length, 2)
  assert.strictEqual(sel.messages[0].messageId, "a1")
  assert.ok(sel.messages[0].message.indexOf("Subject: One") >= 0)
  assert.strictEqual(sel.subject, "2 messages")
  assert.strictEqual(sel.folder, "INBOX")
}
console.log("test_agent.js presets ok")
