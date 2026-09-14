pragma Singleton
import QtQuick

QtObject {
  id: root

  readonly property SystemPalette palette: SystemPalette {
    colorGroup: SystemPalette.Active
  }
  readonly property bool dark: Qt.styleHints.colorScheme === Qt.Dark
  readonly property color foreground: palette.windowText
  readonly property color background: palette.window
  readonly property color accent: palette.highlight
  readonly property color urgent: Qt.lighter(palette.highlight, dark ? 1.25 : 0.85)
  readonly property QtObject popups: QtObject {
    readonly property color background: root.palette.base
    readonly property color border: root.palette.mid
  }
}
