import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// Naming a mailbox.
//
// The field draws a box whether or not it can be typed into, which is how it
// shipped unusable twice. This types into it the way a person does — a click,
// then keys — rather than assigning `text` from the test, which would pass
// against a field nothing can reach.
Item {
  width: 700
  height: 500

  QtObject {
    id: fakeBackend
    property bool ready: true
    property string method: ""
    property var params: null
    property var callback: null
    function call(method, params, callback) {
      fakeBackend.method = method; fakeBackend.params = params; fakeBackend.callback = callback
    }
  }
  QtObject {
    id: fakeService

    property string activeAccountId: "a@example.org"
    property var accountSummaries: []
    property var accountSignatures: [
      { id: "a@example.org", email: "a@example.org", label: "", signature: "",
        provider: "imap", senderName: "" },
      { id: "b@example.net", email: "b@example.net", label: "Work", signature: "",
        provider: "gmail", senderName: "" },
      { id: "c@example.com", email: "c@example.com", label: "", signature: "",
        provider: "outlook", senderName: "Jane Example" }
    ]
    property bool backendCanNameSender: true
    property int undoSendSeconds: 10
    property bool unifiedCalendarView: false
    property bool notifyNewMail: true
    property string contentDirection: "auto"
    property var auth: null
    property var backend: fakeBackend
    property string signatureId: ""
    property string signatureHtml: ""
    function setAccountSignatureHtml(id, html) { signatureId = id; signatureHtml = html }

    // What the page wrote, and for which mailbox.
    property string namedId: ""
    property string namedText: ""
    property int nameWrites: 0

    function setAccountLabel(id, text) {
      namedId = String(id || "")
      namedText = String(text || "")
      nameWrites += 1
    }

    property string senderNamedId: ""
    property string senderNamedText: ""
    property int senderNameWrites: 0

    function setAccountSenderName(id, text) {
      senderNamedId = String(id || "")
      senderNamedText = String(text || "")
      senderNameWrites += 1
    }

    function setAccountSignature(_id, _text) {}
    function setUndoSendSeconds(_value) {}
    function setUnifiedCalendarView(_value) {}
    function setNotifyNewMail(_value) {}
    function setContentDirection(_value) {}
    function setAlwaysRenderHeavyMessages(_value) {}
  }

  Omamail.SettingsPage {
    id: page
    width: parent.width
    service: fakeService
    calendarController: null
    textColor: Qt.rgba(0.1, 0.1, 0.1, 1)
    dimColor: Qt.rgba(0.45, 0.45, 0.45, 1)
    accentColor: Qt.rgba(0.8, 0.4, 0, 1)
    urgentColor: Qt.rgba(0.8, 0.1, 0.1, 1)
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "SettingsName"
    when: windowShown

    function find(objectName, item) {
      var node = item === undefined ? page : item
      if (!node) return null
      if (node.objectName === objectName) return node
      var children = node.children || []
      for (var i = 0; i < children.length; i++) {
        var found = find(objectName, children[i])
        if (found) return found
      }
      return null
    }

    function nameField() {
      return find("settings-name-editor")
    }

    // Laid out before it is clicked: switching mailboxes in `init` can show
    // or hide the field, and the column places it on the next polish.
    function senderField() {
      var field = find("settings-sender-name-editor")
      if (field && field.visible) waitForPolish(field.parent)
      return field
    }

    function init() {
      fakeService.backendCanNameSender = true
      page.selectNameAccount("a@example.org")
      // The fake service keeps nothing it is given, so the fields go back to
      // the stored values rather than carrying one test's typing into the next.
      page.showNameAccount(page.signatureAccount("a@example.org"))
      fakeService.namedId = ""
      fakeService.namedText = ""
      fakeService.nameWrites = 0
      fakeService.senderNamedId = ""
      fakeService.senderNamedText = ""
      fakeService.senderNameWrites = 0
    }

    function test_signature_import_waits_for_native_result_and_keeps_original_account() {
      fakeService.signatureHtml = ""
      page.selectedSignatureAccountId = "a@example.org"
      page.importStage = "read"
      page.importing = true
      page.finishImport(JSON.stringify({ok: true, mimeType: "image/png", data: "iVBORw0KGgoAAA=="}))
      compare(fakeBackend.method, "message.signatureImport")
      compare(fakeBackend.params.kind, "image")
      compare(page.importing, true)
      compare(fakeService.signatureHtml, "")
      page.selectedSignatureAccountId = "b@example.net"
      fakeBackend.callback({html: "<p>native</p>", plain: "", images: 1, dropped: 0, problem: ""}, null)
      compare(fakeService.signatureId, "a@example.org")
      compare(fakeService.signatureHtml, "<p>native</p>")
      compare(page.importing, false)
    }

    function test_the_field_is_on_the_page_and_starts_from_the_stored_name() {
      var field = nameField()
      verify(field, "the name field has to exist to be typed into")
      verify(field.width > 0)
      verify(field.height > 0)
      compare(field.enabled, true)
      compare(field.readOnly, false, "a field that cannot be written to is a label")
      compare(field.text, "", "this mailbox has no name yet")
      compare(field.placeholderText, "",
        "an empty field is empty: every prompt tried here was read as the name")
    }

    // The whole fault, as a test: a click has to leave the keyboard in the
    // field. Everything else about naming a mailbox is downstream of this.
    function test_clicking_the_field_gives_it_the_keyboard() {
      var field = nameField()
      verify(field)
      mouseClick(field, field.width / 2, field.height / 2)
      verify(field.activeFocus, "a click must put the cursor in the field")
    }

    function test_typing_into_it_reaches_the_mailbox_it_names() {
      var field = nameField()
      verify(field)
      mouseClick(field, field.width / 2, field.height / 2)
      verify(field.activeFocus)

      keyClick(Qt.Key_P)
      keyClick(Qt.Key_R)
      keyClick(Qt.Key_I)
      compare(field.text, "pri", "the keys have to land in the field")

      // Saved on the way out rather than on every keystroke: three keys, and
      // nothing written until the field is left or Return is pressed.
      fakeService.nameWrites = 0
      keyClick(Qt.Key_Return)
      compare(fakeService.nameWrites, 1)
      compare(fakeService.namedId, "a@example.org")
      compare(fakeService.namedText, "pri")
    }

    // The picker chooses which mailbox is being named; it is not the name.
    function test_the_picker_moves_the_field_to_another_mailbox() {
      compare(page.selectedNameAccountId, "a@example.org")
      compare(nameField().text, "")

      page.selectNameAccount("b@example.net")
      compare(page.selectedNameAccountId, "b@example.net")
      compare(nameField().text, "Work", "the field shows that mailbox's own name")
    }

    // Leaving the field saves it, so clicking straight into the picker does
    // not lose what was typed.
    function test_moving_away_saves_what_was_typed() {
      var field = nameField()
      mouseClick(field, field.width / 2, field.height / 2)
      keyClick(Qt.Key_X)
      compare(field.text, "x")

      page.selectNameAccount("b@example.net")
      compare(fakeService.nameWrites, 1)
      compare(fakeService.namedId, "a@example.org",
        "what was typed belongs to the mailbox it was typed for")
      compare(fakeService.namedText, "x")
    }

    // ---------------------------------------------------------- sender name

    // An IMAP mailbox has no server to name its sender, so the name is set
    // here, and typed the way a person types it.
    function test_an_imap_mailbox_takes_a_sender_name() {
      var field = senderField()
      verify(field, "the sender name field has to exist")
      verify(field.visible, "an IMAP mailbox's From name is set here")
      compare(field.text, "")
      mouseClick(field, field.width / 2, field.height / 2)
      verify(field.activeFocus, "a click must put the cursor in the field")
      keyClick(Qt.Key_J)
      keyClick(Qt.Key_O)
      compare(fakeService.senderNameWrites, 0, "nothing is written per keystroke")
      keyClick(Qt.Key_Return)
      compare(fakeService.senderNameWrites, 1)
      compare(fakeService.senderNamedId, "a@example.org")
      compare(fakeService.senderNamedText, "jo")
    }

    // Leaving for another mailbox saves the name for the one it was typed for.
    function test_moving_away_saves_the_sender_name_where_it_was_typed() {
      var field = senderField()
      mouseClick(field, field.width / 2, field.height / 2)
      keyClick(Qt.Key_Z)
      page.selectNameAccount("c@example.com")
      compare(fakeService.senderNamedId, "a@example.org")
      compare(fakeService.senderNamedText, "z")
      compare(field.text, "Jane Example", "an Outlook mailbox shows its own stored name")
      verify(field.visible)
    }

    // A server-named mailbox would ignore the field, so there is none.
    function test_a_server_named_mailbox_has_no_sender_name_field() {
      page.selectNameAccount("b@example.net")
      verify(!senderField().visible, "Gmail names the sender itself")
      compare(page.senderNameEditable, false)
      page.saveSenderName()
      compare(fakeService.senderNameWrites, 0, "nothing is written for it either")
    }

    // A backend older than API 7 sends the bare address whatever is stored, so
    // the field waits for one that writes the name.
    function test_an_older_backend_hides_the_sender_name_field() {
      fakeService.backendCanNameSender = false
      verify(!senderField().visible)
      fakeService.backendCanNameSender = true
      verify(senderField().visible)
    }
  }
}
