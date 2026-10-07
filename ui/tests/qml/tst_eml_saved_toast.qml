import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// The saved-file card: it appears when the service says a .eml was written,
// names the file and the folder, opens that folder on request, and goes away
// on its own or when dismissed.
Item {
  id: window
  width: 900
  height: 600

  QtObject {
    id: fakeService
    property var opened: []
    signal emlSaved(var result)
    function openExternal(target) { opened = opened.concat([String(target)]); return true }
  }

  // Stands in for App.qml: the card reads the service and the theme off it.
  QtObject {
    id: fakeApp
    property var service: fakeService
    property color foreground: Qt.rgba(1, 1, 1, 1)
    property color dim: Qt.rgba(0.6, 0.6, 0.6, 1)
    property color accent: Qt.rgba(1, 0.5, 0, 1)
    property color popupBackground: Qt.rgba(0.1, 0.1, 0.1, 1)
    property color popupBorder: Qt.rgba(0.4, 0.4, 0.4, 1)
    property string fontFamily: "monospace"
  }

  Omamail.EmlSavedToast {
    id: toast
    app: fakeApp
    timeout: 300
  }

  TestCase {
    name: "EmlSavedToast"
    when: windowShown

    function named(item, name) {
      if (!item) return null
      if (item.objectName === name) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var hit = named(values[i], name)
        if (hit) return hit
      }
      return null
    }

    function saved(path, filename) {
      fakeService.emlSaved({ ok: true, path: path, filename: filename, bytes: 10 })
      wait(10)
    }

    function init() {
      toast.clearance = 0
      toast.dismiss()
      fakeService.opened = []
    }

    function test_nothing_shows_until_a_file_is_saved() {
      compare(toast.visible, false)
    }

    function test_a_save_names_the_file_and_the_folder() {
      saved("/srv/mail/Project update (2).eml", "Project update (2).eml")
      compare(toast.visible, true)
      compare(named(toast, "eml-saved-name").text, "Saved Project update (2).eml")
      compare(named(toast, "eml-saved-folder").text, "in /srv/mail")
      verify(toast.x + toast.width <= window.width, "the card stays inside the window")
      verify(toast.y + toast.height <= window.height)
    }

    function test_the_card_sits_above_the_reader_toolbar() {
      saved("/srv/mail/Note.eml", "Note.eml")
      var resting = toast.y
      toast.clearance = 44
      verify(toast.y + toast.height <= window.height - 28 - 44,
        "the card clears the status line and the toolbar above it")
      compare(toast.y, resting - 44)
      toast.clearance = 0
    }

    function test_open_folder_opens_the_folder_and_closes_the_card() {
      saved("/srv/mail/Note.eml", "Note.eml")
      var button = named(toast, "eml-saved-open-folder")
      verify(button && button.visible)
      button.clicked()
      compare(fakeService.opened, ["/srv/mail"], "the folder, never the file itself")
      compare(toast.visible, false)
    }

    function test_dismiss_and_timeout_both_hide_it() {
      saved("/srv/mail/Note.eml", "Note.eml")
      named(toast, "eml-saved-close").clicked()
      compare(toast.visible, false)
      saved("/srv/mail/Note.eml", "Note.eml")
      compare(toast.visible, true)
      tryCompare(toast, "visible", false, 2000, "it leaves on its own")
    }

    function test_a_second_save_replaces_the_first() {
      saved("/srv/mail/One.eml", "One.eml")
      saved("/srv/other/Two.eml", "Two.eml")
      compare(named(toast, "eml-saved-name").text, "Saved Two.eml")
      compare(toast.folder, "/srv/other")
    }
  }
}
