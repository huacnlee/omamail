import QtQuick
import qs.Commons

Item {
  property color foreground: Color.foreground
  implicitHeight: Math.max(1, Style.normalBorderWidth)
  Rectangle {
    anchors.fill: parent
    color: Style.normalBorderFor(parent.foreground, Color.accent)
  }
}
