const assert = require("assert")
const { load, deepEqual } = require("./load")
const exchange = load("calendar/ExchangeEvents.js")
const sources = load("calendar/Sources.js")
const calendar = load("calendar/Calendar.js")

// More than one calendar on an Exchange mailbox: its own default calendar, its other calendar folders, and the
// calendars other mailboxes share with it. Each is a source of its own: the mailbox's own are found by discovery,
// another mailbox's is added by the address of that mailbox, and every request about an event names the calendar
// the screen drew it from.

const ACCOUNT = "exchange:alice@example.org"
const DEFAULT_ID = "exchange:" + ACCOUNT
const FOLDER = "aaaaaanfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuwsq"
const FOLDER2 = "aaaaaanfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuwsy"
const SHARED = FOLDER + ":colleague@example.org"
const OWN_ID = DEFAULT_ID + ":" + "1".repeat(64)
const SHARED_ID = DEFAULT_ID + ":" + "2".repeat(64)
const PROJECTS_ID = DEFAULT_ID + ":" + "3".repeat(64)

const entry = (extra) => Object.assign({
  sourceId: DEFAULT_ID, calendarId: "", name: "Calendar", isDefault: true, own: true, mailbox: "",
  origin: "default", readOnly: false, canCreate: true, accessRole: "owner",
  rights: { read: true, create: true, modify: true, delete: true }
}, extra || {})

// A whole discovery: the default calendar and the two other folders of the mailbox, and a folder step that answered.
const found = () => ({ provider: "exchange", accountId: ACCOUNT, truncated: false,
  steps: { folders: { found: 2, code: null } }, calendars: [
    entry(),
    entry({ sourceId: OWN_ID, calendarId: FOLDER, name: "Team", isDefault: false, origin: "folder" }),
    entry({ sourceId: PROJECTS_ID, calendarId: FOLDER2, name: "Projects", isDefault: false, origin: "folder" })
  ] })

// A colleague's calendar opened by its address, which the owner may only read.
const opened = () => ({ provider: "exchange", accountId: ACCOUNT, calendar: entry({ sourceId: SHARED_ID, calendarId: SHARED,
  name: "Calendar", isDefault: false, own: false, mailbox: "colleague@example.org", origin: "address", readOnly: true,
  canCreate: false, accessRole: "reader", rights: { read: true, create: false, modify: false, delete: false } }) })

const byId = (list, id) => list.sources.find((source) => source.id === id)
const ids = (list) => list.sources.map((s) => s.id).sort()

// ---------------------------------------------------------------- discovery makes a source per calendar

{
  const list = sources.applyDiscovery(sources.emptyList(), found())
  deepEqual(list.sources.map((s) => s.id), [DEFAULT_ID, OWN_ID, PROJECTS_ID])
  for (const source of list.sources) {
    assert.strictEqual(source.kind, "exchange")
    assert.strictEqual(source.accountId, ACCOUNT)
    assert.strictEqual(source.discovered, true)
    assert.strictEqual(source.enabled, true, "a calendar that was looked for is shown")
    assert.ok(sources.COLOR_KEYS.indexOf(source.colorKey) >= 0)
  }
  const [mine, team] = list.sources
  // The default calendar keeps the id every saved file knows, and the name the mailbox is known by.
  assert.strictEqual(mine.name, "alice@example.org")
  assert.strictEqual(mine.calendarId, "")
  assert.strictEqual(team.name, "Team")
  assert.strictEqual(team.calendarId, FOLDER)
  // Nobody asked to hear about another calendar's events: only the default one reminds until turned on.
  deepEqual([mine.remindersEnabled, team.remindersEnabled], [true, false])
  deepEqual([mine.preferred, team.preferred], [true, false])
  // An error names a calendar and its mailbox once.
  const accounts = [{ id: ACCOUNT, email: "alice@example.org", provider: "exchange", signedIn: true }]
  assert.strictEqual(sources.errorLabel(mine, accounts), "alice@example.org")
  assert.strictEqual(sources.errorLabel(team, accounts), "Team · alice@example.org")
}

