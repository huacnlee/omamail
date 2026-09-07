import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail
import "../../calendar/Calendar.js" as Calendar

// A week drawn five days wide or seven, and the range fetched for either.
Item {
  width: 900
  height: 700

  QtObject {
    id: calendarController

    property var events: []
    property bool loading: false
    property bool sourcesLoaded: true
    property string lastError: ""
    property string lastErrorKind: ""
    property double nowMs: 0
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
    weekDayCount: 7
    // The service owns the setting, so the view only ever reads back a width
    // something else agreed to. The test stands in for that.
    onWeekDayCountRequested: function(count) { calendarView.weekDayCount = count }
  }

  TestCase {
    name: "CalendarWeekDays"
    when: windowShown

    function init() {
      calendarView.setView("month")
      calendarView.weekDayCount = 7
      calendarController.refreshRanges = []
    }

    function test_a_week_is_drawn_five_days_wide_or_seven() {
      calendarView.setView("week")
      compare(calendarView.weekDays.length, 7)

      var five = findChild(calendarView, "calendarWeekDays5")
      var seven = findChild(calendarView, "calendarWeekDays7")
      verify(five !== null)
      verify(seven !== null)
      verify(five.visible, "the widths are offered in week view")
      compare(seven.selected, true)
      compare(five.selected, false)

      five.clicked()
      compare(calendarView.weekDayCount, 5)
      compare(calendarView.weekDays.length, 5)
      compare(five.selected, true)
      compare(seven.selected, false)

      // Monday to Friday of the week the anchor falls in, whichever day the
      // anchor is: the five are the front of the same seven.
      var whole = Calendar.weekSpan(calendarView.visibleWeek.getTime(), 1)
      compare(calendarView.weekDays[0].isoDate, whole[0].isoDate)
      compare(calendarView.weekDays[4].isoDate, whole[4].isoDate)

      seven.clicked()
      compare(calendarView.weekDayCount, 7)
      compare(calendarView.weekDays.length, 7)
    }

    // The widths belong to the week, so they are drawn with it and nowhere
    // else. They do not navigate: a width is not a view.
    function test_the_widths_are_drawn_only_with_the_week_view() {
      var five = findChild(calendarView, "calendarWeekDays5")
      var seven = findChild(calendarView, "calendarWeekDays7")
      compare(calendarView.viewMode, "month")
      compare(five.visible, false)
      compare(seven.visible, false)

      calendarView.setView("week")
      compare(five.visible, true)
      compare(seven.visible, true)
    }

    // Both widths ask for the same seven days, so the toggle reads the week
    // already fetched instead of opening a second entry in the range cache.
    function test_both_widths_fetch_the_whole_week() {
      calendarView.setView("week")

      calendarController.refreshRanges = []
      calendarView.setWeekDayCount(5)
      calendarView.refresh()
      var narrow = calendarController.refreshRanges[calendarController.refreshRanges.length - 1]

      calendarView.setWeekDayCount(7)
      calendarView.refresh()
      var wide = calendarController.refreshRanges[calendarController.refreshRanges.length - 1]

      compare(JSON.stringify(narrow), JSON.stringify(wide))
    }

    // A drawn column, not a property saying how many there ought to be.
    // `dayCount` can be right while the divisor is still a literal seven,
    // which draws five columns across five sevenths of the grid and leaves
    // the rest empty. So what is measured here is a column's width.
    function test_the_columns_fill_the_width_they_are_given() {
      calendarView.setView("week")
      var grid = findChild(calendarView, "calendarWeekGrid")
      verify(grid !== null)

      var seven = dayColumn()
      verify(seven !== null, "a day column is drawn")
      fuzzyCompare(seven.width, (grid.width - grid.timeRailWidth) / 7, 1.5)

      calendarView.setWeekDayCount(5)
      var five = dayColumn()
      verify(five !== null)
      fuzzyCompare(five.width, (grid.width - grid.timeRailWidth) / 5, 1.5)
      verify(five.width > seven.width, "five columns are wider than seven")
    }

    // The first day column of the week on screen, by name.
    function dayColumn() {
      return findChild(calendarView, "calendarDayColumn:" + calendarView.weekDays[0].isoDate)
    }

    // The heading names the days on screen, so it ends on the last of them.
    function test_the_title_ends_on_the_last_day_drawn() {
      calendarView.setView("week")
      calendarView.setWeekDayCount(5)
      var days = calendarView.weekDays
      var title = Calendar.weekTitle(days)
      verify(title !== "", "a five-day week has a heading at all")
      verify(String(title).indexOf(String(days[days.length - 1].day)) >= 0,
        "the Friday it shows is named in the heading: " + title)

      calendarView.setWeekDayCount(7)
      var wide = calendarView.weekDays
      var wideTitle = Calendar.weekTitle(wide)
      verify(String(wideTitle).indexOf(String(wide[6].day)) >= 0)
      verify(title !== wideTitle, "five days are not titled as seven")
    }

    // A selection standing on a day the narrower week drops is let go, so the
    // keyboard cannot walk from an event that is no longer drawn.
    function test_narrowing_the_week_drops_a_selection_it_hides() {
      calendarView.setView("week")
      calendarView.setWeekDayCount(7)
      var saturday = calendarView.weekDays[5]

      calendarController.events = [{
        uid: "weekend", sourceId: "s", summary: "Football",
        start: { ms: saturday.startMs + 10 * 3600000, allDay: false },
        end: { ms: saturday.startMs + 11 * 3600000 }
      }]
      calendarView.selectedEventId = "weekend"
      compare(calendarView.selectedEventId, "weekend")

      calendarView.setWeekDayCount(5)
      compare(calendarView.selectedEventId, "", "Saturday is no longer drawn")
      calendarController.events = []
    }
  }
}
