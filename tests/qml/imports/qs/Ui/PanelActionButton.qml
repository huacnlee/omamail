import QtQuick

Item {
  property string iconText: ""
  property string tooltipText: ""
  property color foreground: "transparent"
  property color hoverColor: foreground
  property string fontFamily: "monospace"
  property real fontSize: 13
  property bool focusable: false
  property bool hasCursor: false
  property bool bordered: false
  signal clicked()
  signal hovered(bool isHovered)
}
