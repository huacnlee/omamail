import QtQuick
import QtQuick.Templates as T
import qs.Commons

T.Switch {
  id: control

  readonly property int trackHeight: Math.max(22,
    Math.round(Style.spacing.controlHeight * 0.55))
  readonly property int trackWidth: Math.round(trackHeight * 1.9)
  readonly property int knobSize: Math.max(6, Math.round(trackHeight * 0.72))
  readonly property int knobInset: Math.max(1, Math.round((trackHeight - knobSize) / 2))
  readonly property color semanticForeground: palette.windowText
  readonly property color semanticAccent: palette.highlight

  implicitWidth: trackWidth
  implicitHeight: trackHeight
  padding: 0

  indicator: Rectangle {
    id: track
    anchors.fill: parent
    color: control.checked
      ? Style.selectedFillFor(control.semanticForeground, control.semanticAccent)
      : Style.normalFillFor(control.semanticForeground, control.semanticAccent)
    radius: Style.cornerRadius > 0 ? height / 2 : 0
    border.width: control.activeFocus ? Style.focusBorderWidth : Style.normalBorderWidth
    border.color: control.activeFocus
      ? Style.focusBorderFor(control.semanticForeground, control.semanticAccent)
      : (control.checked
        ? Style.selectedBorderFor(control.semanticForeground, control.semanticAccent)
        : Style.normalBorderFor(control.semanticForeground, control.semanticAccent))

    Rectangle {
      objectName: "omamail-switch-knob"
      width: control.knobSize
      height: control.knobSize
      anchors.verticalCenter: parent.verticalCenter
      x: control.checked ? track.width - width - control.knobInset : control.knobInset
      radius: Style.cornerRadius > 0 ? height / 2 : 0
      color: control.checked
        ? Style.selectedStateColor(control.semanticForeground, control.semanticAccent)
        : Style.mutedColorFor(control.semanticForeground, control.palette.window)

      Behavior on x { NumberAnimation { duration: 120; easing.type: Easing.OutCubic } }
      Behavior on color { ColorAnimation { duration: 120 } }
    }

    Behavior on color { ColorAnimation { duration: 120 } }
  }

  contentItem: Item {}
}
