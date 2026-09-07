import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail
import "../../calendar/Calendar.js" as Calendar

// The day view: one column of the week grid, and what it stops drawing.
Item {
  id: shell
  width: 900
  height: 700

  QtObject {
    id: calendarController
    property var events: []
    property bool loading: false
    property bool sourcesLoaded: true
    property string lastError: ""
    property string lastErrorKind: ""
    property double nowMs: Date.now()
    property bool clockRunning: false
    property var refreshRanges: []
    function refresh(startMs, endMs) {
      refreshRanges = refreshRanges.concat([[Number(startMs), Number(endMs)]])
    }
    function colorKeyFor(_sourceId) { return "accent" }
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
    calendarBorderWidth: 1
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "CalendarDayView"
    when: windowShown

    function init() {
      calendarView.setView("month")
      calendarController.refreshRanges = []
    }

    function test_the_day_view_draws_one_column() {
      calendarView.setView("day")
      compare(calendarView.viewMode, "day")
      compare(calendarView.periodDays.length, 1)
      compare(calendarView.periodDays[0].isoDate, Calendar.isoDate(calendarView.visibleDay))

      var grid = findChild(calendarView, "calendarWeekGrid")
      verify(grid !== null)
      verify(grid.visible, "the week grid draws the day too")
      compare(grid.days.length, 1)
    }

    // Nothing to tell apart: the one column on screen is the day the heading
    // names, so tinting all of it marks nothing off against anything.
    function test_the_day_view_does_not_tint_today() {
      var grid = findChild(calendarView, "calendarWeekGrid")

      calendarView.setView("week")
      compare(grid.highlightToday, true, "a week has other days to tell it from")

      calendarView.setView("day")
      compare(grid.highlightToday, false)
    }

    // Stepping day by day reads the week already held rather than opening a
    // cache entry per day: the range asked for is the whole week either way.
    function test_a_day_fetches_its_whole_week() {
      calendarView.setView("day")
      calendarController.refreshRanges = []
      calendarView.refresh()
      var asked = calendarController.refreshRanges[0]

      var week = Calendar.weekDays(calendarView.visibleDay.getTime(), 1)
      compare(asked[0], week[0].startMs)
      compare(asked[1], week[6].endMs)
    }

    // The heading names the one day, not a span.
    function test_the_day_view_is_titled_for_its_day() {
      calendarView.setView("day")
      var title = calendarView.periodTitle
      verify(title !== "")
      compare(title, Calendar.dayTitle(calendarView.periodDays))
      compare(calendarView.periodNoun, "day")
    }

    // And the chevrons move by a day rather than by a week.
    function test_stepping_moves_one_day() {
      calendarView.setView("day")
      var before = Calendar.isoDate(calendarView.visibleDay)
      calendarView.movePeriod(1)
      var after = new Date(calendarView.visibleDay.getFullYear(),
        calendarView.visibleDay.getMonth(), calendarView.visibleDay.getDate())
      var expected = new Date(after.getFullYear(), after.getMonth(), after.getDate() - 1)
      compare(Calendar.isoDate(expected), before, "one day forward, not seven")
    }
  }
}
