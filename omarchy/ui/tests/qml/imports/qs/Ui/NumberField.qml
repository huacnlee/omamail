import QtQuick

Item {
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
  signal modified(int value)
}
