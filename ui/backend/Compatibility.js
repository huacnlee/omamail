.pragma library

// The binary must be the pinned version exactly, and speak either the
// released API or the one unreleased step past it: a local build of the
// checkout is the step, and refusing it would leave the step untestable in
// the desktop. Anything else — an older API, two steps, a version off the
// pin — is refused, and `latestApiVersion` counts only as that one step.
function accepts(info, expectedVersion, expectedApiVersion, latestApiVersion) {
  var step = typeof latestApiVersion === "number" && latestApiVersion === expectedApiVersion + 1
    ? latestApiVersion : expectedApiVersion
  return !!info && info.protocol === 1
    && typeof expectedVersion === "string" && expectedVersion.length > 0
    && typeof info.version === "string" && info.version === expectedVersion
    && typeof expectedApiVersion === "number" && expectedApiVersion > 0
    && expectedApiVersion <= 2147483647
    && Math.floor(expectedApiVersion) === expectedApiVersion
    && (info.apiVersion === expectedApiVersion || info.apiVersion === step
      || (info.apiVersion === undefined && info.version === "0.9.0" && expectedApiVersion === 1))
}

// The API the connected binary speaks, as the handshake read it: the
// released 0.9.0 predates the field and is API 1.
function connectedApiVersion(info) {
  if (!info) return 0
  if (info.apiVersion === undefined) return info.version === "0.9.0" ? 1 : 0
  return typeof info.apiVersion === "number" ? info.apiVersion : 0
}

// Whether the checkout implements an API step the connected binary lacks.
// True only with a binary connected: nothing to update until there is one.
function needsUpdate(info, latestApiVersion) {
  var connected = connectedApiVersion(info)
  return connected > 0 && typeof latestApiVersion === "number" && latestApiVersion > connected
}

// A method only the unreleased step has, asked of a binary without it: the
// answer is this error, in the same shape the backend's own refusals take,
// so a caller that forgot to look before asking fails the way it already
// handles — and never a request the old binary would misread.
var NEEDS_UPDATE = "backend_needs_update"
function unreleasedRefusal(method, unreleasedMethods, needsUpdate) {
  if (!needsUpdate) return null
  var list = Array.isArray(unreleasedMethods) ? unreleasedMethods : []
  if (list.indexOf(String(method || "")) < 0) return null
  return { code: -32012, message: NEEDS_UPDATE }
}

function dispatchError(connected, ready, stopping, method, internal) {
  if (!connected) return "Backend unavailable"
  if (stopping && internal === true && method === "system.quit") return null
  if (stopping)
    return "Backend is shutting down"
  if (ready || (internal === true && method === "system.info")) return null
  return "Backend is not ready"
}

function shouldRequestQuit(stopping, pendingCount, quitRequested) {
  return stopping && pendingCount === 0 && !quitRequested
}

function isCleanShutdown(stopping, quitRequested, pendingCount, failed, exitCode) {
  return stopping && quitRequested && pendingCount === 0 && !failed && exitCode === 0
}
