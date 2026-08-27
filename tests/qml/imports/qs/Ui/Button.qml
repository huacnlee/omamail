import QtQuick

Rectangle {
  property string text: ""
  // The kit's Button renders one when it is set; a stub only has to accept it,
  // because a property the real component has and this one does not is a
  // component that will not instantiate here and does instantiate in the shell.
  property string tooltipText: ""
  property color foreground: Qt.rgba(1, 1, 1, 1)
  property color accent: Qt.rgba(1, 0.5, 0, 1)
  property color background: "transparent"
  property bool bordered: false
  property bool selected: false
  property bool hasCursor: false
  property bool leftAlign: false
  property bool focusable: false
  property string fontFamily: "monospace"
  property real fontSize: 13
  property real horizontalPadding: 8
  property real verticalPadding: 5
  signal clicked()
  signal hovered(bool isHovered)
  implicitWidth: Math.max(40, label.implicitWidth + horizontalPadding * 2)
  implicitHeight: label.implicitHeight + verticalPadding * 2
  color: background

  Text {
    id: label
    anchors.centerIn: parent
    text: parent.text
    color: parent.foreground
    font.family: parent.fontFamily
    font.pixelSize: parent.fontSize
  }

  MouseArea {
    anchors.fill: parent
    onClicked: parent.clicked()
  }
}
