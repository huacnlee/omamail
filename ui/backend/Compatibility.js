.pragma library

function accepts(info, expectedVersion) {
  return !!info && info.protocol === 1
    && typeof expectedVersion === "string" && expectedVersion.length > 0
    && typeof info.version === "string" && info.version === expectedVersion
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
