import QtQuick
import Quickshell.Io

// This helper remains usable when the mail backend cannot start. Only error
// envelopes cross stdin; Python allowlists them before writing anything.
Item {
  id: root
  required property string pluginDir
  property var queue: []
  property bool openRequested: false
  readonly property bool busy: openRequested || (worker.running && mode === "open")
  property string mode: ""
  property string payload: ""
  property string previous: ""
  property double previousAt: 0
  property bool timedOut: false
  signal failed(string message)

  function record(method, error) {
    var event = {method: String(method || "").slice(0, 80), error: {
      code: error && typeof error.code === "number" ? error.code : null,
      message: error && typeof error.message === "string" && error.message.length <= 128
        ? error.message : "unknown_error"
    }}
    var encoded = JSON.stringify(event)
    var now = Date.now()
    if (encoded === previous && now - previousAt < 10000) return
    previous = encoded; previousAt = now
    queue = queue.slice(-31).concat([event])
  }
  function open() {
    if (busy) return
    openRequested = true
    pump()
  }
  function pump() {
    if (worker.running) return
    if (queue.length) {
      mode = "record"
      payload = JSON.stringify(queue)
      queue = []
    } else if (openRequested) {
      mode = "open"
      openRequested = false
      payload = ""
    } else return
    worker.command = ["python3", pluginDir + "/scripts/diagnostics.py", mode]
    timedOut = false
    worker.running = true
    deadline.restart()
  }
  function reportFailure(message) {
    var requested = openRequested || mode === "open"
    openRequested = false
    if (requested) failed(message)
    else console.warn("Omamail could not save diagnostic errors.")
  }
  Timer {
    interval: 250
    running: root.queue.length > 0 && !worker.running
    onTriggered: root.pump()
  }
  Timer {
    id: deadline
    interval: 20000
    onTriggered: {
      root.timedOut = true
      worker.running = false
      root.reportFailure("Diagnostics timed out. Try again.")
    }
  }
  Process {
    id: worker
    objectName: "diagnostics-helper"
    stdinEnabled: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onStarted: {
      if (root.mode === "record") write(root.payload + "\n")
      root.payload = ""
    }
    onExited: function(exitCode) {
      deadline.stop()
      root.payload = ""
      if (root.timedOut) return
      if (exitCode !== 0) {
        root.reportFailure("Could not save diagnostics or open the system AI.")
      } else Qt.callLater(root.pump)
    }
  }
}
