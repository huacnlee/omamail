const assert = require("assert")
const { load } = require("./load")
const sources = load("calendar/Sources.js")

let list = sources.emptyList()
list = sources.add(list, {
  id: "nextcloud-personal",
  kind: "caldav",
  name: "Personal",
  url: "https://nextcloud.example/remote.php/dav/calendars/me/personal/",
  username: "me",
  enabled: true
})
assert.strictEqual(list.sources.length, 1)
assert.strictEqual(list.sources[0].kind, "caldav")
assert.strictEqual(list.sources[0].url,
  "https://nextcloud.example/remote.php/dav/calendars/me/personal/")
assert.ok(sources.COLOR_KEYS.indexOf(list.sources[0].colorKey) >= 0,
  "an older calendar gets a stable theme-palette color")
assert.strictEqual(list.sources[0].colorKey,
  sources.defaultColorKey("nextcloud-personal"))

list = sources.add(list, {
  id: "nextcloud-personal", kind: "caldav", name: "Renamed",
  url: "https://nextcloud.example/remote.php/dav/calendars/me/personal/", username: "me"
})
assert.strictEqual(list.sources.length, 1, "an existing source is replaced")
assert.strictEqual(list.sources[0].name, "Renamed")

const roundTrip = sources.load(sources.serialize(list))
assert.deepStrictEqual(JSON.parse(sources.serialize(roundTrip)), JSON.parse(sources.serialize(list)))
assert.strictEqual(sources.validate({ kind: "caldav", url: "http://remote.example/x", username: "me" }).ok, false)
assert.strictEqual(sources.validate({ kind: "caldav", url: "https://remote.example/x", username: "" }).ok, false)
assert.strictEqual(sources.validate({
  kind: "caldav", name: "", url: "https://remote.example/x", username: "me"
}).error, "Add a calendar name")
assert.strictEqual(sources.validate({ kind: "google", accountId: "me@gmail.com" }).ok, true)
assert.deepStrictEqual(JSON.parse(JSON.stringify(sources.keyringAttributes("nextcloud-personal"))), [
  "service", "omamail", "kind", "calendar-password", "source", "nextcloud-personal"
])
assert.strictEqual(
  sources.sourceId({ kind: "caldav", url: "https://nextcloud.example/dav/me/personal/" }),
  "caldav:nextcloud-example-dav-me-personal")
assert.strictEqual(sources.sourceId({ kind: "google", accountId: "me@gmail.com" }),
  "google:me@gmail.com")

const withGoogle = sources.withGoogleAccounts(list, [
  { id: "me@gmail.com", email: "me@gmail.com", provider: "gmail", signedIn: true },
  { id: "imap:work@example.com", email: "work@example.com", provider: "imap", signedIn: true },
  { id: "later@gmail.com", email: "later@gmail.com", provider: "gmail", signedIn: false }
])
assert.strictEqual(withGoogle.sources.length, 2)
assert.strictEqual(withGoogle.sources[1].id, "google:me@gmail.com")
assert.strictEqual(withGoogle.sources[1].accountId, "me@gmail.com")
assert.strictEqual(withGoogle.sources[1].readOnly, false,
  "a Google calendar accepts writes through the API")
assert.ok(sources.writable(withGoogle.sources[1]))

let readOnlyList = sources.add(list, {
  id: "caldav:shared-example-team", kind: "caldav", name: "Team",
  url: "https://shared.example/dav/team/", username: "me", readOnly: true
})
assert.strictEqual(sources.writable(readOnlyList.sources[1]), false,
  "a read-only calendar is not somewhere a write can be offered")
assert.strictEqual(sources.load(sources.serialize(readOnlyList)).sources[1].readOnly,
  true, "the read-only flag survives a config round trip")
const writableGroups = sources.writableGroups(sources.groupByAccount(readOnlyList, [
  { id: "me@gmail.com", email: "me@gmail.com", provider: "gmail", signedIn: true }
]))
assert.strictEqual(writableGroups.length, 1)
assert.strictEqual(JSON.stringify(writableGroups[0].calendars.map(function (source) { return source.id })),
  JSON.stringify(["nextcloud-personal"]), "the read-only calendar leaves the creation picker")
assert.strictEqual(withGoogle.sources[1].name, "me@gmail.com",
  "Google calendar errors must identify the full account address")
