import QtQuick
import qs.Commons

Item {
  property size minimumSize: Qt.size(0, 0)
  property string title: ""
  property color color: Color.background
  width: parent ? parent.width : implicitWidth
  height: parent ? parent.height : implicitHeight
}
