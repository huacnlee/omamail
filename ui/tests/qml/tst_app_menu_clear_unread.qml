import QtQuick
import QtTest
import "../../components" as Omamail

Item {
  width: 600
  height: 700

  Omamail.AppMenu {
    id: appMenu
    anchors.fill: parent
    textColor: Qt.rgba(1, 1, 1, 1)
    popupBackgroundColor: Qt.rgba(0, 0, 0, 1)
    popupBorderColor: textColor
    panelFontFamily: "monospace"
    signedIn: true
  }
  SignalSpy { id: clearRequested; target: appMenu; signalName: "clearUnreadRequested" }

  // The members of the service's ClearUnreadQueue that the menu reads.
  QtObject {
    id: controller
    property bool available: true
    property bool running: false
    property int cleared: 0
    property int loadedUnread: 12
    // How many messages a run will mark; -1 while counting or unknown.
    property int unread: 734
    property bool counting: false
    property int refreshes: 0
    function refreshCounts() { refreshes++ }
  }

  TestCase {
    name: "AppMenuClearUnread"
    when: windowShown

    function row(name) {
      for (var i = 0; i < appMenu.menuRows.length; i++)
        if (appMenu.menuRows[i].objectName === name) return appMenu.menuRows[i]
      return null
    }
    function rowIndex(name) { return appMenu.menuRows.indexOf(row(name)) }

    function init() {
      clearRequested.clear()
      controller.available = true
      controller.running = false
      controller.cleared = 0
      controller.loadedUnread = 12
      controller.unread = 734
      controller.counting = false
      controller.refreshes = 0
      appMenu.clearUnread = controller
      appMenu.openAt(10, 10)
      tryCompare(appMenu, "opened", true)
    }
    function cleanup() {
      appMenu.close()
      tryCompare(appMenu, "opened", false)
    }

    function test_opening_the_menu_counts_the_inbox() {
      compare(controller.refreshes, 1, "every opening asks for fresh counts")
    }

    function test_counting_shows_an_ellipsis_and_waits() {
      controller.counting = true
      controller.unread = -1
      var all = row("app-menu-clear-unread")
      compare(all.suffix, "\u2026")
      verify(!all.enabled, "the dialog needs the numbers")
    }

    function test_an_unknown_count_shows_no_number_but_still_runs() {
      controller.unread = -1
      var all = row("app-menu-clear-unread")
      compare(all.suffix, "")
      verify(all.enabled)
    }

    function test_hidden_without_backend_support() {
      controller.available = false
      compare(row("app-menu-clear-unread").visible, false)
      appMenu.clearUnread = null
      compare(row("app-menu-clear-unread").visible, false, "no service, no row")
    }

    function test_counts_tell_the_rows_apart() {
      var these = row("app-menu-mark-these-read")
      var all = row("app-menu-clear-unread")
      compare(these.text, "Mark these read")
      compare(these.suffix, "12")
      compare(all.text, "Mark all read...")
      compare(all.suffix, "734")
      verify(all.enabled)
      controller.unread = 2254
      compare(all.suffix, "2254", "the exact number, past 500 too")
      compare(rowIndex("app-menu-clear-unread"), rowIndex("app-menu-mark-these-read") + 1,
        "the two scopes sit together")
    }

    function test_disabled_without_a_count() {
      controller.unread = 0
      controller.loadedUnread = 0
      var all = row("app-menu-clear-unread")
      verify(all.visible)
      verify(!all.enabled)
      compare(row("app-menu-mark-these-read").suffix, "")
      verify(!row("app-menu-mark-these-read").enabled, "nothing loaded is unread, so it has nothing to mark")
    }

    function test_mark_these_read_keeps_its_old_rule_without_the_controller() {
      appMenu.clearUnread = null
      verify(row("app-menu-mark-these-read").enabled, "an older backend leaves the row as it was")
    }

    function test_locked_while_running() {
      controller.running = true
      controller.cleared = 1200
      var all = row("app-menu-clear-unread")
      compare(all.text, "Marking all read")
      compare(all.suffix, "1200")
      verify(!all.enabled)
      var locked = rowIndex("app-menu-clear-unread")
      for (var i = 0; i < appMenu.menuRows.length * 2; i++) {
        keyClick(Qt.Key_J)
        verify(appMenu.cursorIndex !== locked, "the keyboard skips a run in progress")
      }
      compare(clearRequested.count, 0)
    }

    function test_keyboard_reaches_the_row() {
      var wanted = rowIndex("app-menu-clear-unread")
      for (var i = 0; i < appMenu.menuRows.length && appMenu.cursorIndex !== wanted; i++)
        keyClick(Qt.Key_J)
      compare(appMenu.cursorIndex, wanted)
      keyClick(Qt.Key_Return)
      compare(clearRequested.count, 1)
      tryCompare(appMenu, "opened", false)
    }
  }
}