// A second discovery keeps what the owner chose for each calendar, by its id.
{
  let list = sources.applyDiscovery(sources.emptyList(), found())
  list = sources.setEnabled(list, OWN_ID, false)
  list = sources.setColor(list, PROJECTS_ID, "red")
  list = sources.add(list, Object.assign({}, byId(list, PROJECTS_ID), { remindersEnabled: true, reminderMinutes: 15 }))
  list = sources.add(list, Object.assign({}, byId(list, OWN_ID), { preferred: true }))
  const again = sources.applyDiscovery(list, found())
  assert.strictEqual(byId(again, OWN_ID).enabled, false)
  assert.strictEqual(byId(again, PROJECTS_ID).colorKey, "red")
  deepEqual([byId(again, PROJECTS_ID).remindersEnabled, byId(again, PROJECTS_ID).reminderMinutes], [true, 15])
  assert.strictEqual(byId(again, OWN_ID).preferred, true)
  assert.strictEqual(again.sources.length, 3, "nothing is listed twice")
}

// A file saved before there was a choice has one source, the default calendar's, and discovery adopts it.
{
  const before = { sources: [{ id: DEFAULT_ID, kind: "exchange", name: "alice@example.org", accountId: ACCOUNT,
    enabled: false, colorKey: "green", remindersEnabled: false, reminderMinutes: 30 }] }
  const after = sources.applyDiscovery(before, found())
  const mine = byId(after, DEFAULT_ID)
  deepEqual([mine.enabled, mine.colorKey, mine.remindersEnabled, mine.reminderMinutes], [false, "green", false, 30])
  assert.strictEqual(mine.discovered, true)
  assert.strictEqual(after.sources.length, 3)
}

// A folder a whole discovery no longer lists leaves with it; a calendar added by hand, another account's and
// CalDAV stay.
{
  const list = sources.addShared(sources.applyDiscovery(sources.emptyList(), found()), opened())
  const gone = found()
  gone.calendars.splice(1, 1)
  gone.steps.folders.found = 1
  const other = sources.add(list, { id: "exchange:exchange:bob@example.org", kind: "exchange", accountId: "exchange:bob@example.org", name: "bob" })
  const caldav = sources.add(other, { id: "caldav:x", kind: "caldav", name: "x", url: "https://x.example.org/", username: "u" })
  const after = sources.applyDiscovery(caldav, gone)
  deepEqual(ids(after), [DEFAULT_ID, PROJECTS_ID, SHARED_ID, "caldav:x", "exchange:exchange:bob@example.org"].sort())
}

// A discovery that did not see everything drops nothing it did not see: a folder step that failed, a list cut short,
// or an answer that says nothing of its steps keeps every folder found before, and still adopts what it did list.
{
  const before = sources.applyDiscovery(sources.emptyList(), found())
  const failed = found()
  failed.calendars = failed.calendars.slice(0, 1)
  failed.steps = { folders: { found: 0, code: "exchange_server_error" } }
  const cut = found()
  cut.calendars = cut.calendars.slice(0, 2)
  cut.truncated = true
  const unsaid = found()
  unsaid.calendars = unsaid.calendars.slice(0, 1)
  delete unsaid.steps
  for (const partial of [failed, cut, unsaid]) {
    const after = sources.applyDiscovery(sources.setColor(before, PROJECTS_ID, "blue"), partial)
    deepEqual(ids(after), [DEFAULT_ID, OWN_ID, PROJECTS_ID].sort(), JSON.stringify(partial.steps))
    deepEqual([byId(after, PROJECTS_ID).discovered, byId(after, PROJECTS_ID).colorKey], [true, "blue"])
    assert.ok(exchange.discoveryNotice(partial).length > 0, "the owner is told the list may be old")
  }
  assert.ok(/could not be read/.test(exchange.discoveryNotice(failed)))
  assert.ok(/more calendars/.test(exchange.discoveryNotice(cut)))
  assert.strictEqual(exchange.discoveryNotice(found()), "", "a whole discovery says nothing more")
  // With the steps answered again, what is not listed goes.
  const whole = found()
  whole.calendars = whole.calendars.slice(0, 2)
  deepEqual(ids(sources.applyDiscovery(before, whole)), [DEFAULT_ID, OWN_ID].sort())
}

