import QtQuick
import Quickshell
import Quickshell.Io
import "../calendar/Palette.js" as Palette

QtObject {
  id: root

  required property color textColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor

  property var values: ({})
  readonly property var slots: Palette.keys()
  readonly property string palettePath: Quickshell.env("HOME")
    + "/.local/state/omarchy/current/theme/colors.toml"

  function colorFor(key) {
    var normalized = Palette.normalizeKey(key)
    var value = values[normalized]
    if (typeof value === "string" && value !== "") return value
    if (normalized === "red") return root.urgentColor
    if (normalized === "accent") return root.accentColor
    return root.dimColor
  }

  function reload() { paletteFile.reload() }

  onAccentColorChanged: reload()

  property FileView paletteFile: FileView {
    path: root.palettePath
    watchChanges: true
    printErrors: false
    onLoaded: root.values = Palette.parse(text())
    onFileChanged: reload()
    onLoadFailed: root.values = ({})
  }
}
