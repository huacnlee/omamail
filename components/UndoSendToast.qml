import QtQuick
import qs.Commons
import qs.Ui

Rectangle {
  id: root

  required property int secondsRemaining
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  signal undoRequested()

  implicitWidth: content.implicitWidth + Style.space(16)
  implicitHeight: Math.max(content.implicitHeight + Style.space(12), Style.space(42))
  radius: Style.cornerRadius
  color: Qt.rgba(popupBackgroundColor.r, popupBackgroundColor.g,
    popupBackgroundColor.b, 1)
  border.width: Style.normalBorderWidth
  border.color: popupBorderColor

  Row {
    id: content
    anchors.centerIn: parent
    spacing: Style.space(12)

    Text {
      objectName: "undo-send-message"
      anchors.verticalCenter: parent.verticalCenter
      text: "Sending in " + root.secondsRemaining + "s"
      textFormat: Text.PlainText
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Button {
      objectName: "undo-send-button"
      anchors.verticalCenter: parent.verticalCenter
      text: "Undo  z"
      foreground: root.accentColor
      accent: root.accentColor
      bordered: true
      fontFamily: root.panelFontFamily
      fontSize: Style.font.bodySmall
      onClicked: root.undoRequested()
    }
  }
}
