import QtQuick
import qs.Commons
import qs.Ui

// The reference sheet behind Ctrl+/. A plain list rather than a dialog because
// it never needs an answer — Esc, Ctrl+/ again, or a click puts it away.
Rectangle {
  id: root

  required property color textColor
  required property color backgroundColor
  required property color dimColor
  required property string panelFontFamily

  signal dismissed()

  readonly property var rows: [
    { keys: "j / k", action: "Move down / up" },
    { keys: "Enter", action: "Open the selected message" },
    { keys: "u", action: "Back to the list" },
    { keys: "e", action: "Archive" },
    { keys: "#", action: "Move to trash" },
    { keys: "s", action: "Star or unstar" },
    { keys: "Shift+I / Shift+U", action: "Mark read / unread" },
    { keys: "r / a / f", action: "Reply, reply all, forward" },
    { keys: "c", action: "Compose" },
    { keys: "Ctrl+Enter", action: "Send" },
    { keys: "/ or Ctrl+K", action: "Search" },
    { keys: "g then i / s / u / t", action: "Inbox, starred, unread, sent" },
    { keys: "Right-click a row", action: "Archive, trash, spam, star" },
    { keys: "Ctrl+= / Ctrl+-", action: "Zoom the message body" },
    { keys: "Ctrl+0", action: "Reset the zoom" },
    { keys: "F5", action: "Check for mail" },
    { keys: "Ctrl+/", action: "Toggle this sheet" },
    { keys: "Esc", action: "Back, or close the window" }
  ]

  color: Qt.rgba(backgroundColor.r, backgroundColor.g, backgroundColor.b, 0.96)

  MouseArea {
    anchors.fill: parent
    onClicked: root.dismissed()
  }

  Column {
    anchors.centerIn: parent
    width: Math.min(parent.width - Style.space(80), Style.space(420))
    spacing: Style.space(6)

    Text {
      text: "Keyboard shortcuts"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.subtitle
      font.bold: true
    }

    Item {
      width: parent.width
      implicitHeight: Style.space(6)
    }

    Repeater {
      model: root.rows

      Item {
        required property var modelData
        width: parent.width
        implicitHeight: Style.space(20)

        Text {
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          width: Style.space(150)
          text: modelData.keys
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        Text {
          anchors.left: parent.left
          anchors.leftMargin: Style.space(155)
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          text: modelData.action
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }
}
