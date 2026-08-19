import QtQuick
import qs.Commons
import qs.Ui

// A drawn icon on the kit's shared hover/cursor surface. qs.Ui's
// PanelActionButton takes a font glyph, and this app's icons are Canvas paths,
// so this is that button with the glyph swapped for an ActionIcon.
Rectangle {
  id: root

  property string iconName: ""
  property string tooltipText: ""
  property color foreground: Color.foreground
  property color hoverColor: foreground
  property color accent: Color.accent
  property bool filled: false
  property bool hasCursor: false
  // Held down for as long as a menu this button opened is on screen. A trigger
  // that looks untouched while its own popup is up leaves the popup looking
  // unattached to anything.
  property bool selected: false
  property real iconSize: Style.font.icon
  property real size: Math.max(Style.space(24), iconSize + Style.spacing.sm * 2)
  property string fontFamily: Style.font.family

  signal clicked()

  readonly property bool hot: (mouse.containsMouse || hasCursor) && enabled

  implicitWidth: size
  implicitHeight: size
  width: size
  height: size
  radius: Style.cornerRadius
  opacity: enabled ? 1.0 : 0.4
  color: mouse.pressed ? Style.pressedFillFor(root.foreground, root.accent)
    : (root.selected ? Style.selectedFillFor(root.foreground, root.accent)
      : (hot ? Style.hoverFillFor(root.foreground, root.accent) : "transparent"))

  ActionIcon {
    anchors.centerIn: parent
    name: root.iconName
    iconSize: root.iconSize
    color: root.hot || root.selected ? root.hoverColor : root.foreground
    filled: root.filled
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
