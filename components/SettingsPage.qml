import QtQuick
import qs.Commons
import qs.Ui

// Where mailboxes are managed.
//
// Adding one used to drop the user on the first-run walkthrough, which by then
// had nothing left to ask: the client was connected and an account was already
// signed in, so the page showed a finished setup for the *other* mailbox and
// there was no way forward. Adding a mailbox belongs here, next to the ones
// that already exist, and signing it in happens on its own row rather than by
// sending the window somewhere else.
Column {
  id: root

  required property var service
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property color urgentColor
  required property string panelFontFamily

  signal backRequested()
  signal clientSetupRequested()
  signal addRequested()
  signal editRequested(int index)

  readonly property var accounts: service ? service.accountSummaries : []
  readonly property var auth: service ? service.auth : null

  spacing: Style.space(16)

  BackBar {
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
    onActivated: root.backRequested()
  }

  Text {
    text: "Settings"
    color: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.heading
    font.bold: true
  }

  // ------------------------------------------------------------- mailboxes

  Text {
    text: "MAILBOXES"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Column {
    width: parent.width
    spacing: Style.space(2)

    Repeater {
      model: root.accounts

      Rectangle {
        id: row
        required property var modelData
        required property int index

        width: parent.width
        implicitHeight: Math.max(rowText.implicitHeight, rowActions.implicitHeight)
          + Style.space(16)
        radius: Style.cornerRadius
        color: modelData.active
          ? Style.selectedFillFor(root.textColor, root.accentColor)
          : Style.normalFillFor(root.textColor, root.accentColor)

        Column {
          id: rowText
          anchors.left: parent.left
          anchors.leftMargin: Style.space(12)
          anchors.right: rowActions.left
          anchors.rightMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(2)

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: row.modelData.email !== "" ? row.modelData.email : "New mailbox"
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: row.modelData.active
            elide: Text.ElideMiddle
          }

          Text {
            width: parent.width
            text: {
              if (row.modelData.error !== undefined && row.modelData.error !== "")
                return row.modelData.error
              if (!row.modelData.signedIn) return "Not signed in yet"
              var count = row.modelData.unread
              var unread = count === 0 ? "No unread mail"
                : (count === 1 ? "1 unread message" : count + " unread messages")
              return row.modelData.active ? unread + " · showing now" : unread
            }
            color: row.modelData.error !== undefined && row.modelData.error !== ""
              ? root.urgentColor : root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        Row {
          id: rowActions
          anchors.right: parent.right
          anchors.rightMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(6)

          IconTextButton {
            text: "Edit..."
            foreground: root.textColor
            fontFamily: root.panelFontFamily
            tooltipText: "Edit this mailbox"
            onClicked: root.editRequested(row.index)
          }
        }
      }
    }
  }

  IconTextButton {
    iconName: "plus"
    text: "Add a mailbox"
    foreground: root.textColor
    fontFamily: root.panelFontFamily
    tooltipText: "Sign in to another Gmail account"
    onClicked: root.addRequested()
  }

  PanelSeparator {
    width: parent.width
    foreground: root.textColor
  }

  // ---------------------------------------------------------- oauth client

  Text {
    text: "GOOGLE OAUTH CLIENT"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Item {
    width: parent.width
    implicitHeight: Math.max(clientText.implicitHeight, clientButton.implicitHeight)

    Column {
      id: clientText
      anchors.left: parent.left
      anchors.right: clientButton.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: root.auth && root.auth.credentialsPresent
          ? root.auth.clientDescription : "No client yet"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideMiddle
      }

      Text {
        width: parent.width
        // Every mailbox signs in through this one client, which is why adding
        // an account never asks for another.
        text: "Shared by every mailbox above"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    IconTextButton {
      id: clientButton
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      text: root.auth && root.auth.credentialsPresent ? "Change..." : "Set up..."
      foreground: root.dimColor
      fontFamily: root.panelFontFamily
      onClicked: root.clientSetupRequested()
    }
  }
}
