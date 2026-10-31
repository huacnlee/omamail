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
