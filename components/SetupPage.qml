import QtQuick
import qs.Commons
import qs.Ui

// Gmail has no shared application to sign in through the way Spotify does:
// Google issues API access per project, so every user creates their own OAuth
// client once. This page is that walkthrough, with each step's console page one
// click away, because the alternative is a README the window cannot show.
Column {
  id: root

  required property var service
  required property color textColor
  required property color dimColor
  required property string panelFontFamily
  property bool canLeave: false

  signal backRequested()

  readonly property var auth: service ? service.auth : null
  readonly property bool configured: !!auth && auth.credentialsPresent
  readonly property bool toolsMissing: !!auth && auth.toolsChecked && auth.missingTools.length > 0

  spacing: Style.space(10)

  function beginEdit() {
    if (!auth) return
    clientIdField.text = auth.clientId
    clientSecretField.text = ""
    Qt.callLater(function() { clientIdField.forceActiveFocus(); clientIdField.selectAll() })
  }

  function save() {
    if (!auth) return
    var secret = clientSecretField.text.trim()
    if (auth.saveCredentials(clientIdField.text.trim() + (secret === "" ? "" : "\n" + secret)))
      clientSecretField.text = ""
  }

  Row {
    width: parent.width
    spacing: Style.space(8)

    Button {
      visible: root.canLeave
      text: "←"
      foreground: root.textColor
      bordered: false
      fontSize: Style.font.title
      onClicked: root.backRequested()
    }

    PanelSectionHeader {
      anchors.verticalCenter: parent.verticalCenter
      text: "GOOGLE CLOUD OAUTH CLIENT"
      foreground: root.textColor
      fontFamily: root.panelFontFamily
    }
  }

  Text {
    width: parent.width
    text: "Google issues Gmail API access per project, so Omarchy Gmail signs in with a client you own. "
      + "Nothing here is shared with anyone, and the mailbox is only ever read by this machine."
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    wrapMode: Text.WordWrap
  }

  // Missing dependencies come first: none of the steps below can finish
  // without them, so offering the steps first would waste the user's time.
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
          + " before signing in. Omarchy Gmail uses them for the loopback listener and the keyring."
        : ""
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Step {
    number: "1"
    title: "Create a Desktop app client"
    detail: "In Google Cloud, pick or create a project, then create an OAuth client with application type Desktop app."
    actionText: "Open Google Cloud..."
    onActivated: root.service.openCloudConsole()
  }

  Step {
    number: "2"
    title: "Enable the Gmail API"
    detail: "The client cannot read anything until the Gmail API is enabled on the same project."
    actionText: "Open the Gmail API page..."
    onActivated: root.service.openGmailApiPage()
  }

  Step {
    number: "3"
    title: "Add yourself as a test user"
    detail: "On the consent screen, add the Gmail address you want to read."
    actionText: "Open the consent screen..."
    onActivated: root.service.openConsentScreen()
  }

  // The step everyone skips, and the one that decides whether the sign-in
  // lasts. Google issues seven-day refresh tokens to projects left in Testing.
  Step {
    number: "4"
    title: "Press \"Publish app\""
    detail: "A project left in Testing is issued refresh tokens that expire after seven days, so the app would sign you out every week. Publishing your own project fixes that. You will see an \"unverified app\" warning once — expected for a client you made yourself."
    actionText: ""
  }

  Step {
    number: "5"
    title: "Paste the client below"
    detail: "Copy the client ID from the console. The secret is shown next to it — paste it too if your client has one."
    actionText: ""
  }

  Text {
    width: parent.width
    text: "Steps 1 and 2 have a CLI: run scripts/google-cloud-setup.sh if you have gcloud. "
      + "The consent screen and the client itself are console-only."
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  Column {
    width: parent.width
    spacing: Style.space(6)

    Text {
      text: "Client ID"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }

    TextField {
      id: clientIdField
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "000000000000-xxxxxxxx.apps.googleusercontent.com"
      onAccepted: clientSecretField.forceActiveFocus()
    }

    Text {
      text: "Client secret (leave empty if your client has none)"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }

    // Masked because it is a credential, even though Google is explicit that a
    // desktop client's secret is not confidential — a shoulder-surfable window
    // is still a worse default than a masked one.
    TextField {
      id: clientSecretField
      width: parent.width
      foreground: root.textColor
      password: true
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "GOCSPX-…"
      onAccepted: root.save()
    }
  }

  Row {
    spacing: Style.space(8)

    Button {
      text: "Save client"
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      enabled: !!root.auth && !root.auth.credentialsWriteBusy
      onClicked: root.save()
    }

    Button {
      visible: root.configured
      text: "Sign in with Google..."
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      enabled: !!root.auth && !root.auth.loginBusy
      onClicked: root.service.signIn()
    }

    Button {
      visible: !!root.auth && root.auth.loginBusy
      text: "Cancel sign-in"
      foreground: root.dimColor
      bordered: false
      fontSize: Style.font.bodySmall
      onClicked: root.service.cancelSignIn()
    }
  }

  Text {
    width: parent.width
    visible: !!root.service && root.service.signInProgress !== ""
    text: root.service ? root.service.signInProgress : ""
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  Text {
    width: parent.width
    visible: root.configured
    text: root.auth ? "Connected client: " + root.auth.clientDescription : ""
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    elide: Text.ElideRight
  }

  Text {
    width: parent.width
    text: root.auth
      ? "Saved to " + root.auth.credentialsPath + ", readable only by you. "
        + "You can also copy the JSON the console downloads to that path instead of pasting."
      : ""
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  component Step: Item {
    id: step
    required property string number
    required property string title
    required property string detail
    property string actionText: ""
    signal activated()

    width: root.width
    implicitHeight: stepBody.implicitHeight

    Text {
      id: marker
      anchors.left: parent.left
      anchors.top: parent.top
      width: Style.space(18)
      text: step.number + "."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Column {
      id: stepBody
      anchors.left: marker.right
      anchors.right: parent.right
      anchors.top: parent.top
      spacing: Style.space(3)

      Text {
        width: parent.width
        text: step.title
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: true
        wrapMode: Text.WordWrap
      }

      Text {
        width: parent.width
        text: step.detail
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      Button {
        visible: step.actionText !== ""
        text: step.actionText
        foreground: Color.accent
        bordered: false
        leftAlign: true
        horizontalPadding: 0
        fontSize: Style.font.caption
        onClicked: step.activated()
      }
    }
  }
}
