import QtQuick
import qs.Commons
import qs.Ui
import "../providers/Exchange.js" as Exchange
import "../providers/MicrosoftOAuth.js" as Microsoft
import "../account/Accounts.js" as Accounts

// Exchange: enter email → device code appears immediately → sign in on any browser.
// No buttons, no toggles, no Azure setup. Client ID is baked in.
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
  readonly property bool busy: !!auth && (auth.loginBusy || auth.graphRoundBusy === true)
  readonly property string userCode: (auth && auth.userCode) ? auth.userCode : ""
  readonly property string verificationUri: (auth && auth.verificationUri) ? auth.verificationUri : ""
  readonly property bool hasCode: userCode !== ""

  // Only surface errors after the user has explicitly kicked off a sign-in.
  // Session-restore failures on first load are expected and should be silent.
  property bool signInAttempted: false

  spacing: Style.space(16)

  function startFlow() {
    if (!root.service || root.busy || root.signedIn) return
    var address = addressField.text.trim()
    if (!Accounts.isValidEmail(address)) {
      errorText.text = "Enter a valid work email address first"
      return
    }
    errorText.text = ""
    root.signInAttempted = true
    var tenant = "organizations"
    var imap = Exchange.settings(address, tenant, "")
    imap.tenant = tenant
    var values = {
      provider: "exchange",
      email: address,
      clientId: Microsoft.BUILTIN_CLIENT_ID,
      clientSecret: "",
      imap: imap
    }
    root.service.configureCurrentAccountAndSignInOAuth(values)
  }

  Connections {
    target: root.auth
    ignoreUnknownSignals: true
    function onLastErrorChanged() {
      if (root.auth && root.auth.lastError !== "" && root.signInAttempted)
        errorText.text = root.auth.lastError
    }
  }

  // ---------------------------------------------------------------- hero

  ProviderHero {
    width: parent.width
    providerId: "exchange"
    title: "Add an Exchange mailbox"
    detail: "Sign in with your work Microsoft account. Omamail never sees your password."
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
    onWebsiteRequested: if (root.service) root.service.openProviderWebsite("exchange")
  }

  // ---------------------------------------------------------------- email field (hidden once flow starts)

  Column {
    width: parent.width
    spacing: Style.space(8)
    visible: !root.hasCode && !root.signedIn

    TextField {
      id: addressField
      objectName: "exchange-address-field"
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Work or school email address"
      onAccepted: root.startFlow()
    }

    Text {
      width: parent.width
      text: root.busy ? "Contacting Microsoft" : "Press Enter to begin sign-in"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }
  }

  // ---------------------------------------------------------------- device code panel

  Rectangle {
    width: parent.width
    visible: root.hasCode
    implicitHeight: codeColumn.implicitHeight + Style.space(28)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)
    border.width: 1
    border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

    Column {
      id: codeColumn
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.space(16)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(12)

      Text {
        width: parent.width
        text: "Open this address in any browser:"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      // URL — clickable, underlined, accent colour
      Text {
        width: parent.width
        text: root.verificationUri
        color: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        font.underline: true
        wrapMode: Text.WrapAnywhere
        textFormat: Text.PlainText

        HoverHandler { cursorShape: Qt.PointingHandCursor }
        TapHandler {
          onTapped: {
            if (root.service && typeof root.service.openExternal === "function")
              root.service.openExternal(root.verificationUri)
          }
        }
      }

      Text {
        width: parent.width
        text: "Then enter this code:"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      // The device code — large, prominent
      Text {
        objectName: "exchange-user-code"
        width: parent.width
        text: root.userCode
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
        font.letterSpacing: 3
        textFormat: Text.PlainText
      }

      Text {
        width: parent.width
        text: "Waiting for sign-in"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  // ---------------------------------------------------------------- signed-in state

  Text {
    width: parent.width
    visible: root.signedIn
    text: root.service && root.service.accountEmail !== ""
      ? "Signed in as " + root.service.accountEmail
      : "Signed in"
    color: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    wrapMode: Text.WordWrap
  }

  // ---------------------------------------------------------------- error

  Text {
    id: errorText
    objectName: "exchange-error"
    textFormat: Text.PlainText
    width: parent.width
    visible: text !== ""
    text: ""
    color: root.dangerColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  // ---------------------------------------------------------------- buttons

  Row {
    spacing: Style.space(8)

    Button {
      objectName: "exchange-cancel-sign-in"
      visible: root.busy
      text: "Cancel"
      foreground: root.dimColor
      bordered: false
      fontSize: Style.font.bodySmall
      onClicked: if (root.service) root.service.cancelSignIn()
    }

    Button {
      visible: root.signedIn
      text: "Sign out"
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
}
