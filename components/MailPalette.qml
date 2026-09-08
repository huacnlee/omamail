import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "../calendar/Palette.js" as Palette

// Theme-reactive mail roles. Like the weather palette, color is selective:
// neutral/muted structure for large surfaces and the terminal accent only for
// state that deserves attention. Optional `omamail.*` shell.toml roles let a
// theme override the defaults without teaching this view about that theme.
QtObject {
  id: root

  property bool enabled: false
  property color baseBackground: Color.background
  property color baseText: Color.foreground
  property color baseUrgent: Color.urgent
  property var terminalValues: ({})
  readonly property string palettePath: Quickshell.env("HOME")
    + "/.local/state/omarchy/current/theme/colors.toml"

  function role(name, fallbackColor) {
    if (typeof Color.pick !== "function" || typeof Color.flatColor !== "function")
      return fallbackColor
    var configured = Color.pick("omamail." + name, "")
    return configured === "" ? fallbackColor
      : Color.flatColor(configured, fallbackColor)
  }

  function terminal(name, fallbackColor) {
    var value = terminalValues[String(name || "").toLowerCase()]
    return typeof value === "string" && value !== "" ? value : fallbackColor
  }

  function alpha(color, amount) {
    return Qt.rgba(color.r, color.g, color.b, amount)
  }

  readonly property color primary: role("accent", Color.accent)
  readonly property color muted: role("muted",
    typeof Color.muted !== "undefined" ? Color.muted : baseText)
  readonly property color unread: role("unread", terminal("cyan", primary))
  readonly property color starred: role("starred", terminal("yellow", primary))
  readonly property color sent: role("sent", terminal("green", primary))
  readonly property color drafts: role("drafts", terminal("magenta", primary))
  readonly property color labels: role("labels", terminal("orange", starred))
  readonly property color calendar: role("calendar", terminal("green", primary))
  readonly property color danger: role("danger", terminal("red", baseUrgent))

  // Large areas stay close to the terminal background. The accent is reserved
  // for selection, matching the weather plugin's cards instead of washing an
  // entire pane with one saturated hue.
  readonly property color sidebarSurface: enabled
    ? alpha(muted, 0.10) : baseBackground
  readonly property color listSurface: enabled
    ? alpha(unread, 0.03) : baseBackground
  readonly property color readerSurface: enabled
    ? alpha(drafts, 0.018) : baseBackground
  readonly property color selectedSurface: alpha(primary, 0.15)
  readonly property color hoverSurface: alpha(primary, 0.065)
  readonly property color activeText: primary

  property FileView paletteFile: FileView {
    path: root.palettePath
    watchChanges: true
    printErrors: false
    onLoaded: root.terminalValues = Palette.parse(text())
    onFileChanged: reload()
    onLoadFailed: root.terminalValues = ({})
  }
}
