// A line-for-line port of omarchy/ui/calendar/Sources.js, typed with the
// shapes in types.ts; its behavior is unchanged from the Qt client's, and the
// tests next to it are the Qt tests ported. calendars.json and discovery
// results arrive untrusted: their fields stay `unknown` until read here.
import * as Palette from "./palette";
import * as Accounts from "./accounts";
import type {
  AccountSummary, CalendarGroup, CalendarSource, JsonObject, SourceList, SourceVerdict
} from "./types";

// The fields of whatever arrived, each still to be checked. A missing value
// reads as an empty object, as `raw || {}` did in the Qt client.
function fields(value: unknown): JsonObject {
  return (value || {}) as JsonObject
}

/** A calendar as a caller may name it: any of its fields. */
type SourceLike = Partial<CalendarSource> | null | undefined
export var VERSION = 1
export var KINDS: string[] = ["caldav", "google", "microsoft", "icloud", "hey"]
export var COLOR_KEYS: string[] = Palette.keys()

export function defaultColorKey(identity?: unknown): string { return Palette.defaultKey(identity) }

export function trimmed(value?: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim()
}

export function emptyList(): SourceList {
  return { version: VERSION, sources: [] }
}

export function normalizeKind(value?: unknown): string {
  var kind = trimmed(value).toLowerCase()
  return KINDS.indexOf(kind) >= 0 ? kind : "caldav"
}

export function sourceId(raw?: unknown): string {
  var value = fields(raw)
  var kind = normalizeKind(value.kind)
  if (kind === "google") return "google:" + trimmed(value.accountId)
  if (kind === "microsoft") return "microsoft:" + trimmed(value.accountId)
  var address = trimmed(value.url).toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return kind + ":" + address
}

export function makeSource(raw?: unknown): CalendarSource {
  var value = fields(raw)
  var kind = normalizeKind(value.kind)
  var id = trimmed(value.id)
  var colorKey = Palette.normalizeKey(value.colorKey)
  if (colorKey === "") colorKey = Palette.defaultKey(id)
  return {
    id: id, kind: kind, name: trimmed(value.name),
    url: trimmed(value.url), username: trimmed(value.username),
    accountId: trimmed(value.accountId), enabled: value.enabled !== false,
    calendarId: trimmed(value.calendarId),
    readOnly: value.readOnly === true, discovered: value.discovered === true,
    colorKey: colorKey,
    accessRole: trimmed(value.accessRole), timeZone: trimmed(value.timeZone),
    canCreateMeet: value.canCreateMeet === true,
    defaultReminders: Array.isArray(value.defaultReminders) ? value.defaultReminders.slice() : [],
    remindersEnabled: value.remindersEnabled === undefined ? value.enabled !== false : value.remindersEnabled === true,
    reminderMinutes: isFinite(Number(value.reminderMinutes)) && value.reminderMinutes !== undefined
      ? Math.max(-1, Math.min(40320, Math.floor(Number(value.reminderMinutes)))) : -1,
    preferred: value.preferred === true
  }
}

export function copyList(list?: SourceList | null): SourceList {
  var value = list || emptyList()
  return {
    version: VERSION,
    sources: Array.isArray(value.sources) ? value.sources.slice() : []
  }
}

export function add(list: SourceList | null | undefined, raw?: unknown): SourceList {
  var next = copyList(list)
  var source = makeSource(raw)
  if (source.id === "") return next
  var found = -1
  for (var i = 0; i < next.sources.length; i++) {
    if (next.sources[i] && next.sources[i].id === source.id) { found = i; break }
  }
  if (found >= 0) next.sources[found] = source
  else next.sources.push(source)
  return next
}

export function remove(list: SourceList | null | undefined, id?: unknown): SourceList {
  var next = copyList(list)
  var wanted = trimmed(id)
  for (var i = 0; i < next.sources.length; i++) {
    if (next.sources[i] && next.sources[i].id === wanted) {
      next.sources.splice(i, 1)
      break
    }
  }
  return next
}

export function setEnabled(list: SourceList | null | undefined, id?: unknown, enabled?: boolean): SourceList {
  var next = copyList(list)
  var wanted = trimmed(id)
  for (var i = 0; i < next.sources.length; i++) {
    if (!next.sources[i] || next.sources[i].id !== wanted) continue
    var changed = makeSource(next.sources[i])
    changed.enabled = enabled !== false
    next.sources[i] = changed
    break
  }
  return next
}

