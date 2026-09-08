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
  // A `MouseArea` rather than a `TapHandler`, and the difference is what the
  // press does to everything under it. A handler takes a passive grab and
  // leaves the press to carry on down the stack, so a row in a menu drawn over
  // the rail chose from the menu *and* activated the rail row beneath it in the
  // same click. A `MouseArea` grabs exclusively, which ends the press here.
  MouseArea {
    anchors.fill: parent
    onClicked: root.activated()
  }
}
