import QtQuick

Item {
  property string label: ""
  property string value: ""
  property var options: []
  property color foreground: "transparent"
  property color background: "transparent"
  property color popupBorder: "transparent"
  property color accent: "transparent"
  property string fontFamily: ""
  property int rowHeight: 36
  property int popupRowHeight: 36
  property bool showLabel: true
  property bool hasCursor: false
  readonly property bool popupOpen: false

  signal changed(string value)
  signal hovered(bool isHovered)

  implicitWidth: 240
  implicitHeight: rowHeight
}
