import QtQuick
import QtQuick.Window
import QtQuick.Controls as QQC
import QtTest
import "../../components" as Omamail

// The keyboard belongs to the application, and the context says what a key
// means where. Two things are exercised: that a key is live only in the
// contexts its row names, and that changing context takes the keyboard with it
// — the part that, kept separate, let a dismissed field eat every key.
Item {
  id: host
  width: 300; height: 200

  property string lastId: ""
  property string lastSequence: ""
  property string context: "list"
  property bool overlay: false

  Omamail.KeyRouter {
    context: host.context
    overlay: host.overlay
    onTriggered: function(id, sequence) {
      host.lastId = id
      host.lastSequence = sequence
    }
  }

  readonly property Item focusItem: host.Window.activeFocusItem

  // Stands in for the window's focus scope: a home for the keyboard, and a
  // field that is only on screen while its context is.
  FocusScope {
    id: scope
    anchors.fill: parent
    focus: true

    Item { id: keyboardHome; width: 1; height: 1 }

    Item {
      id: compose
      anchors.fill: parent
      property bool opened: false
      visible: opened
      QQC.TextField { id: composeField; width: 80 }
    }

    function applyContextFocus() {
      if (host.context === "compose") composeField.forceActiveFocus()
      else keyboardHome.forceActiveFocus()
    }
  }

  TestCase {
    name: "KeyRouter"
    when: windowShown

    function init() {
      host.context = "list"
      host.overlay = false
      host.lastId = ""
      host.lastSequence = ""
      compose.opened = false
      scope.applyContextFocus()
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

    function test_a_bare_letter_is_dead_in_a_draft() {
      host.context = "compose"
      wait(20)
      keyClick(Qt.Key_E)
      compare(host.lastId, "", "e is a letter in a sentence, not archive")
    }

    function test_a_bare_letter_is_dead_in_a_query() {
      host.context = "search"
      wait(20)
      keyClick(Qt.Key_E)
      compare(host.lastId, "", "e is a letter in a query")
    }

    function test_a_modified_key_still_reaches_a_draft() {
      host.context = "compose"
      wait(20)
      keyClick(Qt.Key_K, Qt.ControlModifier)
      compare(host.lastId, "searchAnywhere",
        "search is reachable from inside a draft, which is why it is bound twice")
    }

    function test_escape_is_the_way_out_of_every_context() {
      var contexts = ["list", "reader", "search", "compose", "page"]
      for (var i = 0; i < contexts.length; i++) {
        host.context = contexts[i]
        host.lastId = ""
        wait(20)
        keyClick(Qt.Key_Escape)
        compare(host.lastId, "back", "Escape must leave " + contexts[i])
      }
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

    // A sheet taller than the window is the reason: behind it, moving moves
    // the sheet. App.qml is what sends it there; the router only has to keep
    // the keys alive.
    function test_moving_survives_an_overlay_so_it_can_walk_one() {
      host.overlay = true
      wait(20)
      keyClick(Qt.Key_J)
      compare(host.lastId, "cursorDown")
    }

    // Moving is deliberately not opening, so with a message up there has to be
    // a key that says open — otherwise reading the next one means leaving the
    // reader and coming back.
    function test_open_works_from_the_reader_too() {
      host.context = "reader"
      wait(20)
      keyClick(Qt.Key_O)
      compare(host.lastId, "open")
      host.lastId = ""
      keyClick(Qt.Key_Return)
      compare(host.lastId, "open")
    }

    // Answering works from the list as well as the reader: the row's own menu
    // has always offered it, and the keyboard was able to do less than a
    // right-click. What is opened first is App.qml's job.
    function test_answering_works_from_the_list_and_the_reader() {
      keyClick(Qt.Key_R)
      compare(host.lastId, "reply", "from the list")
      host.context = "reader"
      host.lastId = ""
      wait(20)
      keyClick(Qt.Key_R)
      compare(host.lastId, "reply", "and from the reader")
    }

    // Zoom is not: there is no message body to size until one is open.
    // A row of ten keys, told apart by which one fired. No chord: Qt puts a
    // 400ms deadline on an unfinished sequence, which is what the mailboxes
    // used to be reached through and why half the presses did nothing.
    function test_a_digit_names_the_mailbox_it_opens() {
      keyClick(Qt.Key_3, Qt.AltModifier)
      compare(host.lastId, "goMailbox")
      compare(host.lastSequence, "Alt+3")
    }

    function test_the_tenth_mailbox_is_the_zero_key() {
      keyClick(Qt.Key_0, Qt.AltModifier)
      compare(host.lastId, "goMailbox")
      compare(host.lastSequence, "Alt+0")
    }

    function test_a_digit_is_dead_in_a_draft() {
      host.context = "compose"
      wait(20)
      keyClick(Qt.Key_3, Qt.AltModifier)
      compare(host.lastId, "", "typing a number into a reply is not going anywhere")
    }

    // One press, not a chord: it opens a list the keyboard then walks, so
    // getting to it should not itself be a sequence.
    function test_the_switcher_opens_on_one_press() {
      keyClick(Qt.Key_A, Qt.AltModifier)
      compare(host.lastId, "switchAccount")
    }

    function test_the_bare_letter_still_means_reply_all() {
      keyClick(Qt.Key_A)
      compare(host.lastId, "replyAll", "Alt+A did not take the letter with it")
    }

    function test_the_switcher_key_is_dead_in_a_draft() {
      host.context = "compose"
      wait(20)
      keyClick(Qt.Key_A, Qt.AltModifier)
      compare(host.lastId, "", "switching is a mailbox action, not a draft one")
    }

    function test_a_reader_only_key_is_dead_in_the_list() {
      keyClick(Qt.Key_0, Qt.ControlModifier)
      compare(host.lastId, "", "nothing to zoom from the list")
      host.context = "reader"
      host.lastId = ""
      wait(20)
      keyClick(Qt.Key_0, Qt.ControlModifier)
      compare(host.lastId, "zoomReset")
    }

    // The mechanism, not a key: leaving a text-entry context has to take the
    // keyboard with it. Handing it back to the focus scope does not — that
    // re-elects the scope's current focus item, which is the field being left,
    // so the dismissed field kept swallowing j and k for the rest of the
    // session. It has to land on a plain Item.
    function test_leaving_a_draft_takes_the_keyboard_with_it() {
      host.context = "compose"
      compose.opened = true
      scope.applyContextFocus()
      wait(30)
      compare(host.focusItem, composeField, "the draft is what is typed into")

      compose.opened = false
      host.context = "list"
      scope.applyContextFocus()
      wait(30)
      verify(host.focusItem !== composeField,
        "a dismissed field must not keep the keyboard")
      compare(host.focusItem, keyboardHome, "which parks on the home item")

      host.lastId = ""
      keyClick(Qt.Key_J)
      compare(host.lastId, "cursorDown",
        "and j reaches the mailbox again, which is the whole point")
    }
  }
}
