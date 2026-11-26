.pragma library

// One contiguous transfer at a time; limits apply before retaining each chunk.
// UTF-8 scalar boundaries can shorten 64 KiB chunks by up to three bytes,
// so a valid 64 MiB response can require a 1025th chunk.
function accept(state, line) {
  function invalid() { return { error: true, state: null, line: null } }
  if (typeof line !== "string" || line.length >= 1048576) return invalid()
  var value
  try { value = JSON.parse(line) } catch (error) { return invalid() }
  if (!value || value.method !== "transport.chunk")
    return state ? invalid() : { state: null, line: line, value: value }
  var p = value.params
  if (value.jsonrpc !== "2.0" || Object.prototype.hasOwnProperty.call(value, "id")
      || !p || typeof p.transfer !== "string" || !/^[0-9]{1,20}$/.test(p.transfer)
      || !Number.isInteger(p.index) || !Number.isInteger(p.total)
      || p.total < 2 || p.total > 1025 || p.index < 0 || p.index >= p.total
      || !Number.isInteger(p.size) || p.size < 1 || p.size > 67108864
      || typeof p.data !== "string" || p.data.length < 1 || p.data.length > 65536)
    return invalid()
  if (!state) {
    if (p.index !== 0) return invalid()
    state = { transfer: p.transfer, total: p.total, size: p.size,
              next: 0, length: 0, parts: [], started: Date.now() }
  }
  if (state.transfer !== p.transfer || state.total !== p.total || state.size !== p.size
      || state.next !== p.index || state.length + p.data.length > state.size)
    return invalid()
  state.parts.push(p.data)
  state.length += p.data.length
  state.next++
  if (state.next < state.total) return { state: state, line: null }
  if (state.length !== state.size) return invalid()
  return { state: null, line: state.parts.join("") }
}

// Retain the frame's decoded value. A completed transfer needs one additional
// decode of the assembled document; an ordinary response needs none.
function decode(state, line) {
  var accepted = accept(state, line)
  if (accepted.error || accepted.line === null) return accepted
  if (!Object.prototype.hasOwnProperty.call(accepted, "value")) {
    try { accepted.value = JSON.parse(accepted.line) }
    catch (error) { return { error: true, state: null, line: null } }
  }
  return accepted
}
