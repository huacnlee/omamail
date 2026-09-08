const assert = require("assert")
const { load, deepEqual } = require("./load")

const agent = load("agent/Agent.js")

// Two accounts, by the id the service gives them. Both can hold "m1".
const A = "imap:ada@example.com"
const B = "imap:bob@example.com"

assert.strictEqual(agent.hasAgent("  "), false)
assert.strictEqual(agent.hasAgent("claude -p"), true)

// A listing that is not a listing is no jobs, and a row missing its identity
// is dropped rather than drawn on nothing.
deepEqual(agent.parseJobs("not json"), [])
deepEqual(agent.parseJobs('{"id":"x"}'), [])
deepEqual(agent.parseJobs('[{"id":"a","messageId":"1"},{"id":"b","scope":"all"},null,{"messageId":"2"}]'),
  [{ id: "a", messageId: "1" }, { id: "b", scope: "all" }],
  "a scope, selection or draft job has no message and is still a job")

const running = { id: "r", messageId: "m1", state: "running", created: 5, subject: "Invoice", accountId: A }
const older = { id: "o", messageId: "m1", state: "done", created: 1, summary: "Filed it", accountId: A }
const asked = { id: "q", messageId: "m2", state: "done", question: "Reply, or file?", created: 3, accountId: A }
const failed = { id: "f", messageId: "m3", state: "failed", error: "exited 3", created: 2, accountId: A }
const stopped = { id: "c", messageId: "m4", state: "cancelled", created: 2, accountId: A }
const jobs = [older, running, asked, failed, stopped]

assert.strictEqual(agent.isActive(running), true)
assert.strictEqual(agent.isActive(older), false)
assert.strictEqual(agent.anyActive(jobs), true)
assert.strictEqual(agent.anyActive([older, asked]), false)

// The live job wins over an older finished one on the same message; with
// none live, the newest.
assert.strictEqual(agent.jobFor(jobs, "m1", A).id, "r")
assert.strictEqual(agent.jobFor([older, { id: "n", messageId: "m1", state: "done", created: 9, accountId: A }], "m1", A).id, "n")
assert.strictEqual(agent.jobFor(jobs, "none", A), null)
assert.strictEqual(agent.jobFor(jobs, "", A), null)
const byMessage = agent.jobsByMessage(jobs, A)
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

assert.strictEqual(agent.folderOf("41:INBOX", "inbox", "imap"), "INBOX")
assert.strictEqual(agent.folderOf("41:2026", "inbox", "imap"), "2026", "an IMAP folder can be a number")
assert.strictEqual(agent.folderOf("18c2f0a9", "sent", "gmail"), "sent", "a Gmail id has no folder")
assert.strictEqual(agent.folderOf("12:34", "inbox", "hey"), "inbox", "a HEY id is posting:topic, not a folder")

// The pane's jobs are the ones about a scope rather than a message.
const paneJob = { id: "p", scope: "all", messageId: "", state: "running", created: 7 }
assert.strictEqual(agent.isScopeJob(paneJob), true)
assert.strictEqual(agent.isScopeJob(running), false)
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
  const many = { id: "s", messageIds: ["m1", "m2"], state: "running", created: 9, accountId: A }
  deepEqual(agent.messageIdsOf(many), ["m1", "m2"])
  deepEqual(agent.messageIdsOf({ messageId: "m3" }), ["m3"])
  deepEqual(agent.messageIdsOf(null), [])
  const map = agent.jobsByMessage([older, many], A)
  assert.strictEqual(map.m1.id, "s", "the live selection job wins on a message it names")
  assert.strictEqual(map.m2.id, "s")
  assert.strictEqual(agent.jobFor([older, many], "m2", A).id, "s")
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

