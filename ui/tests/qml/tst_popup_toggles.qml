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
    property var recipientContacts: [({ name: "First Person", email: "first@example.com" })]
    property var sendAsAliases: []
    property var sendIdentities: [
      ({ email: "me@example.com", accountId: "me@example.com", label: "me" }),
      ({ email: "alt@example.com", accountId: "me@example.com", label: "alt" })
    ]
    property string accountEmail: "me@example.com"
    property string activeAccountId: "me@example.com"
    function preferredSendAs(_r) { return null }
    function switchTo(_id) { return true }
    function refreshRecipientContacts() {}
    function send(_f) { return true }
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
    name: "PopupToggles"
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

    // A popup that closes on a press outside itself is already closed by the
    // press that reaches the control which opened it, so a plain
    // `opened ? close() : open()` reopens it on the release and the control can
    // never put its own popup away. Both of these read as a flicker.
    function test_the_from_menu_toggles_shut() {
      compose.begin("new", null, "", [])
      var button = named(compose, "compose-from-button")
      verify(button)
      mouseClick(button)
      wait(50)
      var openedOnce = compose.fromMenuOpened
      mouseClick(button)
      wait(50)
      compare([openedOnce, compose.fromMenuOpened], [true, false])
    }

    function test_the_contacts_button_toggles_shut() {
      compose.begin("new", null, "", [])
      var button = named(compose, "compose-contacts-button")
      verify(button)
      mouseClick(button)
      wait(50)
      var openedOnce = compose.contactsPickerOpened
      mouseClick(button)
      wait(50)
      compare([openedOnce, compose.contactsPickerOpened], [true, false])
    }
  }
}
