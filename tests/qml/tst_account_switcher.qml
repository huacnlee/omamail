import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// The mailbox list, and the row above it that stands for all of them.
//
// Two things here are worth a test rather than a reading. The combined row
// shifts every account down by one, so the index this component reports and
// the index it is given are no longer the same number — which is the kind of
// arithmetic that looks right and is off by one. And the popup answers keys
// itself, against the rule the rest of the window follows, so a `KeyRouter`
// binding put here later would look live and never run.
Item {
  width: 600
  height: 400

  readonly property var threeMailboxes: [
    { id: "a@example.org", email: "a@example.org", label: "Personal",
      unread: 2, active: true, signedIn: true, busy: false, error: "" },
    { id: "b@example.net", email: "b@example.net", label: "Work",
      unread: 0, active: false, signedIn: true, busy: false, error: "" },
    { id: "c@example.com", email: "c@example.com", label: "Other",
      unread: 5, active: false, signedIn: true, busy: false, error: "" }
  ]

  readonly property var oneMailbox: [
    { id: "a@example.org", email: "a@example.org", label: "Personal",
      unread: 2, active: true, signedIn: true, busy: false, error: "" }
  ]

  Omamail.AccountSwitcher {
    id: switcher
    anchors.fill: parent
    textColor: Qt.rgba(1, 1, 1, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    urgentColor: Qt.rgba(1, 0.2, 0.2, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    popupBackgroundColor: Qt.rgba(0.13, 0.13, 0.13, 1)
    popupBorderColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    panelFontFamily: "monospace"
    accounts: threeMailboxes
  }

  SignalSpy {
    id: chosenSpy
    target: switcher
    signalName: "accountChosen"
  }

  SignalSpy {
    id: unifiedSpy
    target: switcher
    signalName: "unifiedChosen"
  }

  TestCase {
    name: "AccountSwitcher"
    when: windowShown

    // The rows live inside the popup's content, which is built only once the
    // menu has been opened.
    function accountRows(item) {
      var found = []
      var node = item === undefined ? switcher.menuRows : item
      if (!node) return found
      if (node.objectName === "account-row") found.push(node)
      var children = node.children || []
      for (var i = 0; i < children.length; i++)
        found = found.concat(accountRows(children[i]))
      return found
    }

    function init() {
      switcher.accounts = threeMailboxes
      switcher.unifiedActive = false
      switcher.close()
      chosenSpy.clear()
      unifiedSpy.clear()
    }

    function cleanup() {
      switcher.close()
    }

    // ------------------------------------------------------- the row model

    function test_the_combined_row_is_offered_only_when_there_is_more_than_one() {
      compare(switcher.unifiedOffered, true)
      compare(switcher.rowOffset, 1)
      compare(switcher.rowCount, 4, "three mailboxes and the row for all of them")

      switcher.accounts = oneMailbox
      compare(switcher.unifiedOffered, false,
        "one mailbox has nothing to combine")
      compare(switcher.rowOffset, 0)
      compare(switcher.rowCount, 1)

      switcher.accounts = []
      compare(switcher.unifiedOffered, false)
      compare(switcher.rowCount, 0)
    }

    // ----------------------------------------------------------- the cursor

    function test_the_cursor_walks_the_combined_row_with_the_rest() {
      switcher.openCentered()
      // Opening rests on the mailbox already in use, which is the first
      // account — one row below the combined one.
      compare(switcher.cursorIndex, 1)

      switcher.moveCursor(-1)
      compare(switcher.cursorIndex, 0, "up from the first mailbox is the combined row")

      switcher.moveCursor(-1)
      compare(switcher.cursorIndex, 3, "and up from there wraps to the last mailbox")

      switcher.moveCursor(1)
      compare(switcher.cursorIndex, 0, "which wraps back onto the combined row")
    }

    function test_opening_rests_on_the_combined_row_when_that_is_what_is_in_use() {
      switcher.unifiedActive = true
      switcher.openCentered()
      compare(switcher.cursorIndex, 0)
    }

    function test_with_one_mailbox_the_cursor_never_leaves_it() {
      switcher.accounts = oneMailbox
      switcher.openCentered()
      compare(switcher.cursorIndex, 0)
      switcher.moveCursor(1)
      compare(switcher.cursorIndex, 0, "one row wraps onto itself")
    }

    // ------------------------------------------------------- what is chosen

    // The arithmetic worth testing: the row the keyboard is on is not the
    // account index this reports.
    function test_choosing_a_mailbox_reports_its_own_index_not_its_row() {
      switcher.openCentered()
      switcher.cursorIndex = 1
      switcher.chooseCursor()

      compare(unifiedSpy.count, 0)
      compare(chosenSpy.count, 1)
      compare(chosenSpy.signalArguments[0][0], 0,
        "the first mailbox is account 0 even though it is row 1")

      chosenSpy.clear()
      switcher.openCentered()
      switcher.cursorIndex = 3
      switcher.chooseCursor()
      compare(chosenSpy.signalArguments[0][0], 2, "the last mailbox is account 2")
    }

    function test_choosing_the_combined_row_asks_for_every_mailbox() {
      switcher.openCentered()
      switcher.cursorIndex = 0
      switcher.chooseCursor()

      compare(chosenSpy.count, 0, "no single mailbox was chosen")
      compare(unifiedSpy.count, 1)
    }

    // Without the row there is no shift, and row 0 is account 0 again.
    function test_with_one_mailbox_row_zero_is_account_zero() {
      switcher.accounts = oneMailbox
      switcher.openCentered()
      switcher.cursorIndex = 0
      switcher.chooseCursor()

      compare(unifiedSpy.count, 0, "one mailbox is never the combined view")
      compare(chosenSpy.count, 1)
      compare(chosenSpy.signalArguments[0][0], 0)
    }

    function test_a_cursor_off_the_end_chooses_nothing() {
      switcher.openCentered()
      switcher.cursorIndex = 99
      switcher.chooseCursor()
      compare(chosenSpy.count, 0)
      compare(unifiedSpy.count, 0)
    }

    // -------------------------------------------------------- what is in use

    // The combined view leaves an account active underneath, because compose
    // still needs an address to send from. Drawing both as in use said the
    // window was in two places at once.
    function test_only_one_row_is_drawn_as_the_one_in_use() {
      switcher.openCentered()
      var rows = accountRows()
      compare(rows.length, 3)
      compare(rows[0].inUse, true, "the active account is in use on its own")
      compare(rows[1].inUse, false)

      switcher.unifiedActive = true
      compare(rows[0].inUse, false,
        "the account stays active underneath but is no longer what is read")
      compare(rows[1].inUse, false)
      compare(rows[2].inUse, false)
    }

    // ------------------------------------------------------------- the keys

    // The popup takes every key before the window's shortcut map sees it, so
    // these handlers are the ones that run. This is the half of that the
    // component's own comment promises is tested.
    function test_the_open_menu_answers_its_own_keys() {
      switcher.openCentered()
      compare(switcher.opened, true)
      compare(switcher.cursorIndex, 1)

      keyClick(Qt.Key_J)
      compare(switcher.cursorIndex, 2, "j moves down inside the popup")

      keyClick(Qt.Key_K)
      compare(switcher.cursorIndex, 1)

      keyClick(Qt.Key_Up)
      compare(switcher.cursorIndex, 0, "and the arrows reach the combined row too")

      keyClick(Qt.Key_Return)
      compare(unifiedSpy.count, 1, "Enter takes the row the cursor is on")
      compare(switcher.opened, false, "and closes the menu")
    }

    function test_o_opens_the_row_the_cursor_is_on() {
      switcher.openCentered()
      switcher.cursorIndex = 2
      keyClick(Qt.Key_O)
      compare(chosenSpy.count, 1)
      compare(chosenSpy.signalArguments[0][0], 1)
    }
  }
}
