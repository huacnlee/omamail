import QtQuick
import qs.Commons
import qs.Ui
import "../components"
import "../message/Direction.js" as Direction

Column {
  id: root
  required property var messages
  required property var events
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color dimColor
  required property string panelFontFamily
  // The same setting the window reads. A subject that lands on the right edge
  // in the list and on the left one here would be the setting half-applied.
  property string contentDirection: Direction.MODE_DEFAULT
  // Only a chosen direction reaches the lines that are not subjects: Qt already
  // resolves a sender's name and a date from their own text.
  readonly property var textAlignment: alignmentFor(Direction.forced(root.contentDirection))

  function alignmentFor(direction) {
    if (!Direction.hasAnswer(direction)) return undefined
    return Direction.isRightToLeft(direction) ? Text.AlignRight : Text.AlignLeft
  }

  width: Style.space(360)
  spacing: Style.space(5)

  signal messageRequested(string accountId, string messageId)
  signal callRequested(string url)
  signal eventRequested(var eventData)

  Text {
    text: "LATEST MAIL"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.bold: true
    textFormat: Text.PlainText
  }

  Repeater {
    model: root.messages
    delegate: Rectangle {
      id: mailRow
      required property var modelData
      width: root.width
      height: Style.space(66)
      radius: Style.cornerRadius
      color: mailMouse.containsMouse
        ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent"

      Column {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: Style.space(8)
        anchors.rightMargin: Style.space(8)
        spacing: Style.space(2)
        Text {
          width: parent.width
          text: mailRow.modelData.subject || "(no subject)"
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: mailRow.modelData.unread === true
          elide: Text.ElideRight
          textFormat: Text.PlainText
          // The reply prefix in front of a subject is Latin whatever the thread
          // is written in, so the subject is asked on its own account here too.
          horizontalAlignment: root.alignmentFor(Direction.resolveSubject(
            mailRow.modelData.subject, root.contentDirection))
        }
        Text {
          width: parent.width
          text: (mailRow.modelData.from ? mailRow.modelData.from.display : "")
            + "  ·  " + mailRow.modelData.sourceLabel
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          textFormat: Text.PlainText
          horizontalAlignment: root.textAlignment
        }
        Text {
          width: parent.width
          text: mailRow.modelData.receivedLabel || ""
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          textFormat: Text.PlainText
          horizontalAlignment: root.textAlignment
        }
      }
      MouseArea {
        id: mailMouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.messageRequested(
          String(mailRow.modelData.accountId || ""), String(mailRow.modelData.id || ""))
      }
    }
  }

  Text {
    visible: root.messages.length === 0
    text: "No unread messages"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    textFormat: Text.PlainText
  }

  Rectangle {
    width: root.width
    height: 1
    color: Style.normalBorderFor(root.textColor, root.accentColor)
  }

  Text {
    text: "UP NEXT"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.bold: true
    textFormat: Text.PlainText
  }

  Repeater {
    model: root.events
    delegate: Rectangle {
      id: eventRow
      required property var modelData
      width: root.width
      height: Style.space(58)
      radius: Style.cornerRadius
      color: callMouse.containsMouse
        ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent"
      border.width: 1
      border.color: Style.normalBorderFor(root.textColor, root.accentColor)

      Column {
        anchors.left: parent.left
        anchors.right: callIcon.visible ? callIcon.left : parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: Style.space(8)
        anchors.rightMargin: Style.space(8)
        spacing: Style.space(2)
        Text {
          width: parent.width
          text: eventRow.modelData.summary || "Untitled event"
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: true
          elide: Text.ElideRight
          textFormat: Text.PlainText
        }
        Text {
          width: parent.width
          text: new Date(eventRow.modelData.start.ms).toLocaleString(
            Qt.locale(), "MMM d · ddd HH:mm")
            + "  ·  " + eventRow.modelData.sourceLabel
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          textFormat: Text.PlainText
        }
      }

      ActionIcon {
        id: callIcon
        visible: eventRow.modelData.callUrl !== ""
        anchors.right: parent.right
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        name: "video"
        color: root.accentColor
        iconSize: Style.font.icon
      }
      MouseArea {
        id: callMouse
        anchors.fill: parent
        enabled: true
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: {
          if (eventRow.modelData.callUrl !== "") root.callRequested(eventRow.modelData.callUrl)
          else root.eventRequested(eventRow.modelData)
        }
      }
    }
  }

  Text {
    visible: root.events.length === 0
    text: "No events in the next 31 days"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    textFormat: Text.PlainText
  }

}
