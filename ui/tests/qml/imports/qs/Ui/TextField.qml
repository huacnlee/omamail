import QtQuick
import QtQuick.Controls as QQC

QQC.TextField {
  property bool password: false
  property color foreground: Qt.rgba(1, 1, 1, 1)
  property color accent: Qt.rgba(1, 0.5, 0, 1)
  property real verticalPadding: 5
  color: foreground
  topPadding: verticalPadding
  bottomPadding: verticalPadding
}
