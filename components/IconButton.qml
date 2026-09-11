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
  // Something behind this button wants the owner — an agent's question, a
  // job that finished unseen. A slow pulse of the accent around the glyph,
  // and nothing else changes: the button still says what it always said.
  property bool attention: false
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

  // The pulse: a ring of the accent that breathes while attention is asked
  // for, drawn under the fill so a hover still reads as a hover.
  Rectangle {
    id: halo
    anchors.fill: parent
    anchors.margins: root.visualInset - Style.space(1)
    radius: Style.cornerRadius + Style.space(1)
    color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.18)
    border.width: Style.normalBorderWidth
    border.color: root.accent
    visible: root.attention
    opacity: 0

    SequentialAnimation on opacity {
      running: root.attention
      loops: Animation.Infinite
      NumberAnimation { from: 0.15; to: 1.0; duration: 900; easing.type: Easing.InOutSine }
      NumberAnimation { from: 1.0; to: 0.15; duration: 900; easing.type: Easing.InOutSine }
      onRunningChanged: if (!running) halo.opacity = 0
    }
  }

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
