import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons as Commons
import qs.Ui

// What remains of the Omarchy plugin once Omamail is its own app: one bar
// entry. When the standalone app is installed it opens it; when it is not,
// it says so and opens the install page. It reads no mail and runs no
// backend. Keeping the plugin id "omamail" lets existing installs update in
// place; the plugin's settings are handed to the app once, for it to import.
BarWidget {
  id: root

  moduleName: "omamail"

  readonly property string helper: Qt.resolvedUrl("omamail-app.sh").toString().replace(/^file:\/\//, "")
  readonly property string installUrl: "https://huacnlee.github.io/omamail/"
  // "" while checking, then "installed" or "missing".
  property string appState: ""
  property bool exported: false

  readonly property color foreground: bar ? bar.barForeground : Commons.Color.foreground

  function check() {
    if (!status.running) status.running = true
  }

  function activate() {
    if (appState === "installed") {
      Quickshell.execDetached([helper, "open"])
      return
    }
    // A fixed address; nothing from settings or the environment goes in it.
    Quickshell.execDetached(["xdg-open", installUrl])
  }

  // The settings the old plugin kept: written once, for the app's first launch.
  function exportSettings() {
    if (exported || !settings) return
    exported = true
    exporter.running = true
  }

  Process {
    id: status
    command: [root.helper, "status"]
    stdout: SplitParser {
      onRead: data => {
        var value = String(data).trim()
        if (value === "installed" || value === "missing") root.appState = value
      }
    }
  }

  Process {
    id: exporter
    command: [root.helper, "export-settings"]
    stdinEnabled: true
    onStarted: {
      write(JSON.stringify({ version: 1, settings: root.settings || {} }))
      stdinEnabled = false
    }
  }

  // An install or removal elsewhere shows up within a minute.
  Timer {
    interval: 60000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.check()
  }

  Component.onCompleted: exportSettings()

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    tooltipText: root.appState === "missing"
      ? "Omamail is now a standalone app. Install Omamail..."
      : root.appState === "installed" ? "Open Omamail" : "Omamail"

    iconComponent: Component {
      Canvas {
        // An envelope; a dot beside it while the app is missing. The
        // tooltip says the same in words.
        implicitWidth: 16
        implicitHeight: 12
        property color ink: root.foreground
        property bool missing: root.appState === "missing"
        onInkChanged: requestPaint()
        onMissingChanged: requestPaint()
        onPaint: {
          var ctx = getContext("2d")
          ctx.reset()
          ctx.strokeStyle = ink
          ctx.lineWidth = 1.2
          ctx.strokeRect(1, 1, 13, 10)
          ctx.beginPath()
          ctx.moveTo(1, 1); ctx.lineTo(7.5, 6.5); ctx.lineTo(14, 1)
          ctx.stroke()
          if (missing) {
            ctx.fillStyle = Commons.Color.accent
            ctx.beginPath()
            ctx.arc(14, 2, 2, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
    }

    onPressed: function(buttonCode) {
      if (buttonCode === Qt.LeftButton) root.activate()
      else root.check()
    }
  }
}
