import QtQuick
import qs.Commons
import qs.Ui
import "../providers/ExchangeProtocol.js" as Exchange
import "../account/Accounts.js" as Accounts

// Connecting a mailbox on an Exchange server your organization runs: an address,
// the server's web-service address, a login and a password, all on screen.
//
// The server is typed, never guessed from the address or found from the domain:
// whatever answers there is sent an NTLM response or a Basic password, and
// nothing is sent until you press the button.
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

  signal removeRequested()

  readonly property var auth: service ? service.auth : null
  readonly property bool signedIn: !!auth && auth.loggedIn === true
  readonly property bool busy: !!auth && auth.loginBusy === true
  // The saved password is not usable: the server refused it or the keyring has
  // lost it. Nothing is signed out; the one wrong thing is a string to type again.
  readonly property bool rejected: !!service && service.credentialsRejected === true
  readonly property var settings: auth && auth.settings ? auth.settings : null
  // A backend without the Exchange methods is sent nothing.
  readonly property string backendProblem: Exchange.backendProblem(service ? service.backend : null)

  spacing: Style.space(16)

  function syncFromStore() {
    nameField.syncFromStore()
    if (!settings) return
    addressField.text = service.accountAddress
    if (!settings.ewsUrl) return
    serverField.text = settings.ewsUrl
    // A login that is only the address was not typed: showing it would leave it
    // behind as the login when the address is changed later.
    var login = settings.username || ""
    usernameField.text = login.toLowerCase() === addressField.text.trim().toLowerCase() ? "" : login
  }

  // A password is good for one account, server and login: changing any of them
  // means typing it again, and the saved one goes first, signed in or not (a
  // keyring that was locked at start still holds it for the old server).
  function moved(address, values) {
    var saved = String(service.accountAddress)
    return Exchange.serverKey(settings, saved) !== Exchange.serverKey(values, address)
      || address.toLowerCase() !== saved.toLowerCase()
  }

  // Written down before the password is tried, so a refused mailbox keeps its
  // address and server to correct. Changes to a signed-in mailbox that leave its
  // server and login alone are only saved: nothing is asked of the server.
  function submit() {
    // Enter in the password field while a sign-in is being finished: the button
    // is off, and a second submit would take the password being saved away.
    if (!service || backendProblem !== "" || busy) return
    var address = addressField.text.trim()
    var values = Accounts.makeExchangeSettings({ ewsUrl: serverField.text, username: usernameField.text,
      authScheme: settings ? settings.authScheme : "" })
    var problem = !Accounts.isValidEmail(address)
      ? (address === "" ? "Add the email address for this mailbox" : "That is not a full email address")
      : Exchange.validateSettings(values, address)
    var changed = moved(address, values)
    // The method a sign-in learned is about that server and login only.
    if (changed) values.authScheme = "auto"
    // Refused before the old password goes or anything is saved.
    var typed = Exchange.typedPassword(secretField.text)
    if (problem === "" && typed === null) problem = Exchange.PASSWORD_CONTROL
    if (problem === "" && typed === "" && (changed || !signedIn || rejected))
      problem = signedIn && !rejected ? "Enter the password again: it is only sent to the server it was entered for"
        : "Enter the password for this mailbox"
    errorText.text = problem
    if (problem !== "") return
    var entry = { provider: "exchange", email: address, exchange: values, label: nameField.value() }
    // The old password is out of the keyring before settings that name another
    // server or login are saved, or nothing is saved.
    var save = function(released) {
      if (released === false) {
        errorText.text = "The old password could not be removed from the system keyring, so nothing was saved. Check that it is unlocked, then try again"
        return
      }
      if (typed !== "") service.configureCurrentAccountAndSignIn(entry, typed)
      else service.configureCurrentAccount(entry)
    }
    // A password kept for the address being taken over, unless another mailbox
    // in the list is that address (the save will refuse the duplicate).
    var target = Accounts.accountId(address, "exchange")
    var taken = ((service.accountList || {}).accounts || []).some(function(row) {
      return row.id === target && row.id !== auth.accountId
    })
    if (changed) auth.releaseStored(save, taken ? "" : target)
    else save(true)
  }

  Component.onCompleted: {
    syncFromStore()
    if (rejected) secretField.text = ""
  }

  onRejectedChanged: if (rejected) secretField.text = ""

  Connections {
    target: root.auth
    ignoreUnknownSignals: true
    function onLastErrorChanged() {
      if (root.auth && root.auth.lastError !== "") errorText.text = root.auth.lastError
    }
    function onLoginSucceeded() { errorText.text = "" }
  }

  ProviderHero {
    width: parent.width
    providerId: "exchange"
    title: "Add an Exchange mailbox"
    detail: "A mailbox on your organization's own Exchange server, with the username and password you use for work mail. Reading, searching, flagging, deleting, sending and drafts work; folders of your own are not shown."
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
  }

  Column {
    width: parent.width
    spacing: Style.space(10)

    AccountNameField {
      id: nameField
      service: root.service
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      onAccepted: addressField.forceActiveFocus()
    }

    TextField {
      id: addressField
      objectName: "exchange-address-field"
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Email address — you@example.com"
      onAccepted: serverField.forceActiveFocus()
    }

    TextField {
      id: serverField
      objectName: "exchange-server-field"
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Server address — " + Exchange.EWS_EXAMPLE
      onAccepted: usernameField.forceActiveFocus()
    }

    TextField {
      id: usernameField
      objectName: "exchange-username-field"
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: addressField.text.trim() !== ""
        ? addressField.text.trim() : "Sign-in name — usually your email address"
      onAccepted: secretField.forceActiveFocus()
    }

    Item {
      width: parent.width
      implicitHeight: secretField.implicitHeight

      TextField {
        id: secretField
        objectName: "exchange-secret-field"
        anchors.left: parent.left
        anchors.right: parent.right
        // Masked by default; readable on demand, as a long one cannot be checked by eye.
        password: !root.secretVisible
        rightPadding: horizontalPadding + Style.space(26)
        foreground: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Password"
        onAccepted: root.submit()
      }

      IconButton {
        anchors.right: parent.right
        anchors.rightMargin: Style.space(4)
        anchors.verticalCenter: secretField.verticalCenter
        visible: secretField.text !== ""
        iconName: root.secretVisible ? "eyeOff" : "eye"
        tooltipText: root.secretVisible ? "Hide the password" : "Show the password"
        foreground: root.dimColor
        hoverColor: root.textColor
        iconSize: Style.font.iconSmall
        size: Style.space(22)
        fontFamily: root.panelFontFamily
        onClicked: root.secretVisible = !root.secretVisible
      }
    }

    Text {
      width: parent.width
      text: "The sign-in name is DOMAIN\\user or user@domain; left empty it is your email address. The password goes only to the server address above, over a verified HTTPS connection, using NTLM where the server offers it and Basic otherwise. It is kept in the system keyring, never in a file."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    // Not drawn when it only repeats the card below; anything else is a second
    // fact, such as a server unreachable after a refusal.
    Text {
      id: errorText
      objectName: "exchange-error"
      width: parent.width
      visible: text !== "" && !(root.rejected && text === Exchange.sentence("exchange_unauthorized", true))
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
    visible: root.signedIn && !root.rejected
    spacing: Style.space(4)

    Text {
      objectName: "exchange-signed-in"
      width: parent.width
      textFormat: Text.PlainText
      text: Exchange.serverHost(root.settings) !== "" ? "Signed in · " + Exchange.serverHost(root.settings) : "Signed in"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
      elide: Text.ElideRight
    }

    // A missing Sent folder does not fail sign-in: this says what cannot be done,
    // rather than a Send button that fails after the message is written.
    Text {
      width: parent.width
      visible: !!root.service && root.service.canSend === false
      text: "Sending is not offered: this account has no Sent folder on the server."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Rectangle {
    width: parent.width
    visible: root.rejected
    implicitHeight: rejectedText.implicitHeight + Style.space(20)
    radius: Style.cornerRadius
    // The same surface as every other note, with the sentence in the danger
    // colour: the words, not the colour, say what happened.
    color: Style.normalFillFor(root.textColor, root.accentColor)
    border.width: 1
    border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

    Text {
      id: rejectedText
      objectName: "exchange-rejected"
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      text: "The saved password is not usable: the server rejected it (it may have expired or been changed) or the system keyring no longer has it. Enter it again."
      color: root.dangerColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Row {
    spacing: Style.space(8)

    Button {
      objectName: "exchange-submit"
      text: root.busy ? "Checking" : (root.rejected ? "Sign in again" : (root.signedIn ? "Save changes" : "Connect the mailbox"))
      enabled: !root.busy && root.backendProblem === "" && addressField.text.trim() !== ""
        && (secretField.text !== "" || (root.signedIn && !root.rejected))
      foreground: root.textColor
      bordered: true
      fontSize: Style.font.bodySmall
      onClicked: root.submit()
    }

    // No sign-out while re-entering: it would throw away the keyring entry and the
    // cache to fix a string in a field.
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

  Text {
    objectName: "exchange-backend"
    width: parent.width
    visible: root.backendProblem !== ""
    textFormat: Text.PlainText
    text: root.backendProblem
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }
}
