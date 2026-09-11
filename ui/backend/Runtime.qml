import QtQuick
import Quickshell.Io
import "Runtime.js" as Rules

Item {
  id: root
  required property string pluginDir
  property string developmentExecutable: ""
  state: "checking"
  property string requiredVersion: ""
  property int requiredApiVersion: 0
  property string installedVersion: ""
  property string executable: ""
  property string error: ""
  property bool cliInstalled: false
  readonly property bool development: developmentExecutable !== ""
  readonly property bool busy: operation.running
  readonly property bool canInstall: Rules.canInstall(state, busy, development)
  property string action: ""
  property string response: ""
  property bool received: false
  property bool timedOut: false
  signal validated()

  function refresh() { run("status") }
  function install() { if (canInstall) run("install") }
  function enableCli() { if (!development && !cliInstalled && state === "ready") run("enable-cli") }
  function disableCli() { if (!development && cliInstalled) run("disable-cli") }

  function run(command) {
    if (busy || pluginDir === "") return
    action = command
    response = ""
    received = false
    timedOut = false
    error = ""
    // A local check must not interrupt requests using the validated runtime.
    // Its answer can revoke that validation, but starting the probe cannot.
    if (command === "install" || (command === "status" && state !== "ready")) {
      executable = ""
      state = command === "install" ? "installing" : "checking"
    }
    operation.command = ["python3", pluginDir + "/scripts/backend-runtime.py", command]
    operation.running = true
    deadline.restart()
  }

  function applyResult(result, exitCode) {
    requiredVersion = result.requiredVersion
    requiredApiVersion = result.requiredApiVersion
    installedVersion = result.installedVersion
    executable = exitCode === 0 ? result.executable : ""
    error = result.error
    state = exitCode !== 0 && result.state === "ready" ? "error" : result.state
    cliInstalled = exitCode === 0 && state === "ready" && !development && result.cliInstalled === true
    if (exitCode !== 0 && result.state === "ready")
      error = "Backend runtime operation failed"
    if (state === "ready") validated()
  }

  Component.onCompleted: refresh()

  Timer {
    id: deadline
    interval: root.action === "install" ? 180000 : 15000
    onTriggered: {
      root.timedOut = true
      root.state = "error"
      root.executable = ""
      root.cliInstalled = false
      root.error = "Backend runtime operation timed out. Retry the check."
      operation.running = false
    }
  }
  Process {
    id: operation
    stdout: SplitParser {
      onRead: data => {
        if (root.received || data.length > 16384) {
          root.response = ""
        } else root.response = data
        root.received = true
      }
    }
    onExited: function(exitCode) {
      deadline.stop()
      if (root.timedOut) return
      var result = Rules.decode(root.response)
      if (root.action === "install" && exitCode === 0 && result.state === "ready") {
        Qt.callLater(root.refresh)
        return
      }
      if (root.state === "ready" && result.state === "ready" && exitCode === 0
          && (root.requiredVersion !== result.requiredVersion || root.requiredApiVersion !== result.requiredApiVersion
              || root.executable !== result.executable)) {
        // Let the backend stop before publishing a different validated runtime,
        // so its replacement must perform a new exact-version handshake.
        root.state = "checking"
        root.executable = ""
        Qt.callLater(function() { root.applyResult(result, exitCode) })
      } else {
        root.applyResult(result, exitCode)
      }
    }
  }
}
