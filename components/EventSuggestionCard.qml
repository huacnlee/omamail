import QtQuick
import qs.Commons
import qs.Ui
import "../agent/Agent.js" as Agent

// What the agent found in the message: one row per event — what, when,
// where — with Add and Dismiss. Add opens the calendar's composer with the
// fields filled in; nothing is written from here. Every string on the card
// came out of the agent's answer, which came out of the message, so it is
// drawn as text and only text.
Rectangle {
  id: root

  property var suggestions: []

  required property color textColor
  required property color accentColor
  required property color dimColor
  required property color dimmerColor
  required property string panelFontFamily

  signal addRequested(var suggestion)
  signal dismissRequested(string key)

  readonly property var rows: Array.isArray(suggestions) ? suggestions : []
  visible: rows.length > 0
  implicitHeight: visible ? column.implicitHeight + Style.space(24) : 0
  height: implicitHeight
  radius: Style.cornerRadius
  color: Style.hoverFillFor(root.textColor, root.accentColor)
  border.width: 1
  border.color: root.dimmerColor

  Column {
    id: column
    x: Style.space(14)
    y: Style.space(12)
    width: parent.width - Style.space(28)
    spacing: Style.space(8)

    Row {
      spacing: Style.space(6)
      ActionIcon {
        name: "calendar"
        iconSize: Style.font.icon
        color: root.accentColor
        anchors.verticalCenter: parent.verticalCenter
      }
      Text {
        objectName: "suggestionHeading"
        text: root.rows.length === 1 ? "The agent found an event in this message"
          : "The agent found " + root.rows.length + " events in this message"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        textFormat: Text.PlainText
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    Repeater {
      model: root.rows

      Column {
        required property var modelData
        objectName: "suggestion"
        width: column.width
        spacing: Style.space(2)

        Text {
          objectName: "suggestionTitle"
          width: parent.width
          text: modelData.title
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.body
          font.weight: Font.DemiBold
          elide: Text.ElideRight
          textFormat: Text.PlainText
        }
        Text {
          objectName: "suggestionWhen"
          width: parent.width
          text: Agent.suggestionWhen(modelData, Date.now())
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          textFormat: Text.PlainText
        }
        Text {
          objectName: "suggestionLocation"
          width: parent.width
          visible: String(modelData.location || "") !== ""
          text: modelData.location
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          textFormat: Text.PlainText
        }
        Text {
          objectName: "suggestionNotes"
          width: parent.width
          visible: String(modelData.notes || "") !== ""
          text: modelData.notes
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
          maximumLineCount: 3
          elide: Text.ElideRight
          textFormat: Text.PlainText
        }
        Row {
          spacing: Style.space(8)
          topPadding: Style.space(2)
          IconTextButton {
            objectName: "suggestionAdd"
            iconName: "plus"
            // The composer opens, so the label says so before it is pressed.
            text: "Add to calendar..."
            foreground: root.textColor
            accent: root.accentColor
            fontFamily: root.panelFontFamily
            fontSize: Style.font.caption
            onClicked: root.addRequested(modelData)
          }
          IconTextButton {
            objectName: "suggestionDismiss"
            iconName: "close"
            text: "Dismiss"
            foreground: root.dimColor
            accent: root.accentColor
            fontFamily: root.panelFontFamily
            fontSize: Style.font.caption
            onClicked: root.dismissRequested(String(modelData.key || ""))
          }
        }
      }
    }
  }
}
