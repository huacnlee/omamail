import QtQuick
import qs.Commons
import qs.Ui

// The way out of a second-level page.
//
// Reading a message, composing one, and the OAuth setup are all pages the
// window goes *into*, and every one of them needs the same way back in the
// same place. One component so the three cannot drift apart, and so the escape
// is never something that only exists at some window widths.
Item {
  id: root

  required property color textColor
  required property color dimColor
  required property string panelFontFamily
  property string label: "Back"

  signal activated()

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  IconTextButton {
    id: button
    anchors.left: parent.left
    anchors.verticalCenter: parent.verticalCenter
    iconName: "back"
    text: root.label
    bordered: false
    foreground: root.dimColor
    fontFamily: root.panelFontFamily
    fontSize: Style.font.caption
    tooltipText: "Esc"
    onClicked: root.activated()
  }
}
