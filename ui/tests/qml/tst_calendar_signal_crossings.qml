import QtQuick 2.15
import QtTest 1.3
import "../../calendar/Calendar.js" as Calendar
import "../../components" as Views

// A calendar event that reaches the detail through the week view's `eventActivated` signal or an agenda row's
// `modelData`, which Qt 6.12 hands over as a reference object whose lists are sequences: `Array.isArray`
// refuses them, so the guests read as nobody. Each test goes through the app's own crossing.
Item {
  width: 1000
  height: 700
  SystemPalette { id: palette }

  // A Microsoft 365 mailbox's Graph calendar in the views, with a stand-in controller that holds one meeting.
  QtObject { id: viewService; property bool backendCanGoogleCalendars: false; property string calendarPalettePath: "" }
  QtObject {
    id: viewController
    property var service: viewService
    property var source: ({ id: "microsoft:outlook:jane@corp.example.test", kind: "microsoft",
      accountId: "outlook:jane@corp.example.test", calendarId: "", readOnly: false })
    property var availableSources: ({ sources: [source] })
    property var events: Calendar.eventsFromGraph({ value: [{ id: "g1", iCalUId: "g1-uid", subject: "Review",
      start: { dateTime: "2026-10-14T10:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-14T11:00:00", timeZone: "UTC" },
      organizer: { emailAddress: { address: "jane@corp.example.test", name: "Jane" } },
      attendees: [
        { emailAddress: { address: "one@corp.example.test", name: "One" }, status: { response: "accepted" } },
        { emailAddress: { address: "two@corp.example.test", name: "Two" }, status: { response: "declined" } }] }] },
      "microsoft:outlook:jane@corp.example.test")
    property bool sourcesLoaded: true
    property bool loading: false
    property bool clockRunning: false
    property bool eventWriting: false
    property double nowMs: new Date(2026, 9, 12, 8).getTime()
    property string lastError: ""
    property string lastErrorKind: ""
    function findSource(id) { return source }
    function colorKeyFor(id) { return "accent" }
    function refresh(start, end) {}
    function nativeRequest(source, operation, fields, callback) {}
  }

  Views.CalendarView {
    id: view
    anchors.fill: parent
    controller: viewController
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
    name: "CalendarSignalCrossings"
    when: windowShown

    function find(item, test) {
      if (item && test(item)) return item
      var kids = item ? (item.children || []) : []
      for (var i = 0; i < kids.length; i++) { var found = find(kids[i], test); if (found) return found }
      return null
    }

    function init() {
      view.closeDetail()
      view.setView("week")
    }

    function guestsLine() {
      var line = find(view, function(item) { return typeof item.text === "string" && item.text.indexOf("Guests · ") === 0 })
      return line ? line.text : ""
    }

    // The week view hands the event it was clicked on through `eventActivated`: the detail names its guests.
    function test_an_event_opened_from_the_week_names_its_guests() {
      var week = find(view, function(item) {
        return item !== view && typeof item.eventActivated === "function" && typeof item.eventRescheduled === "function"
      })
      verify(week !== null)
      week.eventActivated(viewController.events[0])
      verify(view.detailOpen)
      compare(view.detailEvent.summary, "Review")
      tryVerify(function() { return guestsLine() === "Guests · 2" }, 2000, "the detail lists both guests")
      verify(Array.isArray(view.detailEvent.attendees), "the open event's guests are a list")
    }

    // An agenda row opens the event its `modelData` holds: the detail names its guests too.
    function test_an_event_opened_from_the_agenda_names_its_guests() {
      view.setView("agenda")
      var row = null
      tryVerify(function() {
        row = find(view, function(item) { return item.modelData !== undefined && item.modelData !== null
          && item.modelData.graphId === "g1" && item.ListView !== undefined && item.ListView.view !== null })
        return row !== null && row.visible && row.width > 0
      }, 2000, "the agenda lists the meeting")
      // A row built a moment ago can miss the first press offscreen; the click is the row's own all the same.
      tryVerify(function() { if (!view.detailOpen) mouseClick(row, 10, 10); return view.detailOpen }, 2000,
        "the row opens its event")
      tryVerify(function() { return guestsLine() === "Guests · 2" }, 2000, "the detail lists both guests")
      verify(Array.isArray(view.detailEvent.attendees), "the open event's guests are a list")
    }
  }
}
