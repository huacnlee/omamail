import QtQuick
import qs.Commons
import qs.Ui
import "../providers/JmapProtocol.js" as Jmap
import "../account/Accounts.js" as Accounts

// Connecting a mailbox on a server that speaks JMAP: an address, a secret, and
// — only if the address does not lead anywhere — the server.
//
// The page names no service. A JMAP server is one thing today and something
// else next year, and a form that told the user where to find their app
// password on two named providers would be wrong about the third. What it can
// say honestly is what kind of credential to bring.
//
// Two fields is the whole of it in the good case: the server is found from the
// address's domain, and which of Basic and Bearer the secret is happens to be
// is detected rather than asked. The disclosure holds the server for the case
// where discovery finds nothing, which on a self-hosted server is the ordinary
// case rather than the exception.
Column {
  id: root

  required property var service
  required property color textColor
  required property color dimColor
  required property color dangerColor
  required property color accentColor
  required property string panelFontFamily
  property int accountCount: 1
  property bool secretVisible: false
  property bool serversVisible: false

  signal removeRequested()

  readonly property var auth: service ? service.auth : null
  readonly property bool signedIn: !!auth && auth.loggedIn === true
  readonly property bool busy: !!auth && auth.loginBusy === true
  readonly property bool toolsMissing: !!auth && auth.toolsChecked === true
    && auth.missingTools !== undefined && auth.missingTools.length > 0
  // The client's own flag, forwarded through the account. A 401 raises it and
  // a successful check clears it, so the card below is the state of the
  // credential rather than a memory of one failed press.
  readonly property bool rejected: !!service && service.credentialsRejected === true
  readonly property int step: auth && auth.progressStep !== undefined ? auth.progressStep : 0

  // What sign-in found out about the server, for the two lines that report it.
  readonly property var settings: auth && auth.settings ? auth.settings : null
  readonly property string host: settings ? Jmap.sessionHost(settings.sessionUrl) : ""
  readonly property string schemeLabel: settings ? Jmap.schemeLabel(settings.authScheme) : ""
  readonly property bool sendingRefused: signedIn && !!auth && auth.sendingOffered === false

  spacing: Style.space(16)

  function syncFromStore() {
    addressField.text = service ? service.accountAddress : ""
    var values = root.settings
    if (!values) return
    if (String(values.username || "") !== "") usernameField.text = String(values.username)
    if (String(values.sessionUrl || "") !== "") serverField.text = String(values.sessionUrl)
  }

  // Neither of these places the keyboard. The page is a component in the
  // setup context and the context owns the focus — it parks the keyboard here,
  // because a form is typed into by the field that was clicked — so a field
  // that took focus on a state change would be the second mechanism that
  // design replaces. The field is emptied, or revealed, and left for the
  // person to pick up.
  function clearSecret() {
    secretField.text = ""
  }

  function openServerField() {
    serversVisible = true
  }

  // The address is this mailbox's identity rather than a label on it:
  // `Accounts.accountId` derives the account id from it, and anything that is
  // not an address derives the empty id a pending row carries. Checked here,
  // against the same predicate that derives the id, while it is still a typo
  // the user can see.
  function validatedAddress() {
    var address = addressField.text.trim()
    if (Accounts.isValidEmail(address)) return address
    errorText.text = address === ""
      ? "Add the email address for this mailbox"
      : "That is not a full email address"
    return ""
  }

  // Written down before the secret is tried, so a mailbox the server refuses
  // still has its address and its server to correct rather than an empty form.
  // The session URL kept here is the typed server until sign-in replaces it
  // with whatever actually answered — which is the same value `discoveryPlan`
  // reads as its typed server, so a saved one is not discovered again.
  function settingsFrom(typedServer) {
    var values = root.settings || {}
    return {
      sessionUrl: typedServer,
      username: usernameField.text.trim(),
      authScheme: String(values.authScheme || ""),
      accountId: String(values.accountId || "")
    }
  }

  function plannedServer(address) {
    var plan = Jmap.discoveryPlan(address, serverField.text)
    if (plan.error !== "") {
      errorText.text = plan.error
      openServerField()
      return null
    }
    // A typed server is the one step there is; anything else is discovery,
    // which has no URL to write down yet.
    var first = plan.steps.length > 0 ? plan.steps[0] : null
    return first && first.kind === Jmap.STEP_TYPED ? first.url : ""
  }

  function signIn() {
    if (!service) return
    var address = validatedAddress()
    if (address === "") return
    var server = plannedServer(address)
    if (server === null) return
    errorText.text = ""
    service.configureCurrentAccountAndSignIn({
      provider: "jmap",
      email: address,
      jmap: settingsFrom(server)
    }, secretField.text)
  }

  // Save changes re-verifies: everything on this page is something the server
  // has to agree with, so writing it down without asking would leave a mailbox
  // that says it is signed in and answers nothing.
  function save() {
    signIn()
  }

  Component.onCompleted: {
    syncFromStore()
    if (rejected) clearSecret()
  }

  onRejectedChanged: if (rejected) clearSecret()

  Connections {
    target: root.auth
    ignoreUnknownSignals: true
    function onLastErrorChanged() {
      if (root.auth && root.auth.lastError !== "") errorText.text = root.auth.lastError
    }
    // Nothing answered for the domain. The server field is the way forward, so
    // it is opened rather than described.
    function onServerNeededChanged() {
      if (root.auth && root.auth.serverNeeded) root.openServerField()
    }
    // The check has written the session URL down; the field should show what
    // the account is actually using rather than what was typed at it.
    function onSessionVerified(result) {
      errorText.text = ""
      var url = result ? String(result.sessionUrl || "") : ""
      if (url !== "") serverField.text = url
    }
  }

  // ------------------------------------------------------------------ hero

  ProviderHero {
    width: parent.width
    providerId: "jmap"
    title: "Add a JMAP mailbox"
    detail: "Any mailbox on a server that speaks JMAP. It signs in with an app password or an API token, never your account password."
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
      text: root.auth && root.auth.missingTools
        ? "Install " + root.auth.missingTools.join(", ")
          + " first — they hold the app password and talk to the server."
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
      onAccepted: secretField.forceActiveFocus()
    }

    // Always shown, and naming nobody. Somebody about to paste the password
    // they sign in to a website with is about to be refused, and this is the
    // sentence that stops it — in body text rather than a caption, because it
    // is the one thing on the page that is worth reading before typing.
    Rectangle {
      width: parent.width
      implicitHeight: noteText.implicitHeight + Style.space(20)
      radius: Style.cornerRadius
      color: Style.normalFillFor(root.textColor, root.accentColor)
      border.width: 1
      border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

      Text {
        id: noteText
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.margins: Style.space(12)
        anchors.verticalCenter: parent.verticalCenter
        text: "Most servers want an app password or an API token made for this client, not the password you sign in to the website with. Your provider's security settings are where to create one."
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    Item {
      width: parent.width
      implicitHeight: secretField.implicitHeight

      TextField {
        id: secretField
        objectName: "jmap-secret-field"
        anchors.left: parent.left
        anchors.right: parent.right
        // Masked by default: this window is shoulder-surfable. Readable on
        // demand, because a pasted token is a string nobody can check by eye.
        password: !root.secretVisible
        rightPadding: horizontalPadding + Style.space(26)
        foreground: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "App password, or API token"
        onAccepted: root.signIn()
      }

      IconButton {
        anchors.right: parent.right
        anchors.rightMargin: Style.space(4)
        anchors.verticalCenter: secretField.verticalCenter
        visible: secretField.text !== ""
        iconName: root.secretVisible ? "eyeOff" : "eye"
        tooltipText: root.secretVisible ? "Hide the app password" : "Show the app password"
        foreground: root.dimColor
        hoverColor: root.textColor
        iconSize: Style.font.iconSmall
        size: Style.space(22)
        fontFamily: root.panelFontFamily
        onClicked: root.secretVisible = !root.secretVisible
      }
    }

    Text {
      id: errorText
      objectName: "jmap-error"
      width: parent.width
      visible: text !== "" && !root.rejected
      textFormat: Text.PlainText
      text: ""
      color: root.dangerColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // --------------------------------------------------------- what it is doing
  //
  // Three waits that look identical from outside. Naming which one is running
  // is the difference between "it is working" and "it is stuck", and a check
  // beside the ones already past is what says the next one is not the first.

  Column {
    id: progress
    width: parent.width
    visible: root.busy
    spacing: Style.space(6)

    readonly property var lines: [
      "Finding the server", "Checking the app password", "Reading your mailboxes"]

    Repeater {
      model: progress.lines

      Row {
        id: line
        required property string modelData
        required property int index

        readonly property bool done: root.step > index + 1
        readonly property bool running: root.step === index + 1

        spacing: Style.space(8)

        ActionIcon {
          anchors.verticalCenter: parent.verticalCenter
          visible: line.done
          name: "check"
          iconSize: Style.font.caption
          color: root.accentColor
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          visible: !line.done
          // A bullet rather than a spinner: nothing here animates, and a row
          // that reserved the icon's width would leave the three lines
          // ragged.
          text: "·"
          color: line.running ? root.accentColor : root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          font.bold: line.running
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: line.modelData
          color: line.running ? root.textColor : root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          font.bold: line.running
        }
      }
    }
  }

  // ------------------------------------------------------------- signed in

  Column {
    width: parent.width
    visible: root.signedIn && !root.rejected
    spacing: Style.space(4)

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: root.host !== ""
        ? "Signed in · " + root.host + " · " + root.schemeLabel
        : "Signed in"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
      elide: Text.ElideRight
    }

    // A missing submission capability does not fail sign-in — the mailbox
    // reads perfectly well — so the account signs in and this says what it
    // cannot do, rather than a Send button that fails after the message is
    // written.
    Text {
      width: parent.width
      visible: root.sendingRefused
      text: "Sending is not offered: this credential cannot submit mail."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // -------------------------------------------------------------- rejected
  //
  // The server refused the credential. Nothing here is signed out: the account,
  // its server and its cache are all still right, and the one wrong thing is a
  // string that has to be typed again.

  Rectangle {
    width: parent.width
    visible: root.rejected
    implicitHeight: rejectedText.implicitHeight + Style.space(20)
    radius: Style.cornerRadius
    // The same surface every other note on this page draws on, with the
    // sentence in the danger colour rather than the box: colour alone never
    // carries state here, and the words are what says what happened.
    color: Style.normalFillFor(root.textColor, root.accentColor)
    border.width: 1
    border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

    Text {
      id: rejectedText
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      text: "The server rejected that app password or API token. Enter it again — it may have expired or been revoked."
      color: root.dangerColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // ------------------------------------------------------- server settings
  //
  // Behind a disclosure, because the address is enough wherever the domain
  // publishes a record or serves the well-known URL. Opened by the page when
  // it is not, which is the only time most people will see these fields.

  Column {
    width: parent.width
    spacing: Style.space(10)

    IconTextButton {
      objectName: "jmap-server-disclosure"
      iconName: root.serversVisible ? "chevronDown" : "chevronRight"
      text: root.serversVisible
        ? "Hide the server settings"
        : (root.host !== "" ? "Server settings — " + root.host : "Server settings")
      foreground: root.dimColor
      fontFamily: root.panelFontFamily
      fontSize: Style.font.caption
      onClicked: root.serversVisible = !root.serversVisible
    }

    Column {
      width: parent.width
      visible: root.serversVisible
      spacing: Style.space(8)

      TextField {
        id: serverField
        objectName: "jmap-server-field"
        width: parent.width
        foreground: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Server — mail.example.org, or the full session URL"
      }

      // Only for the servers where the login name is not the address, which is
      // common enough on self-hosted mail to be worth a field and rare enough
      // to keep out of the way.
      TextField {
        id: usernameField
        objectName: "jmap-username-field"
        width: parent.width
        foreground: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Username — only if it is not the address"
      }

      Text {
        width: parent.width
        text: "Left empty, the server is looked up from the address's domain. HTTPS only, and the credential goes to the server that answered and to the addresses inside its own session object."
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }
  }

  Row {
    spacing: Style.space(8)

    Button {
      visible: !root.signedIn && !root.rejected
      text: root.busy ? "Checking" : "Connect the mailbox"
      enabled: !root.busy && addressField.text.trim() !== "" && secretField.text !== ""
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: root.signIn()
    }

    Button {
      visible: root.rejected
      text: root.busy ? "Checking" : "Sign in again"
      enabled: !root.busy && secretField.text !== ""
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: root.signIn()
    }

    Button {
      visible: root.signedIn && !root.rejected
      text: "Save changes"
      enabled: !root.busy
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: root.save()
    }

    // No sign-out while the credential is being re-entered: signing out would
    // throw away the keyring entry and the cache to fix a string in a field.
    Button {
      visible: root.signedIn && !root.rejected
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
