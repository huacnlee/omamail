.pragma library

function selectable(entry) {
  return !!entry && entry.selectable !== false && entry.visible !== false && entry.enabled !== false
}

function firstSelectable(entries) {
  var values = Array.isArray(entries) ? entries : []
  for (var i = 0; i < values.length; i++) if (selectable(values[i])) return i
  return -1
}

function nextSelectable(entries, current, step) {
  var values = Array.isArray(entries) ? entries : []
  if (values.length === 0) return -1
  var direction = Number(step) < 0 ? -1 : 1
  var at = Math.floor(Number(current))
  if (!isFinite(at) || at < 0 || at >= values.length) at = direction > 0 ? -1 : 0
  for (var i = 0; i < values.length; i++) {
    at = (at + direction + values.length) % values.length
    if (selectable(values[at])) return at
  }
  return -1
}

function position(anchorX, anchorY, width, height, containerWidth, containerHeight) {
  var x = Math.max(0, Math.min(Number(anchorX), Number(containerWidth) - Number(width)))
  var y = Number(anchorY)
  if (y + height > containerHeight) y = y - height
  if (y + height > containerHeight) y = containerHeight - height
  return { x: Math.max(0, x), y: Math.max(0, y) }
}
