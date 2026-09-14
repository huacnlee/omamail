import QtQuick
import QtQuick.Controls as QQC
import qs.Commons

Item {
  id: root

  property QtObject bar: null
  property Component iconComponent: null
  property string tooltipText: ""
  property real slotSize: Style.space(24)
  property real opticalSize: Style.space(20)
  property bool active: false
  property color foreground: Color.foreground
  signal pressed(int button)
  signal wheelMoved(int delta)

  implicitWidth: slotSize
  implicitHeight: slotSize

  Loader {
    anchors.centerIn: parent
    width: root.opticalSize
    height: root.opticalSize
    sourceComponent: root.iconComponent
  }
  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.AllButtons
    onPressed: function(event) { root.pressed(event.button) }
    onWheel: function(event) { root.wheelMoved(event.angleDelta.y) }
  }
  PanelToolTip {
    visible: parent.children[1].containsMouse && root.tooltipText !== ""
    text: root.tooltipText
  }
}
