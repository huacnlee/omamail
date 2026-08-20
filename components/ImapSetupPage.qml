import QtQuick
import qs.Commons
import qs.Ui
import "../providers/ImapProtocol.js" as Imap

// Connecting an ordinary mailbox: an address, a password, and — only if the
// guess was wrong — the servers.
//
// The Gmail page next door is a walkthrough because Google genuinely requires
// one. This is not that: for a known provider it is two fields, because the
// hostnames are already known and typing them out is a way to get them wrong.
// The servers are filled in from the address and shown behind a disclosure, so
// they can be corrected without being in anyone's way.
Column {
  id: root

  required property var service
  required property color textColor
  required property color dimColor
  required property color dangerColor
  required property string panelFontFamily
  property bool canLeave: false
  property int accountCount: 1
  property bool passwordVisible: false
  property bool serversVisible: false

  signal backRequested()
  signal removeRequested()

  readonly property var auth: service ? service.auth : null
  readonly property bool signedIn: !!auth && auth.loggedIn
  readonly property bool busy: !!auth && auth.loginBusy
  readonly property bool toolsMissing: !!auth && auth.toolsChecked && auth.missingTools.length > 0

  // Recomputed as the address is typed, and only ever used to *fill* the
  // fields — never to override something already typed into them.
  readonly property var suggestion: Imap.suggestedSettings(addressField.text)

  spacing: Style.space(16)

  function currentSettings() {
    return {
      imapHost: imapHostField.text.trim(),
      imapPort: imapPortField.text.trim() === "" ? 993 : Number(imapPortField.text.trim()),
      smtpHost: smtpHostField.text.trim(),
      smtpPort: smtpPortField.text.trim() === "" ? 465 : Number(smtpPortField.text.trim()),
      username: (usernameField.text.trim() || addressField.text.trim()),
      insecure: false
    }
  }

  // The address drives the servers until the user takes them over. Once a field
  // has been edited by hand, a later change of address must not overwrite it —
  // which is what `touched` records.
  property bool serversTouched: false

  function applySuggestion() {
    if (serversTouched) return
    // onTextChanged runs before the readonly binding above is guaranteed to
    // have observed the last keystroke. Derive from the field here, or typing
    // the final "m" in .com can leave the server suggestion ending in .co.
    var current = Imap.suggestedSettings(addressField.text)
    imapHostField.text = current.imapHost
    imapPortField.text = String(current.imapPort)
    smtpHostField.text = current.smtpHost
    smtpPortField.text = String(current.smtpPort)
  }

  function syncFromStore() {
    if (!auth || !auth.settings) return
    var settings = auth.settings
    addressField.text = service ? service.accountAddress : ""
    if (settings.username !== "") {
      usernameField.text = settings.username
    }
    if (settings.imapHost !== "") {
      imapHostField.text = settings.imapHost
      imapPortField.text = String(settings.imapPort)
      smtpHostField.text = settings.smtpHost
      smtpPortField.text = String(settings.smtpPort)
      // Settings that came off disk are the user's own, so the address must not
      // overwrite them.
      serversTouched = true
    }
  }

  // Saved before the password is tried, so a mailbox that the server rejects
  // still has its settings to correct rather than an empty form to fill again.
  function save() {
    if (!service) return
    var check = Imap.validateSettings(currentSettings())
    if (!check.ok) {
      errorText.text = check.error
      return
    }
    errorText.text = ""
    service.configureCurrentAccount({
      provider: "imap",
      email: addressField.text.trim(),
      imap: check.settings
    })
  }

  function signIn() {
    if (!service) return
    var check = Imap.validateSettings(currentSettings())
    if (!check.ok) {
      errorText.text = check.error
      return
    }
    errorText.text = ""
    service.configureCurrentAccountAndSignIn({
      provider: "imap",
      email: addressField.text.trim(),
      imap: check.settings
    }, passwordField.text)
  }

  Component.onCompleted: syncFromStore()

  Connections {
    target: root.auth
    ignoreUnknownSignals: true
    function onLastErrorChanged() {
      if (root.auth && root.auth.lastError !== "") errorText.text = root.auth.lastError
    }
  }

  BackBar {
    visible: root.canLeave
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
    onActivated: root.backRequested()
  }

  // ------------------------------------------------------------------ hero

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
      text: "Any mailbox that speaks IMAP — Fastmail, iCloud, Zoho, a server of your own. The address is usually all it takes."
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
    color: Style.normalFillFor(root.textColor, Color.accent)
    border.width: 1
    border.color: Style.hoverBorderFor(root.textColor, Color.accent)

    Text {
      id: missingText
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      text: root.auth
        ? "Install " + root.auth.missingTools.join(", ")
          + " first — they hold the password and talk to the server."
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
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Email address — you@example.com"
      onTextChanged: root.applySuggestion()
      onAccepted: passwordField.forceActiveFocus()
    }

    // What a provider wants instead of the website password. Shown as soon as
    // the address names one, because someone typing their everyday password
    // into this box will otherwise be told only that it was rejected.
    Text {
      width: parent.width
      visible: root.suggestion.note !== ""
      text: root.suggestion.note
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Item {
      width: parent.width
      implicitHeight: passwordField.implicitHeight

      TextField {
        id: passwordField
        anchors.left: parent.left
        anchors.right: parent.right
        // Masked by default: this window is shoulder-surfable. Readable on
        // demand, because an app password is a 16-character string nobody can
        // check by memory.
        password: !root.passwordVisible
        rightPadding: horizontalPadding + Style.space(26)
        foreground: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Password, or app password"
        onAccepted: root.signIn()
      }

      IconButton {
        anchors.right: parent.right
        anchors.rightMargin: Style.space(4)
        anchors.verticalCenter: passwordField.verticalCenter
        visible: passwordField.text !== ""
        iconName: root.passwordVisible ? "eyeOff" : "eye"
        tooltipText: root.passwordVisible ? "Hide the password" : "Show the password"
        foreground: root.dimColor
        hoverColor: root.textColor
        iconSize: Style.font.iconSmall
        size: Style.space(22)
        fontFamily: root.panelFontFamily
        onClicked: root.passwordVisible = !root.passwordVisible
      }
    }

    Text {
      id: errorText
      width: parent.width
      visible: text !== ""
      text: ""
      color: Color.urgent
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // ------------------------------------------------------------ the servers
  //
  // Behind a disclosure, because for a known provider they are already right
  // and four more fields on screen would suggest otherwise.

  Column {
    width: parent.width
    spacing: Style.space(10)

    IconTextButton {
      iconName: root.serversVisible ? "chevronDown" : "chevronRight"
      text: root.serversVisible ? "Hide the server settings" : "Server settings"
      foreground: root.dimColor
      fontFamily: root.panelFontFamily
      fontSize: Style.font.caption
      onClicked: root.serversVisible = !root.serversVisible
    }

    Column {
      width: parent.width
      visible: root.serversVisible
      spacing: Style.space(8)

      Row {
        width: parent.width
        spacing: Style.space(8)

        TextField {
          id: imapHostField
          width: parent.width - imapPortField.width - parent.spacing
          foreground: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          placeholderText: "IMAP server"
          onTextEdited: root.serversTouched = true
        }

        TextField {
          id: imapPortField
          width: Style.space(90)
          foreground: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          placeholderText: "IMAP port"
          onTextEdited: root.serversTouched = true
        }
      }

      Row {
        width: parent.width
        spacing: Style.space(8)

        TextField {
          id: smtpHostField
          width: parent.width - smtpPortField.width - parent.spacing
          foreground: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          placeholderText: "SMTP server — leave empty to read only"
          onTextEdited: root.serversTouched = true
        }

        TextField {
          id: smtpPortField
          width: Style.space(90)
          foreground: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          placeholderText: "SMTP port"
          onTextEdited: root.serversTouched = true
        }
      }

      // Only for the servers where the login name is not the address, which is
      // common enough on self-hosted mail to be worth a field and rare enough
      // to keep out of the way.
      TextField {
        id: usernameField
        width: parent.width
        foreground: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Username — only if it is not the address"
      }
    }

    Text {
      width: parent.width
      visible: root.serversVisible
      text: "Connections are TLS on the port given. Plain text is refused unless the server is on this machine."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Row {
    spacing: Style.space(8)

    Button {
      visible: !root.signedIn
      text: root.busy ? "Checking…" : "Connect the mailbox"
      enabled: !root.busy && addressField.text.trim() !== "" && passwordField.text !== ""
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