// The reviewer's sequence: a colleague's calendar added by address, then a discovery whose folder step failed. The
// calendar the owner added stays, as they added it, whatever a discovery says.
{
  let list = sources.applyDiscovery(sources.emptyList(), found())
  list = sources.addShared(list, opened())
  list = sources.setColor(list, SHARED_ID, "purple")
  const failed = found()
  failed.calendars = failed.calendars.slice(0, 1)
  failed.steps = { folders: { found: 0, code: "exchange_timeout" } }
  const after = sources.applyDiscovery(list, failed)
  deepEqual(byId(after, SHARED_ID), byId(list, SHARED_ID))
  // Even an answer that listed it would not make it discovery's, nor change what the owner chose.
  const listing = found()
  listing.calendars.push(Object.assign({}, opened().calendar, { name: "Renamed", readOnly: false }))
  const listed = sources.applyDiscovery(list, listing)
  deepEqual(byId(listed, SHARED_ID), byId(list, SHARED_ID))
  assert.strictEqual(listed.sources.filter((s) => s.id === SHARED_ID).length, 1)
  assert.strictEqual(sources.addedByHand(byId(listed, SHARED_ID)), true, "still removed by hand")
}

// A colleague's calendar added before the first discovery does not push the mailbox's own default calendar down:
// it leads the mailbox's calendars, in Settings and in the new-event picker.
{
  const accounts = [{ id: ACCOUNT, email: "alice@example.org", provider: "exchange", signedIn: true }]
  const writer = { provider: "exchange", accountId: ACCOUNT, calendar: Object.assign({}, opened().calendar, {
    readOnly: false, canCreate: true, accessRole: "writer" }) }
  const other = sources.add(sources.emptyList(), { id: "caldav:x", kind: "caldav", name: "x", url: "https://x.example.org/", username: "u" })
  const after = sources.applyDiscovery(sources.addShared(other, writer), found())
  deepEqual(after.sources.map((s) => s.id), ["caldav:x", DEFAULT_ID, SHARED_ID, OWN_ID, PROJECTS_ID])
  const picker = sources.writableGroups(sources.groupByAccount(after, accounts))
  deepEqual(picker[0].calendars.map((s) => s.id), [DEFAULT_ID, SHARED_ID, OWN_ID, PROJECTS_ID])
  // Again, it stays where it is.
  deepEqual(sources.applyDiscovery(after, found()).sources.map((s) => s.id), after.sources.map((s) => s.id))
}

// A discovery names the account it is for, and only that account's calendars are replaced.
{
  const bob = { id: "exchange:exchange:bob@example.org:" + "4".repeat(64), kind: "exchange", accountId: "exchange:bob@example.org",
    name: "Team", calendarId: FOLDER, discovered: true }
  const list = sources.add(sources.emptyList(), bob)
  assert.ok(byId(sources.applyDiscovery(list, found()), bob.id), "another mailbox's calendars are not touched")
  assert.strictEqual(sources.applyDiscovery(list, { provider: "exchange", accountId: "", calendars: [] }).sources.length, 1)
  assert.strictEqual(sources.applyDiscovery(list, { provider: "exchange", accountId: ACCOUNT, calendars: "no" }).sources.length, 1)
}