// Attention: a question or a finish nobody has opened yet.
{
  const q = { id: "q", messageId: "m1", state: "done", question: "Which?", accountId: A }
  const d = { id: "d", messageId: "m2", state: "done", accountId: A }
  const r = { id: "r", messageId: "m3", state: "running", accountId: A }
  assert.strictEqual(agent.wantsAttention(q, []), true)
  assert.strictEqual(agent.wantsAttention(q, ["q"]), false, "opened once is enough")
  assert.strictEqual(agent.wantsAttention(r, []), false, "running is the glyph's job")
  assert.strictEqual(agent.wantsAttention({ id: "c", state: "cancelled" }, []), false)
  assert.strictEqual(agent.anyAttention([r, d], []), true)
  assert.strictEqual(agent.anyAttention([r, d], ["d"]), false)
  deepEqual(agent.attentionByMessage([q, d, r], ["d"], A), { m1: true })
  deepEqual(agent.markSeen(["a"], "b"), ["a", "b"])
  deepEqual(agent.markSeen(["a"], "a"), ["a"])
  deepEqual(agent.markSeen(null, ""), [])
}
// The composer's draft job.
{
  const line = agent.draftPayload({ to: "ada@example.com", subject: " Plan ", body: "Hi\nthere" }, " Shorten ", "me@x", "claude -p")
  assert.strictEqual(line.indexOf("\n"), -1)
  const parsed = JSON.parse(line)
  assert.strictEqual(parsed.draft.body, "Hi\nthere")
  assert.strictEqual(parsed.subject, "Draft: Plan")
  assert.strictEqual(parsed.prompt, "Shorten")
  assert.strictEqual(JSON.parse(agent.draftPayload({}, "x", "", "c")).subject, "Draft")
  assert.strictEqual(agent.isDraftJob({ kind: "draft" }), true)
  assert.strictEqual(agent.isDraftJob({ kind: "message" }), false)
  deepEqual(agent.draftJobs([{ id: "a", kind: "draft", created: 1, accountId: A }, { id: "m", kind: "message", accountId: A },
    { id: "b", kind: "draft", created: 5, accountId: A }, { id: "z", kind: "draft", created: 9, accountId: B }], A)
    .map(function (j) { return j.id }), ["b", "a"])
  assert.ok(agent.draftAsks().length >= 5)
  assert.ok(agent.draftAsks().every(function (a) { return a.id && a.label && a.prompt }))
  assert.strictEqual(agent.draftAnswer({ state: "done" }, "Hi Ada,\n\nBetter.\n\nQUESTION: ok?\n"), "Hi Ada,\n\nBetter.")
  assert.strictEqual(agent.draftAnswer({ state: "running" }, "x"), "")
  assert.strictEqual(agent.draftAnswer({ state: "failed" }, "x"), "")
}
console.log("test_agent.js attention ok")

// A job is its account's. Ada and Bob both hold "m1": Bob's row must not
// show, glow for, or cancel Ada's job, and a job that names no owner — one
// written before owners were recorded — is nobody's row.
{
  const adas = { id: "ja", messageId: "m1", state: "running", created: 5, accountId: A }
  const bobs = { id: "jb", messageId: "m1", state: "done", question: "Which?", created: 6, accountId: B }
  const nobodys = { id: "jn", messageId: "m1", state: "running", created: 7 }
  const both = [adas, bobs, nobodys]
  assert.strictEqual(agent.ownedBy(adas, A), true)
  assert.strictEqual(agent.ownedBy(adas, B), false)
  assert.strictEqual(agent.ownedBy(nobodys, A), false)
  assert.strictEqual(agent.ownedBy(adas, ""), false, "no account owns nothing")
  assert.strictEqual(agent.jobFor(both, "m1", A).id, "ja")
  assert.strictEqual(agent.jobFor(both, "m1", B).id, "jb")
  assert.strictEqual(agent.jobFor(both, "m1", "imap:cy@example.com"), null)
  assert.strictEqual(agent.jobFor(both, "m1", ""), null)
  assert.strictEqual(agent.jobFor(both, "m1"), null)
  deepEqual(Object.keys(agent.jobsByMessage(both, A)), ["m1"])
  assert.strictEqual(agent.jobsByMessage(both, A).m1.id, "ja")
  assert.strictEqual(agent.jobsByMessage(both, B).m1.id, "jb")
  deepEqual(agent.jobsByMessage(both, ""), {})
  deepEqual(agent.attentionByMessage(both, [], A), {}, "Ada's job is running, not asking")
  deepEqual(agent.attentionByMessage(both, [], B), { m1: true })
  assert.strictEqual(agent.anyActive(both), true, "the pane still counts every job")

  // Every payload names its owner, and a continuation names its parent's.
  const summary = { id: "m1", subject: "S", from: { email: "x@y" } }
  assert.strictEqual(JSON.parse(agent.payload(summary, "", "ada@example.com", "INBOX", "c", "p", A)).accountId, A)
  assert.strictEqual(JSON.parse(agent.payload(summary, "", "ada@example.com", "INBOX", "c", "p")).accountId, "")
  assert.strictEqual(JSON.parse(agent.scopePayload("p", "all", "ada@example.com", [], "c", A)).accountId, A)
  assert.strictEqual(JSON.parse(agent.selectionPayload([summary], "ada@example.com", "inbox", "c", "p", A)).accountId, A)
  assert.strictEqual(JSON.parse(agent.draftPayload({}, "p", "ada@example.com", "c", A)).accountId, A)
  assert.strictEqual(JSON.parse(agent.continuationPayload(adas, "yes", "c")).accountId, A)
  assert.strictEqual(JSON.parse(agent.continuationPayload({ id: "x" }, "yes", "c")).accountId, "")
}

