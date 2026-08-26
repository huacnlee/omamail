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
