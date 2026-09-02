import QtQuick
import qs.Commons
import qs.Ui

// A drawn icon on the kit's shared hover/cursor surface. qs.Ui's
// PanelActionButton takes a font glyph, and this app's icons are Canvas paths,
// so this is that button with the glyph swapped for an ActionIcon.
Item {
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
  // Working on the thing the button asks for — checking for mail, say. The
  // glyph turns while it is, and stays at full strength: a button that only
  // went dim said "you cannot" when the truth was "already doing it".
  property bool busy: false
  property real iconSize: Style.font.icon
  property real size: Math.max(Style.space(24), iconSize + Style.spacing.sm * 2)
  property real visualInset: Style.space(2)
  property string fontFamily: Style.font.family

  signal clicked()

  readonly property bool hot: (mouse.containsMouse || hasCursor) && enabled

  implicitWidth: size
  implicitHeight: size
  width: size
  height: size
  opacity: enabled || busy ? 1.0 : 0.4

  Rectangle {
    anchors.fill: parent
    anchors.margins: root.visualInset
    radius: Style.cornerRadius
    color: mouse.pressed ? Style.pressedFillFor(root.foreground, root.accent)
      : (root.selected ? Style.selectedFillFor(root.foreground, root.accent)
        : (root.hot ? Style.hoverFillFor(root.foreground, root.accent) : "transparent"))
  }

  ActionIcon {
    id: glyph
    anchors.centerIn: parent
    name: root.iconName
    iconSize: root.iconSize
    color: root.hot || root.selected ? root.hoverColor : root.foreground
    filled: root.filled

    // A full turn a second, and back to upright the moment the work ends so
    // the glyph never rests at a tilt.
    RotationAnimation on rotation {
      running: root.busy
      loops: Animation.Infinite
      from: 0
      to: 360
      duration: 1000
      onRunningChanged: if (!running) glyph.rotation = 0
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
