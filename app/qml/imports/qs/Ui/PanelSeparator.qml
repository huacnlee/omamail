import QtQuick
import qs.Commons
import qs.Commons as Commons

Item {
  property color foreground: Commons.Color.foreground
  implicitHeight: Math.max(1, Style.normalBorderWidth)
  Rectangle {
    anchors.fill: parent
    color: Style.normalBorderFor(parent.foreground, Commons.Color.accent)
  }
}
