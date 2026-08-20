import QtQuick
import QtTest
import "../../components" as Omamail

// The router turns the table into Shortcuts. What matters here is that the
// table's rules actually reach the keyboard: context gates a key, typing stands
// bare keys down but leaves modified ones alone, and Escape arrives as a
// Shortcut rather than travelling by focus — which is what made it depend on
// where the user had last clicked.
Item {
  id: host
  width: 300; height: 200

  property string lastId: ""
  property string context: "list"
  property bool typing: false
  property bool overlay: false

  Omamail.KeyRouter {
    context: host.context
    typing: host.typing
    overlay: host.overlay
    onTriggered: function(id) { host.lastId = id }
  }

  TestCase {
    name: "KeyRouter"
    when: windowShown

    function init() {
      host.context = "list"
      host.typing = false
      host.overlay = false
      host.lastId = ""
      wait(20)
    }

    function test_a_bare_letter_fires_in_its_context() {
      keyClick(Qt.Key_E)
      compare(host.lastId, "archive")
    }

    function test_the_same_letter_is_dead_on_a_form() {
      host.context = "page"
      wait(20)
      keyClick(Qt.Key_E)
      compare(host.lastId, "", "e is not archive on a settings form")
    }

    function test_typing_stands_bare_keys_down() {
      host.typing = true
      wait(20)
      keyClick(Qt.Key_E)
      compare(host.lastId, "", "e belongs to the field being typed in")
    }

    function test_typing_leaves_modified_keys_alone() {
      // The same row as the bare `/`, which is standing down at this moment.
      host.typing = true
      wait(20)
      keyClick(Qt.Key_K, Qt.ControlModifier)
      compare(host.lastId, "search")
    }

    function test_escape_is_a_shortcut_not_a_focus_handler() {
      host.typing = true
      wait(20)
      keyClick(Qt.Key_Escape)
      compare(host.lastId, "back",
        "Escape must not depend on who holds the focus")
    }

    function test_an_overlay_stands_the_mailbox_down() {
      host.overlay = true
      wait(20)
      keyClick(Qt.Key_E)
      compare(host.lastId, "", "nothing acts on mail behind the shortcut sheet")
    }

    function test_but_the_sheets_own_key_still_closes_it() {
      host.overlay = true
      wait(20)
      keyClick(Qt.Key_Question)
      compare(host.lastId, "help")
    }

    function test_a_reader_key_is_dead_in_the_list() {
      keyClick(Qt.Key_R)
      compare(host.lastId, "", "there is nothing to reply to from the list")
    }

    function test_and_live_in_the_reader() {
      host.context = "reader"
      wait(20)
      keyClick(Qt.Key_R)
      compare(host.lastId, "reply")
    }
  }
}
