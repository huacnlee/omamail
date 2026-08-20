import QtQuick
import QtQuick.Window
import QtQuick.Controls as QQC
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

  // The real `typing` in App.qml is answered by asking the window who holds the
  // focus, rather than by naming the fields — the naming is what missed nine of
  // them. This exercises that decision against real focus rather than a bool.
  function looksLikeTextEntry(item) {
    return !!item
        && item.hasOwnProperty("cursorPosition")
        && item.hasOwnProperty("selectedText")
        && item.hasOwnProperty("readOnly")
        && item.visible
        && !item.readOnly
  }
  readonly property bool typingByFocus:
    looksLikeTextEntry(host.Window.activeFocusItem)

  QQC.TextField { id: someField; width: 80 }
  QQC.Button { id: someButton; y: 40; text: "b" }

  // A compose that owns the focus only while it is up, exactly as App.qml has
  // it. Closing it leaves its field holding the window's focus while invisible.
  Item {
    id: compose
    property bool opened: false
    visible: opened
    focus: opened
    QQC.TextField { id: composeField; width: 80 }
  }

  TestCase {
    name: "KeyRouter"
    when: windowShown

    function init() {
      host.context = "list"
      host.typing = false
      host.overlay = false
      host.lastId = ""
      // Each case starts with the focus somewhere harmless. A field left
      // holding it swallows the printable keys the next case presses.
      compose.opened = false
      someButton.forceActiveFocus()
      wait(30)
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

    // A field nobody named. This is the whole point: the guard is answered by
    // the focus, so a text field added later is covered without being listed.
    function test_focus_on_any_text_field_counts_as_typing() {
      someField.forceActiveFocus()
      wait(30)
      compare(host.typingByFocus, true,
        "a field nobody added to a list still stands the letters down")
      someButton.forceActiveFocus()
      wait(30)
      compare(host.typingByFocus, false, "a button is not a text field")
    }

    // Closing compose used to leave its field holding the focus while hidden,
    // which pinned the typing guard true and stood every bare key down for the
    // rest of the session — Esc out of a reply and j/k were simply gone.
    function test_a_hidden_field_is_not_being_typed_into() {
      compose.opened = true
      composeField.forceActiveFocus()
      wait(30)
      compare(host.typingByFocus, true, "a field on screen is being typed into")
      compose.opened = false
      wait(30)
      compare(host.typingByFocus, false,
        "nobody is typing into a field they cannot see")
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
