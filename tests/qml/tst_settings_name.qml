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
    id: fakeService

    property string activeAccountId: "a@example.org"
    property var accountSummaries: []
    property var accountSignatures: [
      { id: "a@example.org", email: "a@example.org", label: "", signature: "" },
      { id: "b@example.net", email: "b@example.net", label: "Work", signature: "" }
    ]
    property int undoSendSeconds: 10
    property bool unifiedCalendarView: false
    property bool notifyNewMail: true
    property string contentDirection: "auto"
    property var auth: null

    // What the page wrote, and for which mailbox.
    property string namedId: ""
    property string namedText: ""
    property int nameWrites: 0

    function setAccountLabel(id, text) {
      namedId = String(id || "")
      namedText = String(text || "")
      nameWrites += 1
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

    function init() {
      fakeService.namedId = ""
      fakeService.namedText = ""
      fakeService.nameWrites = 0
      page.selectNameAccount("a@example.org")
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
  }
}
