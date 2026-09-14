import QtQuick
import QtQuick.Controls as QQC
import qs.Commons

Item {
  id: root

  property bool checked: false
  property bool busy: false
  property color foreground: Color.foreground
  property color accent: Color.accent
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
    enabled: !root.busy
    palette.window: Color.background
    palette.windowText: root.foreground
    palette.highlight: root.accent
    onToggled: {
      root.toggled()
      checked = root.checked
    }
  }

  QQC.BusyIndicator {
    anchors.centerIn: parent
    width: parent.height
    height: parent.height
    running: root.busy
    visible: running
    palette.window: Color.background
    palette.windowText: root.foreground
    palette.highlight: root.accent
  }
}
