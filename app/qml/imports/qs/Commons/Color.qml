pragma Singleton
import QtQuick
import Quickshell
import "Theme.js" as Theme

QtObject {
  id: root

  property var theme: Theme.fallback()
  readonly property bool dark: theme.appearance === "dark"
  readonly property color foreground: theme.foreground
  readonly property color background: theme.background
  readonly property color accent: theme.accent
  readonly property color urgent: theme.urgent
  readonly property color warning: theme.warning
  readonly property color success: theme.success
  readonly property color surface: theme.surface
  readonly property color inset: theme.inset
  readonly property color bright: theme.bright
  readonly property color secondary: theme.secondary
  readonly property color selection: theme.selection
  readonly property color border: theme.border
  readonly property color onAccent: theme.onAccent
  readonly property QtObject popups: QtObject {
    readonly property color background: root.surface
    readonly property color border: root.border
  }

  function reload() {
    var home = Quickshell.env("HOME")
    var store = Quickshell.fileStore
    if (home === "" || !store || typeof store.read !== "function") {
      theme = Theme.fallback()
      return false
    }
    var stateCurrent = home + "/.local/state/omarchy/current"
    var legacyCurrent = home + "/.config/omarchy/current"
    // A stale legacy theme must never replace an invalid current theme. It is
    // consulted only when the state/current entry itself does not exist.
    var rootPath = typeof store.exists === "function" && store.exists(stateCurrent)
      ? stateCurrent : legacyCurrent
    var result = store.read(rootPath + "/theme/colors.toml") || ({})
    theme = result.ok === true ? Theme.resolve(String(result.text || "")) : Theme.fallback()
    return result.ok === true && Theme.parse(String(result.text || "")) !== null
  }

  property Connections quickshellConnections: Connections {
    target: Quickshell
    function onFileStoreChanged() { root.reload() }
    function onNativeHostChanged() { root.reload() }
  }

  Component.onCompleted: reload()
}
