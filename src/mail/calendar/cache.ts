// A line-for-line port of omarchy/ui/calendar/Cache.js, typed with the
// shapes in types.ts; its behavior is unchanged from the Qt client's, and the
// tests next to it are the Qt tests ported. The cache file is read back as
// untrusted: a range's fields stay `unknown` until a rule checks them.
import type { CalendarCacheRange, CalendarCacheStore, CalendarEvent, JsonObject } from "./types";
// Version 2 added the Google item id required by update and delete; version 3
// adds the original CalDAV resource required to preserve fields during PUT.
// Older ranges cannot recover either value, so they are fetched again instead
// of restoring rows that are unwritable or unsafe to edit.
export var VERSION = 3
export var MAX_RANGES = 8
export var MAX_EVENTS = 2500

export function emptyStore(): CalendarCacheStore {
  return { version: VERSION, ranges: {} }
}

export function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function load(text?: unknown): CalendarCacheStore {
  var raw: unknown = null
  try { raw = JSON.parse(String(text || "")) } catch (e) {}
  if (!isObject(raw) || Number(raw.version) !== VERSION || !isObject(raw.ranges))
    return emptyStore()
  // Each range is still unchecked; its fields are read as `unknown`.
  return { version: VERSION, ranges: raw.ranges as { [key: string]: CalendarCacheRange } }
}

export function serialize(store?: CalendarCacheStore | null): string {
  return JSON.stringify(store || emptyStore())
}

export function rangeKey(scope: string | null | undefined, startMs: number, endMs: number): string {
  return String(scope || "") + "\n" + Math.floor(Number(startMs) || 0)
    + ":" + Math.floor(Number(endMs) || 0)
}

export function eventsFor(store: CalendarCacheStore | null | undefined, scope: string | null | undefined,
    startMs: number, endMs: number, enabledSourceIds?: string[] | null): CalendarEvent[] {
  var source = store && store.ranges ? store.ranges[rangeKey(scope, startMs, endMs)] : null
  if (!source && store && store.ranges) {
    var candidates = Object.keys(store.ranges).filter(function(key) {
      var range = store.ranges[key]
      return key.indexOf(String(scope || "") + "\n") === 0
        && Number(range.startMs) < Number(endMs) && Number(range.endMs) > Number(startMs)
    })
    candidates.sort(function(a, b) { return Number(store.ranges[b].at) - Number(store.ranges[a].at) })
    if (candidates.length) source = store.ranges[candidates[0]]
  }
  var values: unknown[] = source && Array.isArray(source.events) ? source.events : []
  var enabled: { [id: string]: boolean } = {}
  var ids = Array.isArray(enabledSourceIds) ? enabledSourceIds : []
  for (var i = 0; i < ids.length; i++) enabled[String(ids[i])] = true
  var out: CalendarEvent[] = []
  for (var j = 0; j < values.length; j++) {
    // A cached event is read back as it was written; only these fields are checked.
    var event = values[j] as CalendarEvent | null | undefined
    if (event && enabled[String(event.sourceId || "")]
        && (!event.start || Number(event.start.ms) < Number(endMs))
        && (!event.end || Number(event.end.ms) > Number(startMs))) out.push(event)
  }
  return out
}

export function putRange(store: CalendarCacheStore | null | undefined, scope: string | null | undefined,
    startMs: number, endMs: number, events?: CalendarEvent[] | null, nowMs?: number,
    refreshedSourceIds?: string[] | null): CalendarCacheStore {
  var source: { [key: string]: CalendarCacheRange } = store && isObject(store.ranges) ? store.ranges : {}
  var ranges: { [key: string]: CalendarCacheRange } = {}
  for (var key in source) ranges[key] = source[key]
  var kept: CalendarEvent[] = Array.isArray(events) ? events.slice() : []
  var old = source[rangeKey(scope, startMs, endMs)]
  if (Array.isArray(refreshedSourceIds) && old && Array.isArray(old.events)) {
    kept = kept.concat(old.events.filter(function(event: CalendarEvent | null | undefined) {
      return event && refreshedSourceIds.indexOf(String(event.sourceId || "")) < 0
    }))
  }
  ranges[rangeKey(scope, startMs, endMs)] = {
    startMs: Number(startMs) || 0,
    endMs: Number(endMs) || 0,
    at: Number(nowMs) || 0,
    events: kept.slice(0, MAX_EVENTS)
  }
  var keys = Object.keys(ranges)
  keys.sort(function(a, b) { return Number(ranges[b].at) - Number(ranges[a].at) })
  for (var i = MAX_RANGES; i < keys.length; i++) delete ranges[keys[i]]
  return { version: VERSION, ranges: ranges }
}
