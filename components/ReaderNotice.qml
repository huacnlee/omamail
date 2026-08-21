import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui

// A line above the message saying why it does not look the way the sender
// meant it to, and offering the one thing that would change that.
//
// There are three of these and they stack, which is the reason this is a type
// rather than three near-identical rectangles: they have to be the same height,
// the same fill and the same distance apart, or a message that trips two of
// them looks like a bug rather than like two answers to two questions.
Rectangle {
  id: root

  property string text: ""
  property string actionLabel: ""
  // While the action is in flight. The button says so rather than disappearing,
  // because a control that vanishes under the pointer reads as a misclick.
  property bool busy: false
  property string busyLabel: ""
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property string panelFontFamily

  signal activated()

  implicitHeight: Style.space(30)
  radius: Style.cornerRadius
  color: Style.normalFillFor(root.textColor, root.accentColor)
  border.width: 1
  border.color: Style.normalBorderFor(root.textColor, root.accentColor)

  Text {
    anchors.left: parent.left
    anchors.leftMargin: Style.space(10)
    anchors.right: action.visible ? action.left : parent.right
    anchors.rightMargin: Style.space(6)
    anchors.verticalCenter: parent.verticalCenter
    // A stranger's mail decides when this shows but never what it says, so the
    // string is this app's own — plain text all the same, because the rule
    // that every Text in the reader declares its format has no exceptions
    // worth remembering.
    textFormat: Text.PlainText
    text: root.text
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    elide: Text.ElideRight
  }

  Button {
    id: action
    visible: root.actionLabel !== ""
    enabled: !root.busy
    anchors.right: parent.right
    anchors.rightMargin: Style.space(6)
    anchors.verticalCenter: parent.verticalCenter
    text: root.busy && root.busyLabel !== "" ? root.busyLabel : root.actionLabel
    foreground: root.textColor
    bordered: false
    fontSize: Style.font.caption
    onClicked: root.activated()
  }
}
