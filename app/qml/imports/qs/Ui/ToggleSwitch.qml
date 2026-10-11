import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Commons as Commons

Item {
  id: root

  property bool checked: false
  property bool busy: false
  property bool interactive: true
  property bool cursorRing: false
  property bool hasCursor: false
  property color foreground: Commons.Color.foreground
  property color accent: Commons.Color.accent
  signal toggled()

  onCheckedChanged: {
    if (toggle.checked !== checked) toggle.checked = checked
  }

  implicitWidth: toggle.implicitWidth
  implicitHeight: toggle.implicitHeight

  QQC.Switch {
    id: toggle
    objectName: "toggle-switch-input"
    anchors.centerIn: parent
    checked: root.checked
    enabled: root.interactive && !root.busy
    focusPolicy: root.interactive ? Qt.StrongFocus : Qt.NoFocus
    palette.window: Commons.Color.background
    palette.windowText: root.foreground
    palette.highlight: root.accent
    onToggled: {
      root.toggled()
      checked = root.checked
    }
  }

  Rectangle {
    objectName: "toggle-switch-cursor-ring"
    anchors.fill: toggle
    radius: Style.cornerRadius
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0)
    border.width: Style.focusBorderWidth
    border.color: Style.focusBorderFor(root.foreground, root.accent)
    visible: root.cursorRing && root.hasCursor
  }

  QQC.BusyIndicator {
    anchors.centerIn: parent
    width: parent.height
    height: parent.height
    running: root.busy
    visible: running
    palette.window: Commons.Color.background
    palette.windowText: root.foreground
    palette.highlight: root.accent
  }
}
