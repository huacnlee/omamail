import QtQuick
import qs.Commons
import qs.Ui

Rectangle {
  id: root

  required property string text
  required property color textColor
  required property string panelFontFamily
  property color tone: textColor
  // A count or key shown at the row's end, such as how many messages the row
  // would change. Empty draws nothing.
  property string suffix: ""
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
    anchors.right: suffixText.visible ? suffixText.left : parent.right
    anchors.rightMargin: suffixText.visible ? Style.space(12) : Style.space(9)
    anchors.verticalCenter: parent.verticalCenter
    textFormat: Text.PlainText
    text: root.text
    color: root.tone
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    elide: Text.ElideRight
  }

  Text {
    id: suffixText
    anchors.right: parent.right
    anchors.rightMargin: Style.space(9)
    anchors.verticalCenter: parent.verticalCenter
    visible: root.suffix !== ""
    textFormat: Text.PlainText
    text: root.suffix
    color: Qt.rgba(root.tone.r, root.tone.g, root.tone.b, 0.6)
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
  }

  HoverHandler { id: hover }
  // The exclusive grab on press, not a passive one: a menu can sit over a
  // message row, whose MouseArea takes the exclusive grab if this does not,
  // and the release then opens the message under the menu instead of
  // running the row that was clicked.
  TapHandler {
    gesturePolicy: TapHandler.ReleaseWithinBounds
    onTapped: root.activated()
  }
}