const forMe = sources.forAccount(sources.withGoogleAccounts(list, [
  { id: "me@gmail.com", email: "me@gmail.com", provider: "gmail", signedIn: true },
  { id: "other@gmail.com", email: "other@gmail.com", provider: "gmail", signedIn: true }
]), "me@gmail.com")
assert.strictEqual(JSON.stringify(forMe.sources.map(function (source) { return source.id })),
  JSON.stringify(["nextcloud-personal", "google:me@gmail.com"]),
  "an account calendar keeps shared CalDAV and only that account's Google source")
const forDraft = sources.forAccount(withGoogle, "__no_google_account__")
assert.strictEqual(JSON.stringify(forDraft.sources.map(function (source) { return source.id })),
  JSON.stringify(["nextcloud-personal"]),
  "a draft account must not inherit another account's Google calendar")

let hiddenGoogle = sources.add(list, {
  id: "google:me@gmail.com", kind: "google", name: "Personal Google",
  accountId: "me@gmail.com", enabled: false, readOnly: true
})
hiddenGoogle = sources.withGoogleAccounts(hiddenGoogle, [
  { id: "me@gmail.com", email: "me@gmail.com", provider: "gmail", signedIn: true }
])
assert.strictEqual(hiddenGoogle.sources[1].enabled, false,
  "discovering an account must not undo its saved visibility")
assert.strictEqual(hiddenGoogle.sources[1].readOnly, false,
  "a legacy synthesized Google source must not keep its old read-only stamp")

const visibility = sources.setEnabled(hiddenGoogle, "google:me@gmail.com", true)
assert.strictEqual(visibility.sources[1].enabled, true)
assert.strictEqual(visibility.sources[1].colorKey, hiddenGoogle.sources[1].colorKey,
  "visibility updates preserve the calendar color")
assert.strictEqual(hiddenGoogle.sources[1].enabled, false,
  "visibility updates return a new list")

const colored = sources.setColor(visibility, "google:me@gmail.com", "magenta")
assert.strictEqual(colored.sources[1].colorKey, "magenta")
assert.strictEqual(visibility.sources[1].colorKey !== "magenta"
  || colored.sources[1] !== visibility.sources[1], true,
  "color updates return a new source")
assert.strictEqual(sources.setColor(colored, "google:me@gmail.com", "not-a-color")
  .sources[1].colorKey, "magenta", "unknown palette slots are ignored")
assert.strictEqual(sources.load(sources.serialize(colored)).sources[1].colorKey, "magenta",
  "the selected color survives a config round trip")

let savedGoogleColor = sources.add(list, {
  id: "google:me@gmail.com", kind: "google", name: "Personal Google",
  accountId: "me@gmail.com", enabled: true, readOnly: true, colorKey: "cyan"
})
savedGoogleColor = sources.withGoogleAccounts(savedGoogleColor, [
  { id: "me@gmail.com", email: "me@gmail.com", provider: "gmail", signedIn: true }
])
assert.strictEqual(savedGoogleColor.sources[1].colorKey, "cyan",
  "account discovery must not overwrite a saved color")

let groupedList = sources.emptyList()
groupedList = sources.add(groupedList, {
  id: "google:me@gmail.com", kind: "google", name: "Personal",
  accountId: "me@gmail.com", enabled: true
})
groupedList = sources.add(groupedList, {
  id: "work", kind: "caldav", name: "Team",
  url: "https://cloud.example/cal/team", username: "work@example.com", enabled: true
})
groupedList = sources.add(groupedList, {
  id: "shared", kind: "caldav", name: "Shared",
  url: "https://cloud.example/cal/shared", username: "cal-user", enabled: false
})
groupedList = sources.add(groupedList, {
  id: "hey:me", kind: "hey", name: "HEY Calendar",
  accountId: "hey@example.com", enabled: true
})
const groups = sources.groupByAccount(groupedList, [
  { id: "me@gmail.com", email: "me@gmail.com", label: "Personal Gmail", provider: "gmail" },
  { id: "imap:work", email: "work@example.com", label: "Work mail", provider: "imap" },
  { id: "hey@example.com", email: "hey@example.com", label: "HEY", provider: "hey" }
])
assert.strictEqual(JSON.stringify(groups.map(function (group) { return group.providerLabel })),
  JSON.stringify(["Google", "CalDAV", "HEY", "CalDAV"]))
assert.strictEqual(JSON.stringify(groups.map(function (group) { return group.accountLabel })),
  JSON.stringify(["me@gmail.com", "Work mail", "HEY", "cal-user"]))
