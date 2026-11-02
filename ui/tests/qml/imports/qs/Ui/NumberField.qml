import QtQuick
import QtQuick.Controls as QQC

Column {
  id: root

  property string label: ""
  property int value: 0
  property int from: 0
  property int to: 100
  property int stepSize: 1
  property color foreground: "transparent"
  property color accent: "transparent"
  property string fontFamily: "monospace"
  property real fontSize: 13
  property real fieldWidth: 80
  // The shell's NumberField exposes the spin box it composes, and a caller that
  // replaces that box's background needs it to be the same shape here.
  property alias field: spin
  signal modified(int value)

  QQC.SpinBox {
    id: spin
    width: root.fieldWidth
    from: root.from
    to: root.to
    stepSize: root.stepSize
    value: root.value
    editable: true
    onValueModified: root.modified(value)
  }
}