// The default calendar's source is made every time, keeps what was saved, and leaves the calendars beside it alone.
{
  const accounts = [{ id: ACCOUNT, email: "alice@example.org", provider: "exchange", signedIn: true }]
  let list = sources.addShared(sources.applyDiscovery(sources.emptyList(), found()), opened())
  list = sources.add(list, Object.assign({}, byId(list, DEFAULT_ID), { preferred: false, readOnly: true }))
  const made = sources.withExchangeAccounts(list, accounts)
  assert.strictEqual(made.sources.length, 4)
  deepEqual([byId(made, DEFAULT_ID).discovered, byId(made, DEFAULT_ID).preferred], [true, false])
  assert.strictEqual(byId(made, DEFAULT_ID).readOnly, false, "the owner's own calendar is theirs to write")
  deepEqual(byId(made, SHARED_ID), byId(list, SHARED_ID), "another calendar is left as it was saved")
  assert.strictEqual(sources.withExchangeAccounts(sources.emptyList(), accounts).sources[0].id, DEFAULT_ID)
  // Every calendar of the mailbox is under it, and the picker offers the ones that can be written to.
  const groups = sources.groupByAccount(made, accounts)
  assert.strictEqual(groups.length, 1)
  assert.strictEqual(groups[0].calendars.length, 4)
  deepEqual(sources.writableGroups(groups)[0].calendars.map((s) => s.id), [DEFAULT_ID, OWN_ID, PROJECTS_ID],
    "the calendar that is only read is not offered")
}

// ---------------------------------------------------------------- added by the address of the mailbox

{
  const answer = { provider: "exchange", accountId: ACCOUNT, calendar: Object.assign({}, opened().calendar, {
    readOnly: false, canCreate: true, accessRole: "writer" }) }
  const list = sources.addShared(sources.emptyList(), answer)
  const [added] = list.sources
  deepEqual([added.id, added.kind, added.name, added.calendarId],
    [SHARED_ID, "exchange", "Calendar · colleague@example.org", SHARED], "another mailbox's calendar says whose it is")
  assert.strictEqual(added.discovered, false, "added by hand, so discovery leaves it")
  assert.strictEqual(added.enabled, true)
  assert.strictEqual(added.remindersEnabled, false, "nobody asked to be told of it")
  deepEqual([added.readOnly, added.accessRole], [false, "writer"])
  assert.strictEqual(sources.addedByHand(added), true)
  // The same calendar added again is that source, with what the owner chose.
  const coloured = sources.setColor(list, SHARED_ID, "blue")
  assert.strictEqual(byId(sources.addShared(coloured, answer), SHARED_ID).colorKey, "blue")
  assert.strictEqual(sources.addShared(coloured, answer).sources.length, 1)
  // A calendar the owner may only read is nowhere to put an event.
  assert.strictEqual(sources.writable(sources.addShared(sources.emptyList(), opened()).sources[0]), false)
  // What is not an answer for an Exchange mailbox adds nothing.
  for (const bad of [null, {}, { provider: "microsoft", accountId: ACCOUNT, calendar: answer.calendar },
    { provider: "exchange", accountId: "", calendar: answer.calendar },
    { provider: "exchange", accountId: ACCOUNT, calendar: Object.assign({}, answer.calendar, { calendarId: "" }) },
    { provider: "exchange", accountId: ACCOUNT, calendar: Object.assign({}, answer.calendar, { sourceId: "" }) }])
    assert.strictEqual(sources.addShared(sources.emptyList(), bad).sources.length, 0, JSON.stringify(bad))
}

{
  assert.strictEqual(sources.addedByHand({ kind: "exchange", calendarId: FOLDER, discovered: false }), true)
  assert.strictEqual(sources.addedByHand({ kind: "exchange", calendarId: FOLDER, discovered: true }), false)
  assert.strictEqual(sources.addedByHand({ kind: "exchange", calendarId: "", discovered: false }), false, "the default calendar is never removed by hand")
  assert.strictEqual(sources.addedByHand({ kind: "caldav", discovered: false }), true)
  assert.strictEqual(sources.addedByHand({ kind: "caldav", discovered: true }), false)
  assert.strictEqual(sources.addedByHand({ kind: "google", discovered: false }), false)
  assert.strictEqual(sources.addedByHand(null), false)
}

