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
      appMenu.canClearUnread = true
      appMenu.clearingUnread = false
      appMenu.clearedSoFar = 0
      appMenu.loadedUnreadSuffix = "12"
      appMenu.unreadSuffix = "734"
      appMenu.openAt(10, 10)
      tryCompare(appMenu, "opened", true)
    }
    function cleanup() {
      appMenu.close()
      tryCompare(appMenu, "opened", false)
    }

    function test_hidden_without_backend_support() {
      appMenu.canClearUnread = false
      compare(row("app-menu-clear-unread").visible, false)
    }

    function test_counts_tell_the_rows_apart() {
      var these = row("app-menu-mark-these-read")
      var all = row("app-menu-clear-unread")
      compare(these.text, "Mark these read")
      compare(these.suffix, "12")
      compare(all.text, "Mark all read...")
      compare(all.suffix, "734")
      verify(all.enabled)
      compare(rowIndex("app-menu-clear-unread"), rowIndex("app-menu-mark-these-read") + 1,
        "the two scopes sit together")
    }

    function test_disabled_without_a_count() {
      appMenu.unreadSuffix = ""
      var all = row("app-menu-clear-unread")
      verify(all.visible)
      verify(!all.enabled)
    }

    function test_locked_while_running() {
      appMenu.clearingUnread = true
      appMenu.clearedSoFar = 1200
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
