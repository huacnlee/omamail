import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// A signature is placed by the compose view and edited on the settings page,
// and neither half is reachable from node: one owns a text editor's contents,
// the other is a Repeater that rebuilds itself out of the write it causes.
Item {
  width: 900
  height: 700

  QtObject {
    id: mailAuth
    property bool credentialsPresent: true
    property string clientDescription: "test client"
  }

  QtObject {
    id: calendars
    property var sourceList: []
    property bool savingSource: false
    function addCalDavCalendar(_url, _user, _password) {}
    function removeCalendar(_id) {}
    function updateCalendarPassword(_id, _password) {}
  }

  QtObject {
    id: mailService
    property bool sendPending: false
    property bool sending: false
    property int sendSecondsRemaining: 10
    property var lastSent: null
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: []
    property string accountEmail: "me@example.com"
    property string activeAccountId: "me@example.com"
    property string activeSignature: ""

    property bool alwaysShowImages: false
    property bool alwaysRenderHeavyMessages: false
    property int undoSendSeconds: 10
    property var auth: mailAuth

    // What the settings page renders, and what a save has to come back as.
    property var accountSummaries: [({
      id: "me@example.com", email: "me@example.com", provider: "gmail",
      label: "me", signature: "Maarten\nmadra.nl", unread: 0, active: true,
      signedIn: true, busy: false, error: ""
    })]

    property string savedId: ""
    property string savedText: ""
    property int saveCount: 0

    function preferredSendAs(_recipients) { return null }
    function switchTo(_id) { return true }
    function refreshRecipientContacts() {}
    function send(_fields) { return true }
    function setAlwaysShowImages(_value) {}
    function setAlwaysRenderHeavyMessages(_value) {}
    function setUndoSendSeconds(_value) {}

    function setAccountSignature(id, text) {
      savedId = String(id || "")
      savedText = String(text || "")
      saveCount = saveCount + 1
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

  Omamail.SettingsPage {
    id: settings
    width: parent.width
    service: mailService
    calendarController: calendars
    textColor: Qt.rgba(1, 1, 1, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    urgentColor: Qt.rgba(1, 0.2, 0.2, 1)
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "Signature"
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

    function summary() {
      return ({
        threadId: "t1", messageId: "m1", subject: "Hello",
        fullTime: "1 Jan 2026", from: ({ email: "her@example.com", display: "Her" }),
        replyTo: null, to: [], cc: []
      })
    }

    function init() {
      mailService.activeSignature = ""
      mailService.saveCount = 0
      compose.reset()
      compose.opened = false
    }

    // The behaviour every account without a signature keeps.
    function test_an_unsigned_account_composes_as_before() {
      compose.begin("new", null, "", [])
      compare(named(compose, "compose-body-editor").text, "")

      compose.begin("reply", summary(), "Body", [])
      var replied = named(compose, "compose-body-editor").text
      compare(replied.indexOf("\n\n"), 0)
      verify(replied.indexOf("> Body") > 0)
    }

    function test_a_new_message_opens_signed() {
      mailService.activeSignature = "Maarten\nmadra.nl"
      compose.begin("new", null, "", [])
      compare(named(compose, "compose-body-editor").text, "\n\nMaarten\nmadra.nl")
    }

    // Under the reply, above the thread being answered.
    function test_a_reply_signs_above_the_quote() {
      mailService.activeSignature = "Maarten"
      compose.begin("reply", summary(), "Body", [])
      var text = named(compose, "compose-body-editor").text
      var sign = text.indexOf("Maarten")
      var quote = text.indexOf("> Body")
      verify(sign > 0, "the signature is placed")
      verify(quote > sign, "and the quoted message follows it")
    }

    // A draft already carries whatever it was written with. Reopening one must
    // not sign it a second time.
    function test_reopening_a_draft_does_not_sign_it_again() {
      mailService.activeSignature = "Maarten"
      compose.beginDraft({ mode: "draft", body: "Half written\n\nMaarten" }, "m1", [])
      compare(named(compose, "compose-body-editor").text, "Half written\n\nMaarten")
    }

    // A mailto: is a new message, so it is signed like one.
    function test_a_mailto_draft_is_signed() {
      mailService.activeSignature = "Maarten"
      compose.beginDraft({ mode: "new", to: "her@example.com", body: "" }, "", [])
      compare(named(compose, "compose-body-editor").text, "\n\nMaarten")
    }

    // ------------------------------------------------------------- settings

    function test_the_editor_opens_on_what_is_stored() {
      var editor = named(settings, "settings-signature-editor")
      verify(editor, "the settings page builds a signature field")
      compare(editor.text, "Maarten\nmadra.nl")
    }

    // Saved when the field is done with, not on every keystroke: the write
    // rebuilds these rows, and a save per character would do it under the
    // cursor.
    function test_the_field_saves_when_focus_leaves_it() {
      var editor = named(settings, "settings-signature-editor")
      verify(editor)
      editor.forceActiveFocus()
      editor.text = "Maarten\nmadra.nl\n+31"
      compare(mailService.saveCount, 0, "typing alone does not write")

      editor.focus = false
      compose.forceActiveFocus()
      tryCompare(mailService, "saveCount", 1)
      compare(mailService.savedId, "me@example.com")
      compare(mailService.savedText, "Maarten\nmadra.nl\n+31")
    }
  }
}
