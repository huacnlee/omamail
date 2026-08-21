import QtQuick
import QtQuick.Controls as QQC
import QtTest

// Why the account switcher answers its own keys, which is the opposite of what
// every other component in this window does.
//
// The rule is that a window `Shortcut` beats a focused item's `Keys` handler,
// so a local one looks live and never runs — that is the whole reason
// `KeyRouter` exists. An open `QQC.Popup` inverts it: the popup takes the key
// before the shortcut map sees it, with `focus` true or false, bare key or
// modified. So inside a popup the `KeyRouter` binding is the one that would
// look live and never run.
//
// Both halves are here because the inversion is the entire justification for
// the exception, and a rule whose reason is untested is a rule somebody tidies
// away. The switcher itself cannot be built in this runner — it imports
// `qs.Ui`, which only exists inside the shell process — so what is asserted is
// the Qt behaviour the switcher is shaped around.
Item {
  id: host
  width: 300; height: 200

  property string windowShortcut: ""
  property string localHandler: ""

  Shortcut { sequence: "j"; onActivated: host.windowShortcut = "j" }
  Shortcut { sequence: "Alt+A"; onActivated: host.windowShortcut = "alt-a" }

  QQC.Popup {
    id: focusedPopup
    width: 100; height: 80
    modal: false
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    contentItem: Item {
      focus: true
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_J) { host.localHandler = "j"; event.accepted = true }
      }
    }
  }

  // Not focused, and it makes no difference: this is the version somebody
  // reaches for on the way to "then the router can drive it".
  QQC.Popup {
    id: unfocusedPopup
    width: 100; height: 80
    modal: false
    focus: false
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
  }

  TestCase {
    name: "PopupKeys"
    when: windowShown

    function init() {
      host.windowShortcut = ""
      host.localHandler = ""
      focusedPopup.close()
      unfocusedPopup.close()
      wait(30)
    }

    function test_the_window_owns_the_keys_while_no_popup_is_up() {
      keyClick(Qt.Key_J)
      compare(host.windowShortcut, "j")
      keyClick(Qt.Key_A, Qt.AltModifier)
      compare(host.windowShortcut, "alt-a")
    }

    function test_an_open_popup_takes_every_key_before_the_shortcut_map() {
      focusedPopup.open()
      wait(60)
      verify(focusedPopup.opened)
      keyClick(Qt.Key_J)
      compare(host.windowShortcut, "", "a bare key does not reach the window")
      keyClick(Qt.Key_A, Qt.AltModifier)
      compare(host.windowShortcut, "", "and neither does a modified one")
    }

    function test_focus_false_changes_nothing() {
      unfocusedPopup.open()
      wait(60)
      verify(unfocusedPopup.opened)
      keyClick(Qt.Key_J)
      compare(host.windowShortcut, "",
        "so there is no version of this a KeyRouter binding could drive")
    }

    function test_a_keys_handler_on_the_content_item_is_what_works() {
      focusedPopup.open()
      wait(60)
      keyClick(Qt.Key_J)
      compare(host.localHandler, "j")
      compare(host.windowShortcut, "")
    }

    function test_and_the_window_gets_them_back_when_it_closes() {
      focusedPopup.open()
      wait(60)
      focusedPopup.close()
      wait(60)
      keyClick(Qt.Key_J)
      compare(host.windowShortcut, "j")
    }
  }
}
