.pragma library

function request(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params }) + "\n"
}

function response(line) {
  var value
  try { value = JSON.parse(line) } catch (error) { return null }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.jsonrpc !== "2.0" || typeof value.id !== "string") return null
  var success = Object.prototype.hasOwnProperty.call(value, "result")
  var failure = Object.prototype.hasOwnProperty.call(value, "error")
  if (success === failure) return null
  if (failure && (!value.error || typeof value.error.code !== "number"
      || typeof value.error.message !== "string")) return null
  return value
}