assert.strictEqual(groups[0].calendars[0].id, "google:me@gmail.com")
assert.strictEqual(groups[1].calendars[0].id, "work")
assert.strictEqual(groups[3].calendars[0].enabled, false)

assert.strictEqual(sources.calendarEditorUrl({ sources: [{
  kind: "caldav", enabled: true,
  url: "https://nextcloud.example/remote.php/dav/calendars/me/personal/"
}] }), "https://nextcloud.example/apps/calendar/")
assert.strictEqual(sources.calendarEditorUrl({ sources: [{
  kind: "google", enabled: true, accountId: "me@gmail.com"
}] }), "https://calendar.google.com/calendar/u/0/r/eventedit")

console.log("test_calendar_sources.js ok")

assert.strictEqual(sources.sameUrl("https://CALDAV.ICLOUD.COM/Work/", "https://caldav.icloud.com/Work"), true)
assert.strictEqual(sources.sameUrl("https://caldav.icloud.com/Work/", "https://caldav.icloud.com/work/"), false,
  "case-sensitive calendar paths must not adopt or remove another saved calendar")

const namedMicrosoft = sources.withMicrosoftAccounts({sources: [{
  id: "microsoft:outlook:me@contoso.com", kind: "microsoft", accountId: "outlook:me@contoso.com",
  name: "Work appointments", calendarId: "default-id", discovered: true
}]}, [{id: "outlook:me@contoso.com", email: "me@contoso.com", provider: "outlook", signedIn: true}])
assert.strictEqual(namedMicrosoft.sources[0].name, "Work appointments",
  "refreshing the account summary must preserve the discovered default calendar's name")

// A Microsoft calendar comes with a signed-in Outlook mailbox, the way a
// Google one comes with Gmail.
{
  const withMicrosoft = sources.withMicrosoftAccounts(list, [
    { id: "outlook:me@contoso.com", email: "me@contoso.com", provider: "outlook", signedIn: true },
    { id: "outlook:later@contoso.com", email: "later@contoso.com", provider: "outlook", signedIn: false },
    { id: "me@gmail.com", email: "me@gmail.com", provider: "gmail", signedIn: true }
  ])
  assert.strictEqual(withMicrosoft.sources.length, 2)
  assert.strictEqual(withMicrosoft.sources[1].id, "microsoft:outlook:me@contoso.com")
  assert.strictEqual(withMicrosoft.sources[1].kind, "microsoft")
  assert.strictEqual(withMicrosoft.sources[1].name, "me@contoso.com")
  assert.ok(sources.writable(withMicrosoft.sources[1]))
  assert.strictEqual(sources.providerLabel("microsoft"), "Microsoft")
  const mine = sources.forAccount(withMicrosoft, "outlook:me@contoso.com")
  assert.strictEqual(mine.sources.length, 2, "another account's Microsoft calendar is left out, a CalDAV one kept")
  assert.strictEqual(sources.forAccount(withMicrosoft, "me@gmail.com").sources.length, 1)
}

// Provider discovery replaces only the account-owned calendars, preserves the
// user's choices and adopts a manually assembled iCloud URL without duplication.
{
  let before = sources.add(sources.emptyList(), {
    id: "manual-icloud", kind: "caldav", name: "Old Personal",
    url: "https://p37-caldav.icloud.com/123/calendars/personal/",
    username: "person@icloud.com", enabled: false, colorKey: "cyan"
  })
  before = sources.add(before, {
    id: "unrelated", kind: "caldav", name: "Work",
    url: "https://dav.example/work/", username: "person", enabled: true
  })
  const found = sources.applyDiscovery(before, {
    provider: "icloud", accountId: "imap:person@icloud.com", calendars: [{
      sourceId: "icloud:stable-personal", name: "Personal",
      url: "https://p37-caldav.icloud.com/123/calendars/personal",
      username: "person@icloud.com", readOnly: true
    }, {
      sourceId: "icloud:stable-family", name: "Family",
      url: "https://p37-caldav.icloud.com/123/calendars/family/",
      username: "person@icloud.com", readOnly: false
    }]
  })
  assert.strictEqual(found.sources.length, 3)
  assert.strictEqual(found.sources[0].id, "unrelated")
  assert.strictEqual(found.sources[1].id, "icloud:stable-personal")
  assert.strictEqual(found.sources[1].enabled, false)
  assert.strictEqual(found.sources[1].colorKey, "cyan")
  assert.strictEqual(found.sources[1].readOnly, true)
  assert.strictEqual(found.sources[1].accountId, "imap:person@icloud.com")
  assert.strictEqual(found.sources[1].discovered, true)
  assert.strictEqual(found.sources[2].enabled, true)
  assert.strictEqual(sources.providerLabel("icloud"), "iCloud")
  assert.strictEqual(sources.forAccount(found, "imap:person@icloud.com").sources.length, 3)

  const refreshed = sources.applyDiscovery(found, {
    provider: "icloud", accountId: "imap:person@icloud.com", calendars: [{
      sourceId: "icloud:stable-personal", name: "Personal renamed",
      url: "https://p37-caldav.icloud.com/123/calendars/personal/",
      username: "person@icloud.com", readOnly: false
    }]
  })
  assert.strictEqual(refreshed.sources.length, 2, "a calendar no longer returned is removed")
  assert.strictEqual(refreshed.sources[1].enabled, false, "refresh keeps visibility")
  assert.strictEqual(refreshed.sources[1].colorKey, "cyan", "refresh keeps color")
  assert.strictEqual(refreshed.sources[1].name, "Personal renamed")
}

