import QtQuick
import qs.Commons
import qs.Ui

// One segment of the header's scope line: the account, or the mailbox open in
// it. A ghost control — the text is the state and the fill only appears under
// the pointer or while the popup it opens is up — with a small chevron after
// the name to say it is a list, not a title.
Rectangle {
  id: root

  property string iconName: ""
  property string text: ""
  property string tooltipText: ""
  required property color foreground
  required property color hoverColor
  required property color accent
  property string fontFamily: Style.font.family
  property real fontSize: Style.font.bodySmall
  property real iconSize: Style.font.iconSmall
  // Held for as long as the popup this opens is on screen, so the segment
  // that opened it stays lit — see "Popups and their triggers" in AGENTS.md.
  property bool selected: false
  // The name is elided rather than the header, which has a search field and
  // two buttons to keep on it.
  property real maxTextWidth: Style.space(180)

  signal clicked()

  readonly property bool hot: mouse.containsMouse && enabled
  readonly property color inkColor: hot || selected ? hoverColor : foreground

  implicitWidth: row.implicitWidth + Style.spacing.controlPaddingX * 2
  implicitHeight: Math.max(Style.space(24), iconSize + Style.spacing.sm * 2)
  radius: Style.cornerRadius
  color: mouse.pressed ? Style.pressedFillFor(root.foreground, root.accent)
    : (root.selected ? Style.selectedFillFor(root.foreground, root.accent)
      : (hot ? Style.hoverFillFor(root.foreground, root.accent) : "transparent"))
  border.width: root.selected ? Style.normalBorderWidth : 0
  border.color: Style.hoverBorderFor(root.foreground, root.accent)

  Row {
    id: row
    anchors.centerIn: parent
    spacing: Style.spacing.sm

    ActionIcon {
      anchors.verticalCenter: parent.verticalCenter
      visible: root.iconName !== ""
      name: root.iconName
      iconSize: root.iconSize
      color: root.inkColor
    }

    Text {
      id: label
      anchors.verticalCenter: parent.verticalCenter
      visible: root.text !== ""
      // An account's name and a folder's name are both written by somebody.
      textFormat: Text.PlainText
      text: root.text
      width: Math.min(implicitWidth, root.maxTextWidth)
      elide: Text.ElideRight
      color: root.inkColor
      font.family: root.fontFamily
      font.pixelSize: root.fontSize
    }

    ActionIcon {
      anchors.verticalCenter: parent.verticalCenter
      name: "chevronDown"
      iconSize: Style.font.iconSmall
      color: root.inkColor
      opacity: root.hot || root.selected ? 1.0 : 0.6
    }
  }

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    onClicked: root.clicked()
  }

  PanelToolTip {
    visible: root.tooltipText !== "" && mouse.containsMouse
    text: root.tooltipText
    fontFamily: root.fontFamily
  }
}
