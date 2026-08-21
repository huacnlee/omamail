import QtQuick
import qs.Commons
import qs.Ui

Rectangle {
  id: root

  required property string text
  required property color textColor
  required property string panelFontFamily
  property color tone: textColor
  property var collection: []
  property int cursorIndex: -1
  readonly property bool selected: collection.indexOf(root) === cursorIndex

  signal activated()

  implicitHeight: Style.spacing.popupRowHeight
  radius: Style.cornerRadius
  opacity: enabled ? 1.0 : 0.4
  color: hover.hovered || selected
    ? Qt.rgba(textColor.r, textColor.g, textColor.b, 0.08)
    : "transparent"

  Text {
    anchors.left: parent.left
    anchors.leftMargin: Style.space(9)
    anchors.right: parent.right
    anchors.rightMargin: Style.space(9)
    anchors.verticalCenter: parent.verticalCenter
    textFormat: Text.PlainText
    text: root.text
    color: root.tone
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    elide: Text.ElideRight
  }

  HoverHandler { id: hover }
  TapHandler { onTapped: root.activated() }
}
