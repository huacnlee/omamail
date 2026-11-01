import QtQuick
import QtTest
import qs.Commons
import "../../components" as Views
import "../../calendar/Calendar.js" as Calendar

Item {
  width: 1000
  height: 700
  SystemPalette { id: palette }
  QtObject {
    id: fixture
    property var service: null
    property int hourHeight: 60
    function zoomHours(direction, shown, filled) { hourHeight = Calendar.zoomedHourHeight(hourHeight, shown, direction, filled) }
    property bool eventWriting: false
    property bool loading: false
    property double pendingRangeStart: 0
    property string enabledSourceKey: ""
    property string calendarScope: ""
    property string sourceKind: "google"
    property bool apiReady: true
    function findSource(id) { return {id:id,kind:sourceKind} }
    function rescheduleRefusal(event) {
      var refusal = Calendar.writeRefusal(findSource(event.sourceId), event, "reschedule")
      return refusal === "" && !apiReady ? "Update the backend to move events by dragging" : refusal
    }
    signal eventUpdated(bool ok, string error)
    property var events: [{sourceId:"personal",googleId:"meeting",uid:"uid",summary:"Planning",
      start:{ms:new Date(2026,9,1,10).getTime()},end:{ms:new Date(2026,9,1,11).getTime()}}]
    function colorKeyFor(id) { return "accent" }
  }
  Views.WeekCalendarView {
    id: view
    anchors.fill: parent
    controller: fixture
    days: Calendar.weekDays(new Date(2026,9,1).getTime(), 1)
    nowMs: 0
    textColor: palette.text
    backgroundColor: palette.base
    accentColor: palette.highlight
    urgentColor: palette.highlight
    dimColor: palette.mid
    calendarBorderColor: palette.mid
    calendarTodayBackgroundColor: palette.alternateBase
    calendarBorderWidth: 1
    panelFontFamily: "sans-serif"
    selectedEventId: ""
  }
  SignalSpy { id: moved; target: view; signalName: "eventRescheduled" }
  SignalSpy { id: created; target: view; signalName: "createRange" }
  SignalSpy { id: allDayCreated; target: view; signalName: "createAllDay" }
  SignalSpy { id: activated; target: view; signalName: "eventActivated" }
  TestCase {
    name: "CalendarGestures"
    when: windowShown
    function init() {
      moved.clear(); created.clear(); fixture.eventWriting = false; fixture.loading = false; view.pendingGesture = null
      fixture.sourceKind = "google"
      fixture.apiReady = true
      fixture.hourHeight = 60
      fixture.pendingRangeStart = 0
      view.anchors.fill = view.parent
      wait(0)
      view.resetTimeScroll()
      waitForRendering(view)
      wait(50)
    }
    function test_zoom_changes_the_hour_height_and_stays_at_the_same_hour() {
      var timeline = findChild(view, "calendar-time-scroll")
      compare(timeline.hourHeight, Style.space(60))
      timeline.contentY = 8 * timeline.hourHeight
      view.zoomHours(-1)
      compare(timeline.hourHeight, Style.space(55))
      fuzzyCompare(timeline.contentY / timeline.hourHeight, 8, 0.01)
      view.zoomHours(1)
      view.zoomHours(1)
      compare(timeline.hourHeight, Style.space(65))
      fuzzyCompare(timeline.contentY / timeline.hourHeight, 8, 0.01)
    }
    function test_hours_are_automatic_until_zoomed_and_after_a_reset() {
      var timeline = findChild(view, "calendar-time-scroll")
      fixture.hourHeight = 0
      wait(0)
      fuzzyCompare(timeline.hourHeight, timeline.height / 16, 0.01)
      timeline.contentY = 7 * timeline.hourHeight
      var shown = Math.round(timeline.hourHeight)
      view.zoomHours(1)
      compare(fixture.hourHeight, shown + 5)
      fuzzyCompare(topHour(), 7, 0.01)
      view.zoomHours(0)
      compare(fixture.hourHeight, 0)
      fuzzyCompare(timeline.hourHeight, timeline.height / 16, 0.01)
      wait(0)
      fuzzyCompare(topHour(), 7, 0.01)
    }
    function test_automatic_hours_stay_at_the_same_hour_when_the_window_resizes() {
      var timeline = findChild(view, "calendar-time-scroll")
      var height = view.height
      fixture.hourHeight = 0
      wait(0)
      timeline.contentY = 7 * timeline.hourHeight
      resizeTo(height / 2)
      verify(timeline.hourHeight < height / 16)
      fuzzyCompare(topHour(), 7, 0.01)
      resizeTo(height + 60)
      fuzzyCompare(topHour(), 7, 0.01)
      resizeTo(height + 500)
      verify(topHour() < 7, "a maximized window has no room to open this late")
      resizeTo(height)
      fuzzyCompare(topHour(), 7, 0.01)
    }
    function test_saved_hours_stay_at_the_same_hour_when_the_window_resizes() {
      var timeline = findChild(view, "calendar-time-scroll")
      var height = view.height
      fixture.hourHeight = 40
      wait(0)
      timeline.contentY = 5 * timeline.hourHeight
      resizeTo(height + 100)
      fuzzyCompare(topHour(), 5, 0.01)
    }
    function test_a_window_taller_than_the_day_returns_to_the_same_hour() {
      var timeline = findChild(view, "calendar-time-scroll")
      var height = view.height
      fixture.hourHeight = 30
      wait(0)
      timeline.contentY = 2 * timeline.hourHeight
      resizeTo(height + 200)
      compare(timeline.contentY, 0, "the whole day fits")
      resizeTo(height)
      fuzzyCompare(topHour(), 2, 0.01)
      var original = fixture.events
      fixture.events = plannedAt(1)
      wait(50)
      fuzzyCompare(topHour(), 2, 0.01, "still a scroll by hand")
      fixture.events = original
    }
    function test_zooming_out_stops_when_the_whole_day_fits() {
      var timeline = findChild(view, "calendar-time-scroll")
      fixture.hourHeight = 0
      wait(0)
      for (var i = 0; i < 12; i++) view.zoomHours(-1)
      compare(timeline.contentHeight, timeline.height, "24 hours without scrolling")
      compare(fixture.hourHeight, Math.floor(timeline.height / 24 / Style.space(60) * 60))
    }
    function test_zooming_out_and_back_returns_to_the_same_hour() {
      var timeline = findChild(view, "calendar-time-scroll")
      timeline.contentY = 12 * timeline.hourHeight
      for (var i = 0; i < 7; i++) view.zoomHours(-1)
      verify(topHour() < 12, "too short to stay at noon")
      for (i = 0; i < 7; i++) view.zoomHours(1)
      fuzzyCompare(topHour(), 12, 0.01)
    }
    function test_more_all_day_rows_do_not_change_the_automatic_height() {
      var timeline = findChild(view, "calendar-time-scroll")
      var original = fixture.events
      fixture.hourHeight = 0
      var hour = timeline.hourHeight
      var day = view.days[0]
      fixture.events = original.concat([0, 1, 2].map(function(index) {
        return {sourceId:"personal",uid:"all"+index,summary:"Away",start:{ms:day.startMs,allDay:true},end:{ms:day.endMs}}
      }))
      compare(view.allDayCount, 3)
      compare(timeline.hourHeight, hour)
      fixture.events = original
    }
    function test_the_view_opens_at_the_first_event_and_follows_late_events_until_scrolled() {
      var timeline = findChild(view, "calendar-time-scroll")
      var original = fixture.events
      fuzzyCompare(topHour(), 10, 0.01)
      fixture.events = []
      fuzzyCompare(topHour(), 7, 0.01, "no events: the usual hour")
      wait(0)
      timeline.contentY += 0.6
      fixture.events = original
      fuzzyCompare(topHour(), 10, 0.01, "rounding to a pixel is not a scroll")
      wait(0)
      timeline.contentY = 2 * timeline.hourHeight
      fixture.events = []
      wait(50)
      fuzzyCompare(topHour(), 2, 0.01, "a scroll is kept")
      fixture.events = original
      view.resetTimeScroll()
    }
    function test_the_view_stops_following_events_once_they_have_loaded() {
      var original = fixture.events
      fixture.loading = true
      fixture.pendingRangeStart = 1
      fixture.loading = false
      fixture.events = plannedAt(5)
      fuzzyCompare(topHour(), 5, 0.01, "the range it asked for is still to come")
      fixture.loading = true
      fixture.pendingRangeStart = 0
      fixture.loading = false
      fixture.events = plannedAt(9)
      wait(50)
      fuzzyCompare(topHour(), 5, 0.01, "deleting the first event leaves the view alone")
      fixture.events = original
      view.resetTimeScroll()
      fuzzyCompare(topHour(), 10, 0.01)
    }
    function test_a_calendar_arriving_after_the_first_load_is_followed_unless_scrolled() {
      var timeline = findChild(view, "calendar-time-scroll")
      var original = fixture.events
      fixture.loading = true
      fixture.loading = false
      fixture.events = plannedAt(5)
      fuzzyCompare(topHour(), 10, 0.01, "the first load has ended")
      fixture.enabledSourceKey = "work"
      fuzzyCompare(topHour(), 5, 0.01, "its cached events came first")
      wait(0)
      timeline.contentY = 9 * timeline.hourHeight
      fixture.enabledSourceKey = "work\nhome"
      fixture.events = plannedAt(4)
      wait(50)
      fuzzyCompare(topHour(), 9, 0.01, "a scroll is kept")
      fixture.enabledSourceKey = ""
      fixture.events = original
      view.resetTimeScroll()
    }
    function test_switching_mailbox_waits_for_a_drag_to_finish() {
      var timeline = findChild(view, "calendar-time-scroll")
      var drag = findChild(view, "calendar-event-drag-meeting")
      wait(0)
      timeline.contentY = 8 * timeline.hourHeight
      var top = timeline.contentY
      mousePress(drag, drag.width / 2, drag.height / 2)
      mouseMove(drag, drag.width / 2, drag.height / 2 + 40, 20)
      verify(view.dragPreview !== null)
      fixture.calendarScope = "other"
      compare(timeline.contentY, top)
      mouseRelease(drag, drag.width / 2, drag.height / 2 + 40)
      fixture.calendarScope = ""
      view.pendingGesture = null
    }
    function test_switching_mailbox_opens_at_its_first_event() {
      var timeline = findChild(view, "calendar-time-scroll")
      var original = fixture.events
      wait(0)
      timeline.contentY = 2 * timeline.hourHeight
      fixture.calendarScope = "other"
      fixture.events = plannedAt(5)
      fuzzyCompare(topHour(), 5, 0.01)
      fixture.calendarScope = ""
      fixture.events = original
      view.resetTimeScroll()
    }
    function test_dragging_the_first_event_does_not_scroll_the_view() {
      var original = fixture.events
      var drag = findChild(view, "calendar-event-drag-meeting")
      var hour = findChild(view, "calendar-time-scroll").hourHeight
      mousePress(drag, drag.width / 2, drag.height / 2)
      mouseMove(drag, drag.width / 2, drag.height / 2 - hour, 20)
      mouseRelease(drag, drag.width / 2, drag.height / 2 - hour)
      compare(moved.count, 1)
      fixture.events = plannedAt(9)
      view.pendingGesture = null
      wait(50)
      fuzzyCompare(topHour(), 10, 0.01)
      fixture.events = original
      view.resetTimeScroll()
    }
    function test_zoom_at_the_bottom_of_the_day_stays_inside_the_timeline() {
      var timeline = findChild(view, "calendar-time-scroll")
      timeline.contentY = timeline.contentHeight - timeline.height
      view.zoomHours(-1)
      compare(timeline.contentY, timeline.contentHeight - timeline.height)
    }
    function test_zoom_waits_for_a_drag_to_finish() {
      var drag = findChild(view, "calendar-event-drag-meeting")
      mousePress(drag, drag.width / 2, drag.height / 2)
      mouseMove(drag, drag.width / 2, drag.height / 2 + 40, 20)
      verify(view.dragPreview !== null)
      view.zoomHours(-1)
      compare(fixture.hourHeight, 60)
      mouseRelease(drag, drag.width / 2, drag.height / 2 + 40)
      view.pendingGesture = null
    }
    function topHour() {
      var timeline = findChild(view, "calendar-time-scroll")
      return timeline.contentY / timeline.hourHeight
    }
    function resizeTo(height) {
      view.anchors.fill = undefined
      view.width = 1000
      view.height = height
      wait(50)
    }
    function plannedAt(hour) {
      return [{sourceId:"personal",googleId:"meeting",uid:"uid",summary:"Planning",
        start:{ms:new Date(2026,9,1,hour).getTime()},end:{ms:new Date(2026,9,1,hour + 1).getTime()}}]
    }
    function test_short_hours_still_move_a_short_event() {
      var original = fixture.events
      fixture.hourHeight = 25
      fixture.events = [{sourceId:"personal",googleId:"meeting",uid:"uid",summary:"Planning",
        start:{ms:new Date(2026,9,1,10).getTime()},end:{ms:new Date(2026,9,1,10,30).getTime()}}]
      waitForRendering(view)
      var drag = findChild(view, "calendar-event-drag-meeting")
      verify(drag.height <= Style.space(18), "a card the fixed edges would swallow")
      var hour = findChild(view, "calendar-time-scroll").hourHeight
      mousePress(drag, drag.width / 2, drag.height / 2)
      mouseMove(drag, drag.width / 2, drag.height / 2 + hour, 20)
      mouseRelease(drag, drag.width / 2, drag.height / 2 + hour)
      compare(moved.count, 1)
      var startMoved = moved.signalArguments[0][1] - new Date(2026,9,1,10).getTime()
      var endMoved = moved.signalArguments[0][2] - new Date(2026,9,1,10,30).getTime()
      verify(startMoved > 0, "the start moved")
      compare(endMoved, startMoved)
      view.pendingGesture = null
      fixture.events = original
    }
    function test_legacy_provider_cannot_dispatch_resize() {
      for (var i = 0; i < 3; i++) {
        fixture.sourceKind = ["microsoft", "icloud", "caldav"][i]
        var drag = findChild(view, "calendar-event-drag-meeting")
        mousePress(drag, drag.width / 2, drag.height - 2)
        mouseMove(drag, drag.width / 2, drag.height + 35, 20)
        mouseRelease(drag, drag.width / 2, drag.height + 35)
        compare(moved.count, 0)
        compare(view.pendingGesture, null)
      }
    }
    function test_old_backend_cannot_dispatch_resize() {
      fixture.apiReady = false
      var drag = findChild(view, "calendar-event-drag-meeting")
      mousePress(drag, drag.width / 2, drag.height - 2)
      mouseMove(drag, drag.width / 2, drag.height + 35, 20)
      mouseRelease(drag, drag.width / 2, drag.height + 35)
      compare(moved.count, 0)
      compare(view.pendingGesture, null)
    }
    function test_pending_resize_is_immediate_and_failure_restores_it() {
      var originalEnd = fixture.events[0].end.ms
      var accept = function() { fixture.eventWriting = true }
      view.eventRescheduled.connect(accept)
      var drag = findChild(view, "calendar-event-drag-meeting")
      mousePress(drag, drag.width / 2, drag.height - 2)
      mouseMove(drag, drag.width / 2, drag.height + 35, 20)
      mouseRelease(drag, drag.width / 2, drag.height + 35)
      view.eventRescheduled.disconnect(accept)
      verify(view.pendingGesture !== null)
      verify(view.pendingGesture.end > originalEnd)
      compare(fixture.events[0].end.ms, originalEnd)
      fixture.eventWriting = false
      fixture.eventUpdated(false, "Conflict")
      compare(view.pendingGesture, null)
    }
    function test_pending_resize_stays_until_refresh_finishes() {
      view.pendingGesture = {key:Calendar.eventKey(fixture.events[0]),start:fixture.events[0].start.ms,end:fixture.events[0].end.ms + 900000}
      fixture.eventUpdated(true, "")
      verify(view.pendingGesture !== null)
      fixture.loading = true
      fixture.loading = false
      compare(view.pendingGesture, null)
    }
    function test_gmail_generated_travel_event_does_not_dispatch_resize() {
      var original = fixture.events
      var event = JSON.parse(JSON.stringify(original[0]))
      event.eventType = "fromGmail"
      fixture.events = [event]
      wait(0)
      var drag = findChild(view, "calendar-event-drag-meeting")
      compare(drag.cursorShape, Qt.PointingHandCursor)
      mousePress(drag, drag.width / 2, drag.height - 2)
      mouseMove(drag, drag.width / 2, drag.height + 35, 20)
      compare(view.dragPreview, null)
      mouseRelease(drag, drag.width / 2, drag.height + 35)
      compare(moved.count, 0)
      fixture.events = original
    }
    function test_resize_changes_only_the_end() {
      var drag = findChild(view, "calendar-event-drag-meeting")
      verify(drag !== null)
      mousePress(drag, drag.width / 2, drag.height - 2)
      mouseMove(drag, drag.width / 2, drag.height + 35, 20)
      mouseRelease(drag, drag.width / 2, drag.height + 35)
      compare(moved.count, 1)
      compare(moved.signalArguments[0][1], fixture.events[0].start.ms)
      verify(moved.signalArguments[0][2] > fixture.events[0].end.ms)
      compare(moved.signalArguments[0][2] % 900000, 0)
    }
    function test_overlapping_events_have_separate_hit_targets() {
      var original = fixture.events
      fixture.events = original.concat([{sourceId:"personal",googleId:"overlap",uid:"overlap",summary:"Review",
        start:{ms:original[0].start.ms + 900000},end:{ms:original[0].end.ms + 900000}}])
      wait(0)
      var first = findChild(view, "calendar-event-drag-meeting")
      var second = findChild(view, "calendar-event-drag-overlap")
      verify(first !== null && second !== null)
      var left = first.mapToItem(view, 0, 0)
      var right = second.mapToItem(view, 0, 0)
      verify(left.x + first.width <= right.x)
      fixture.events = original
    }
    function test_empty_time_drag_creates_a_range() {
      var slots = findChild(view, "calendar-time-slots-2026-10-01")
      verify(slots !== null)
      // The view opens at the meeting, so start below it.
      var scroll = findChild(view, "calendar-time-scroll")
      var offset = scroll.contentY + scroll.hourHeight
      mousePress(slots, slots.width / 2, offset + 20)
      mouseMove(slots, slots.width / 2, offset + 70, 20)
      verify(view.dragPreview !== null)
      verify(view.dragPreview.label.indexOf("–") > 0)
      mouseRelease(slots, slots.width / 2, offset + 70)
      compare(view.dragPreview, null)
      compare(created.count, 1)
      verify(created.signalArguments[0][1] > created.signalArguments[0][0])
      compare(created.signalArguments[0][0] % 900000, 0)
      compare(created.signalArguments[0][1] % 900000, 0)
    }
    function test_empty_all_day_lane_creates_single_and_multi_day_ranges() {
      allDayCreated.clear()
      compare(view.allDayCount, 0)
      var lane = findChild(view, "calendar-all-day-lane")
      verify(lane.visible && lane.height > 0)
      var slots = findChild(view, "calendar-all-day-slots-2026-10-01")
      mouseClick(slots, slots.width / 2, slots.height / 2)
      compare(allDayCreated.count, 1)
      compare(allDayCreated.signalArguments[0][0], new Date(2026,9,1).getTime())
      compare(allDayCreated.signalArguments[0][1], new Date(2026,9,2).getTime())
      mousePress(slots, slots.width / 2, slots.height / 2)
      mouseMove(slots, -slots.width / 2, slots.height / 2, 20)
      mouseRelease(slots, -slots.width / 2, slots.height / 2)
      compare(allDayCreated.count, 2)
      compare(allDayCreated.signalArguments[1][0], new Date(2026,8,30).getTime())
      compare(allDayCreated.signalArguments[1][1], new Date(2026,9,2).getTime())
      compare(view.allDayDragStart, -1)
    }
    function test_long_timed_event_moves_to_top_lane_and_keeps_original_times() {
      var original = fixture.events
      var originalDays = view.days
      var stay = {sourceId:"personal",googleId:"stay",uid:"stay",summary:"Holiday",
        start:{ms:new Date(2026,8,29,12).getTime()},end:{ms:new Date(2026,9,3,12).getTime()}}
      fixture.events = original.concat([stay])
      wait(0)
      var bar = findChild(view,"calendar-all-day-event-stay")
      verify(bar !== null && bar.visible)
      verify(bar.width > view.width / 2)
      compare(findChild(view,"calendar-event-drag-stay"),null)
      compare(view.firstHour,0)
      activated.clear()
      mouseClick(bar,bar.width-10,bar.height/2)
      compare(activated.count,1)
      compare(activated.signalArguments[0][0].start.ms,stay.start.ms)
      compare(activated.signalArguments[0][0].start.allDay,undefined)
      view.days = [originalDays[3]]
      wait(0)
      verify(findChild(view,"calendar-all-day-event-stay").visible)
      compare(findChild(view,"calendar-event-drag-stay"),null)
      view.days = originalDays
      fixture.events = original
    }
    function test_day_and_week_scroll_to_late_evening_and_early_morning() {
      var originalDays = view.days
      var scroll = findChild(view, "calendar-time-scroll")
      for (var count = 0; count < 2; count++) {
        view.days = count === 0 ? [originalDays[3]] : originalDays
        wait(1)
        compare(view.firstHour, 0)
        compare(view.lastHour, 24)
        for (var i = 0; i < 20; i++) mouseWheel(scroll, scroll.width - 20, scroll.height / 2, 0, -120)
        compare(Math.round(scroll.contentY + scroll.height), Math.round(scroll.contentHeight))
        var slots = findChild(view, "calendar-time-slots-2026-10-01")
        created.clear()
        var late = 23 * scroll.hourHeight
        mousePress(slots, slots.width / 2, late)
        mouseMove(slots, slots.width / 2, late + scroll.hourHeight / 2, 20)
        mouseRelease(slots, slots.width / 2, late + scroll.hourHeight / 2)
        compare(created.count, 1)
        compare(new Date(created.signalArguments[0][0]).getHours(), 23)
        for (var j = 0; j < 20; j++) mouseWheel(scroll, scroll.width - 20, scroll.height / 2, 0, 120)
        compare(scroll.contentY, 0)
      }
      view.resetTimeScroll()
    }
  }
}
