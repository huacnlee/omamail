import QtQuick
import QtQuick.Templates as T
import qs.Commons

T.SpinBox {
  id: control

  readonly property color semanticForeground: palette.windowText
  readonly property color semanticAccent: palette.highlight
  readonly property int stepperWidth: Math.max(Style.space(24), height)

  implicitWidth: Style.spacing.numberFieldWidth
  implicitHeight: Math.max(Style.spacing.controlHeight,
    font.pixelSize + Style.spacing.inputPaddingY * 2)
  leftPadding: stepperWidth
  rightPadding: stepperWidth
  topPadding: Style.spacing.inputPaddingY
  bottomPadding: Style.spacing.inputPaddingY

  contentItem: TextInput {
    objectName: "omamail-spinbox-editor"
    text: control.displayText
    font: control.font
    color: control.semanticForeground
    selectionColor: Style.selectionFillFor(control.semanticForeground, control.semanticAccent)
    selectedTextColor: control.semanticForeground
    horizontalAlignment: Qt.AlignHCenter
    verticalAlignment: Qt.AlignVCenter
    readOnly: !control.editable
    validator: control.validator
    inputMethodHints: Qt.ImhFormattedNumbersOnly
  }

  up.indicator: Rectangle {
    objectName: "omamail-spinbox-increment"
    x: control.width - width
    height: control.height
    width: control.stepperWidth
    color: control.up.pressed
      ? Style.pressedFillFor(control.semanticForeground, control.semanticAccent)
      : (control.up.hovered
        ? Style.hoverFillFor(control.semanticForeground, control.semanticAccent)
        : Style.normalFillFor(control.semanticForeground, control.semanticAccent))

    Text {
      anchors.centerIn: parent
      text: "+"
      color: control.semanticForeground
      font: control.font
    }
  }

  down.indicator: Rectangle {
    objectName: "omamail-spinbox-decrement"
    x: 0
    height: control.height
    width: control.stepperWidth
    color: control.down.pressed
      ? Style.pressedFillFor(control.semanticForeground, control.semanticAccent)
      : (control.down.hovered
        ? Style.hoverFillFor(control.semanticForeground, control.semanticAccent)
        : Style.normalFillFor(control.semanticForeground, control.semanticAccent))

    Text {
      anchors.centerIn: parent
      text: "−"
      color: control.semanticForeground
      font: control.font
    }
  }

  background: Rectangle {
    objectName: "omamail-spinbox-background"
    color: control.activeFocus
      ? Style.focusFillFor(control.semanticForeground, control.semanticAccent)
      : Style.normalFillFor(control.semanticForeground, control.semanticAccent)
    radius: Style.cornerRadius
    border.width: control.activeFocus ? Style.focusBorderWidth : Style.normalBorderWidth
    border.color: control.activeFocus
      ? Style.focusBorderFor(control.semanticForeground, control.semanticAccent)
      : Style.normalBorderFor(control.semanticForeground, control.semanticAccent)
  }
}
