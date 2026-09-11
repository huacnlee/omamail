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
    property var sendIdentities: []
    property string accountEmail: "me@example.com"
    property string activeAccountId: "me@example.com"
    property string switchedTo: ""

    function preferredSendAs(_recipients) { return null }
    function switchTo(id) {
      switchedTo = String(id || "")
      activeAccountId = switchedTo
      return true
    }
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
      mailService.sendIdentities = []
      mailService.activeAccountId = "me@example.com"
      mailService.switchedTo = ""
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

    function test_from_picker_switches_the_sending_account() {
      mailService.sendIdentities = [
        { accountId: "me@example.com", email: "me@example.com",
          displayName: "", label: "me" },
        { accountId: "imap:home@example.com", email: "home@example.com",
          displayName: "", label: "home" }
      ]
      compose.beginDraft({
        to: "jane@example.com", cc: "", bcc: "", subject: "Hi", body: "There"
      })
      wait(30)
      compare(compose.canChooseFrom, true)
      var button = named(compose, "compose-from-button")
      compare(button.enabled, true)
      mouseClick(button)
      wait(30)
      compare(button.selected, true,
        "clicking From must open the mailbox menu")
      compose.chooseFrom(mailService.sendIdentities[1])
      compare(compose.fromEmail, "home@example.com")
      compare(mailService.switchedTo, "imap:home@example.com")
      compare(named(compose, "compose-to-field").text, "jane@example.com",
        "changing From must keep the draft")
    }

    function test_bcc_toggle_shows_the_field_and_submit_sends_it() {
      compose.begin("new", null, "", [])
      compare(compose.bccVisible, false)
      var toggle = named(compose, "compose-bcc-toggle")
      var bccField = named(compose, "compose-bcc-field")
      verify(toggle)
      verify(bccField)
      toggle.clicked()
      compare(compose.bccVisible, true)
      bccField.text = "hidden@example.com"
      named(compose, "compose-to-field").text = "jane@example.com"
      named(compose, "compose-body-editor").text = "Hello"
      compose.submit()
      compare(mailService.lastSent.bcc, "hidden@example.com")
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

    function test_a_pending_send_keeps_a_new_reply_editable() {
      compose.begin("new", null, "", [])
      named(compose, "compose-to-field").text = "first@example.com"
      named(compose, "compose-body-editor").text = "First message"
      compose.submit()

      compose.begin("reply", ({
        messageId: "<second@example.com>",
        threadId: "thread-2",
        subject: "Second subject",
        from: ({ email: "second@example.com", display: "Second Person" }),
        replyTo: ({ email: "second@example.com" }),
        to: [],
        cc: [],
        fullTime: "today"
      }), "Second body", [])

      compare(compose.opened, true)
      compare(compose.parkedForSend, true,
        "the first draft must remain available to undo")
      compare(named(compose, "compose-to-field").enabled, true)
      compare(named(compose, "compose-body-editor").enabled, true)
    }

    function test_undo_does_not_discard_the_new_reply() {
      compose.begin("new", null, "", [])
      named(compose, "compose-to-field").text = "first@example.com"
      named(compose, "compose-body-editor").text = "First message"
      compose.submit()

      compose.beginDraft({
        to: "second@example.com", cc: "", bcc: "",
        subject: "Second subject", body: "Second message"
      })
      verify(mailService.undoSend())
      verify(compose.resumePendingSend())
      compare(named(compose, "compose-to-field").text, "first@example.com")
      compare(named(compose, "compose-body-editor").text, "First message")

      compose.finish()
      compare(compose.opened, true,
        "closing the restored send must return to the new reply")
      compare(named(compose, "compose-to-field").text, "second@example.com")
      compare(named(compose, "compose-subject-field").text, "Second subject")
      compare(named(compose, "compose-body-editor").text, "Second message")
    }

    function test_delivery_does_not_close_the_new_reply() {
      compose.begin("new", null, "", [])
      named(compose, "compose-to-field").text = "first@example.com"
      named(compose, "compose-body-editor").text = "First message"
      compose.submit()

      compose.beginDraft({
        to: "second@example.com", cc: "", bcc: "",
        subject: "Second subject", body: "Second message"
      })
      mailService.sendPending = false
      verify(compose.completePendingSend())
      compare(compose.opened, true)
      compare(named(compose, "compose-to-field").text, "second@example.com")
      compare(named(compose, "compose-body-editor").text, "Second message")
    }

    function test_contacts_button_and_picker() {
      compose.begin("new", null, "", [])
      var contactsBtn = named(compose, "compose-contacts-button")
      var picker = named(compose, "compose-contacts-picker")
      verify(contactsBtn)
      verify(picker)

      picker.contactChosen({ name: "Alice", email: "alice@example.com" }, "to")
      compare(named(compose, "compose-to-field").text, "Alice <alice@example.com>")

      picker.contactChosen({ name: "Bob", email: "bob@example.com" }, "cc")
      compare(compose.ccVisible, true)
      compare(named(compose, "compose-cc-field").text, "Bob <bob@example.com>")
    }
  }
}

