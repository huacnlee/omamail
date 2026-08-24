.pragma library

var DEFAULT_DELAY_SECONDS = 10
var MAX_DELAY_SECONDS = 60

function normalizeDelay(value) {
  if (value === undefined || value === null || value === "")
    return DEFAULT_DELAY_SECONDS
  var seconds = Number(value)
  if (!isFinite(seconds)) return DEFAULT_DELAY_SECONDS
  return Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.floor(seconds)))
}

function schedule(payload, now, delaySeconds) {
  var delay = normalizeDelay(delaySeconds)
  if (delay === 0) return null
  return ({ payload: payload, dueAt: Number(now) + delay * 1000 })
}

function remainingSeconds(dueAt, now) {
  return Math.max(0, Math.ceil((Number(dueAt) - Number(now)) / 1000))
}
