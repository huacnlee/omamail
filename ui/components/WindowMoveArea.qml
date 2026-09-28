import QtQuick

// Keep this below header controls so their pointer handlers win. Empty
// title-bar space delegates movement to the compositor; retaining a QML
// MouseArea grab while moving the native window makes it trail the pointer.
MouseArea {
  id: root
  required property var nativeWindow
  objectName: "app-title-bar-drag-area"
  acceptedButtons: Qt.NoButton
  hoverEnabled: false
  readonly property bool dragsTheWindow: windowMoveHandler.target === null

  DragHandler {
    id: windowMoveHandler
    enabled: root.enabled
    target: null
    dragThreshold: 0
    acceptedButtons: Qt.LeftButton
    onActiveChanged: {
      if (active && root.nativeWindow) root.nativeWindow.startSystemMove()
    }
  }
}
