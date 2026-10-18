import QtQuick
import qs.Commons
import qs.Ui
import "../providers/M365Protocol.js" as M365
import "../account/Accounts.js" as Accounts

// A work or school mailbox on Microsoft 365: an address, the Application (client)
// ID of an app registered once in Microsoft Entra, and one code.
//
// The sign-in happens on Microsoft's own page, so there is no password here.
// Pressing the button asks Microsoft for a code, opens its page and shows the
// code to enter there; the window then waits and says which step it is on. The
// browser may already be signed in to another Microsoft account, which Microsoft
// then offers: the code card says what to do about that.
Column {
  id: root

  required property var service
  required property color textColor
  required property color dimColor
  required property color dangerColor
  required property color accentColor
  required property string panelFontFamily

  signal removeRequested()

  readonly property var auth: service ? service.auth : null
  readonly property bool signedIn: !!auth && auth.loggedIn === true
  readonly property bool removing: !!auth && auth.removalBusy === true
  readonly property bool busy: !!auth && (auth.loginBusy === true || removing)
  readonly property string stage: auth && auth.signInStage !== undefined ? String(auth.signInStage) : ""
  readonly property bool reconnecting: !signedIn && !busy && !!auth && auth.recoveringSession === true
  // The same rule the auth object applies before it sends anything: an older
  // backend has no Microsoft 365 methods, and the page says so up front, as it
  // does while the backend is still starting.
  readonly property string backendProblem: service ? M365.backendProblem(service.backend) : ""
  readonly property bool backendTooOld: backendProblem !== "" && !!service && !!service.backend
    && service.backend.ready === true

  spacing: Style.space(16)

  function validatedAddress() {
    var address = addressField.text.trim()
    if (Accounts.isValidEmail(address)) return address
    errorText.text = address === "" ? "Add your work email address" : "That is not a full email address"
    return ""
  }

  // Saved as the backend keys the sign-in: a GUID in lower case.
  function validatedClientId() {
    var value = clientIdField.text.trim()
    if (M365.clientId(value) !== "") return M365.clientId(value)
    errorText.text = value === ""
      ? "Add the Application (client) ID from Microsoft Entra"
      : "That is not a Microsoft Application (client) ID"
    return ""
  }

  // The sign-in starts on the account the form describes: the address and the ID
  // are written down first, so a mailbox whose sign-in fails keeps them.
  function signIn() {
    if (!service || busy || signedIn) return
    var address = validatedAddress()
    var clientId = address === "" ? "" : validatedClientId()
    if (clientId === "") return
    errorText.text = ""
    service.configureCurrentAccountAndSignInOAuth({ provider: "m365", email: address, clientId: clientId })
  }

  function syncFromStore() {
    errorText.text = auth ? String(auth.lastError || "") : ""
    if (!service) return
    addressField.text = String(service.accountAddress || "")
    clientIdField.text = auth && auth.clientId ? String(auth.clientId) : ""
  }

  function open(url) {
    if (service && typeof service.openExternal === "function") service.openExternal(url)
  }

  // The auth object is rebuilt when the entry is saved, so what the page shows
  // is read again from whichever one is current.
  onAuthChanged: syncFromStore()
  Component.onCompleted: syncFromStore()

  Connections {
    target: root.auth
    ignoreUnknownSignals: true
    function onLastErrorChanged() {
      errorText.text = root.auth ? String(root.auth.lastError || "") : ""
    }
    // A session that is there is no failure to report any more.
    function onLoggedInChanged() {
      if (root.auth && root.auth.loggedIn === true) errorText.text = ""
    }
  }

  ProviderHero {
    width: parent.width
    providerId: "m365"
    title: "Add a Microsoft 365 mailbox"
    detail: "Your work or school mailbox, signed in with Microsoft, with your calendar. Folders of your own are not shown."
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
  }

  Rectangle {
    width: parent.width
    visible: root.backendProblem !== "" && !root.signedIn
    implicitHeight: missingText.implicitHeight + Style.space(20)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)
    border.width: 1
    border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

    Text {
      id: missingText
      objectName: "m365-backend-note"
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: root.backendTooOld ? "Update the mail backend first: this version cannot talk to Microsoft 365."
        : "Waiting for the mail backend to start. Sign in is available once it has."
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
      objectName: "m365-address-field"
      width: parent.width
      visible: !root.signedIn
      readOnly: root.busy
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Work email address — you@example.org"
      onAccepted: clientIdField.forceActiveFocus()
    }

    TextField {
      id: clientIdField
      objectName: "m365-client-id-field"
      width: parent.width
      visible: !root.signedIn
      readOnly: root.busy
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Microsoft Application (client) ID"
      onAccepted: root.signIn()
    }

    Text {
      objectName: "m365-asks"
      width: parent.width
      visible: !root.signedIn && !root.busy
      textFormat: Text.PlainText
      text: "Omamail asks Microsoft to sign you in, and for this: read and write mail, send mail, read and write your calendar. That is one sign-in on Microsoft's own page: there is no second code, and Omamail never sees your password."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Text {
      id: errorText
      objectName: "m365-error"
      width: parent.width
      visible: text !== ""
      textFormat: Text.PlainText
      text: ""
      color: root.dangerColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Column {
    width: parent.width
    // Not while a code is out: the code is what the person needs to see.
    visible: !root.signedIn && !root.busy
    spacing: Style.space(6)

    Text {
      width: parent.width
      text: "One-time Microsoft app setup"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
    }

    Repeater {
      model: [
        "In Microsoft Entra, register an app for accounts in your organization's directory. It needs no redirect URI: the sign-in uses a code.",
        "Under Authentication, set Allow public client flows to Yes.",
        "Under API permissions, add the delegated Microsoft Graph permissions Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, openid, profile, email and offline_access.",
        "Copy the Application (client) ID from the app's Overview page into the field above."
      ]

      Text {
        required property string modelData
        required property int index

        objectName: "m365-step"
        width: parent.width
        textFormat: Text.PlainText
        text: (index + 1) + ". " + modelData
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    Text {
      objectName: "m365-admin-note"
      width: parent.width
      textFormat: Text.PlainText
      text: "If your organization does not let people approve apps themselves, an administrator has to approve this one before the sign-in works."
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
      onActivated: root.open(tooltipText)
    }
  }

  Text {
    objectName: "m365-progress"
    width: parent.width
    visible: root.busy || root.reconnecting
    textFormat: Text.PlainText
    text: root.removing ? "Removing the saved Microsoft sign-in"
      : root.reconnecting ? "Checking the saved Microsoft sign-in"
      : root.stage === "checking" ? "Signed in on Microsoft's side. Checking the mailbox"
      : root.stage === "waiting" ? "Waiting for you to finish on the Microsoft page"
      : "Asking Microsoft for a code"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  // The code and where to enter it, for as long as it is wanted: once it has
  // been entered the page says the mailbox is being checked instead. The page
  // address is selectable, to be pasted into a private window.
  Rectangle {
    objectName: "m365-code-card"
    width: parent.width
    visible: root.busy && !!root.auth && root.auth.userCode !== ""
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
        textFormat: Text.PlainText
        text: "Enter this code on the Microsoft page opened in your browser, then sign in with your work account. If it offers another account, paste the page address below into a private window:"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      TextField {
        objectName: "m365-code"
        width: parent.width
        readOnly: true
        text: root.auth ? String(root.auth.userCode) : ""
        foreground: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
      }

      TextField {
        objectName: "m365-link"
        width: parent.width
        readOnly: true
        text: root.auth ? String(root.auth.verificationUri) : ""
        foreground: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      LinkLabel {
        objectName: "m365-open-again"
        text: "Open the Microsoft sign-in page again..."
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        onActivated: if (root.auth) root.open(String(root.auth.verificationUri))
      }
    }
  }

  Column {
    width: parent.width
    visible: root.signedIn
    spacing: Style.space(4)

    Text {
      objectName: "m365-signed-in"
      width: parent.width
      textFormat: Text.PlainText
      text: "Signed in · " + (root.service ? String(root.service.accountAddress || "") : "")
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
      elide: Text.ElideRight
    }

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: "Mail and calendar use this one sign-in. Signing out removes it from this computer."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Row {
    spacing: Style.space(8)

    Button {
      objectName: "m365-sign-in"
      visible: !root.signedIn
      text: root.removing ? "Removing account" : root.busy ? "Waiting for Microsoft" : "Sign in with Microsoft..."
      enabled: !root.busy && root.backendProblem === "" && addressField.text.trim() !== ""
        && clientIdField.text.trim() !== ""
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: root.signIn()
    }

    Button {
      objectName: "m365-cancel-sign-in"
      visible: root.busy && !root.removing
      text: "Cancel"
      foreground: root.dimColor
      bordered: false
      fontSize: Style.font.bodySmall
      onClicked: if (root.service) root.service.cancelSignIn()
    }

    Button {
      objectName: "m365-sign-out"
      visible: root.signedIn
      text: "Sign out"
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: if (root.service) root.service.signOut()
    }

    // The window asks first; the saved sign-in goes once the removal is confirmed.
    Button {
      objectName: "m365-remove"
      visible: !!root.service && root.service.accountCount > 1
      text: "Remove account"
      enabled: !root.removing
      foreground: root.dangerColor
      bordered: false
      fontSize: Style.font.bodySmall
      onClicked: root.removeRequested()
    }
  }
}