// A draft job is its account's too: Bob's composer is offered none of Ada's.
{
  const adas = { id: "da", kind: "draft", created: 3, accountId: A, state: "done" }
  const bobs = { id: "db", kind: "draft", created: 4, accountId: B, state: "done" }
  deepEqual(agent.draftJobs([adas, bobs], A).map(function (j) { return j.id }), ["da"])
  deepEqual(agent.draftJobs([adas, bobs], B).map(function (j) { return j.id }), ["db"])
  deepEqual(agent.draftJobs([adas, bobs], ""), [])
  deepEqual(agent.draftJobs([{ id: "legacy", kind: "draft", created: 1 }], A), [], "no owner, no row")
}

// ------------------------------------------------------------ suggested events
{
  // The prefilter: a date or a time in the text, by name, number or
  // relation; not a word that only looks like one.
  const yes = ["See you Thursday at 3pm", "Dinner on 12 September", "Sep 12 works for me", "12/09/2026 at the office",
    "2026-09-12", "call at 14:30", "tomorrow morning", "next week then", "May 12 works", "on Thu, then"]
  const no = ["I may go", "he sat down and thought", "the sun was out", "no dates in here", "", "march on", "a dec in the code"]
  for (const text of yes) assert.strictEqual(agent.mentionsDate(text), true, text)
  for (const text of no) assert.strictEqual(agent.mentionsDate(text), false, text)

  const now = Date.parse("2026-09-07T12:00:00Z")
  assert.strictEqual(agent.tooOldForEvents(now - 3 * 86400000, now), false)
  assert.strictEqual(agent.tooOldForEvents(now - 90 * 86400000, now), true)
  assert.strictEqual(agent.tooOldForEvents(0, now), true, "no date known is no reason to spend a look")

  // The look is a background job: no glyph, no glow, no row, but it counts
  // as running, and one per message is enough.
  const look = { id: "e1", kind: "events", messageId: "m1", accountId: A, state: "running", created: 3 }
  const done = { id: "e0", kind: "events", messageId: "m2", accountId: A, state: "done", created: 2,
    events: [{ title: "Dinner", startMs: 1789232400000, endMs: 1789239600000 }] }
  assert.strictEqual(agent.isEventsJob(look), true)
  assert.strictEqual(agent.isEventsJob(running), false)
  assert.strictEqual(agent.jobFor([look], "m1", A), null)
  deepEqual(agent.jobsByMessage([look, done], A), {})
  assert.strictEqual(agent.anyAttention([done], []), false)
  assert.strictEqual(agent.anyActive([look]), true, "polling still follows it")
  assert.strictEqual(agent.activeEventsJobs([look, done, running]), 1)
  assert.strictEqual(agent.hasEventsJob([look], "m1", A), true)
  assert.strictEqual(agent.hasEventsJob([look], "m1", B), false, "Bob's m1 was not looked at")
  assert.strictEqual(agent.hasEventsJob([{ id: "x", kind: "events", messageId: "m1", accountId: A, state: "cancelled" }], "m1", A), false,
    "a cancelled look may be taken again")
  assert.strictEqual(agent.hasEventsJob([{ id: "x", kind: "events", messageId: "m1", accountId: A, state: "failed" }], "m1", A), false,
    "and so may one that failed")
  assert.strictEqual(agent.finishedNote(done), "The agent found an event in the message")
  assert.strictEqual(agent.finishedNote({ id: "e2", kind: "events", state: "done", events: [], subject: "S" }), "", "nothing found says nothing")
  assert.strictEqual(agent.finishedNote({ id: "e3", kind: "events", state: "done", subject: "S",
    events: [{ title: "a" }, { title: "b" }] }), "The agent found 2 events in \u201CS\u201D")

  const line = JSON.parse(agent.eventsPayload({ id: "m1", subject: "Plans", from: { email: "b@x" } }, "Dinner Thu 7pm", "ada@example.com", "INBOX", "claude -p", A))
  assert.strictEqual(line.events, true)
  assert.strictEqual(line.messageId, "m1")
  assert.strictEqual(line.accountId, A)
  assert.strictEqual(line.kind, undefined, "the runner decides the kind")
  assert.ok(line.prompt.length > 0)
  assert.ok(line.message.indexOf("Dinner Thu 7pm") >= 0)

  // The suggestions: the newest finished look at the open message, in its
  // account, less the dismissed; a Bob look says nothing about Ada's row.
  const older = { id: "e4", kind: "events", messageId: "m2", accountId: A, state: "done", created: 1,
    events: [{ title: "Old", startMs: 1, endMs: 2 }] }
  const bobs = { id: "e5", kind: "events", messageId: "m2", accountId: B, state: "done", created: 9,
    events: [{ title: "Bob's", startMs: 5, endMs: 6 }] }
  const found = agent.eventSuggestions([older, done, bobs, look], A, "m2", [])
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0].title, "Dinner")
  assert.strictEqual(found[0].key, "e0:0")
  assert.strictEqual(found[0].jobId, "e0")
  deepEqual(agent.eventSuggestions([older, done, bobs], A, "m2", ["e0:0"]), [])
  deepEqual(agent.eventSuggestions([done], A, "m1", []), [])
  deepEqual(agent.eventSuggestions([done], "", "m2", []), [], "no account owns nothing")
  deepEqual(agent.eventSuggestions([{ id: "e6", kind: "events", messageId: "m2", accountId: A, state: "done", created: 5,
    events: [{ title: "", startMs: 1 }, { title: "No start" }] }], A, "m2", []), [], "a title and a start, or no event")
  const untimed = agent.eventSuggestions([{ id: "e7", kind: "events", messageId: "m2", accountId: A, state: "done", created: 5,
    events: [{ title: "T", startMs: 1000 }] }], A, "m2", [])
  assert.strictEqual(untimed[0].endMs, 1000 + 3600000, "an hour when no end was given")

  // When, as the card says it.
  const sep12 = new Date(2026, 8, 12, 19, 0).getTime()
  const thisYear = new Date(2026, 8, 7).getTime()
  assert.strictEqual(agent.suggestionWhen({ startMs: sep12, endMs: sep12 + 3600000 }, thisYear), "Sat 12 Sep, 19:00–20:00")
  assert.strictEqual(agent.suggestionWhen({ startMs: sep12, endMs: sep12 }, thisYear), "Sat 12 Sep, 19:00")
  // A whole day runs from midnight to the next: one day, or two.
  const sep12day = new Date(2026, 8, 12).getTime()
  assert.strictEqual(agent.suggestionWhen({ startMs: sep12day, endMs: sep12day + 86400000, allDay: true }, thisYear), "Sat 12 Sep (all day)")
  assert.strictEqual(agent.suggestionWhen({ startMs: sep12day, endMs: sep12day + 2 * 86400000, allDay: true }, thisYear), "Sat 12 Sep – Sun 13 Sep (all day)")
  assert.strictEqual(agent.suggestionWhen({ startMs: sep12, endMs: sep12 + 26 * 3600000 }, thisYear), "Sat 12 Sep, 19:00 – Sun 13 Sep, 21:00")
  assert.strictEqual(agent.suggestionWhen({ startMs: sep12, endMs: sep12 + 3600000 }, new Date(2027, 0, 1).getTime()), "Sat 12 Sep 2026, 19:00–20:00")
  assert.strictEqual(agent.suggestionWhen({ startMs: 0 }, thisYear), "")

  // The composer's fields: a whole day becomes nine to ten, and says so.
  const timed = agent.eventPrefill({ title: "Dinner", startMs: sep12, endMs: sep12 + 7200000, location: "Luigi's", notes: "Table for 4" })
  deepEqual(timed, { title: "Dinner", startMs: sep12, endMs: sep12 + 7200000, location: "Luigi's", description: "Table for 4", accountId: "" })
  const whole = agent.eventPrefill({ title: "Offsite", startMs: new Date(2026, 9, 2).getTime(), endMs: new Date(2026, 9, 3).getTime(), allDay: true }, A)
  assert.strictEqual(new Date(whole.startMs).getHours(), 9)
  assert.strictEqual(whole.endMs - whole.startMs, 3600000)
  assert.strictEqual(whole.description, "All day, as the message put it.")
  assert.strictEqual(whole.accountId, A, "and whose calendar")
  // Two whole days, and an evening that runs past midnight: the form holds
  // one day, so the notes carry what the message put.
  const twoDays = agent.eventPrefill({ title: "Offsite", startMs: new Date(2026, 9, 2).getTime(), endMs: new Date(2026, 9, 4).getTime(), allDay: true })
  assert.strictEqual(twoDays.description, "All day through Sat 3 Oct, as the message put it.")
  const late = agent.eventPrefill({ title: "Party", startMs: sep12, endMs: sep12 + 5 * 3600000, notes: "Bring wine" })
  assert.strictEqual(new Date(late.endMs).getHours(), 23)
  assert.strictEqual(new Date(late.endMs).getMinutes(), 59)
  assert.strictEqual(late.description, "Bring wine\n\nThe message has it ending Sun 13 Sep, 00:00.")
  assert.strictEqual(agent.eventPrefill({ title: "T", startMs: sep12, endMs: sep12 + 3600000 }).accountId, "")
}

