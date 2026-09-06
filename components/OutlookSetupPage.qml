import QtQuick
import qs.Commons
import qs.Ui
import "../providers/Outlook.js" as Outlook
import "../providers/MicrosoftOAuth.js" as Microsoft
import "../account/Accounts.js" as Accounts

// Outlook.com and Hotmail use Microsoft OAuth. The app registration is a
// public client: its ID is configuration, not a secret, and the account
// password is entered only on Microsoft's own page.
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
  readonly property bool usingBuiltinClient: Microsoft.isValidClientId(Microsoft.BUILTIN_CLIENT_ID)
  readonly property bool toolsMissing: !!auth && auth.toolsChecked && auth.missingTools.length > 0

  spacing: Style.space(16)

  function validatedAddress() {
    var address = addressField.text.trim()
    if (Accounts.isValidEmail(address)) return address
    errorText.text = address === ""
      ? "Add the Outlook or Hotmail address"
      : "That is not a full email address"
    return ""
  }

  function validatedClientId() {
    var value = root.usingBuiltinClient ? Microsoft.BUILTIN_CLIENT_ID : clientIdField.text.trim()
    if (Microsoft.isValidClientId(value)) return value
    errorText.text = value === ""
      ? "Add the Application (client) ID from Microsoft Entra"
      : "That is not a Microsoft Application (client) ID"
    return ""
  }

  function accountValues() {
    var address = validatedAddress()
    if (address === "") return null
    var clientId = validatedClientId()
    if (clientId === "") return null
    return ({
      provider: "outlook",
      email: address,
      clientId: clientId,
      clientSecret: "",
      imap: Outlook.settings(address)
    })
  }

  function save() {
    var values = accountValues()
    if (!values || !service) return
    errorText.text = ""
    service.configureCurrentAccount(values)
  }

  function signIn() {
    if (root.busy) return
    var values = accountValues()
    if (!values || !service) return
    errorText.text = ""
    service.configureCurrentAccountAndSignInOAuth(values)
  }

  function syncFromStore() {
    if (!service) return
    addressField.text = String(service.accountAddress || "")
    if (auth && auth.configuredClientId)
      clientIdField.text = String(auth.configuredClientId)
  }

  Component.onCompleted: syncFromStore()

  Connections {
    target: root.auth
    ignoreUnknownSignals: true
    function onLastErrorChanged() {
      if (root.auth && root.auth.lastError !== "") errorText.text = root.auth.lastError
    }
  }

  ProviderHero {
    width: parent.width
    providerId: "outlook"
    title: "Add an Outlook mailbox"
    detail: "Outlook.com and Hotmail use Microsoft sign-in. Omamail never sees your password."
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
    onWebsiteRequested: if (root.service) root.service.openProviderWebsite("outlook")
  }

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
        ? "Install " + root.auth.missingTools.join(", ") + " before signing in."
        : ""
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Column {
    width: parent.width
    spacing: Style.space(10)

    TextField {
      id: addressField
      objectName: "outlook-address-field"
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Outlook or Hotmail address"
      onAccepted: if (!root.usingBuiltinClient) clientIdField.forceActiveFocus()
    }

    TextField {
      id: clientIdField
      objectName: "outlook-client-id-field"
      width: parent.width
      visible: !root.usingBuiltinClient
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Microsoft Application (client) ID"
      onAccepted: root.signIn()
    }

    Text {
      id: errorText
      objectName: "outlook-error"
      textFormat: Text.PlainText
      width: parent.width
      visible: text !== ""
      text: ""
      color: root.dangerColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Column {
    width: parent.width
    visible: !root.signedIn
    spacing: Style.space(6)

    Text {
      width: parent.width
      text: "Enable IMAP in Outlook.com before signing in. Under Settings > Mail > Forwarding and IMAP, turn on Let devices and apps use IMAP, then save."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    LinkLabel {
      text: "Open Outlook IMAP help..."
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      tooltipText: "https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com"
      onActivated: Qt.openUrlExternally(tooltipText)
    }
  }

  Column {
    width: parent.width
    visible: !root.usingBuiltinClient && !root.signedIn
    spacing: Style.space(6)

    Text {
      width: parent.width
      text: "One-time Microsoft app setup"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
    }

    Text {
      width: parent.width
      text: "1. Register an app for personal Microsoft accounts. 2. Under Authentication, enable public client flows. 3. Copy its Application (client) ID above. Omamail requests only IMAP, SMTP and offline access when you sign in."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    LinkLabel {
      text: "Open Microsoft Entra app registrations..."
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      tooltipText: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
      onActivated: Qt.openUrlExternally(tooltipText)
    }
  }

  Rectangle {
    width: parent.width
    visible: root.busy && root.auth && root.auth.userCode !== ""
    implicitHeight: deviceColumn.implicitHeight + Style.space(20)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)
    border.width: 1
    border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

    Column {
      id: deviceColumn
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(8)

      Text {
        width: parent.width
        text: "Enter this code on the Microsoft page opened in your browser:"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      TextField {
        width: parent.width
        readOnly: true
        text: root.auth ? root.auth.userCode : ""
        foreground: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
      }

      LinkLabel {
        text: "Open Microsoft sign-in again..."
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        tooltipText: root.auth ? root.auth.verificationUri : ""
        onActivated: Qt.openUrlExternally(tooltipText)
      }
    }
  }

  Row {
    spacing: Style.space(8)

    Button {
      objectName: "outlook-sign-in"
      visible: !root.signedIn
      text: "Sign in with Microsoft..."
      enabled: !root.busy && addressField.text.trim() !== ""
        && (root.usingBuiltinClient || clientIdField.text.trim() !== "")
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: root.signIn()
    }

    Button {
      objectName: "outlook-cancel-sign-in"
      visible: root.busy
      text: "Cancel"
      foreground: root.dimColor
      bordered: false
      fontSize: Style.font.bodySmall
      onClicked: if (root.service) root.service.cancelSignIn()
    }

    Button {
      visible: root.signedIn
      text: "Save changes"
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: root.save()
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
