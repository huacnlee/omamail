.pragma library

function accepts(info, expectedVersion, expectedApiVersion) {
  return !!info && info.protocol === 1
    && typeof expectedVersion === "string" && expectedVersion.length > 0
    && typeof info.version === "string" && info.version === expectedVersion
    && typeof expectedApiVersion === "number" && expectedApiVersion > 0
    && expectedApiVersion <= 2147483647
    && Math.floor(expectedApiVersion) === expectedApiVersion
    && (info.apiVersion === expectedApiVersion
      || (info.apiVersion === undefined && info.version === "0.9.0" && expectedApiVersion === 1))
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
