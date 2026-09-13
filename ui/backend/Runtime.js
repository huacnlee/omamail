.pragma library

function decode(raw) {
  var failed = { state: "error", requiredVersion: "", requiredApiVersion: 0, latestApiVersion: 0,
    unreleasedMethods: [], installedVersion: "",
    executable: "", error: "Could not read backend runtime status", development: false, cliInstalled: false }
  var value
  try { value = JSON.parse(raw) } catch (e) { return failed }
  if (!value || ["ready", "missing", "mismatch", "unsupported", "error"].indexOf(value.state) < 0
      || typeof value.requiredVersion !== "string"
      || typeof value.installedVersion !== "string" || typeof value.error !== "string") return failed
  if (value.state === "ready" && (typeof value.requiredApiVersion !== "number"
      || value.requiredApiVersion <= 0 || value.requiredApiVersion > 2147483647
      || Math.floor(value.requiredApiVersion) !== value.requiredApiVersion)) return failed
  // The step ahead of the pin: what this checkout implements and the pinned
  // binary does not. Absent or malformed means no step — never a guess.
  var latest = value.latestApiVersion
  if (typeof latest !== "number" || Math.floor(latest) !== latest
      || latest < value.requiredApiVersion || latest > value.requiredApiVersion + 1) latest = value.requiredApiVersion
  var unreleased = Array.isArray(value.unreleasedMethods)
    ? value.unreleasedMethods.filter(function(m) { return typeof m === "string" && m !== "" }) : []
  if (latest === value.requiredApiVersion) unreleased = []
  if (value.state === "ready" && (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.requiredVersion)
      || value.installedVersion !== value.requiredVersion
      || typeof value.executable !== "string" || value.executable.charAt(0) !== "/"
      || /[\x00-\x1f\x7f]/.test(value.executable))) return failed
  return { state: value.state, requiredVersion: value.requiredVersion,
    requiredApiVersion: value.requiredApiVersion || 0,
    latestApiVersion: latest || 0, unreleasedMethods: unreleased,
    installedVersion: value.installedVersion,
    executable: value.state === "ready" ? value.executable : "",
    error: value.error, development: value.development === true,
    cliInstalled: value.state === "ready" && value.development !== true && value.cliInstalled === true }
}

function canInstall(state, busy, development) {
  return !busy && !development && ["missing", "mismatch", "error"].indexOf(state) >= 0
}
