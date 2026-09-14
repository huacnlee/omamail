import QtQuick
import QtQuick.Controls.Basic as QQC
import qs.Commons

Rectangle {
  id: root

  property string text: ""
  property string tooltipText: ""
  property color foreground: Color.foreground
  property color accent: Color.accent
  property color background: Style.normalFillFor(foreground, accent)
  property bool bordered: false
  property bool selected: false
  property bool hasCursor: false
  property bool leftAlign: false
  property bool focusable: false
  property string fontFamily: Style.font.family
  property real fontSize: Style.font.bodySmall
  property real horizontalPadding: Style.spacing.controlPaddingX
  property real verticalPadding: Style.spacing.controlPaddingY
  signal clicked()
  signal hovered(bool isHovered)

  implicitWidth: Math.max(Style.space(40), label.implicitWidth + horizontalPadding * 2)
  implicitHeight: label.implicitHeight + verticalPadding * 2
  radius: Style.cornerRadius
  color: control.down ? Style.pressedFillFor(foreground, accent)
    : (selected || hasCursor ? Style.selectedFillFor(foreground, accent)
      : (control.hovered ? Style.hoverFillFor(foreground, accent) : background))
  border.width: bordered ? Style.normalBorderWidth : 0
  border.color: selected || hasCursor
    ? Style.selectedStateColor(foreground, accent)
    : Style.normalBorderFor(foreground, accent)

  Text {
    id: label
    anchors.left: root.leftAlign ? parent.left : undefined
    anchors.leftMargin: root.leftAlign ? root.horizontalPadding : 0
    anchors.horizontalCenter: root.leftAlign ? undefined : parent.horizontalCenter
    anchors.verticalCenter: parent.verticalCenter
    text: root.text
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: root.fontSize
    elide: Text.ElideRight
  }

  QQC.Button {
    id: control
    anchors.fill: parent
    flat: true
    focusPolicy: root.focusable ? Qt.StrongFocus : Qt.NoFocus
    background: Item {}
    contentItem: Item {}
    onClicked: root.clicked()
    onHoveredChanged: root.hovered(hovered)
  }

  PanelToolTip {
    visible: control.hovered && root.tooltipText !== ""
    text: root.tooltipText
    fontFamily: root.fontFamily
  }
}