// ---------------------------------------------------------------- what a request names

const source = (extra) => Object.assign({ id: DEFAULT_ID, kind: "exchange", accountId: ACCOUNT, calendarId: "" }, extra || {})

{
  deepEqual(exchange.eventsParams(source(), 1000.4, 2000.2), { accountId: ACCOUNT, startMs: 1000, endMs: 2001 })
  deepEqual(exchange.eventsParams(source({ calendarId: SHARED }), 1000, 2000),
    { accountId: ACCOUNT, startMs: 1000, endMs: 2000, calendar: SHARED })
  assert.strictEqual(exchange.otherCalendar(source()), false)
  assert.strictEqual(exchange.otherCalendar(source({ calendarId: FOLDER })), true)
  assert.strictEqual(exchange.otherCalendar(null), false)
}

const item = (extra) => Object.assign({ id: "t1", uid: "u-t1", title: "Standup", location: "", organizer: "", allDay: false,
  startMs: Date.UTC(2026, 9, 23, 7, 0), endMs: Date.UTC(2026, 9, 23, 7, 30), busy: "busy", meeting: false,
  response: "organizer", kind: "single", recurring: false, private: false, changeKey: "key-1", editable: true, lock: "" }, extra || {})

{
  const [mine] = exchange.eventsFromExchange({ events: [item()] }, DEFAULT_ID)
  const [theirs] = exchange.eventsFromExchange({ events: [item()] }, SHARED_ID, SHARED)
  assert.strictEqual(mine.exchangeCalendar, "", "the default calendar names none")
  deepEqual([theirs.exchangeCalendar, theirs.sourceId], [SHARED, SHARED_ID])
  // Every request about an event names the calendar it was drawn from, and none for the default one.
  deepEqual(exchange.detailParams(source(), mine), { accountId: ACCOUNT, id: "t1" })
  deepEqual(exchange.detailParams(source({ calendarId: SHARED }), theirs), { accountId: ACCOUNT, id: "t1", calendar: SHARED })
  const form = calendar.updateEvent({ title: "Renamed", location: "", startMs: theirs.start.ms, endMs: theirs.end.ms, allDay: false }, theirs, 1)
  assert.strictEqual(exchange.updateParams(ACCOUNT, theirs, form).calendar, SHARED)
  assert.ok(!("calendar" in exchange.updateParams(ACCOUNT, mine, form)))
  assert.strictEqual(exchange.deleteParams(ACCOUNT, theirs).calendar, SHARED)
  assert.ok(!("calendar" in exchange.deleteParams(ACCOUNT, mine)))
  // What the backend locks there is still asked with the calendar named, so it is refused and never done to
  // the default calendar's item of the same id.
  for (const params of [exchange.cancelParams(ACCOUNT, theirs), exchange.removeParams(ACCOUNT, theirs),
    exchange.respondParams(ACCOUNT, theirs, "accepted", ""), exchange.declineParams(ACCOUNT, theirs)])
    assert.strictEqual(params.calendar, SHARED, JSON.stringify(params))
  assert.ok(!("calendar" in exchange.respondParams(ACCOUNT, mine, "accepted", "")))
  const built = calendar.createEvent({ title: "New", startMs: 1000, endMs: 2000 }, 1)
  assert.strictEqual(exchange.createParams(ACCOUNT, built, FOLDER).calendar, FOLDER)
  assert.ok(!("calendar" in exchange.createParams(ACCOUNT, built, "")))
  assert.ok(!("calendar" in exchange.createParams(ACCOUNT, built)))
  assert.strictEqual(exchange.meetingCreateParams(ACCOUNT, built, ["g@example.org"], FOLDER).calendar, FOLDER)
}

