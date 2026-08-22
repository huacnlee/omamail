import QtQuick
import qs.Commons
import qs.Ui
import "../providers/Registry.js" as Provider

// Connecting a HEY mailbox, which is a program and a button.
//
// There is no form here at all, and that is the point: HEY publishes no IMAP
// and no API this plugin could sign in to, so Omamail reads it through `hey`,
// the command line client 37signals ship — and `hey` owns the sign-in, the
// token and the keyring entry it lives in. Everything this page can do is say
// whether the program is there, start its browser flow, and be honest about
// what HEY is not.
Column {
  id: root

  required property var service
  required property color textColor
  required property color dimColor
  required property color dangerColor
  required property color accentColor
  required property string panelFontFamily
  property bool canLeave: false
  property int accountCount: 1

  signal backRequested()
  signal removeRequested()

  readonly property var auth: service ? service.auth : null
  readonly property bool checked: !!auth && auth.toolsChecked
  readonly property bool installed: !!auth && auth.toolsPresent
  readonly property bool signedIn: !!auth && auth.loggedIn
  readonly property bool busy: !!auth && auth.loginBusy

  // The one line somebody has to run. Written out rather than run from here:
  // this window would be piping a script from the internet into a shell on the
  // user's behalf, which is a thing to decide in a terminal you are looking at.
  readonly property string installCommand: "curl -fsSL https://hey.com/install-cli | bash"

  spacing: Style.space(16)

  BackBar {
    visible: root.canLeave
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
    onActivated: root.backRequested()
  }

  // ------------------------------------------------------------------ hero

  ProviderHero {
    width: parent.width
    providerId: "hey"
    title: "Add a HEY mailbox"
    detail: "HEY does not speak IMAP or POP. Omamail reads it through the HEY CLI, the client 37signals publish for exactly this — install it once, then sign in here."
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
    onWebsiteRequested: if (root.service) root.service.openProviderWebsite("hey")
  }

  // --------------------------------------------------------- install first

  Column {
    width: parent.width
    visible: root.checked && !root.installed
    spacing: Style.space(10)

    // The name of the thing to install is also where to read about it. Split
    // rather than set as rich text: only the client's name is the link, and a
    // whole heading that opened a browser would be a heading somebody made
    // clickable by accident.
    Row {
      spacing: 0

      Text {
        text: "Install the "
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: true
      }

      LinkLabel {
        text: "HEY CLI"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: true
        tooltipText: "Open the HEY CLI on GitHub"
        onActivated: if (root.service) root.service.openProviderClient("hey")
      }
    }

    Text {
      width: parent.width
      text: "Run this in a terminal:"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    // Selectable, because the whole point of the box is to get the line into a
    // terminal. Read-only: nothing here runs what it holds.
    Rectangle {
      width: parent.width
      implicitHeight: commandText.implicitHeight + Style.space(20)
      radius: Style.cornerRadius
      color: Style.normalFillFor(root.textColor, root.accentColor)
      border.width: 1
      border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

      TextEdit {
        id: commandText
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.margins: Style.space(12)
        anchors.verticalCenter: parent.verticalCenter
        text: root.installCommand
        textFormat: TextEdit.PlainText
        readOnly: true
        selectByMouse: true
        wrapMode: TextEdit.WrapAnywhere
        color: root.textColor
        selectedTextColor: root.textColor
        selectionColor: Style.selectedFillFor(root.textColor, root.accentColor)
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }
    }

    Text {
      width: parent.width
      text: "Recent versions of Omarchy install it for you — omarchy-mise-install github:basecamp/hey-cli hey does the same thing. Either way it lands in ~/.local/bin."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Button {
      text: "Check again"
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: if (root.auth) root.auth.recheck()
    }
  }

  // ---------------------------------------------------------- then sign in

  Column {
    width: parent.width
    visible: root.installed && !root.signedIn
    spacing: Style.space(10)

    Text {
      width: parent.width
      text: "Sign in to HEY"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
    }

    Text {
      width: parent.width
      text: "This opens HEY in your browser. The token comes back to the HEY CLI, which keeps it in your keyring and refreshes it — Omamail never holds it and never asks for your HEY password."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Row {
      spacing: Style.space(8)

      Button {
        visible: !root.busy
        text: "Sign in to HEY..."
        foreground: root.textColor
        bordered: true
        fontSize: Style.font.bodySmall
        onClicked: if (root.service) root.service.signIn()
      }

      Button {
        visible: root.busy
        text: "Cancel"
        foreground: root.textColor
        bordered: true
        fontSize: Style.font.bodySmall
        onClicked: if (root.service) root.service.cancelSignIn()
      }

      Text {
        visible: root.busy
        anchors.verticalCenter: parent.verticalCenter
        text: "Waiting for the browser"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  // ------------------------------------------------------------- connected

  Column {
    width: parent.width
    visible: root.signedIn
    spacing: Style.space(4)

    Text {
      width: parent.width
      text: "Connected"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
    }

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: root.service && root.service.accountAddress !== ""
        ? root.service.accountAddress + " — signed in through the HEY CLI."
        : "Signed in through the HEY CLI."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Text {
    id: errorText
    width: parent.width
    visible: text !== ""
    textFormat: Text.PlainText
    text: root.auth ? root.auth.lastError : ""
    color: root.dangerColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  // ------------------------------------------------------- what HEY is not
  //
  // Said here rather than discovered later. Every one of these is a button this
  // provider does not draw, and somebody who came from Gmail will look for two
  // of them within a minute.

  Column {
    width: parent.width
    spacing: Style.space(4)

    Text {
      width: parent.width
      text: "What is different about HEY"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
    }

    Text {
      width: parent.width
      text: "No star and no archive — HEY has neither. A thread is moved to Set Aside, Reply Later or Paper Trail instead, and those are mailboxes in the rail. No Sent either: the HEY CLI does not serve one yet. Reading, marking read, replying, searching, labels and reporting spam all work. A row here is one conversation rather than one message, and attachments and the Screener stay in HEY's own app."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Row {
    spacing: Style.space(8)

    Button {
      visible: root.signedIn
      text: "Sign out of HEY"
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: if (root.service) root.service.signOut()
    }

    Button {
      visible: root.accountCount > 1
      text: "Remove account"
      foreground: root.dangerColor
      bordered: false
      fontSize: Style.font.bodySmall
      onClicked: root.removeRequested()
    }
  }

  // The sign-out above is `hey`'s own, because the token is `hey`'s. Said next
  // to the button rather than after it has been pressed.
  Text {
    width: parent.width
    visible: root.signedIn
    text: "Signing out signs the HEY CLI out, so anything else on this machine that uses it — the HEY terminal app, the bar plugin — is signed out too."
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }
}
