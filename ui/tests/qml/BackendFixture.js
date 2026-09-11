.pragma library

// Service owns the backend runtime, so tests exercising App actions must
// provide the same validated-runtime and completed-handshake state as the
// shell does before making those actions available.
function markReady(service) {
  var executable = service.backend.executable
  service.backendRuntime.requiredVersion = "0.0.0"
  service.backendRuntime.executable = executable
  service.backendRuntime.state = "ready"
  service.backend.connected = true
  service.backend.protocolInfo = { protocol: 1, version: "0.0.0" }
}