// A look runs at the harness's cheapest model where the preset knows one,
// the owner's own look command over that, and an unknown command as it is.
{
  const claude = agent.presetById("claude").command
  const look = agent.lookCommand(claude, "")
  assert.ok(look.indexOf("--model claude-haiku-4-5-20251001") > 0, look)
  assert.strictEqual(look.indexOf("allowedTools"), -1, "a look runs no tool without asking")
  assert.strictEqual(agent.lookCommand(claude, " my-look --cheap "), "my-look --cheap")
  // The harness is known by the program it runs, whatever follows it.
  assert.strictEqual(agent.lookCommand("claude -p --model opus --dangerously-skip-permissions", ""), look)
  assert.strictEqual(agent.lookCommand("/usr/local/bin/claude -p", ""), look)
  assert.ok(agent.lookCommand("codex exec --full-auto --sandbox danger-full-access", "").indexOf("--sandbox read-only") > 0)
  assert.strictEqual(agent.lookCommand("gemini --yolo -p \"x\"", "").indexOf("--yolo"), -1)
  assert.strictEqual(agent.lookCommand(agent.presetById("grok").command, ""), agent.presetById("grok").command, "no cheaper model known: the same")
  assert.strictEqual(agent.lookCommand("my-harness --fast", ""), "my-harness --fast", "a harness no preset knows runs as typed")
  assert.strictEqual(agent.lookCommand("", ""), "")
  assert.strictEqual(agent.commandProgram("  /opt/x/claude -p "), "claude")
}
