import QtQuick
import qs.Commons
import qs.Ui
import "../providers/JmapProtocol.js" as Jmap
import "../account/Accounts.js" as Accounts

// Connecting a JMAP mailbox: an address, the server, and an API token.
//
// Shorter than the IMAP page next door, and not by omission. JMAP has one
// endpoint rather than four, and the session resource reports the ports, the
// account id and what the token is allowed to do — so there is nothing here
// for the user to get wrong except the two things only they know.
Column {
  id: root

  required property var service
  required property color textColor
  required property color dimColor
  required property color dangerColor
  required property color accentColor
  required property string panelFontFamily
  property int accountCount: 1
  property bool tokenVisible: false

  signal removeRequested()

  readonly property var auth: service ? service.auth : null
  readonly property bool signedIn: !!auth && auth.loggedIn
  readonly property bool busy: !!auth && auth.loginBusy
  readonly property bool toolsMissing: !!auth && auth.toolsChecked && auth.missingTools.length > 0

  // What we know about the server the user named, which for a known host is
  // where to mint the token.
  readonly property var preset: Jmap.presetFor(hostField.text)

  spacing: Style.space(16)

  function validatedAddress() {
    var address = String(addressField.text || "").trim()
    if (!Accounts.isValidEmail(address)) {
      errorText.text = "Enter the address of this mailbox"
      return ""
    }
    return address
  }

  function settingsNow() {
    return { host: Jmap.normalizeHost(hostField.text), username: String(addressField.text || "").trim() }
  }

  function save() {
    if (!service) return
    var address = validatedAddress()
    if (address === "") return
    if (!Jmap.isValidHost(hostField.text)) {
      errorText.text = "Enter the address of the JMAP server"
      return
    }
    errorText.text = ""
    service.configureCurrentAccount({ provider: "jmap", email: address, jmap: settingsNow() })
  }

  function signIn() {
    if (!service) return
    var address = validatedAddress()
    if (address === "") return
    if (!Jmap.isValidHost(hostField.text)) {
      errorText.text = "Enter the address of the JMAP server"
      return
    }
    errorText.text = ""
    service.configureCurrentAccountAndSignIn(
      { provider: "jmap", email: address, jmap: settingsNow() }, tokenField.text)
  }

  function syncFromStore() {
    if (!auth) return
    addressField.text = service ? service.accountAddress : ""
    if (auth.configuredHost !== "") hostField.text = auth.configuredHost
  }

  Component.onCompleted: syncFromStore()

  Connections {
    target: root.auth
    ignoreUnknownSignals: true
    function onLastErrorChanged() {
      if (root.auth && root.auth.lastError !== "") errorText.text = root.auth.lastError
    }
  }

  // ------------------------------------------------------------------ hero

  Column {
    width: parent.width
    spacing: Style.space(4)

    Text {
      width: parent.width
      text: "Add a JMAP mailbox"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.heading
      font.bold: true
    }

    Text {
      width: parent.width
      text: "Fastmail, or a server of your own that speaks JMAP. Threads, search and moves come from the server rather than being worked out here."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }
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
        ? "Install " + root.auth.missingTools.join(", ")
          + " first — they hold the token and talk to the server."
        : ""
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // -------------------------------------------------------------- the form

  Column {
    width: parent.width
    spacing: Style.space(10)

    TextField {
      id: addressField
      objectName: "jmap-address-field"
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Email address — you@example.com"
      onAccepted: hostField.forceActiveFocus()
    }

    TextField {
      id: hostField
      objectName: "jmap-host-field"
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      // A custom domain on Fastmail is still Fastmail, and the address cannot
      // say so — which is why this is asked rather than guessed.
      placeholderText: "JMAP server — api.fastmail.com"
      onAccepted: tokenField.forceActiveFocus()
    }

    // Where the token is minted, for a host we know. Nothing is fetched from
    // the server to work this out; it is a fact about the service.
    Rectangle {
      width: parent.width
      visible: !!root.preset
      implicitHeight: noteColumn.implicitHeight + Style.space(20)
      radius: Style.cornerRadius
      color: Style.normalFillFor(root.textColor, root.accentColor)
      border.width: 1
      border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

      Column {
        id: noteColumn
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.margins: Style.space(12)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(6)

        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: root.preset
            ? root.preset.label + " issues API tokens at " + root.preset.tokenHint
              + ". Give it access to mail only."
            : ""
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        LinkLabel {
          objectName: "jmap-token-guide"
          visible: !!root.preset && root.preset.tokenUrl !== ""
          text: "Create an API token..."
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          tooltipText: root.preset ? root.preset.tokenUrl : ""
          onActivated: if (root.preset) Qt.openUrlExternally(root.preset.tokenUrl)
        }
      }
    }

    TextField {
      id: tokenField
      objectName: "jmap-token-field"
      width: parent.width
      visible: !root.signedIn
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      echoMode: root.tokenVisible ? TextInput.Normal : TextInput.Password
      placeholderText: "API token"
      onAccepted: root.signIn()
    }

    Text {
      width: parent.width
      visible: root.signedIn
      text: "Signed in. The token is in the keyring; sign out to replace it."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Text {
      id: errorText
      width: parent.width
      visible: text !== ""
      text: ""
      color: root.dangerColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Row {
    spacing: Style.space(8)

    Button {
      visible: !root.signedIn
      text: root.busy ? "Checking" : "Connect the mailbox"
      enabled: !root.busy && addressField.text.trim() !== "" && tokenField.text !== ""
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: root.signIn()
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
