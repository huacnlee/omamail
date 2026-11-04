import QtQuick
import QtTest
import "../../components" as Views
import "../../calendar" as Calendars
import "../../calendar/Calendar.js" as Calendar

Item {
  width: 1000
  height: 700
  SystemPalette { id: palette }
  Calendars.CalendarController {
    id: controller
    service: null
    pluginDir: "/tmp/omamail-test"
  }
  Views.CalendarView {
    id: view
    anchors.fill: parent
    controller: controller
    textColor: palette.text
    backgroundColor: palette.base
    accentColor: palette.highlight
    urgentColor: palette.highlight
    dimColor: palette.mid
    calendarBorderColor: palette.mid
    calendarTodayBackgroundColor: palette.alternateBase
    calendarBorderWidth: 1
    panelFontFamily: "sans-serif"
  }
  TestCase {
    name: "CalendarToday"
    when: windowShown

    function init() {
      view.visible = true
      view.viewMode = "month"
      wait(0)
    }

    function test_midnight_updates_existing_month_cells_data() {
      return [
        {tag:"overnight", year:2026, month:9, day:27},
        {tag:"month-boundary", year:2026, month:9, day:31},
        {tag:"year-boundary", year:2026, month:11, day:31}
      ]
    }
    function test_midnight_updates_existing_month_cells(data) {
      view.visibleMonth = new Date(data.year, data.month, 1)
      controller.nowMs = new Date(data.year, data.month, data.day, 23, 59).getTime()
      var before = Calendar.isoDate(new Date(controller.nowMs))
      var next = new Date(data.year, data.month, data.day + 1, 0, 0)
      var after = Calendar.isoDate(next)
      compare(view.todayIso, before)
      var yesterday = findChild(view, "calendar-month-day-" + before)
      var today = findChild(view, "calendar-month-day-" + after)
      verify(yesterday !== null && today !== null)
      compare(yesterday.color, view.calendarTodayBackgroundColor)
      compare(today.color, Qt.color("transparent"))

      controller.nowMs = next.getTime()
      compare(view.todayIso, after)
      compare(yesterday.color, Qt.color("transparent"))
      compare(today.color, view.calendarTodayBackgroundColor)
      compare(view.visibleMonth.getMonth(), data.month, "rollover does not navigate away")
    }

    function test_month_clock_runs_and_reopening_catches_up() {
      compare(controller.clockRunning, true)
      view.visible = false
      compare(controller.clockRunning, false)
      controller.nowMs = new Date(2000, 0, 1).getTime()
      var reopenedAt = Date.now()
      view.visible = true
      compare(controller.clockRunning, true)
      tryVerify(function() { return controller.nowMs >= reopenedAt })
      compare(view.todayIso, Calendar.isoDate(new Date(controller.nowMs)))
    }

    function test_tick_preserves_browsed_month() {
      view.visibleMonth = new Date(2025, 1, 1)
      controller.nowMs = new Date(2026, 9, 27, 23, 59).getTime()
      controller.nowMs = new Date(2026, 9, 28).getTime()
      compare(view.todayIso, "2026-10-28")
      compare(Calendar.isoDate(view.visibleMonth), "2025-02-01")
    }
  }
}
