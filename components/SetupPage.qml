import QtQuick
import qs.Commons
import qs.Ui

// Connecting a mailbox, as two steps instead of a wall of instructions.
//
// Gmail has no shared application to sign in through — Google issues API
// access per project — so there is genuinely a setup to do. The page shows one
// step at a time: whichever is finished collapses to a single line with a
// check, and only the one that needs the user is open. The detail most people
// skip lives behind a disclosure, except the one piece that decides whether
// the session lasts, which sits beside the button it affects.
Column {
  id: root

  required property var service
  required property color textColor
  required property color dimColor
  required property color dangerColor
  required property string panelFontFamily
  property bool canLeave: false
  property int accountCount: 1
  property bool secretVisible: false
  property bool detailVisible: false
  // A finished step can be reopened — the client changes when somebody moves
  // Cloud projects. Kept here rather than assigned onto the step, which would
  // break the binding that closes it again.
  property bool clientStepReopened: false

  signal backRequested()
  signal removeRequested()

  readonly property var auth: service ? service.auth : null
  readonly property bool configured: !!auth && auth.credentialsPresent
  readonly property bool signedIn: !!auth && auth.loggedIn
  // A further mailbox signs in with the client that is already set up, so the
  // page is an account chooser rather than the console walkthrough.
  readonly property bool addingMailbox: configured && !signedIn
    && !!service && service.accountEmail === ""
  readonly property bool toolsMissing: !!auth && auth.toolsChecked && auth.missingTools.length > 0

  spacing: Style.space(16)

  // The fields show what is on disk, so the page always says what the app is
  // actually using rather than going blank after a save.
  function syncFromStore() {
    if (!auth) return
    clientIdField.text = auth.clientId
    clientSecretField.text = auth.credentials ? String(auth.credentials.clientSecret || "") : ""
  }

  function save() {
    if (!auth) return
    var secret = clientSecretField.text.trim()
    // The secret stays in the field. Clearing it on success looked exactly
    // like losing it, which is a bad thing for a credential to look like.
    auth.saveCredentials(clientIdField.text.trim() + (secret === "" ? "" : "\n" + secret))
  }

  Component.onCompleted: syncFromStore()

  Connections {
    target: root.auth
    ignoreUnknownSignals: true
    function onClientIdChanged() { root.syncFromStore() }
    function onCredentialsSaved() {
      root.syncFromStore()
      root.clientStepReopened = false
    }
  }

  // Hidden only during first run, when there is genuinely no page behind this
  // one — the mailbox does not exist yet. On its own line rather than inline
  // beside the hero, because that is where it sits on the reader and the
  // compose form, and a control that moves between pages reads as a different
  // control on each of them.
  BackBar {
    visible: root.canLeave
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
    onActivated: root.backRequested()
  }

  // ------------------------------------------------------------------ hero

  Item {
    width: parent.width
    implicitHeight: Math.max(heroIcon.height, heroText.implicitHeight)

    GmailIcon {
      id: heroIcon
      anchors.left: parent.left
      anchors.top: parent.top
      anchors.topMargin: Style.space(2)
      iconSize: Style.font.displayLarge
      color: root.textColor
    }

    Column {
      id: heroText
      anchors.left: heroIcon.right
      anchors.leftMargin: Style.space(14)
      anchors.right: parent.right
      anchors.top: parent.top
      spacing: Style.space(4)

      Text {
        width: parent.width
        text: root.addingMailbox ? "Add a mailbox" : "Connect your mailbox"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
      }

      Text {
        width: parent.width
        text: root.addingMailbox
          ? "Signing in with the OAuth client you already set up. Pick the Google account you want to add."
          : "Google issues Gmail API access per project, so this app signs in with an OAuth client you own. About two minutes, once."
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.WordWrap
      }
    }
  }

  // Missing dependencies come first: neither step below can finish without
  // them, so offering the steps first would waste the user's time.
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
          + " first — they run the sign-in listener and the keyring."
        : ""
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // ------------------------------------------------------- step 1: client

  Step {
    number: "1"
    title: "Create a client in Google Cloud"
    done: root.configured && !root.clientStepReopened
    doneSummary: root.auth ? "Client connected · " + root.auth.clientDescription : ""
    reopenable: true

    Column {
      width: parent.width
      spacing: Style.space(10)

      Text {
        width: parent.width
        text: "Create an OAuth client with application type Desktop app, and enable the Gmail API on the same project."
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      Row {
        spacing: Style.space(8)

        Button {
          text: "Open Google Cloud..."
          foreground: root.textColor
          bordered: true
          fontSize: Style.font.bodySmall
          onClicked: root.service.openCloudConsole()
        }

        Button {
          text: "Enable Gmail API..."
          foreground: root.textColor
          bordered: true
          fontSize: Style.font.bodySmall
          onClicked: root.service.openGmailApiPage()
        }
      }

      TextField {
        id: clientIdField
        width: parent.width
        foreground: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Client ID — 000000-xxxx.apps.googleusercontent.com"
        onAccepted: clientSecretField.forceActiveFocus()
      }

      Item {
        width: parent.width
        implicitHeight: clientSecretField.implicitHeight

        TextField {
          id: clientSecretField
          anchors.left: parent.left
          anchors.right: parent.right
          // Masked by default, because a credential on a shoulder-surfable
          // window is a worse default — but readable on demand, so it can be
          // checked against the console.
          password: !root.secretVisible
          rightPadding: horizontalPadding + Style.space(26)
          foreground: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          placeholderText: "Client secret — optional"
          onAccepted: root.save()
        }

        IconButton {
          anchors.right: parent.right
          anchors.rightMargin: Style.space(4)
          anchors.verticalCenter: clientSecretField.verticalCenter
          visible: clientSecretField.text !== ""
          iconName: root.secretVisible ? "eyeOff" : "eye"
          tooltipText: root.secretVisible ? "Hide the secret" : "Show the secret"
          foreground: root.dimColor
          hoverColor: root.textColor
          iconSize: Style.font.iconSmall
          size: Style.space(22)
          fontFamily: root.panelFontFamily
          onClicked: root.secretVisible = !root.secretVisible
        }
      }

      Button {
        text: "Save client"
        foreground: root.textColor
        bordered: true
        fontSize: Style.font.bodySmall
        enabled: !!root.auth && !root.auth.credentialsWriteBusy
        onClicked: root.save()
      }
    }
  }

  // ------------------------------------------------------- step 2: sign in

  Step {
    number: "2"
    title: "Sign in"
    done: root.signedIn
    doneSummary: root.service ? "Signed in as " + root.service.accountEmail : ""
    waiting: !root.configured

    Column {
      width: parent.width
      spacing: Style.space(10)

      // The one piece of the walkthrough that cannot be hidden: a project left
      // in Testing is issued seven-day refresh tokens, so the app would sign
      // the user out every week. It belongs beside the button it affects.
      Text {
        width: parent.width
        text: "Press \"Publish app\" on your project first, or Google expires the session every seven days. An \"unverified app\" warning is expected — you are the developer."
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      Row {
        spacing: Style.space(8)

        Button {
          text: "Sign in with Google..."
          foreground: root.textColor
          bordered: true
          fontSize: Style.font.bodySmall
          enabled: !!root.auth && !root.auth.loginBusy
          onClicked: root.service.signIn()
        }

        Button {
          text: "Consent screen..."
          foreground: root.dimColor
          bordered: false
          fontSize: Style.font.bodySmall
          onClicked: root.service.openConsentScreen()
        }

        Button {
          visible: !!root.auth && root.auth.loginBusy
          text: "Cancel"
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
    }
  }

  Row {
    visible: root.signedIn || root.accountCount > 1
    spacing: Style.space(8)

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

  // ------------------------------------------------------------- footnotes

  // Whatever went wrong. Without this a rejected client ID looks exactly like
  // a button that does nothing.
  Text {
    width: parent.width
    visible: !!root.auth && root.auth.lastError !== ""
    textFormat: Text.PlainText
    text: root.auth ? root.auth.lastError : ""
    color: Color.urgent
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  PanelSeparator {
    width: parent.width
    foreground: root.textColor
  }

  Button {
    text: root.detailVisible ? "Hide the details" : "Need more detail?"
    foreground: root.dimColor
    bordered: false
    leftAlign: true
    horizontalPadding: 0
    fontSize: Style.font.caption
    onClicked: root.detailVisible = !root.detailVisible
  }

  Text {
    width: parent.width
    visible: root.detailVisible
    text: "In Google Cloud, pick or create a project. Under APIs and Services, enable the Gmail API. "
      + "On the consent screen add the Gmail address you want to read as a test user, then press Publish app. "
      + "Under Credentials, create an OAuth client with application type Desktop app, and paste its client ID above.\n\n"
      + "Steps one and two have a CLI: run scripts/google-cloud-setup.sh if you have gcloud. "
      + "The consent screen and the client itself are console-only.\n\n"
      + (root.auth ? "The client is saved to " + root.auth.credentialsPath + ", readable only by you. "
        + "You can also copy the JSON the console downloads to that path instead of pasting. " : "")
      + "The refresh token goes to GNOME Keyring; the access token never leaves memory."
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  // A step is a number, a title, and a body that is only present while this is
  // the step that needs the user. Finished steps collapse to one line, so the
  // page never shows more than one thing to do.
  component Step: Item {
    id: step
    required property string number
    required property string title
    property bool done: false
    property bool waiting: false
    property bool reopenable: false
    property string doneSummary: ""
    default property alias content: bodyHolder.data

    readonly property bool active: !done && !waiting

    width: root.width
    implicitHeight: stepColumn.implicitHeight
    opacity: step.waiting ? 0.45 : 1.0

    Item {
      id: marker
      anchors.left: parent.left
      anchors.top: parent.top
      width: Style.space(20)
      implicitHeight: Style.space(18)

      Text {
        anchors.left: parent.left
        anchors.top: parent.top
        visible: !step.done
        text: step.number
        color: step.active ? Color.accent : root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: step.active
      }

      ActionIcon {
        anchors.left: parent.left
        anchors.top: parent.top
        visible: step.done
        name: "check"
        iconSize: Style.font.bodySmall
        color: Color.accent
      }
    }

    Button {
      id: reopen
      anchors.right: parent.right
      anchors.top: parent.top
      visible: step.done && step.reopenable
      text: "Change..."
      foreground: root.dimColor
      bordered: false
      fontSize: Style.font.caption
      onClicked: root.clientStepReopened = true
    }

    Column {
      id: stepColumn
      anchors.left: marker.right
      anchors.right: reopen.visible ? reopen.left : parent.right
      anchors.top: parent.top
      spacing: Style.space(8)

      Text {
        width: parent.width
        text: step.done && step.doneSummary !== "" ? step.doneSummary : step.title
        color: step.done ? root.dimColor : root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: !step.done
        elide: Text.ElideRight
      }

      // Sized from its one child rather than childrenRect: the child sizes
      // itself to this holder's width, so asking childrenRect for the height
      // closes a loop through the step's own implicitHeight.
      Item {
        id: bodyHolder
        width: parent.width
        visible: step.active
        implicitHeight: visible && children.length > 0 ? children[0].implicitHeight : 0
      }
    }
  }
}
