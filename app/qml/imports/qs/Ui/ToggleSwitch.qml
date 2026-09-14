import QtQuick
import QtQuick.Controls.Basic as QQC
import qs.Commons

Item {
  id: root

  property bool checked: false
  property bool busy: false
  property color foreground: Color.foreground
  property color accent: Color.accent
  signal toggled()

  implicitWidth: toggle.implicitWidth
  implicitHeight: toggle.implicitHeight

  QQC.Switch {
    id: toggle
    anchors.centerIn: parent
    checked: root.checked
    enabled: !root.busy
    palette.windowText: root.foreground
    palette.highlight: root.accent
    onToggled: {
      root.checked = checked
      root.toggled()
    }
  }

  QQC.BusyIndicator {
    anchors.centerIn: parent
    width: parent.height
    height: parent.height
    running: root.busy
    visible: running
  }
}