{
  let saved = sources.add(sources.emptyList(), {
    id: "microsoft:outlook:me@contoso.com", kind: "microsoft", name: "Calendar",
    accountId: "outlook:me@contoso.com", calendarId: "default-id", enabled: false,
    readOnly: false, discovered: true, colorKey: "blue"
  })
  const found = sources.applyDiscovery(saved, {
    provider: "microsoft", accountId: "outlook:me@contoso.com", calendars: [{
      sourceId: "microsoft:outlook:me@contoso.com", calendarId: "default-id",
      name: "Calendar", readOnly: false, isDefault: true
    }, {
      sourceId: "microsoft:holiday-hash", calendarId: "holiday-id",
      name: "Holidays", readOnly: true
    }]
  })
  assert.strictEqual(found.sources.length, 2)
  assert.strictEqual(found.sources[0].enabled, false)
  assert.strictEqual(found.sources[0].calendarId, "default-id")
  assert.strictEqual(found.sources[1].readOnly, true)
  const available = sources.withMicrosoftAccounts(found, [{
    id: "outlook:me@contoso.com", email: "me@contoso.com",
    provider: "outlook", signedIn: true
  }])
  assert.strictEqual(available.sources.length, 2, "the synthesized default does not duplicate discovery")
  assert.strictEqual(available.sources[0].calendarId, "default-id")
  assert.strictEqual(available.sources[0].enabled, false)
}

// Graph may flag no calendar as the default. Every discovered calendar then
// carries its own id, and synthesizing the account's primary calendar on top
// would fetch the same one twice.
{
  const found = sources.applyDiscovery(sources.emptyList(), {
    provider: "microsoft", accountId: "outlook:me@contoso.com", calendars: [{
      sourceId: "microsoft:outlook:me@contoso.com:primary-hash", calendarId: "primary-id",
      name: "Calendar", readOnly: false
    }, {
      sourceId: "microsoft:outlook:me@contoso.com:holiday-hash", calendarId: "holiday-id",
      name: "Holidays", readOnly: true
    }]
  })
  const accounts = [{
    id: "outlook:me@contoso.com", email: "me@contoso.com",
    provider: "outlook", signedIn: true
  }]
  const available = sources.withMicrosoftAccounts(found, accounts)
  assert.strictEqual(JSON.stringify(available.sources.map(function(source) { return source.id })),
    JSON.stringify(["microsoft:outlook:me@contoso.com:primary-hash", "microsoft:outlook:me@contoso.com:holiday-hash"]),
    "discovery without a flagged default synthesizes no second primary calendar")
  const fresh = sources.withMicrosoftAccounts(sources.emptyList(), accounts)
  assert.strictEqual(JSON.stringify(fresh.sources.map(function(source) { return source.id })),
    JSON.stringify(["microsoft:outlook:me@contoso.com"]),
    "an undiscovered account still gets its primary calendar")
}

