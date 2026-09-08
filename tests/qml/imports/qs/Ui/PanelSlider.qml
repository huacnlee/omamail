import QtQuick

Item {
  property real value: 0
  property real minimum: 0
  property real maximum: 1
  property real step: 0.05
  property bool integer: false
  property color trackColor: "transparent"
  property color fillColor: "transparent"
  property color knobColor: "transparent"
  property color tickColor: "transparent"
  property int tickCount: 0
  property bool dragging: false
  property real liveValue: value
  signal moved(real value)
  signal released(real value)
  implicitWidth: 200
  implicitHeight: 24
}
