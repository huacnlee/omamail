import QtQuick
import qs.Commons
import qs.Ui

Item {
  id: root

  required property color lineColor
  implicitHeight: Style.space(7)

  PanelSeparator {
    anchors.verticalCenter: parent.verticalCenter
    width: parent.width
    foreground: root.lineColor
  }
}