// A discovered calendar outlives the mailbox it came with: removing the
// account edits the account list, not calendars.json. Such a source can no
// longer sign in, so it is named as orphaned for the settings page to offer
// removing it, where a synthesized or still-owned source is not.
{
  const accounts = [
    { id: "outlook:me@contoso.com", email: "me@contoso.com", provider: "outlook", signedIn: true },
    { id: "imap:person@icloud.com", email: "person@icloud.com", provider: "imap", signedIn: false }
  ]
  const owned = { id: "microsoft:outlook:me@contoso.com:hash", kind: "microsoft",
    accountId: "outlook:me@contoso.com", discovered: true }
  const signedOut = { id: "icloud:one", kind: "icloud", accountId: "imap:person@icloud.com", discovered: true }
  const gone = { id: "icloud:two", kind: "icloud", accountId: "imap:gone@icloud.com", discovered: true }
  const caldav = { id: "caldav:team", kind: "caldav", url: "https://calendar.example/team/" }
  assert.strictEqual(sources.orphaned(owned, accounts), false)
  assert.strictEqual(sources.orphaned(signedOut, accounts), false, "a signed-out mailbox is still a mailbox")
  assert.strictEqual(sources.orphaned(gone, accounts), true)
  assert.strictEqual(sources.orphaned(caldav, accounts), false, "a hand-added calendar has no mailbox to lose")
  assert.strictEqual(sources.orphaned(gone, []), true)
  assert.strictEqual(sources.orphaned(null, accounts), false)
}

// A calendar error names its source. Discovery names a calendar the way its
// provider does — every Outlook mailbox has a "Calendar" — so a discovered
// source is named with its mailbox as well, where the address alone said which
// account needed attention before.
{
  const accounts = [
    { id: "outlook:me@contoso.com", email: "me@contoso.com", provider: "outlook", signedIn: true },
    { id: "imap:person@icloud.com", label: "Personal", provider: "imap", signedIn: true }
  ]
  assert.strictEqual(sources.errorLabel({ id: "microsoft:outlook:me@contoso.com", kind: "microsoft",
    name: "Calendar", accountId: "outlook:me@contoso.com", discovered: true }, accounts),
    "Calendar · me@contoso.com")
  assert.strictEqual(sources.errorLabel({ id: "icloud:one", kind: "icloud", name: "Home",
    accountId: "imap:person@icloud.com", discovered: true }, accounts),
    "Home · Personal", "a mailbox with no address is named by its label")
  assert.strictEqual(sources.errorLabel({ id: "icloud:two", kind: "icloud", name: "Home",
    accountId: "imap:gone@icloud.com", discovered: true }, accounts),
    "Home · imap:gone@icloud.com", "a removed mailbox is still named")
  assert.strictEqual(sources.errorLabel({ id: "microsoft:outlook:me@contoso.com", kind: "microsoft",
    name: "me@contoso.com", accountId: "outlook:me@contoso.com" }, accounts),
    "me@contoso.com", "a synthesized source already carries its address")
  assert.strictEqual(sources.errorLabel({ id: "caldav:team", kind: "caldav", name: "Team" }, accounts), "Team")
  assert.strictEqual(sources.errorLabel({ id: "caldav:team", kind: "caldav" }, accounts), "caldav:team")
  assert.strictEqual(sources.errorLabel(null, accounts), "Calendar")
}

// An Outlook mailbox whose tenant refuses Graph reads its calendar through
// Exchange instead: one read-only source, and no Graph one beside it.
{
  const accounts = [
    { id: "outlook:me@contoso.com", email: "me@contoso.com", provider: "outlook",
      signedIn: true, calendarProvider: "ews" },
    { id: "outlook:you@example.org", email: "you@example.org", provider: "outlook",
      signedIn: true, calendarProvider: "microsoft" }
  ]
  const joined = sources.withEwsAccounts(sources.withMicrosoftAccounts(sources.emptyList(), accounts), accounts)
  const ids = joined.sources.map(function(source) { return source.id }).sort()
  assert.strictEqual(JSON.stringify(ids), JSON.stringify(["ews:outlook:me@contoso.com", "microsoft:outlook:you@example.org"]),
    "an Exchange mailbox gets an Exchange source and no Graph one")
  const exchange = joined.sources.filter(function(source) { return source.kind === "ews" })[0]
  assert.strictEqual(exchange.readOnly, true, "the Exchange route lists and does not write")
  assert.strictEqual(sources.writable(exchange), false)
  assert.strictEqual(sources.comesWithAccount(exchange), true)
  assert.strictEqual(sources.providerLabel("ews"), "Exchange")
  assert.strictEqual(sources.sourceId({ kind: "ews", accountId: "outlook:me@contoso.com" }),
    "ews:outlook:me@contoso.com")
  const signedOut = sources.withEwsAccounts(sources.emptyList(),
    [Object.assign({}, accounts[0], { signedIn: false })])
  assert.strictEqual(signedOut.sources.length, 0, "a signed-out mailbox brings no calendar")
}
