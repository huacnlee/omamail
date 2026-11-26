import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// A right-click in the compose form: Cut, Copy, Paste and Select all on
// whichever field was clicked, with Paste going the way Ctrl+V goes — through
// the clipboard-image check first, then into the field that was clicked.
Item {
  width: 900
  height: 600

  QtObject {
    id: mailService
    property bool sendPending: false
    property bool sending: false
    property int sendSecondsRemaining: 10
    property var lastSent: null
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: [
      ({ email: "me@example.com", accountId: "me@example.com", label: "me" })
    ]
    property string accountEmail: "me@example.com"
    property string activeAccountId: "me@example.com"
    property var copied: []
    // Which field had focus each time the clipboard was asked for an image.
    property var pastedInto: []
    function preferredSendAs(_r) { return null }
    function switchTo(_id) { return true }
    function refreshRecipientContacts() {}
    function send(_f) { return true }
    function copyText(text) { copied = copied.concat([String(text)]); return true }
    function clipboardAttachment(_dir, callback) {
      var focused = compose.Window.activeFocusItem
      pastedInto = pastedInto.concat([focused ? String(focused.objectName) : ""])
      callback({ ok: false, error: "no-image" })
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
    popupBorderColor: Qt.rgba(0.3, 0.3, 0.3, 1)
    panelFontFamily: "sans"
  }

  TestCase {
    name: "ComposeTextMenu"
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

    function menu() {
      var found = named(compose, "compose-text-menu")
      verify(found, "the form owns a text menu")
      return found
    }

    function init() {
      compose.begin("new", null, "", [])
      mailService.copied = []
      mailService.pastedInto = []
      menu().close()
    }

    function cleanup() { menu().close() }

    function test_a_right_click_in_the_body_opens_an_editing_menu() {
      var body = named(compose, "compose-body-editor")
      verify(body)
      mouseClick(body, 20, 10, Qt.RightButton)
      wait(20)
      compare(menu().opened, true)
      compare(menu().editable, true)
      verify(menu().target === body)
    }

    function test_copy_in_the_body_goes_through_the_host() {
      var body = named(compose, "compose-body-editor")
      body.text = "draft words"
      body.select(0, 5)
      mouseClick(body, 20, 10, Qt.RightButton)
      wait(20)
      menu().copyRow.activated()
      compare(mailService.copied, ["draft"])
    }

    function test_paste_in_the_body_goes_the_way_ctrl_v_goes() {
      var body = named(compose, "compose-body-editor")
      mouseClick(body, 20, 10, Qt.RightButton)
      wait(20)
      menu().pasteRow.activated()
      wait(20)
      compare(mailService.pastedInto, ["compose-body-editor"])
    }

    function test_a_right_click_on_a_field_opens_the_menu_for_that_field() {
      var subject = named(compose, "compose-subject-field")
      verify(subject)
      subject.text = "a subject"
      mouseClick(subject, 20, subject.height / 2, Qt.RightButton)
      wait(20)
      compare(menu().opened, true)
      verify(menu().target === subject)
      menu().selectAllRow.activated()
      compare(subject.selectedText, "a subject")
    }

    function test_paste_lands_in_the_field_that_was_clicked() {
      var to = named(compose, "compose-to-field")
      verify(to)
      mouseClick(to, 20, to.height / 2, Qt.RightButton)
      wait(20)
      menu().pasteRow.activated()
      wait(20)
      compare(mailService.pastedInto, ["compose-to-field"])
    }
  }
}