export function setColor(list: SourceList | null | undefined, id?: unknown, colorKey?: unknown): SourceList {
  var normalized = Palette.normalizeKey(colorKey)
  if (normalized === "") return copyList(list)
  var next = copyList(list)
  var wanted = trimmed(id)
  for (var i = 0; i < next.sources.length; i++) {
    if (!next.sources[i] || next.sources[i].id !== wanted) continue
    var changed = makeSource(next.sources[i])
    changed.colorKey = normalized
    next.sources[i] = changed
    break
  }
  return next
}

export function validate(raw?: unknown): SourceVerdict {
  var source = makeSource(raw)
  if (source.kind === "google") {
    return source.accountId !== ""
      ? { ok: true, source: source }
      : { ok: false, error: "Choose a signed-in Google account" }
  }
  if (source.kind === "icloud") {
    if (source.accountId === "") return { ok: false, error: "Choose a signed-in iCloud account" }
    if (source.name === "") return { ok: false, error: "That iCloud calendar has no name" }
    if (!/^https:\/\//i.test(source.url)) return { ok: false, error: "That iCloud calendar has no address" }
    return { ok: true, source: source }
  }
  if (source.kind === "hey")
    return { ok: false, error: "The HEY CLI does not expose calendar events" }
  if (source.name === "") return { ok: false, error: "Add a calendar name" }
  if (!/^https:\/\//i.test(source.url))
    return { ok: false, error: "Use an HTTPS CalDAV calendar address" }
  if (source.username === "") return { ok: false, error: "Add the CalDAV username" }
  return { ok: true, source: source }
}

export function serialize(list?: SourceList | null): string {
  return JSON.stringify(copyList(list))
}

export function load(text?: unknown): SourceList {
  var parsed: unknown = null
  try { parsed = JSON.parse(String(text || "")) } catch (e) {}
  var file = fields(parsed)
  var input: unknown[] = parsed && Array.isArray(file.sources) ? file.sources : []
  var list = emptyList()
  for (var i = 0; i < input.length; i++) list = add(list, input[i])
  return list
}

export function keyringAttributes(sourceId?: unknown): string[] {
  var id = trimmed(sourceId)
  if (id === "") return []
  return ["service", "omamail", "kind", "calendar-password", "source", id]
}

export function withGoogleAccounts(list: SourceList | null | undefined,
    accountSummaries?: AccountSummary[] | null): SourceList {
  var next = copyList(list)
  var accounts = Array.isArray(accountSummaries) ? accountSummaries : []
  for (var i = 0; i < accounts.length; i++) {
    var account: Partial<AccountSummary> = accounts[i] || {}
    if (account.provider !== "gmail" || account.signedIn !== true) continue
    var accountId = trimmed(account.id || account.email)
    if (accountId === "") continue
    var saved: CalendarSource | null = null
    for (var s = 0; s < next.sources.length; s++) {
      if (next.sources[s] && next.sources[s].id === "google:" + accountId) {
        saved = next.sources[s]
        break
      }
    }
    // Discovery's primary entry carries permissions, identity and reminder
    // defaults. Never replace it with a synthetic writable primary.
    var hasDiscovery = next.sources.some(function(source) {
      return source && source.kind === "google" && source.accountId === accountId && source.discovered
    })
    if (hasDiscovery) continue
    next = add(next, {
      id: "google:" + accountId,
      kind: "google",
      // Calendar errors name their source. The full address is load-bearing
      // here: two Google accounts commonly share the same local part, and the
      // mailbox's short display label cannot say which grant needs attention.
      name: trimmed(account.email || account.label || "Google Calendar"),
      accountId: accountId,
      enabled: saved ? saved.enabled !== false : true,
      // A Google calendar accepts writes through the API. Older versions
      // persisted readOnly on these synthesized sources, so it must not be
      // inherited: keeping the stamp would hide Edit and Delete after an
      // upgrade. Hand-configured CalDAV sources still keep their own flag.
      readOnly: false,
      colorKey: saved ? saved.colorKey : Palette.defaultKey("google:" + accountId),
      remindersEnabled: saved ? saved.remindersEnabled : true,
      reminderMinutes: saved ? saved.reminderMinutes : -1,
      preferred: saved ? saved.preferred : false
    })
  }
  return next
}

// A Microsoft calendar comes with an Outlook or Microsoft 365 mailbox the
// way a Google one comes with Gmail: one source per signed-in account, its
// primary calendar, reached through the mailbox's own Graph token.
export function withMicrosoftAccounts(list: SourceList | null | undefined,
    accountSummaries?: AccountSummary[] | null): SourceList {
  var next = copyList(list)
  var accounts = Array.isArray(accountSummaries) ? accountSummaries : []
  for (var i = 0; i < accounts.length; i++) {
    var account: Partial<AccountSummary> = accounts[i] || {}
    if (Accounts.calendarProvider(account) !== "microsoft" || account.signedIn !== true) continue
    var accountId = trimmed(account.id || account.email)
    if (accountId === "") continue
    var saved: Partial<CalendarSource> | null = null
    var discovered = false
    for (var s = 0; s < next.sources.length; s++) {
      var source: Partial<CalendarSource> = next.sources[s] || {}
      if (source.id === "microsoft:" + accountId) saved = source
      else if (source.kind === "microsoft" && source.discovered === true
          && trimmed(source.accountId) === accountId) discovered = true
    }
    // Discovery names every calendar the account has, the primary one under
    // this id when Graph flags it as the default. When Graph flags none, the
    // primary calendar is already listed under its own id, and synthesizing
    // another entry for it would fetch and draw the same calendar twice.
    if (!saved && discovered) continue
    next = add(next, {
      id: "microsoft:" + accountId,
      kind: "microsoft",
      name: saved && saved.discovered === true && trimmed(saved.name) !== ""
        ? trimmed(saved.name) : trimmed(account.email || account.label || "Microsoft Calendar"),
      accountId: accountId,
      enabled: saved ? saved.enabled !== false : true,
      calendarId: saved ? trimmed(saved.calendarId) : "",
      readOnly: saved && saved.discovered === true ? saved.readOnly === true : false,
      discovered: saved ? saved.discovered === true : false,
      colorKey: saved ? saved.colorKey : Palette.defaultKey("microsoft:" + accountId),
      remindersEnabled: saved ? saved.remindersEnabled : true,
      reminderMinutes: saved ? saved.reminderMinutes : -1,
      preferred: saved ? saved.preferred : false
    })
  }
  return next
}

export function comesWithAccount(source?: SourceLike): boolean {
  return !!source && (source.kind === "google" || source.kind === "microsoft"
    || source.kind === "icloud")
}

export function accountSummary(accountId?: unknown, accountSummaries?: AccountSummary[] | null): AccountSummary | null {
  var wanted = trimmed(accountId)
  var accounts = Array.isArray(accountSummaries) ? accountSummaries : []
  for (var i = 0; i < accounts.length; i++) {
    if (accounts[i] && trimmed(accounts[i].id || accounts[i].email) === wanted)
      return accounts[i]
  }
  return null
}

// A source that came with a mailbox the list of accounts no longer has.
// Removing an account edits the account list and nothing else, so the
// calendars discovered through it stay in calendars.json with nothing to sign
// in as; the settings page offers to remove what it would otherwise only be
// able to hide. A signed-out mailbox is still a mailbox.
export function orphaned(source?: SourceLike, accountSummaries?: AccountSummary[] | null): boolean {
  if (!source || !comesWithAccount(source) || trimmed(source.accountId) === "") return false
  return accountSummary(source.accountId, accountSummaries) === null
}

// The name a calendar error reports its source under. A discovered calendar
// is named the way its provider names it — every Outlook mailbox has a
// "Calendar" — so its mailbox is named with it, where the address alone
// said which account needed attention before discovery.
export function errorLabel(source?: SourceLike, accountSummaries?: AccountSummary[] | null): string {
  if (!source) return "Calendar"
  var name = trimmed(source.name) || trimmed(source.id) || "Calendar"
  if (source.discovered !== true || !comesWithAccount(source)) return name
  var accountId = trimmed(source.accountId)
  if (accountId === "") return name
  var account = accountSummary(accountId, accountSummaries)
  var mailbox = account ? trimmed(account.email || account.label) : ""
  return name + " · " + (mailbox === "" ? accountId : mailbox)
}

export function comparableUrl(value?: unknown): string {
  var text = trimmed(value)
  var parts = /^(https?:\/\/[^/?#]+)([^?#]*)(.*)$/i.exec(text)
  if (!parts) return text
  return parts[1].toLowerCase() + parts[2].replace(/\/+$/, "") + parts[3]
}

export function sameUrl(left?: unknown, right?: unknown): boolean {
  return comparableUrl(left) === comparableUrl(right)
}

// Replace the account-owned part of a source list with one bounded discovery
// result. Saved visibility and theme colors follow a calendar's stable source
// id; a hand-added iCloud CalDAV URL is adopted instead of drawn twice.
export function applyDiscovery(list: SourceList | null | undefined, result?: unknown): SourceList {
  var value = fields(result)
  var provider = trimmed(value.provider).toLowerCase()
  var accountId = trimmed(value.accountId)
  var kind = provider === "microsoft" ? "microsoft"
    : (provider === "icloud" ? "icloud" : (provider === "google" ? "google" : ""))
  if (kind === "" || accountId === "" || !Array.isArray(value.calendars))
    return copyList(list)
  var current: CalendarSource[] = list && Array.isArray(list.sources) ? list.sources : []
  var discovered: CalendarSource[] = []
  for (var i = 0; i < value.calendars.length; i++) {
    var remote = fields(value.calendars[i])
    var id = trimmed(remote.sourceId)
    if (id === "") continue
    var saved: Partial<CalendarSource> | null = null
    for (var s = 0; s < current.length; s++) {
      var candidate: Partial<CalendarSource> = current[s] || {}
      if (trimmed(candidate.id) === id
          || (kind === "icloud" && trimmed(remote.url) !== ""
            && sameUrl(candidate.url, remote.url))) {
        saved = candidate
        break
      }
    }
    var initial = kind === "google" ? remote.selected !== false && remote.hidden !== true : true
    discovered.push(makeSource({
      id: id, kind: kind, name: remote.name,
      accountId: accountId, calendarId: remote.calendarId,
      url: remote.url, username: remote.username,
      enabled: saved ? saved.enabled !== false : initial,
      readOnly: remote.readOnly === true, discovered: true,
      colorKey: saved ? saved.colorKey : Palette.defaultKey(id),
      accessRole: remote.accessRole, timeZone: remote.timeZone,
      canCreateMeet: remote.canCreateMeet, defaultReminders: remote.defaultReminders,
      remindersEnabled: saved ? saved.remindersEnabled : initial,
      reminderMinutes: saved ? saved.reminderMinutes : -1,
      preferred: saved ? saved.preferred : remote.isDefault === true
    }))
  }
  var next = emptyList()
  for (var c = 0; c < current.length; c++) {
    var source: Partial<CalendarSource> = current[c] || {}
    var owned = source.kind === kind && trimmed(source.accountId) === accountId
    var adopted = kind === "icloud" && source.kind === "caldav"
      && discovered.some(function(item) { return sameUrl(item.url, source.url) })
    if (!owned && !adopted) next = add(next, source)
  }
  for (var d = 0; d < discovered.length; d++) next = add(next, discovered[d])
  return next
}

export function forAccount(list: SourceList | null | undefined, accountId?: unknown,
    invitationCalendarId?: string | null): SourceList {
  var source = list || emptyList()
  var wanted = trimmed(accountId)
  if (wanted === "") return copyList(source)
  var next = emptyList()
  var values = Array.isArray(source.sources) ? source.sources : []
  for (var i = 0; i < values.length; i++) {
    if (!values[i]) continue
    if (!comesWithAccount(values[i]) || trimmed(values[i].accountId) === wanted
        || (invitationCalendarId && values[i].id === invitationCalendarId))
      next = add(next, values[i])
  }
  return next
}

// Whether the window should offer a calendar at all. Nothing connected means
// the view is an empty grid that cannot hold an event, since every write needs
// a source. A list that has not been read yet still counts as having one: the
// entry must not vanish and reappear while the file loads. A disabled source
// still counts, because the calendar is where it is turned back on.
export function hasNone(loaded: unknown, list?: SourceList | null): boolean {
  return loaded === true
    && !(list && Array.isArray(list.sources) && list.sources.length > 0)
}

export function providerLabel(kind?: unknown): string {
  var value = trimmed(kind).toLowerCase()
  if (value === "google" || value === "gmail") return "Google"
  if (value === "microsoft" || value === "outlook") return "Microsoft"
  if (value === "icloud") return "iCloud"
  if (value === "hey") return "HEY"
  return "CalDAV"
}

export function groupByAccount(list: SourceList | null | undefined,
    accountSummaries?: AccountSummary[] | null): CalendarGroup[] {
  var values: CalendarSource[] = list && Array.isArray(list.sources) ? list.sources : []
  var accounts = Array.isArray(accountSummaries) ? accountSummaries : []
  var groups: CalendarGroup[] = []
  var assigned: { [id: string]: boolean } = ({})

  function calendarMatches(source: CalendarSource, account: Partial<AccountSummary>): boolean {
    var accountId = trimmed(account.id || account.email).toLowerCase()
    var email = trimmed(account.email).toLowerCase()
    var owner = trimmed(source.accountId).toLowerCase()
    var username = trimmed(source.username).toLowerCase()
    if (owner !== "" && (owner === accountId || owner === email)) return true
    return source.kind === "caldav" && email !== "" && username === email
  }

  for (var a = 0; a < accounts.length; a++) {
    var account: Partial<AccountSummary> = accounts[a] || {}
    var calendars: CalendarSource[] = []
    for (var i = 0; i < values.length; i++) {
      // A missing entry reads as an empty calendar, as it did in the Qt client.
      var source = values[i] || ({} as CalendarSource)
      if (assigned[source.id] || !calendarMatches(source, account)) continue
      calendars.push(source)
      assigned[source.id] = true
    }
    if (calendars.length === 0) continue
    groups.push({
      id: "account:" + trimmed(account.id || account.email),
      providerLabel: providerLabel(calendars[0].kind || account.provider),
      accountLabel: account.provider === "gmail"
        ? trimmed(account.email || account.label || "Google account")
        : trimmed(account.label || account.email || "Account"),
      calendars: calendars
    })
  }

  for (var v = 0; v < values.length; v++) {
    var remaining = values[v] || ({} as CalendarSource)
    if (assigned[remaining.id]) continue
    var ownerKey = trimmed(remaining.accountId || remaining.username)
    if (ownerKey === "") ownerKey = providerLabel(remaining.kind)
    var groupId = "source:" + remaining.kind + ":" + ownerKey.toLowerCase()
    var group: CalendarGroup | null = null
    for (var g = 0; g < groups.length; g++) {
      if (groups[g].id === groupId) { group = groups[g]; break }
    }
    if (!group) {
      group = { id: groupId, providerLabel: providerLabel(remaining.kind),
        accountLabel: ownerKey, calendars: [] }
      groups.push(group)
    }
    group.calendars.push(remaining)
  }
  return groups
}

// A calendar a write can be offered on. A read-only source still draws its
// events; it is not offered as somewhere to put one.
export function writable(source?: SourceLike): boolean {
  return !!source && source.readOnly !== true
}

// The redesigned views are shared; deep integration is currently Google-only.
// Other providers retain their existing basic create/edit/delete paths.
export function nativeCalendarFeatures(source?: SourceLike): boolean {
  return !!source && source.kind === "google"
}

// The picker groups with the read-only calendars left out, and a group left
// empty by that left out too.
export function writableGroups(groups?: CalendarGroup[] | null): CalendarGroup[] {
  var values = Array.isArray(groups) ? groups : []
  var out: CalendarGroup[] = []
  for (var i = 0; i < values.length; i++) {
    var group = values[i] || ({} as CalendarGroup)
    var calendars = (Array.isArray(group.calendars) ? group.calendars : [])
      .filter(function(source) { return writable(source) })
    if (calendars.length === 0) continue
    out.push({ id: group.id, providerLabel: group.providerLabel,
      accountLabel: group.accountLabel, calendars: calendars })
  }
  return out
}

export function calendarEditorUrl(list?: SourceList | null): string {
  var values: Partial<CalendarSource>[] = list && Array.isArray(list.sources) ? list.sources : []
  for (var i = 0; i < values.length; i++) {
    var source: Partial<CalendarSource> = values[i] || {}
    if (source.enabled === false) continue
    if (source.kind === "google")
      return "https://calendar.google.com/calendar/u/0/r/eventedit"
    if (source.kind === "icloud") return "https://www.icloud.com/calendar/"
    if (source.kind === "caldav") {
      var match = /^(https:\/\/[^/]+)/i.exec(String(source.url || ""))
      if (match) return match[1] + "/apps/calendar/"
    }
  }
  return ""
}
