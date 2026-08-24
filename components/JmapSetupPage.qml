import QtQuick
import qs.Commons
import qs.Ui

// Connecting a JMAP mailbox: the address that identifies the local account and
// a mail-scoped API token. The token is masked here, verified with Session plus
// Mailbox/get, then handed to GNOME Keyring over stdin by JmapAuth.
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
  property bool tokenVisible: false

  signal backRequested()
  signal removeRequested()

  readonly property var auth: service ? service.auth : null
  readonly property bool signedIn: !!auth && auth.loggedIn
  readonly property bool busy: !!auth && auth.loginBusy
  readonly property bool toolsMissing: !!auth && auth.toolsChecked && auth.missingTools.length > 0

  spacing: Style.space(16)

  function syncFromStore() {
    if (!service) return
    addressField.text = service.accountAddress
  }

  function signIn() {
    if (!service) return
    var address = addressField.text.trim()
    if (address === "") {
      errorText.text = "Enter the mailbox address"
      return
    }
    if (tokenField.text.trim() === "") {
      errorText.text = "Enter a mail-scoped API token"
      return
    }
    errorText.text = ""
    service.configureCurrentAccountAndSignIn({ provider: "jmap", email: address },
      tokenField.text)
  }

  Component.onCompleted: syncFromStore()

  Connections {
    target: root.auth
    ignoreUnknownSignals: true
    function onLastErrorChanged() {
      if (root.auth && root.auth.lastError !== "") errorText.text = root.auth.lastError
    }
    function onLoginSucceeded() { tokenField.text = "" }
  }

  BackBar {
    visible: root.canLeave
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
    onActivated: root.backRequested()
  }

  ProviderHero {
    width: parent.width
    providerId: "jmap"
    title: "Connect Fastmail over JMAP"
    detail: "Fastmail exposes mail directly over HTTPS. Use a token limited to mail access; read-only is enough for the reader."
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
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
          + " first — it keeps the API token in the keyring."
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
      width: parent.width
      enabled: !root.signedIn
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Email address — you@example.com"
      onAccepted: tokenField.forceActiveFocus()
    }

    Item {
      width: parent.width
      implicitHeight: tokenField.implicitHeight

      TextField {
        id: tokenField
        anchors.left: parent.left
        anchors.right: parent.right
        password: !root.tokenVisible
        rightPadding: horizontalPadding + Style.space(26)
        foreground: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Mail-scoped API token"
        onAccepted: root.signIn()
      }

      IconButton {
        anchors.right: parent.right
        anchors.rightMargin: Style.space(4)
        anchors.verticalCenter: tokenField.verticalCenter
        visible: tokenField.text !== ""
        iconName: root.tokenVisible ? "eyeOff" : "eye"
        tooltipText: root.tokenVisible ? "Hide the token" : "Show the token"
        foreground: root.dimColor
        hoverColor: root.textColor
        iconSize: Style.font.iconSmall
        size: Style.space(22)
        fontFamily: root.panelFontFamily
        onClicked: root.tokenVisible = !root.tokenVisible
      }
    }

    Text {
      width: parent.width
      text: "Omamail reads the session document first and uses the regional API addresses it returns. The token is never written to plugin settings."
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
      enabled: !root.busy && addressField.text.trim() !== "" && tokenField.text.trim() !== ""
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: root.signIn()
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
