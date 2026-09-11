.pragma library

function decode(raw) {
  var failed = { state: "error", requiredVersion: "", requiredApiVersion: 0, installedVersion: "",
    executable: "", error: "Could not read backend runtime status", development: false, cliInstalled: false }
  var value
  try { value = JSON.parse(raw) } catch (e) { return failed }
  if (!value || ["ready", "missing", "mismatch", "unsupported", "error"].indexOf(value.state) < 0
      || typeof value.requiredVersion !== "string"
      || typeof value.installedVersion !== "string" || typeof value.error !== "string") return failed
  if (value.state === "ready" && (typeof value.requiredApiVersion !== "number"
      || value.requiredApiVersion <= 0 || value.requiredApiVersion > 2147483647
      || Math.floor(value.requiredApiVersion) !== value.requiredApiVersion)) return failed
  if (value.state === "ready" && (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.requiredVersion)
      || value.installedVersion !== value.requiredVersion
      || typeof value.executable !== "string" || value.executable.charAt(0) !== "/"
      || /[\x00-\x1f\x7f]/.test(value.executable))) return failed
  return { state: value.state, requiredVersion: value.requiredVersion,
    requiredApiVersion: value.requiredApiVersion || 0,
    installedVersion: value.installedVersion,
    executable: value.state === "ready" ? value.executable : "",
    error: value.error, development: value.development === true,
    cliInstalled: value.state === "ready" && value.development !== true && value.cliInstalled === true }
}

function canInstall(state, busy, development) {
  return !busy && !development && ["missing", "mismatch", "error"].indexOf(state) >= 0
}
