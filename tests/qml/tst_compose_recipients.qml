import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

Item {
  width: 900
  height: 600

  QtObject {
    id: mailService
    property bool sendPending: false
    property bool sending: false
    property int sendSecondsRemaining: 10
    property var lastSent: null
    property var recipientContacts: [
      ({ name: "First Person", email: "first@example.com" }),
      ({ name: "Second Person", email: "second@example.com" }),
      ({ name: "Third Person", email: "third@example.com" })
    ]
    property var sendAsAliases: []
    property string accountEmail: "me@example.com"

    function preferredSendAs(_recipients) { return null }
    function refreshRecipientContacts() {}
    function send(fields) {
      lastSent = fields
      sendPending = true
      return true
    }
    function undoSend() {
      if (!sendPending) return false
      sendPending = false
      return true
    }
  }

  Omamail.ComposeView {
    id: compose
    anchors.fill: parent
    service: mailService
    textColor: Qt.rgba(1, 1, 1, 1)
    backgroundColor: Qt.rgba(0.06, 0.06, 0.06, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    dimmerColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    popupBackgroundColor: Qt.rgba(0.13, 0.13, 0.13, 1)
    popupBorderColor: Qt.rgba(0.53, 0.53, 0.53, 1)
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "ComposeRecipients"
    when: windowShown

    function named(item, objectName) {
      if (!item) return null
      if (item.objectName === objectName) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = named(values[i], objectName)
        if (found) return found
      }
      return null
    }

    function init() {
      mailService.sendPending = false
      mailService.sending = false
      mailService.lastSent = null
      compose.reset()
      compose.opened = false
    }

    function test_arrows_choose_a_recipient_and_the_popup_stays_above_the_body() {
      compose.begin("new", null, "", [])
      compose.takeFocus()
      wait(30)

      var toField = named(compose, "compose-to-field")
      var picker = named(compose, "compose-to-suggestions")
      var fields = named(compose, "compose-fields")
      var body = named(compose, "compose-body")
      verify(toField)
      verify(picker)
      verify(fields)
      verify(body)

      toField.text = "example"
      toField.forceActiveFocus()
      tryCompare(picker, "visible", true)
      verify(fields.z > body.z, "the message body must not paint over suggestions")

      verify(toField.activeFocus)
      keyClick(Qt.Key_Down)
      compare(picker.currentIndex, 0)
      keyClick(Qt.Key_Down)
      compare(picker.currentIndex, 1)
      keyClick(Qt.Key_Return)
      compare(toField.text, "Second Person <second@example.com>")
      compare(picker.visible, false)
    }

    function test_tab_moves_from_subject_to_body() {
      compose.begin("new", null, "", [])
      var subjectField = named(compose, "compose-subject-field")
      var bodyEditor = named(compose, "compose-body-editor")
      verify(subjectField)
      verify(bodyEditor)

      subjectField.forceActiveFocus()
      verify(subjectField.activeFocus)
      keyClick(Qt.Key_Tab)
      verify(bodyEditor.activeFocus,
        "Tab from the subject must enter the message body")
    }

    function test_begin_draft_fills_the_mailto_fields() {
      compose.beginDraft({
        to: "jane@example.com",
        cc: "copy@example.com",
        bcc: "hidden@example.com",
        subject: "Lunch",
        body: "Tuesday?"
      })
      compare(compose.opened, true)
      compare(named(compose, "compose-to-field").text, "jane@example.com")
      compare(named(compose, "compose-cc-field").text, "copy@example.com")
      compare(compose.ccVisible, true)
      compare(named(compose, "compose-bcc-field").text, "hidden@example.com")
      compare(compose.bccVisible, true)
      compare(named(compose, "compose-subject-field").text, "Lunch")
      compare(named(compose, "compose-body-editor").text, "Tuesday?")
    }

    function test_queued_send_hides_compose_and_undo_restores_the_draft() {
      compose.begin("new", null, "", [])
      var toField = named(compose, "compose-to-field")
      var bodyEditor = named(compose, "compose-body-editor")
      verify(toField)
      verify(bodyEditor)
      toField.text = "person@example.com"
      bodyEditor.text = "Keep this draft intact"

      compose.submit()
      compare(mailService.sendPending, true)
      compare(compose.opened, false, "the mail view returns as soon as send is queued")
      compare(compose.parkedForSend, true)

      verify(mailService.undoSend())
      compose.resumePendingSend()
      compare(compose.opened, true)
      compare(compose.parkedForSend, false)
      compare(toField.text, "person@example.com")
      compare(bodyEditor.text, "Keep this draft intact")
    }
  }
}
