import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui as ShellUi
import "../theme"

// The shell's ToggleSwitch, drawn in the window's own theme.
//
// The switch paints its track and knob on internal children, so no property of
// the base reaches them. The base stays in place for what it owns — the click,
// hover, cursor and keyboard contract, and the `checked` value — and while a
// theme is picked it is drawn at zero opacity, with an equivalent track and
// knob drawn here from the same public state. With Follow Omarchy this is the
// kit's switch unchanged, drawn by the kit.
Item {
  id: root

  property bool checked: false
  property bool busy: false
  // Off when the surrounding row owns the click, as in the kit's own Toggle.
  property bool interactive: true
  property bool hasCursor: false
  property bool cursorRing: root.interactive
  property color foreground: Paint.active ? Paint.foreground : Commons.Color.foreground
  property color accent: Paint.active ? Paint.accent : Commons.Color.accent

  signal toggled()
  signal hovered(bool isHovered)

  readonly property bool hot: base.hot === true || base.hasCursor || base.containsMouse === true
  readonly property bool themed: Paint.active

  // The kit's geometry, read where it exists and derived the same way where the
  // host's control is a simpler one.
  readonly property int trackHeight: base.trackHeight !== undefined
    ? base.trackHeight : Math.max(22, Math.round(Style.spacing.controlHeight * 0.55))
  readonly property int trackWidth: base.trackWidth !== undefined
    ? base.trackWidth : Math.round(trackHeight * 1.9)
  readonly property int knobSize: base.knobSize !== undefined
    ? base.knobSize : Math.max(6, Math.round(trackHeight * 0.72))
  readonly property int knobInset: base.knobInset !== undefined
    ? base.knobInset : Math.max(1, Math.round((trackHeight - knobSize) / 2))
  readonly property int ringPad: base.cursorPad !== undefined ? base.cursorPad : Style.space(6)
  readonly property bool rounded: base.rounded !== undefined ? base.rounded : Style.cornerRadius > 0

  implicitWidth: base.implicitWidth
  implicitHeight: base.implicitHeight

  ShellUi.ToggleSwitch {
    id: base
    anchors.centerIn: parent
    // Not `visible: false`: an invisible item takes no input, and this one is
    // the switch's whole input surface.
    opacity: Paint.active ? 0 : 1
    checked: root.checked
    busy: root.busy
    interactive: root.interactive
    hasCursor: root.hasCursor
    cursorRing: root.cursorRing
    foreground: root.foreground
    accent: root.accent
    onToggled: root.toggled()
    onHovered: function(isHovered) { root.hovered(isHovered) }
  }

  Rectangle {
    id: themedRing
    visible: root.themed && root.cursorRing && root.hot
    anchors.centerIn: parent
    width: root.trackWidth + root.ringPad * 2
    height: root.trackHeight + root.ringPad * 2
    radius: Style.cornerRadius
    color: "transparent"
    border.width: Paint.normalBorderWidth
    border.color: Paint.hoverBorderFor(root.foreground, root.accent)
  }

  Rectangle {
    id: themedTrack
    visible: root.themed
    anchors.centerIn: parent
    width: root.trackWidth
    height: root.trackHeight
    radius: root.rounded ? height / 2 : 0
    color: root.checked
      ? Paint.selectedFillFor(root.foreground, root.accent)
      : Paint.normalFillFor(root.foreground, root.accent)
    border.width: root.checked ? Paint.selectedBorderWidth : Paint.normalBorderWidth
    border.color: root.checked
      ? Paint.selectedBorderFor(root.foreground, root.accent)
      : Paint.normalBorderFor(root.foreground, root.accent)

    Rectangle {
      id: themedKnob
      width: root.knobSize
      height: root.knobSize
      radius: root.rounded ? height / 2 : 0
      x: root.checked ? themedTrack.width - width - root.knobInset : root.knobInset
      anchors.verticalCenter: parent.verticalCenter
      color: root.checked
        ? Paint.selectedStateColor(root.foreground, root.accent)
        : Qt.darker(root.foreground, 1.25)
    }
  }
}
