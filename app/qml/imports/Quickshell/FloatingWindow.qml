import QtQuick
import qs.Commons
import qs.Commons as Commons

Item {
  property size minimumSize: Qt.size(0, 0)
  property string title: ""
  property color color: Commons.Color.background
  width: parent ? parent.width : implicitWidth
  height: parent ? parent.height : implicitHeight
}
