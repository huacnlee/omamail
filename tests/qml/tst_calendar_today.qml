import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail
import "../../calendar/Calendar.js" as Calendar

// How today is marked in the month grid, and how many ways at once.
//
// The fill is the mark that a theme can take away — every fill alpha in the
// kit is a theme token and zero is a legal value — and it is also the one
// laid over the events. So what is asserted here is that it is never the
// only mark: the date carries weight and colour of its own.
Item {
  id: shell
  width: 900
  height: 700

  // A palette with a deliberately quiet accent, so nothing here passes only
  // because the test theme happens to be loud.
  readonly property color fg: Qt.rgba(0.9, 0.9, 0.9, 1)
  readonly property color bg: Qt.rgba(0.1, 0.1, 0.1, 1)
  readonly property color acc: Qt.rgba(0.45, 0.6, 0.8, 1)

  readonly property string todayIso: Calendar.isoDate(new Date())
  readonly property string otherIso: {
    var now = new Date()
    var other = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (now.getDate() > 15 ? -5 : 5))
    return Calendar.isoDate(other)
  }

  QtObject {
    id: calendarController
    property var events: []
    property bool loading: false
    property bool sourcesLoaded: true
    property string lastError: ""
    property string lastErrorKind: ""
    property double nowMs: Date.now()
    property bool clockRunning: false
    function refresh(_a, _b) {}
    function colorKeyFor(_sourceId) { return "accent" }
  }

  Omamail.CalendarView {
    id: calendarView
    anchors.fill: parent
    controller: calendarController
    textColor: shell.fg
    backgroundColor: shell.bg
    accentColor: shell.acc
    urgentColor: shell.acc
    dimColor: Qt.rgba(0.6, 0.6, 0.6, 1)
    calendarBorderColor: shell.fg
    // What App.qml composes: the theme accent at one of the kit's alphas.
    calendarTodayBackgroundColor: Qt.rgba(shell.acc.r, shell.acc.g, shell.acc.b, Style.hoverFillAlpha)
    calendarBorderWidth: 1
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "CalendarToday"
    when: windowShown

    // Reset here rather than at the end of a case: a failed compare aborts the
    // function, so a restore on its last line does not run and one real
    // failure becomes a cascade that hides it.
    function init() {
      calendarView.setView("month")
      calendarView.calendarTodayBackgroundColor = Qt.rgba(
        shell.acc.r, shell.acc.g, shell.acc.b, Style.hoverFillAlpha)
    }

    // The date itself says "today" in two ways that do not depend on the
    // cell's fill, so a theme that draws no fills still marks the day.
    function test_todays_date_is_marked_without_the_fill() {
      var today = findChild(calendarView, "calendarDayNumber:" + shell.todayIso)
      var other = findChild(calendarView, "calendarDayNumber:" + shell.otherIso)
      verify(today !== null, "today is drawn in the month grid")
      verify(other !== null, "and so is a day that is not today")

      compare(today.font.bold, true)
      compare(other.font.bold, false, "weight is a mark, not the default")

      compare(String(today.color), String(shell.acc))
      verify(String(other.color) !== String(today.color),
        "colour is a second mark, and only today wears it")
    }

    // And the fill is still a mark: quiet, but not nothing, and not the same
    // as the cell beside it.
    function test_todays_cell_is_tinted_and_the_others_are_not() {
      var today = findChild(calendarView, "calendarDayCell:" + shell.todayIso)
      var other = findChild(calendarView, "calendarDayCell:" + shell.otherIso)
      verify(today !== null)
      verify(other !== null)

      verify(today.color.a > 0, "today is tinted")
      compare(other.color.a, 0, "and nothing else is")
      verify(String(today.color) !== String(other.color))
    }

    // The point of the weight and the colour: strip the fill entirely, the
    // way a theme with `hover-cursor-fill-alpha = 0` does, and today is still
    // findable. This is the case the fill alone cannot survive.
    function test_today_survives_a_theme_that_draws_no_fill() {
      calendarView.calendarTodayBackgroundColor = "transparent"

      var todayCell = findChild(calendarView, "calendarDayCell:" + shell.todayIso)
      compare(todayCell.color.a, 0, "the fill is gone")

      var today = findChild(calendarView, "calendarDayNumber:" + shell.todayIso)
      var other = findChild(calendarView, "calendarDayNumber:" + shell.otherIso)
      compare(today.font.bold, true)
      compare(String(today.color), String(shell.acc))
      verify(String(other.color) !== String(today.color),
        "today is still told apart with no fill at all")
    }
  }
}
