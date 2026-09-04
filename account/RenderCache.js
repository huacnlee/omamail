.pragma library

// A small process-local cache of parsed message bodies. The disk cache keeps
// the sender's source so sanitizer fixes apply after a restart; this only
// avoids doing the same work again while the account object is alive.

function create(limit) {
  return {
    limit: Math.max(0, Math.floor(Number(limit) || 0)),
    values: {},
    order: []
  }
}

function keyOf(id) {
  return "$" + String(id || "")
}

function removeFromOrder(cache, key) {
  for (var i = 0; i < cache.order.length; i++) {
    if (cache.order[i] !== key) continue
    cache.order.splice(i, 1)
    return
  }
}

function get(cache, id, source, withPlainText) {
  if (!cache || cache.limit < 1) return null
  var key = keyOf(id)
  var entry = cache.values[key]
  if (!entry || entry.source !== String(source || "")
    || entry.withPlainText !== (withPlainText === true)) return null
  removeFromOrder(cache, key)
  cache.order.push(key)
  return entry.value
}

function put(cache, id, source, withPlainText, value) {
  if (!cache || cache.limit < 1 || String(id || "") === "" || !value) return
  var key = keyOf(id)
  removeFromOrder(cache, key)
  cache.values[key] = {
    source: String(source || ""),
    withPlainText: withPlainText === true,
    value: value
  }
  cache.order.push(key)
  while (cache.order.length > cache.limit) {
    var oldest = cache.order.shift()
    delete cache.values[oldest]
  }
}
