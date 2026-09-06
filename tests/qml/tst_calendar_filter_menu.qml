import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail

// Showing and hiding a calendar from the view that draws it.
//
// The pointer and the keyboard are driven here rather than the signals behind
// them: a menu that cannot be clicked shut, or that eats every key while it is
// open, passes every test that calls `clicked()` directly and fails the first
// time somebody uses it.
Item {
  id: shell
  width: 900
  height: 700

  QtObject {
    id: calendarController

    property var events: []
    property bool loading: false
    property bool sourcesLoaded: true
    property bool savingSource: false
    property string lastError: ""
    property string lastErrorKind: ""
    property double nowMs: 0
    property bool clockRunning: false
    property var visibilityChanges: []
    property int showAllCalls: 0
    property var sourceGroups: [{
      id: "account:me@example.com",
      providerLabel: "Google",
      accountLabel: "me@example.com",
      calendars: [
        { id: "google:me@example.com", kind: "google", name: "me@example.com",
          enabled: true, colorKey: "accent" },
        { id: "google:me@example.com:team", kind: "google", name: "Team",
          enabled: false, colorKey: "cyan" }
      ]
    }]

    function refresh(_startMs, _endMs) {}
    function colorKeyFor(_sourceId) { return "accent" }
    // The real controller refuses a write while another is in flight. The
    // stub does too, or a test cannot see a refusal being avoided.
    function setSourceEnabled(sourceId, enabled) {
      if (savingSource) return
      visibilityChanges = visibilityChanges.concat([[String(sourceId), enabled === true]])
    }
    function showAllSources() {
      if (savingSource) return
      showAllCalls = showAllCalls + 1
    }
  }

  Omamail.CalendarView {
    id: calendarView
    anchors.fill: parent
    controller: calendarController
    textColor: Color.foreground
    backgroundColor: Color.background
    accentColor: Color.accent
    urgentColor: Color.accent
    dimColor: Color.foreground
    calendarBorderColor: Color.foreground
    calendarTodayBackgroundColor: Color.accent
    popupBackgroundColor: Color.background
    popupBorderColor: Color.foreground
    calendarBorderWidth: 1
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "CalendarFilterMenu"
    when: windowShown

    // `findChild` follows the object tree, and a Repeater parents its
    // delegates visually rather than owning them — inside a popup that is
    // enough to hide every row it built. This walks what is drawn instead,
    // from the window down, which is also where a popup's contents live.
    function drawn(name) { return drawnUnder(shell.Window.window.contentItem, name) }

    function drawnUnder(item, name) {
      if (!item) return null
      if (String(item.objectName) === name) return item
      for (var i = 0; i < item.children.length; i++) {
        var found = drawnUnder(item.children[i], name)
        if (found !== null) return found
      }
      return null
    }

    function trigger() { return findChild(calendarView, "calendarFilterTrigger") }

    function menu() { return findChild(calendarView, "calendarFilterMenu") }

    // Opening and closing go through the pointer, and the guard that stops a
    // press outside re-opening the menu is waited out between cases.
    function openMenu() {
      if (!menu().opened) mouseClick(trigger())
      verify(menu().opened, "the menu opened")
    }

    function init() {
      calendarController.savingSource = false
      calendarController.visibilityChanges = []
      calendarController.showAllCalls = 0
      if (menu().opened) mouseClick(trigger())
      wait(300)
    }

    // The count is in the label, not only in the colour of a dot: some of
    // your calendars being hidden is exactly the state you forget you left
    // the app in, and a theme can put a calendar's colour near the ground.
    function test_the_trigger_says_how_many_calendars_are_drawn() {
      compare(trigger().text, "Calendars 1/2")
    }

    // The button that opened the menu can put it away. A popup closing on a
    // press outside itself is already shut by the press that reaches its own
    // trigger, so a plain toggle re-opens it on the release and the control
    // never works.
    function test_the_trigger_closes_the_menu_it_opened() {
      mouseClick(trigger())
      compare(menu().opened, true)

      mouseClick(trigger())
      compare(menu().opened, false, "a second click puts it away")
    }

    function test_a_calendar_is_shown_and_hidden_from_the_view() {
      openMenu()

      var primary = drawn("calendarFilter:google:me@example.com")
      var team = drawn("calendarFilter:google:me@example.com:team")
      verify(primary !== null)
      verify(team !== null)
      compare(primary.shown, true)
      compare(team.shown, false)

      mouseClick(primary)
      mouseClick(team)
      compare(JSON.stringify(calendarController.visibilityChanges), JSON.stringify([
        ["google:me@example.com", false],
        ["google:me@example.com:team", true]
      ]))
    }

    // Every hidden calendar comes back in one write, because a second call
    // would be refused while the first is still saving.
    function test_show_all_asks_the_controller_once() {
      openMenu()
      var showAll = drawn("calendarFilterShowAll")
      verify(showAll !== null)
      verify(showAll.visible, "offered while something is hidden")

      mouseClick(showAll)
      compare(calendarController.showAllCalls, 1)
    }

    // A write already in flight is refused by the controller, so the rows say
    // so and take no tap, rather than swallowing one and changing nothing.
    function test_a_save_in_flight_stops_the_rows_taking_a_tap() {
      openMenu()
      var primary = drawn("calendarFilter:google:me@example.com")
      var showAll = drawn("calendarFilterShowAll")
      compare(primary.enabled, true)
      compare(showAll.enabled, true)

      calendarController.savingSource = true
      compare(primary.enabled, false, "a calendar row refuses while saving")
      compare(showAll.enabled, false)

      mouseClick(primary)
      compare(JSON.stringify(calendarController.visibilityChanges), "[]",
        "and the tap changed nothing rather than being dropped silently")
    }

    // An open popup takes every key before the window's shortcut map, so it
    // has to answer the ones it takes. j/k walk the rows, Return toggles the
    // one they are standing on.
    function test_the_keyboard_walks_the_rows_and_toggles_one() {
      openMenu()

      keyClick(Qt.Key_J)
      compare(menu().cursorIndex, 0)
      keyClick(Qt.Key_J)
      compare(menu().cursorIndex, 1)
      keyClick(Qt.Key_K)
      compare(menu().cursorIndex, 0)

      keyClick(Qt.Key_Return)
      compare(JSON.stringify(calendarController.visibilityChanges),
        JSON.stringify([["google:me@example.com", false]]))
    }

    // The cursor wraps past the last row onto Show all, which is a row like
    // any other as far as the keyboard is concerned.
    function test_the_keyboard_reaches_show_all() {
      openMenu()
      compare(menu().rowCount, 3, "two calendars and Show all")

      keyClick(Qt.Key_K)
      compare(menu().cursorIndex, 2, "up from nowhere lands on the last row")

      keyClick(Qt.Key_Return)
      compare(calendarController.showAllCalls, 1)
    }

    // Escape is the popup's own, and it must leave the calendar's keys behind
    // it: the window's shortcut map is dead while this is open.
    function test_escape_closes_the_menu() {
      openMenu()
      keyClick(Qt.Key_Escape)
      compare(menu().opened, false)
    }
  }
}