// The backend's lock for a calendar that does not let the owner change events says so in words.
{
  const [event] = exchange.eventsFromExchange({ events: [item({ editable: false, lock: "calendar" })] }, SHARED_ID, SHARED)
  assert.strictEqual(event.lockReason, "The owner of this calendar has not let you change its events")
  const [unknown] = exchange.eventsFromExchange({ events: [item({ editable: false, lock: "weird" })] }, SHARED_ID, SHARED)
  assert.notStrictEqual(event.lockReason, unknown.lockReason)
  assert.notStrictEqual(calendar.writeRefusal(source({ calendarId: SHARED }), event, "update"), "", "a locked event is not written")
}

// Nothing is deleted in another person's calendar, whatever the event's rights; in the owner's own other calendar
// an appointment is deleted as in the default one.
{
  const [theirs] = exchange.eventsFromExchange({ events: [item()] }, SHARED_ID, SHARED)
  const [team] = exchange.eventsFromExchange({ events: [item()] }, OWN_ID, FOLDER)
  deepEqual([exchange.otherMailbox(source({ calendarId: SHARED })), exchange.otherMailbox(source({ calendarId: FOLDER })),
    exchange.otherMailbox(source()), exchange.otherMailbox(null)], [true, false, false, false])
  assert.strictEqual(exchange.deleteKind(theirs), "appointment", "what deleting it would be is still said")
  assert.strictEqual(exchange.deleteRefusal(source({ id: SHARED_ID, calendarId: SHARED }), theirs), exchange.SHARED_DELETE)
  assert.strictEqual(exchange.deleteRefusal(source({ id: OWN_ID, calendarId: FOLDER }), team), "")
  assert.strictEqual(calendar.writeRefusal(source({ calendarId: SHARED }), theirs, "update"), "", "it may still be changed")
  // A read-only calendar says that first.
  assert.strictEqual(exchange.deleteRefusal(source({ calendarId: SHARED, readOnly: true }), theirs), "This calendar is read-only")
}

// ---------------------------------------------------------------- the address of a shared mailbox

{
  deepEqual(exchange.sharedAddress("  Team@Example.ORG ", ACCOUNT), { ok: true, address: "team@example.org" })
  for (const bad of ["", "   ", undefined, null, "team", "team@example", "Team <team@example.org>", "a b@example.org",
    "team@example.org, other@example.org", "x".repeat(65) + "@example.org", "a@" + "b".repeat(250) + ".org", "team@@example.org"]) {
    const result = exchange.sharedAddress(bad, ACCOUNT)
    assert.strictEqual(result.ok, false, JSON.stringify(bad))
    assert.ok(result.error.length > 0 && !("address" in result), JSON.stringify(bad))
  }
  const own = exchange.sharedAddress("ALICE@example.org", ACCOUNT)
  assert.strictEqual(own.ok, false)
  assert.ok(/your own mailbox/.test(own.error), own.error)
  assert.strictEqual(exchange.sharedFailure({ code: -32000, message: "exchange_calendar_not_shared" }),
    "That calendar is not shared with you, or no mailbox on this server has that address. Use the primary address of the mailbox")
  assert.strictEqual(exchange.sharedFailure({ code: -32000, message: "exchange_calendar_own_mailbox" }),
    "That address is another name for your own mailbox: its calendar is already here")
  assert.ok(/not an email address/.test(exchange.sharedFailure({ message: "invalid_params" })))
  assert.ok(/not an email address/.test(exchange.sharedFailure({ code: -32602, message: "Invalid params" })))
  assert.ok(/Update the mail backend/.test(exchange.sharedFailure({ code: -32601, message: "Method not found" })))
  assert.strictEqual(exchange.sharedFailure("exchange_access_denied"),
    "The server refused access to this mailbox or message. Ask your administrator if it keeps happening")
  assert.ok(!exchange.sharedFailure("SECRET text of a server").includes("SECRET"))
}

console.log("test_calendar_folders.js ok")
