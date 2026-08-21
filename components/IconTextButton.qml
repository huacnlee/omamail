import QtQuick
import qs.Commons
import qs.Ui

// A bordered button carrying a drawn icon beside its label.
//
// qs.Ui's Button takes a font glyph for its icon, and this app's icons are
// Canvas paths — a monospace face has no envelope or paper plane that lines up
// with them. This is that button with the glyph slot replaced, using the same
// state fills, border, padding and height as the rest of the kit.
Rectangle {
  id: root

  property string iconName: ""
  property string text: ""
  property string tooltipText: ""
  property color foreground: Color.foreground
  property color accent: Color.accent
  property bool bordered: true
  // Held while this button is the chosen one of a set — the RSVP row, where
  // three buttons stand for three answers and one of them is the answer given.
  // Never the only sign of it: the caller shows a check glyph too, because a
  // theme can put the selected fill close enough to the normal one that
  // colour alone says nothing.
  property bool selected: false
  property string fontFamily: Style.font.family
  property real fontSize: Style.font.bodySmall

  signal clicked()

  readonly property bool hot: mouse.containsMouse && enabled

  implicitWidth: row.implicitWidth + Style.spacing.controlPaddingX * 2
  implicitHeight: Style.spacing.controlHeight
  radius: Style.cornerRadius
  opacity: enabled ? 1.0 : 0.4
  color: mouse.pressed ? Style.pressedFillFor(root.foreground, root.accent)
    : (root.selected ? Style.selectedFillFor(root.foreground, root.accent)
      : (hot ? Style.hoverFillFor(root.foreground, root.accent)
        : (bordered ? Style.normalFillFor(root.foreground, root.accent) : "transparent")))
  border.width: bordered || hot || root.selected ? Style.normalBorderWidth : 0
  border.color: hot || root.selected
    ? Style.hoverBorderFor(root.foreground, root.accent)
    : Style.normalBorderFor(root.foreground, root.accent)

  Row {
    id: row
    anchors.centerIn: parent
    spacing: Style.spacing.md

    ActionIcon {
      anchors.verticalCenter: parent.verticalCenter
      visible: root.iconName !== ""
      name: root.iconName
      iconSize: Style.font.iconSmall
      color: root.foreground
    }

    Text {
      anchors.verticalCenter: parent.verticalCenter
      visible: root.text !== ""
      text: root.text
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize
    }
  }

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: root.clicked()
  }

  PanelToolTip {
    visible: root.tooltipText !== "" && mouse.containsMouse
    text: root.tooltipText
    fontFamily: root.fontFamily
  }
}
