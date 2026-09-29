import QtQuick
import QtTest
import "../../components" as Views
import "../../calendar/Calendar.js" as Calendar

Item {
  width: 1000
  height: 700
  SystemPalette { id: palette }
  QtObject {
    id: fixture
    property var service: null
    property bool eventWriting: false
    property bool loading: false
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
      view.resetTimeScroll()
      waitForRendering(view)
      wait(50)
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
      var offset = findChild(view, "calendar-time-scroll").contentY
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
