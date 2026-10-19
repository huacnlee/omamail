.pragma library

// Version 2 added the Google item id required by update and delete; version 3
// adds the original CalDAV resource required to preserve fields during PUT.
// Older ranges cannot recover either value, so they are fetched again instead
// of restoring rows that are unwritable or unsafe to edit.
var VERSION = 3
var MAX_RANGES = 8
var MAX_EVENTS = 2500

function emptyStore() {
  return { version: VERSION, ranges: {} }
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function load(text) {
  var raw = null
  try { raw = JSON.parse(String(text || "")) } catch (e) {}
  if (!isObject(raw) || Number(raw.version) !== VERSION || !isObject(raw.ranges))
    return emptyStore()
  return { version: VERSION, ranges: raw.ranges }
}

function serialize(store) {
  return JSON.stringify(store || emptyStore())
}

function rangeKey(scope, startMs, endMs) {
  return String(scope || "") + "\n" + Math.floor(Number(startMs) || 0)
    + ":" + Math.floor(Number(endMs) || 0)
}

function eventsFor(store, scope, startMs, endMs, enabledSourceIds) {
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
  var values = source && Array.isArray(source.events) ? source.events : []
  var enabled = {}
  var ids = Array.isArray(enabledSourceIds) ? enabledSourceIds : []
  for (var i = 0; i < ids.length; i++) enabled[String(ids[i])] = true
  var out = []
  for (var j = 0; j < values.length; j++) {
    var event = values[j]
    if (event && enabled[String(event.sourceId || "")]
        && (!event.start || Number(event.start.ms) < Number(endMs))
        && (!event.end || Number(event.end.ms) > Number(startMs))) out.push(event)
  }
  return out
}

function putRange(store, scope, startMs, endMs, events, nowMs, refreshedSourceIds) {
  var source = store && isObject(store.ranges) ? store.ranges : {}
  var ranges = {}
  for (var key in source) ranges[key] = source[key]
  var kept = Array.isArray(events) ? events.slice() : []
  var old = source[rangeKey(scope, startMs, endMs)]
  if (Array.isArray(refreshedSourceIds) && old && Array.isArray(old.events)) {
    kept = kept.concat(old.events.filter(function(event) {
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
