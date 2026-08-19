import QtQuick
import qs.Commons
import qs.Ui

// Gmail has no shared application to sign in through the way Spotify does:
// Google issues API access per project, so every user creates their own OAuth
// client once. This page is that walkthrough, with each step's console page one
// click away, because the alternative is a README the panel cannot show.
Column {
  id: root

  required property var service
  required property color textColor
  required property string panelFontFamily
  property string cursorTarget: ""

  signal backRequested()

  readonly property var auth: service.auth
  readonly property bool configured: auth.credentialsPresent
  readonly property color dim: Qt.rgba(textColor.r, textColor.g, textColor.b, 0.58)

  spacing: Style.space(10)

  function beginEdit() {
    clientIdField.text = root.auth.clientId
    clientSecretField.text = ""
    Qt.callLater(function() { clientIdField.forceActiveFocus(); clientIdField.selectAll() })
  }

  function save() {
    var secret = clientSecretField.text.trim()
    if (root.auth.saveCredentials(clientIdField.text.trim() + (secret === "" ? "" : "\n" + secret)))
      clientSecretField.text = ""
  }

  Row {
    width: parent.width
    spacing: Style.space(8)

    Button {
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
    color: root.dim
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    wrapMode: Text.WordWrap
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
    detail: "While the consent screen is in testing, only listed test users can sign in. Add the Gmail address you want to read."
    actionText: ""
  }

  Step {
    number: "4"
    title: "Paste the client below"
    detail: "Copy the client ID from the console. The secret is shown next to it — paste it too if your client has one."
    actionText: ""
  }

  Column {
    width: parent.width
    spacing: Style.space(6)

    Text {
      text: "Client ID"
      color: root.dim
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }

    TextField {
      id: clientIdField
      width: parent.width
      foreground: root.textColor
      placeholderText: "000000000000-xxxxxxxx.apps.googleusercontent.com"
      hasCursor: root.cursorTarget === "clientId"
      onAccepted: clientSecretField.forceActiveFocus()
    }

    Text {
      text: "Client secret (leave empty if your client has none)"
      color: root.dim
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }

    // Masked because it is a credential, even though Google is explicit that a
    // desktop client's secret is not confidential — a shoulder-surfable panel
    // is still a worse default than a masked one.
    TextField {
      id: clientSecretField
      width: parent.width
      foreground: root.textColor
      password: true
      placeholderText: "GOCSPX-…"
      hasCursor: root.cursorTarget === "clientSecret"
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
      enabled: !root.auth.credentialsWriteBusy
      hasCursor: root.cursorTarget === "save"
      onClicked: root.save()
    }

    Button {
      visible: root.configured
      text: "Sign in with Google..."
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      enabled: !root.auth.loginBusy
      hasCursor: root.cursorTarget === "signIn"
      onClicked: root.service.signIn()
    }
  }

  Text {
    width: parent.width
    visible: root.configured
    text: "Connected client: " + root.auth.clientDescription
    color: root.dim
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    elide: Text.ElideRight
  }

  Text {
    width: parent.width
    text: "Saved to " + root.auth.credentialsPath + ", readable only by you. "
      + "You can also copy the JSON the console downloads to that path instead of pasting."
    color: root.dim
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
      color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.45)
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
        color: root.dim
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      Button {
        visible: step.actionText !== ""
        text: step.actionText
        foreground: root.textColor
        bordered: false
        leftAlign: true
        horizontalPadding: 0
        fontSize: Style.font.caption
        onClicked: step.activated()
      }
    }
  }
}
