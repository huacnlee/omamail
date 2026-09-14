import QtQuick
import QtQuick.Controls as QQC
import qs.Commons

Item {
  id: root

  property string label: ""
  property int value: 0
  property int from: 0
  property int to: 100
  property int stepSize: 1
  property color foreground: Color.foreground
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  property real fontSize: Style.font.bodySmall
  property real fieldWidth: Style.space(80)
  signal modified(int value)

  onValueChanged: {
    if (spinBox.value !== value) spinBox.value = value
  }

  implicitWidth: labelText.implicitWidth + (label === "" ? 0 : Style.spacing.controlGap)
    + fieldWidth
  implicitHeight: Math.max(labelText.implicitHeight, spinBox.implicitHeight)

  Text {
    id: labelText
    anchors.left: parent.left
    anchors.verticalCenter: parent.verticalCenter
    text: root.label
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: root.fontSize
  }

  QQC.SpinBox {
    id: spinBox
    objectName: "number-field-input"
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    width: root.fieldWidth
    from: root.from
    to: root.to
    stepSize: root.stepSize
    value: root.value
    editable: true
    font.family: root.fontFamily
    font.pixelSize: root.fontSize
    palette.window: Color.background
    palette.windowText: root.foreground
    palette.highlight: root.accent
    onValueModified: {
      root.modified(value)
      value = root.value
    }
  }
}
