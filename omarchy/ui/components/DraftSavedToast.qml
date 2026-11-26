import QtQuick
import qs.Commons

Rectangle {
  id: root

  required property string message
  required property color textColor
  required property color accentColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  implicitWidth: content.implicitWidth + Style.space(20)
  implicitHeight: Math.max(content.implicitHeight + Style.space(12), Style.space(42))
  radius: Style.cornerRadius
  color: Qt.rgba(popupBackgroundColor.r, popupBackgroundColor.g,
    popupBackgroundColor.b, 1)
  border.width: Style.normalBorderWidth
  border.color: popupBorderColor

  Row {
    id: content
    anchors.centerIn: parent
    spacing: Style.space(8)

    Rectangle {
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(7)
      height: width
      radius: width / 2
      color: root.accentColor
    }

    Text {
      anchors.verticalCenter: parent.verticalCenter
      text: root.message
      textFormat: Text.PlainText
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
    }
  }
}
