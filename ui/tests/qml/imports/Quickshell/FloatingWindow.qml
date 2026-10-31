import QtQuick

Item {
  signal closed()
  property string title: ""
  property color color: "transparent"
  property size minimumSize: Qt.size(0, 0)
}
