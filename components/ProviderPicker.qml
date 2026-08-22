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
  required property color accentColor
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
        implicitHeight: Math.max(cardText.implicitHeight, cardMark.height) + Style.space(24)
        radius: Style.cornerRadius
        color: card.connectable && hover.hovered
          ? Style.hoverFillFor(root.textColor, root.accentColor)
          : Style.normalFillFor(root.textColor, root.accentColor)
        border.width: 1
        border.color: Style.hoverBorderFor(root.textColor, root.accentColor)
        // Not greyed out with a literal colour — the theme owns those. Reduced
        // opacity says "not available" without inventing a grey that some
        // themes render as ordinary body text.
        opacity: card.connectable ? 1.0 : 0.55

        // The service's own icon, so the row is recognisable before it is read.
        // A provider with no artwork gets an envelope in the theme's colour
        // rather than nothing at all: an empty slot would leave its text
        // hanging out of line with the rows above it, which reads as a fault
        // rather than as "this one has no logo".
        ProviderLogo {
          id: cardMark
          anchors.left: parent.left
          anchors.leftMargin: Style.space(12)
          anchors.verticalCenter: parent.verticalCenter
          size: Style.space(26)
          logo: Provider.mark(card.modelData)
          fallbackIcon: "unread"
          fallbackColor: root.textColor
        }

        Column {
          id: cardText
          anchors.left: cardMark.right
          anchors.leftMargin: Style.space(12)
          anchors.right: parent.right
          anchors.rightMargin: Style.space(12)
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
        }

        TapHandler {
          enabled: card.connectable
          onTapped: root.chosen(card.modelData)
        }
      }
    }
  }
}
