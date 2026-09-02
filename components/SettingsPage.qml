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
  required property var calendarController
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
  // A separate list on purpose: accountSummaries carries live mailbox state and
  // is replaced on a poll, which would rebuild the field being typed in.
  readonly property var signatureAccounts: service ? service.accountSignatures : []
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

  // --------------------------------------------------------------- reading

  Text {
    text: "READING"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(imagesText.implicitHeight, imagesSwitch.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: imagesText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: imagesSwitch.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "Always show remote images"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        // The cost, in the words of what it actually tells whom. Off, the
        // reader asks about each message and the answer covers that one.
        text: "Loading an image tells its host that this address opened the "
          + "message, and when"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    ToggleSwitch {
      id: imagesSwitch
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      checked: !!root.service && root.service.alwaysShowImages
      foreground: root.textColor
      accent: root.accentColor
      onToggled: if (root.service) root.service.setAlwaysShowImages(!root.service.alwaysShowImages)
    }
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(heavyText.implicitHeight, heavySwitch.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: heavyText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: heavySwitch.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "Always render heavy messages"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        text: "Renders without falling back first; layout can stall the shell while it works"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    ToggleSwitch {
      id: heavySwitch
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      checked: !!root.service && root.service.alwaysRenderHeavyMessages
      foreground: root.textColor
      accent: root.accentColor
      onToggled: if (root.service)
        root.service.setAlwaysRenderHeavyMessages(!root.service.alwaysRenderHeavyMessages)
    }
  }

  // --------------------------------------------------------------- writing

  Text {
    text: "WRITING"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(undoText.implicitHeight, undoSeconds.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: undoText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: undoSeconds.left
      anchors.rightMargin: Style.space(16)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "Undo send window"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        text: "Omamail waits before delivery. Press Alt+Z or select Undo to cancel. Set 0 to send now."
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    NumberField {
      id: undoSeconds
      anchors.right: parent.right
      anchors.rightMargin: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      label: "Seconds"
      from: 0
      to: 60
      stepSize: 1
      value: root.service ? root.service.undoSendSeconds : 10
      foreground: root.textColor
      accent: root.accentColor
      fontFamily: root.panelFontFamily
      fontSize: Style.font.bodySmall
      onModified: function(next) {
        if (root.service) root.service.setUndoSendSeconds(next)
      }
    }
  }

  // A signature signs a mailbox, not a window, so there is one field per
  // account. With a single account that is simply the field — the address
  // above it appears only once there is a second one to tell it apart from.
  Column {
    objectName: "settings-signature-section"
    width: parent.width
    spacing: Style.space(2)
    // The heading and the note below belong to the fields. With no mailbox
    // signed in there are none, and first run would otherwise show an
    // explanation with nothing between it and the heading.
    visible: root.signatureAccounts.length > 0

    Text {
      text: "Signature"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      bottomPadding: Style.space(4)
    }

    Repeater {
      model: root.signatureAccounts

      Column {
        id: signatureRow
        required property var modelData

        width: parent.width
        spacing: Style.space(2)

        Text {
          visible: root.signatureAccounts.length > 1
          width: parent.width
          textFormat: Text.PlainText
          text: signatureRow.modelData.email
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        Rectangle {
          width: parent.width
          implicitHeight: Math.max(signatureEdit.implicitHeight, Style.space(56))
            + Style.space(20)
          radius: Style.cornerRadius
          color: Style.normalFillFor(root.textColor, root.accentColor)

          TextEdit {
            id: signatureEdit
            objectName: "settings-signature-editor"
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: Style.space(10)
            activeFocusOnTab: true
            selectByMouse: true
            wrapMode: TextEdit.Wrap
            textFormat: TextEdit.PlainText
            color: root.textColor
            selectionColor: Style.selectionFillFor(root.textColor, root.accentColor)
            selectedTextColor: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall

            // Filled once from the row this Repeater built, never bound to it.
            // Saving rewrites the account list, which rebuilds these rows: a
            // binding would then reassign the text under the cursor.
            Component.onCompleted: text = String(signatureRow.modelData.signature || "")

            // Saved when the field is done with rather than on every keystroke,
            // for the same reason. By the time the rows are rebuilt the stored
            // text is what is already on screen, so nothing moves.
            onActiveFocusChanged: if (!activeFocus) signatureRow.save()
            Component.onDestruction: signatureRow.save()
          }

          Text {
            anchors.left: signatureEdit.left
            anchors.top: signatureEdit.top
            visible: signatureEdit.text === ""
            text: "No signature"
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }

        function save() {
          if (root.service)
            root.service.setAccountSignature(signatureRow.modelData.id, signatureEdit.text)
        }
      }
    }

    Text {
      width: parent.width
      text: "Sits under a new message, and above the quoted text in a reply. "
        + "Sent as written — no separator line is added in front of it."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
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
              if (!row.modelData.signedIn) return "Signed out"
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
    text: "Add a mailbox..."
    foreground: root.textColor
    fontFamily: root.panelFontFamily
    tooltipText: "Add another mail account"
    onClicked: root.addRequested()
  }

  PanelSeparator {
    width: parent.width
    foreground: root.textColor
  }

  CalendarSettings {
    width: parent.width
    controller: root.calendarController
    textColor: root.textColor
    dimColor: root.dimColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    panelFontFamily: root.panelFontFamily
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
          ? String(root.auth.clientDescription || "Google OAuth client") : "No client yet"
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
