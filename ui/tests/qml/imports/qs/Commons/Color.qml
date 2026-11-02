pragma Singleton
import QtQuick

QtObject {
  // The desktop's palette. Distinctive values, so a test can tell a colour the
  // window drew from its own theme from one it took from the desktop.
  property color foreground: Qt.rgba(1, 1, 1, 1)
  property color background: Qt.rgba(0, 0, 0, 1)
  property color accent: Qt.rgba(1, 0.5, 0, 1)
  property color urgent: Qt.rgba(0.8, 0.2, 0.2, 1)
  property color muted: Qt.rgba(0.5, 0.5, 0.5, 1)

  readonly property QtObject popups: QtObject {
    readonly property color background: Qt.rgba(0.06, 0.06, 0.06, 1)
    readonly property color text: Qt.rgba(0.93, 0.93, 0.93, 1)
    readonly property color border: Qt.rgba(0.27, 0.27, 0.27, 1)
  }
  readonly property QtObject tooltip: QtObject {
    readonly property color background: Qt.rgba(0.06, 0.06, 0.06, 0.97)
    readonly property color text: Qt.rgba(0.93, 0.93, 0.93, 1)
    readonly property color border: Qt.rgba(0.93, 0.93, 0.93, 1)
  }
}
