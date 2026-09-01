import QtQuick
import qs.Commons
import qs.Ui
import "../message/Direction.js" as Direction

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

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(directionText.implicitHeight, directionTrack.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: directionText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: directionTrack.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "Message direction"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        // Says what Auto does rather than only naming it: a reader whose mail
        // is already laid out correctly has no way to tell whether that is the
        // setting working or the setting being unnecessary.
        text: "Auto reads it from the message's own text. The interface is unaffected."
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    // Three names for one setting, sharing a track and the seams between them,
    // the way the reader's own view modes do.
    Rectangle {
      id: directionTrack
      objectName: "contentDirectionTrack"
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      width: directionSegments.implicitWidth
      height: directionSegments.implicitHeight
      radius: Style.cornerRadius
      color: "transparent"
      border.width: 1
      border.color: Style.normalBorderFor(root.textColor, root.accentColor)

      Row {
        id: directionSegments
        spacing: 0

        // The labels are the stored values: the shell hands a plugin the words
        // the schema lists rather than a key behind them, so spelling them
        // anywhere but Direction.js would be a second place to keep them right.
        DirectionButton {
          text: Direction.AUTO; mode: Direction.AUTO; firstSegment: true
        }
        DirectionButton { text: Direction.LEFT_TO_RIGHT; mode: Direction.LEFT_TO_RIGHT }
        DirectionButton { text: Direction.RIGHT_TO_LEFT; mode: Direction.RIGHT_TO_LEFT }
      }
    }
  }

  // -------------------------------------------------------- notifications

  Text {
    text: "NOTIFICATIONS"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(notifyText.implicitHeight, notifySwitch.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: notifyText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: notifySwitch.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "New mail notifications"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        text: "Send a desktop notification when new mail arrives in your inbox"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    ToggleSwitch {
      id: notifySwitch
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      checked: !!root.service && root.service.notifyNewMail
      foreground: root.textColor
      accent: root.accentColor
      onToggled: if (root.service)
        root.service.setNotifyNewMail(!root.service.notifyNewMail)
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
    service: root.service
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

  // One of the three ways a message's direction is arrived at.
  component DirectionButton: Button {
    required property string mode
    property bool firstSegment: false
    selected: !!root.service && root.service.contentDirection === mode
    bordered: false
    foreground: selected ? root.textColor : root.dimColor
    accent: root.accentColor
    fontFamily: root.panelFontFamily
    fontSize: Style.font.caption
    horizontalPadding: Style.space(7)
    verticalPadding: Style.space(3)
    onClicked: if (root.service) root.service.setContentDirection(mode)

    Rectangle {
      visible: !parent.firstSegment
      width: 1
      height: parent.height
      color: directionTrack.border.color
    }
  }
}
