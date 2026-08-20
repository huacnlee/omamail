import QtQuick
import qs.Commons
import qs.Ui
import "../providers/Registry.js" as Provider

// Which kind of mailbox is being added, asked once and before anything else.
//
// It exists because the two setups have nothing in common: one is a Google
// Cloud walkthrough and the other is an address and a password. Guessing from
// the address would be worse than asking — a Gmail address is a legitimate
// IMAP account, and picking the wrong one for the user costs them the whole
// setup before they find out.
//
// A provider with nothing behind it is listed and disabled rather than hidden.
// Somebody looking for HEY should find the answer here, not conclude the app
// forgot about it.
Column {
  id: root

  required property color textColor
  required property color dimColor
  required property string panelFontFamily
  property bool canLeave: false

  signal chosen(string providerId)
  signal backRequested()

  spacing: Style.space(16)

  BackBar {
    visible: root.canLeave
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
    onActivated: root.backRequested()
  }

  Column {
    width: parent.width
    spacing: Style.space(4)

    Text {
      width: parent.width
      text: "Add a mailbox"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.heading
      font.bold: true
    }

    Text {
      width: parent.width
      text: "Which kind?"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }
  }

  Column {
    width: parent.width
    spacing: Style.space(8)

    Repeater {
      model: Provider.ids()

      Rectangle {
        id: card
        required property var modelData

        readonly property bool connectable: Provider.isConnectable(modelData)

        width: root.width
        implicitHeight: cardText.implicitHeight + Style.space(24)
        radius: Style.cornerRadius
        color: card.connectable && hover.hovered
          ? Style.hoverFillFor(root.textColor, Color.accent)
          : Style.normalFillFor(root.textColor, Color.accent)
        border.width: 1
        border.color: Style.hoverBorderFor(root.textColor, Color.accent)
        // Not greyed out with a literal colour — the theme owns those. Reduced
        // opacity says "not available" without inventing a grey that some
        // themes render as ordinary body text.
        opacity: card.connectable ? 1.0 : 0.55

        Column {
          id: cardText
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.margins: Style.space(12)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(3)

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: Provider.badge(card.modelData)
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: true
          }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            // The summary for a provider that works, and the reason for one
            // that does not. Never both, and never a card that says nothing.
            text: card.connectable
              ? Provider.summary(card.modelData)
              : Provider.unavailableReason(card.modelData)
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }

        HoverHandler {
          id: hover
          enabled: card.connectable
          cursorShape: Qt.PointingHandCursor
        }

        TapHandler {
          enabled: card.connectable
          onTapped: root.chosen(card.modelData)
        }
      }
    }
  }
}
