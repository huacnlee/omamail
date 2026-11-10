import QtQuick
import QtTest
import "../../components" as Views
import "../../calendar" as Calendars
import "../../calendar/Calendar.js" as Calendar
import "../../backend/Plain.js" as Plain

Item {
  width: 1000
  height: 700
  SystemPalette { id: palette }
  Calendars.CalendarController {
    id: controller
    service: null
    pluginDir: "/tmp/omamail-test"
    property int writes: 0
    property var submitted: null
    property string refusal: ""
    function refresh(start, end) {}
    function rescheduleRefusal(event) { return refusal }
    function updateEvent(source, event, fields) {
      writes++
      submitted = Plain.plain(fields)
      eventWriting = true
      return true
    }
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
  // The same window-level Back action App dispatches, independent of focus.
  Views.KeyRouter {
    context: "calendar"
    overlay: false
    onTriggered: function(id) { if (id === "back") view.dismissPreview() }
  }
  SignalSpy { id: composed; target: controller; signalName: "composeRequested" }
  TestCase {
    name: "CalendarMonthDrag"
    when: windowShown
    function event() {
      return {sourceId:"personal", googleId:"planning", uid:"planning", summary:"Planning",
        start:{ms:new Date(2026,9,1,10).getTime()}, end:{ms:new Date(2026,9,1,11).getTime()}}
    }
    function init() {
      view.dismissPreview()
      view.closeDetail()
      controller.eventWriting = false
      controller.eventUpdated(false, "")
      controller.loading = false
      controller.refusal = ""
      controller.lastError = ""
      controller.writes = 0
      controller.events = [event()]
      view.visible = true
      view.viewMode = "month"
      view.visibleMonth = new Date(2026,9,1)
      composed.clear()
      waitForRendering(view)
    }
    function card() {
      var item = findChild(view, "calendar-month-event-planning")
      // Locate the same production card on the pre-fix revision too.
      if (!item) item = unnamedCard(findChild(view, "calendar-month-day-2026-10-01"))
      verify(item !== null)
      return item
    }
    function unnamedCard(item) {
      if (!item) return null
      if (item.eventData && item.eventData.googleId === "planning") return item
      for (var i = 0; i < item.children.length; i++) {
        var match = unnamedCard(item.children[i])
        if (match) return match
      }
      return null
    }
    function destination(date) {
      var day = findChild(view, "calendar-month-day-" + date)
      verify(day !== null)
      return day.mapToItem(view, day.width / 2, day.height / 2)
    }
    function drag(item, date) {
      var start = item.mapToItem(view, item.width / 2, item.height / 2)
      mousePress(view, start.x, start.y)
      var end = destination(date)
      mouseMove(view, end.x, end.y, 20)
      return end
    }
    function preview(week) { return findChild(view, "calendar-month-move-preview-" + (week || 0)) }
    function test_preview_drop_failure_and_retry() {
      var original = card()
      var end = drag(original, "2026-10-02")
      verify(preview() !== null, "the destination is visible before release")
      verify(original.opacity < 1, "the original is visibly picked up")
      compare(controller.writes, 0)
      var target = findChild(view, "calendar-month-drop-target-0")
      var day = findChild(view, "calendar-month-day-2026-10-02")
      fuzzyCompare(target.x, day.x + 2, 1)
      mouseRelease(view, end.x, end.y)
      compare(controller.writes, 1)
      compare(controller.submitted.startMs, new Date(2026,9,2,10).getTime())
      compare(controller.submitted.endMs, new Date(2026,9,2,11).getTime())
      verify(preview() !== null, "the dropped event stays visible during the write")
      verify(findChild(view, "calendar-month-move-status-0").text.indexOf("Saving") === 0)
      compare(controller.events[0].start.ms, new Date(2026,9,1,10).getTime(), "cache stays authoritative")
      compare(original.opacity, 0)
      controller.eventWriting = false
      controller.eventUpdated(false, "Conflict")
      compare(preview(), null)
      compare(original.opacity, 1)
      end = drag(original, "2026-10-02")
      mouseRelease(view, end.x, end.y)
      compare(controller.writes, 2, "one new write on retry")
      controller.eventWriting = false
      controller.eventUpdated(true, "")
      controller.loading = true
      wait(0)
      verify(preview() !== null, "no snap-back between write and refresh")
      var updated = event()
      updated.start.ms = new Date(2026,9,2,10).getTime()
      updated.end.ms = new Date(2026,9,2,11).getTime()
      controller.events = [updated]
      controller.loading = false
      compare(preview(), null)
      compare(card().opacity, 1)
      var position = card().mapToItem(view, 0, 0)
      var destinationPosition = day.mapToItem(view, 0, 0)
      verify(position.x >= destinationPosition.x && position.x < destinationPosition.x + day.width)
    }
    function test_escape_outside_and_same_day_never_write() {
      var end = drag(card(), "2026-10-02")
      verify(preview() !== null)
      keyClick(Qt.Key_Escape)
      compare(preview(), null)
      mouseRelease(view, end.x, end.y)
      compare(controller.writes, 0)
      compare(view.detailOpen, false)
      drag(card(), "2026-10-02")
      mouseMove(view, 1, 1, 20)
      compare(preview(), null)
      mouseRelease(view, 1, 1)
      compare(controller.writes, 0)
      end = drag(card(), "2026-10-01")
      mouseRelease(view, end.x, end.y)
      compare(controller.writes, 0)
    }
    function test_click_still_opens_and_read_only_drag_does_not_write() {
      mouseClick(card(), 20, 10)
      compare(view.detailOpen, true)
      view.closeDetail()
      controller.refusal = "Read-only calendar"
      var end = drag(card(), "2026-10-02")
      compare(preview(), null)
      mouseRelease(view, end.x, end.y)
      compare(controller.writes, 0)
    }
    function test_guests_require_confirmation_without_pending_save() {
      var invited = event()
      invited.attendees = [{email:"guest@example.test",self:false}]
      controller.events = [invited]
      var end = drag(card(), "2026-10-02")
      verify(preview() !== null)
      mouseRelease(view, end.x, end.y)
      compare(controller.writes, 0)
      compare(composed.count, 1)
      compare(composed.signalArguments[0][0].startMs, new Date(2026,9,2,10).getTime())
      compare(preview(), null)
    }
    function test_multi_day_span_keeps_grabbed_day_offset_across_rows() {
      var span = event()
      span.start = {ms:new Date(2026,9,2).getTime(),allDay:true}
      span.end = {ms:new Date(2026,9,5).getTime(),allDay:true}
      controller.events = [span]
      var bar = findChild(view, "calendar-month-span-planning-0")
      verify(bar !== null)
      // Pick Saturday inside the Friday–Sunday bar and move it to Monday.
      var start = bar.mapToItem(view, bar.width / 2, bar.height / 2)
      mousePress(view, start.x, start.y)
      var end = destination("2026-10-05")
      mouseMove(view, end.x, end.y, 20)
      verify(preview() !== null && preview(1) !== null, "Sunday–Tuesday crosses the row boundary")
      compare(view.monthMoveEvent.start.ms, new Date(2026,9,4).getTime())
      compare(view.monthMoveEvent.end.ms, new Date(2026,9,7).getTime())
      mouseRelease(view, end.x, end.y)
      compare(controller.writes, 1)
    }
    function test_navigation_and_scope_change_cancel_before_release() {
      var end = drag(card(), "2026-10-02")
      view.moveMonth(1)
      mouseRelease(view, end.x, end.y)
      compare(controller.writes, 0)
      compare(preview(), null)
      view.visibleMonth = new Date(2026,9,1)
      end = drag(card(), "2026-10-02")
      controller.calendarScopeChanged()
      mouseRelease(view, end.x, end.y)
      compare(controller.writes, 0)
      compare(preview(), null)
    }
    function test_pending_move_blocks_another_write_and_failed_refresh_restores_display() {
      var end = drag(card(), "2026-10-02")
      mouseRelease(view, end.x, end.y)
      var second = event()
      second.googleId = "second"
      second.uid = "second"
      controller.events = [controller.events[0], second]
      var other = findChild(view, "calendar-month-event-second")
      end = drag(other, "2026-10-03")
      verify(preview() !== null, "pending placement survives a refused second drag")
      mouseRelease(view, end.x, end.y)
      compare(controller.writes, 1)
      controller.eventWriting = false
      controller.eventUpdated(true, "")
      controller.loading = true
      wait(0)
      controller.lastError = "Could not refresh calendar"
      controller.loading = false
      compare(preview(), null, "a failed refresh cannot leave Saving stuck forever")
      compare(card().opacity, 1)
    }
  }
}
