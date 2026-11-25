pragma Singleton
import QtQuick

QtObject {
  property color foreground: Qt.rgba(1, 1, 1, 1)
  readonly property color accent: Qt.rgba(1, 0.5, 0, 1)
  // See-through, the way a glass theme sets it for shell flyouts.
  readonly property QtObject popups: QtObject {
    readonly property color background: Qt.rgba(0.11, 0.11, 0.12, 0.55)
    readonly property color border: Qt.rgba(1, 1, 1, 1)
    readonly property color text: Qt.rgba(1, 1, 1, 1)
  }
}
