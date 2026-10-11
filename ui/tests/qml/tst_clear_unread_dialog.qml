import QtQuick
import QtTest
import "../../components" as Omamail
import "../../account/Model.js" as Model

Item {
  width: 500
  height: 400

  Omamail.ClearUnreadDialog {
    id: dialog
    textColor: Qt.rgba(1, 1, 1, 1)
    dimColor: textColor
    accentColor: textColor
    popupBackgroundColor: Qt.rgba(0, 0, 0, 1)
    popupBorderColor: textColor
    panelFontFamily: "monospace"
  }
  SignalSpy { id: confirmed; target: dialog; signalName: "confirmed" }

  TestCase {
    name: "ClearUnreadDialog"
    when: windowShown

    // A Popup's content is not a visual child of the item that declares it,
    // so findChild starts from the popup's own content item.
    function shown(name) {
      for (var i = 0; i < dialog.data.length; i++) {
        var popup = dialog.data[i]
        if (popup && popup.contentItem !== undefined && popup.opened !== undefined)
          return findChild(popup.contentItem, name)
      }
      return null
    }

    function init() {
      confirmed.clear()
      dialog.openFor(Model.clearUnreadConfirmation([
        { label: "perso", count: "234", known: true },
        { label: "work", count: "2020", known: true }
      ]))
      tryCompare(dialog, "opened", true)
    }
    function cleanup() {
      dialog.close()
      tryCompare(dialog, "opened", false)
    }

    function test_enter_confirms() {
      keyClick(Qt.Key_Return)
      compare(confirmed.count, 1, "focus starts on the action")
      tryCompare(dialog, "opened", false)
    }

    function test_tab_then_enter_cancels() {
      keyClick(Qt.Key_Tab)
      keyClick(Qt.Key_Return)
      tryCompare(dialog, "opened", false)
      compare(confirmed.count, 0)
    }

    function test_shift_tab_cycles_back_to_the_action() {
      keyClick(Qt.Key_Tab)
      keyClick(Qt.Key_Backtab)
      keyClick(Qt.Key_Enter)
      compare(confirmed.count, 1)
    }

    function test_escape_cancels() {
      keyClick(Qt.Key_Escape)
      tryCompare(dialog, "opened", false)
      compare(confirmed.count, 0)
    }

    function test_names_every_account_and_the_exact_total() {
      compare(shown("clear-unread-title").text, "Mark all read in every account?")
      compare(shown("clear-unread-label-0").text, "perso")
      compare(shown("clear-unread-count-1").text, "2020")
      compare(shown("clear-unread-confirm").text, "Mark 2254 read")
      compare(shown("clear-unread-extra"), null, "no cap left to explain")
    }
  }
}
