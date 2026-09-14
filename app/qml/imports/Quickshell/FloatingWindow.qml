import QtQuick
import QtQuick.Controls as QQC
import qs.Commons

QQC.ApplicationWindow {
  property real implicitWidth: 0
  property real implicitHeight: 0
  property size minimumSize: Qt.size(0, 0)
  minimumWidth: minimumSize.width
  minimumHeight: minimumSize.height
  width: implicitWidth > 0 ? implicitWidth : minimumWidth
  height: implicitHeight > 0 ? implicitHeight : minimumHeight
  color: Color.background
}
