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

    // Live mailbox state. Replaced on every poll, which is the point of the
    // poll test below.
    property var accountSummaries: [({
      id: "me@example.com", email: "me@example.com", provider: "gmail",
      label: "me", unread: 0, active: true, signedIn: true, busy: false, error: ""
    })]

    // What the signature field is built over: only what a signature edit
    // changes.
    property var accountSignatures: [({
      id: "me@example.com", email: "me@example.com", signature: "Maarten\nmadra.nl"
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
      // Rebuilt rather than assigned back field by field: replacing the list is
      // what rebuilds the Repeater's rows, which is how a test that typed into
      // the field hands the next one a field holding what is stored.
      mailService.accountSummaries = [({
        id: "me@example.com", email: "me@example.com", provider: "gmail",
        label: "me", unread: 0, active: true, signedIn: true, busy: false, error: ""
      })]
      // Emptied first, so the next test is handed a field built from what is
      // stored rather than whatever the last one typed into it.
      mailService.accountSignatures = []
      wait(30)
      mailService.accountSignatures = [({
        id: "me@example.com", email: "me@example.com", signature: "Maarten\nmadra.nl"
      })]
      wait(30)
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
    // A compose window nobody wrote in is not a draft. The body holds the
    // sign-off it was opened with, which `trim()` alone reads as content — so
    // Escape used to upload a draft containing only the user's own signature,
    // once per abandoned compose.
    function test_an_untouched_signed_compose_is_not_a_draft() {
      mailService.activeSignature = "Maarten"
      compose.begin("new", null, "", [])
      compare(compose.hasMeaningfulDraft(), false)

      compose.beginDraft({ mode: "new", body: "" }, "", [])
      compare(compose.hasMeaningfulDraft(), false, "a mailto: is the same window")

      compose.begin("new", null, "", [])
      var editor = named(compose, "compose-body-editor")
      editor.text = "Something" + editor.text
      compare(compose.hasMeaningfulDraft(), true, "a sentence above it is a draft")
    }

    // A reply is a draft on its quote alone, signed or not.
    function test_a_reply_is_still_a_draft() {
      mailService.activeSignature = "Maarten"
      compose.begin("reply", summary(), "Body", [])
      compare(compose.hasMeaningfulDraft(), true)
    }

    // The sending mailbox reaches every account through the From menu, and the
    // sign-off has to follow it — the whole reason the field is per-account.
    function test_changing_the_sending_mailbox_re_signs_an_untouched_body() {
      mailService.activeSignature = "Maarten"
      compose.begin("new", null, "", [])
      var editor = named(compose, "compose-body-editor")
      compare(editor.text, "\n\nMaarten")

      mailService.activeSignature = "Work Signature"
      compare(editor.text, "\n\nWork Signature")
    }

    function test_changing_it_does_not_overwrite_what_was_typed() {
      mailService.activeSignature = "Maarten"
      compose.begin("new", null, "", [])
      var editor = named(compose, "compose-body-editor")
      editor.text = "Half a sentence\n\nMaarten"

      mailService.activeSignature = "Work Signature"
      compare(editor.text, "Half a sentence\n\nMaarten")
    }

    // The settings field used to be built over accountSummaries, which a poll
    // replaces twice a cycle with no account having changed — destroying the
    // delegate, and the text and the keyboard with it, mid-word.
    function test_a_poll_does_not_disturb_a_signature_being_typed() {
      var editor = named(settings, "settings-signature-editor")
      verify(editor)
      editor.forceActiveFocus()
      editor.text = "Half a sign-"

      mailService.accountSummaries = [({
        id: "me@example.com", email: "me@example.com", provider: "gmail",
        label: "me", unread: 0, active: true, signedIn: true,
        busy: true, error: ""
      })]
      wait(30)

      var live = named(settings, "settings-signature-editor")
      compare(live.text, "Half a sign-", "the field is not refilled under the cursor")
      verify(live.activeFocus, "and the keyboard is still in it")
      compare(mailService.saveCount, 0, "a poll is not a save")
    }

    // First run has no signed-in mailbox and so no field. A heading and an
    // explanation with nothing between them is not a setting.
    function test_the_section_is_absent_until_a_mailbox_exists() {
      var section = named(settings, "settings-signature-section")
      verify(section)
      compare(section.visible, true)

      mailService.accountSignatures = []
      wait(30)
      compare(section.visible, false)
    }

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
