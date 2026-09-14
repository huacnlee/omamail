pragma Singleton
import QtQuick
import QtQuick.Controls
import Quickshell
import "Theme.js" as Theme
import "ShellTheme.js" as ShellTheme

QtObject {
  id: root

  property var theme: Theme.fallback()
  property var shellTheme: ShellTheme.resolve("", "")
  property bool hasOmarchyTheme: false
  property var watchedStore: null
  property var watchedPaths: []
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

  function systemAppearance() {
    return Application.styleHints.colorScheme === Qt.Light ? "light" : "dark"
  }

  function applySystemAppearance(appearance) {
    if (hasOmarchyTheme) return false
    theme = Theme.fallback(appearance === "light" ? "light" : "dark")
    return true
  }
  function shellColor(value, fallback) {
    var token = String(value || "").replace(/^\s+|\s+$/g, "")
    var role = token.toLowerCase()
    if (role === "foreground" || role === "text") return foreground
    if (role === "background") return background
    if (role === "accent") return accent
    if (role === "urgent") return urgent
    if (role === "transparent") return Qt.rgba(0, 0, 0, 0)
    return token.charAt(0) === "#" ? token : fallback
  }
  function withAlpha(value, alpha) {
    var amount = Number(alpha)
    if (!isFinite(amount)) amount = 1
    return Qt.rgba(value.r, value.g, value.b, Math.max(0, Math.min(1, amount)))
  }
  readonly property QtObject popups: QtObject {
    readonly property color background: root.withAlpha(
      root.shellColor(root.shellTheme.popups.background, root.surface),
      root.shellTheme.popups["background-alpha"] === undefined
        ? 1 : root.shellTheme.popups["background-alpha"])
    readonly property color text: root.shellColor(root.shellTheme.popups.text, root.foreground)
    readonly property color border: root.withAlpha(
      root.shellColor(root.shellTheme.popups.border, root.border),
      root.shellTheme.popups["border-alpha"] === undefined
        ? 1 : root.shellTheme.popups["border-alpha"])
  }

  function updateWatches(store, paths) {
    var i
    if (watchedStore && typeof watchedStore.watch === "function") {
      for (i = 0; i < watchedPaths.length; i++) watchedStore.watch(watchedPaths[i], false)
    }
    watchedStore = store
    watchedPaths = paths
    if (watchedStore && typeof watchedStore.watch === "function") {
      for (i = 0; i < watchedPaths.length; i++) watchedStore.watch(watchedPaths[i], true)
    }
  }

  function reload() {
    var home = Quickshell.env("HOME")
    var store = Quickshell.fileStore
    if (home === "" || !store || typeof store.read !== "function") {
      updateWatches(null, [])
      hasOmarchyTheme = false
      theme = Theme.fallback(systemAppearance())
      return false
    }
    var stateCurrent = home + "/.local/state/omarchy/current"
    var legacyCurrent = home + "/.config/omarchy/current"
    // A stale legacy theme must never replace an invalid current theme. It is
    // consulted only when the state/current entry itself does not exist.
    var rootPath = typeof store.exists === "function" && store.exists(stateCurrent)
      ? stateCurrent : legacyCurrent
    var colorsPath = rootPath + "/theme/colors.toml"
    var shellPath = rootPath + "/theme/shell.toml"
    var userShellPath = home + "/.config/omarchy/shell.toml"
    var paths = [stateCurrent, legacyCurrent, colorsPath, shellPath, userShellPath]
    var sameWatches = watchedStore === store && watchedPaths.length === paths.length
    for (var i = 0; sameWatches && i < paths.length; i++) sameWatches = watchedPaths[i] === paths[i]
    if (!sameWatches) updateWatches(store, paths)
    var result = store.read(colorsPath) || ({})
    var shellResult = store.read(shellPath) || ({})
    var userShellResult = store.read(userShellPath) || ({})
    var parsedTheme = result.ok === true ? Theme.parse(String(result.text || "")) : null
    var nextTheme = parsedTheme ? Theme.roles(parsedTheme) : Theme.fallback(systemAppearance())
    var nextShellTheme = ShellTheme.resolve(
      shellResult.ok === true ? String(shellResult.text || "") : "",
      userShellResult.ok === true ? String(userShellResult.text || "") : "")
    // Both complete values are prepared before either singleton observes the
    // reload, so no partially parsed shell configuration can leak into UI.
    hasOmarchyTheme = parsedTheme !== null
    theme = nextTheme
    shellTheme = nextShellTheme
    Style.applyShellTheme(nextShellTheme)
    return hasOmarchyTheme
  }

  property Connections storeConnections: Connections {
    target: Quickshell.fileStore
    ignoreUnknownSignals: true
    function onChanged(path) {
      if (root.watchedPaths.indexOf(String(path)) >= 0) root.reload()
    }
  }

  property Connections quickshellConnections: Connections {
    target: Quickshell
    function onFileStoreChanged() { root.reload() }
    function onNativeHostChanged() { root.reload() }
  }

  property Connections styleHintsConnections: Connections {
    target: Application.styleHints
    function onColorSchemeChanged() { root.applySystemAppearance(root.systemAppearance()) }
  }

  Component.onCompleted: reload()
  Component.onDestruction: updateWatches(null, [])
}
