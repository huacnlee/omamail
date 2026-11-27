import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland

Item {
  id: root

  signal visibilityReported(bool visible)
  signal showFailed()

  readonly property string helper: decodeURIComponent(String(Qt.resolvedUrl("../../scripts/mail-workspace.py")))
    .replace(/^file:\/\//, "")
  property var pending: []
  property string currentAction: ""
  property string currentTarget: ""
  property bool watchVisibility: false

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (root.watchVisibility && (event.name === "activespecial"
          || event.name === "monitoraddedv2" || event.name === "monitorremoved"))
        root.enqueue("status")
    }
  }

  function enqueue(action, target) {
    if (action === "status" && pending.some(function(next) { return next.action === "status" })) return
    pending = pending.concat([{ action: action, target: target }])
    runNext()
  }

  function runNext() {
    if (currentAction !== "" || pending.length === 0) return
    var next = pending[0]
    pending = pending.slice(1)
    currentAction = next.action
    process.command = ["python3", helper, currentAction]
    currentTarget = next.target || ""
    process.stdinEnabled = currentAction === "link"
    process.running = true
  }

  function hideOnUnload() {
    Quickshell.execDetached(["python3", helper, "hide"])
  }

  Process {
    id: process
    objectName: "mail-workspace-command"
    onStarted: if (root.currentAction === "link") {
      process.write(JSON.stringify(root.currentTarget) + "\n")
      root.currentTarget = ""
    }
    stdout: StdioCollector { id: visibilityOutput; waitForEnd: true }
    onExited: function(exitCode) {
      var action = root.currentAction
      if (exitCode !== 0) {
        console.warn("Omamail workspace action failed:", action)
        if (action === "show" || action === "toggle") root.showFailed()
      } else if (action !== "link") {
        root.visibilityReported(String(visibilityOutput.text || "").trim() === "shown")
      }
      root.currentAction = ""
      Qt.callLater(root.runNext)
    }
  }
}
