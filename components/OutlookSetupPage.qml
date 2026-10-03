import QtQuick
import qs.Commons
import qs.Ui
import "../providers/Registry.js" as Provider

// Connecting a personal Outlook mailbox, which is a browser and a button.
//
// There is no console walkthrough here, and that is the difference from the
// Gmail page next door: Microsoft owns the sign-in, so the app registration is
// not the user's to create and there is nothing to paste. What is left is the
// part people are right to want explained — that a browser window is going to
// open, that a consent screen follows, and that Microsoft's "unverified
// publisher" warning is the expected screen rather than a broken one.
//
// The page is one section while signed out and one while signed in, so it
// never shows a form that cannot finish.
Column {
  id: root

  required property var service
  required property color textColor
  required property color dimColor
  required property color dangerColor
  required property color accentColor
  required property string panelFontFamily
  property int accountCount: 1

  signal removeRequested()

  readonly property var auth: service ? service.auth : null
  readonly property bool signedIn: !!auth && auth.loggedIn
  readonly property bool busy: !!auth && auth.loginBusy
  readonly property bool toolsMissing: !!auth && auth.toolsChecked && auth.missingTools.length > 0
  // A further mailbox signs in through the same browser flow, but the heading
  // still has to tell the two apart: one is adding a mailbox and the other is
  // reconnecting one that is already named.
  readonly property bool addingMailbox: !!service && service.accountEmail === ""

  spacing: Style.space(16)

  // ------------------------------------------------------------------ hero

  ProviderHero {
    width: parent.width
    providerId: "outlook"
    title: root.addingMailbox ? "Add an Outlook mailbox" : "Connect your Outlook mailbox"
    detail: "Microsoft signs you in through your browser. There is no password to type here and no OAuth client to create first — just a consent screen to approve."
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
    onWebsiteRequested: if (root.service) root.service.openProviderWebsite("outlook")
  }

  // Missing dependencies come first: without the listener and the keyring the
  // button below would open a browser to nowhere.
  Rectangle {
    width: parent.width
    visible: root.toolsMissing
    implicitHeight: missingText.implicitHeight + Style.space(20)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)
    border.width: 1
    border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

    Text {
      id: missingText
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      text: root.auth
        ? "Install " + root.auth.missingTools.join(", ")
          + " first — they run the sign-in listener and the keyring."
        : ""
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // ---------------------------------------------------------- the sign-in

  Column {
    width: parent.width
    visible: !root.signedIn
    spacing: Style.space(10)

    Text {
      width: parent.width
      text: "Sign in with Microsoft"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
    }

    Text {
      width: parent.width
      text: "This is for personal Microsoft accounts — outlook.com, hotmail.com, live.com. "
        + "Pressing the button opens your browser on Microsoft's sign-in page, and the window "
        + "finishes by itself once you approve."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    // The one thing on the consent screen that looks like a fault. Said before
    // the browser opens, because a warning met afterwards is a reason to back
    // out of a flow that was working.
    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: "Microsoft may show an \"unverified publisher\" warning. It is expected — the app "
        + "is not publisher-verified, which is the ordinary case for a mail client of this "
        + "kind. Continue past it and approve the request."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Row {
      spacing: Style.space(8)

      Button {
        visible: !root.busy
        text: "Sign in with Microsoft..."
        foreground: root.textColor
        bordered: true
        fontSize: Style.font.bodySmall
        enabled: !!root.auth && !root.busy
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

    // Which of the waits is happening — the listener coming up, the browser, or
    // Microsoft's token endpoint. Without it a slow minute looks like a stuck
    // one.
    Text {
      width: parent.width
      visible: !!root.service && root.service.signInProgress !== ""
      text: root.service ? root.service.signInProgress : ""
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
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
      text: root.service && root.service.accountEmail !== ""
        ? root.service.accountEmail + " — signed in with Microsoft."
        : "Signed in with Microsoft."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // Whatever went wrong. Without this a failed sign-in looks exactly like a
  // button that does nothing.
  Text {
    width: parent.width
    visible: !!root.auth && root.auth.lastError !== ""
    textFormat: Text.PlainText
    text: root.auth ? root.auth.lastError : ""
    color: root.dangerColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  // ------------------------------------------------------------ the token

  Text {
    width: parent.width
    text: "The token Microsoft returns is kept in your system keyring, and Omamail refreshes "
      + "it from there. Your Microsoft password never reaches this app — the consent screen "
      + "hands back a token, not a password."
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  Row {
    visible: root.signedIn || root.accountCount > 1
    spacing: Style.space(8)
    // An unbordered button carries its padding inside an invisible box, so
    // standing first in the row it looks indented. Pulled left by that much
    // whenever it is first, so its text sits on the content edge like
    // everything above it.
    anchors.left: parent.left
    anchors.leftMargin: signOutButton.visible ? 0 : -removeButton.horizontalPadding

    Button {
      id: signOutButton
      visible: root.signedIn
      text: "Sign out"
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: if (root.service) root.service.signOut()
    }

    Button {
      id: removeButton
      visible: root.accountCount > 1
      text: "Remove account"
      foreground: root.dangerColor
      bordered: false
      fontSize: Style.font.bodySmall
      onClicked: root.removeRequested()
    }
  }
}
