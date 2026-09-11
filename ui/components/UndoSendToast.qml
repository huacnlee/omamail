import QtQuick
import qs.Commons
import qs.Ui

Rectangle {
  id: root

  required property int secondsRemaining
  // How many sends are parked. Past one, the countdown is the newest's and
  // Undo says so.
  property int queuedCount: 1
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
      text: root.queuedCount > 1
        ? root.queuedCount + " queued \u00b7 newest in " + root.secondsRemaining + "s"
        : "Sending in " + root.secondsRemaining + "s"
      textFormat: Text.PlainText
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Button {
      objectName: "undo-send-button"
      anchors.verticalCenter: parent.verticalCenter
      text: root.queuedCount > 1 ? "Undo last  Alt+Z" : "Undo  Alt+Z"
      foreground: root.accentColor
      accent: root.accentColor
      bordered: true
      fontFamily: root.panelFontFamily
      fontSize: Style.font.bodySmall
      onClicked: root.undoRequested()
    }
  }
}
