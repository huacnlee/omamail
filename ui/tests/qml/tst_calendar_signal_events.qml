import QtQuick 2.15
import QtTest 1.3
import "../../components" as Views
import "../../calendar" as CalendarModule
import "../../calendar/Calendar.js" as Calendar

// An event the detail hands on through `editRequested` and `deleteRequested`
// crosses two QML signals before the composer or the controller reads it, and
// Qt 6.12 hands its lists over as sequences, which `Array.isArray` refuses.
// Wired as App.qml wires them: the edit to the composer's `beginEdit`, the
// delete to the controller's `deleteRequest`.
Item {
  width: 1000
  height: 700
  SystemPalette { id: palette }

  QtObject { id: viewService; property bool backendCanGoogleCalendars: true; property string calendarPalettePath: "" }
  QtObject {
    id: viewController
    property var service: viewService
    property var source: ({ id: "google:me@example.com", kind: "microsoft", calendarId: "primary", readOnly: false })
    property var availableSources: ({ sources: [source] })
    property var events: [{ sourceId: "google:me@example.com", googleId: "planning", uid: "planning", etag: "v1",
      summary: "Planning", start: { ms: new Date(2026, 9, 1, 10).getTime() }, end: { ms: new Date(2026, 9, 1, 11).getTime() },
      organizer: { self: true }, recurrence: ["RRULE:FREQ=WEEKLY"], recurrenceLines: ["RRULE:FREQ=WEEKLY"],
      attendees: [{ email: "one@example.test", responseStatus: "accepted", displayName: "One" },
        { email: "two@example.test", responseStatus: "declined" }] }]
    property bool sourcesLoaded: true
    property bool loading: false
    property bool clockRunning: false
    property bool eventWriting: false
    property double nowMs: new Date(2026, 9, 1, 8).getTime()
    property string lastError: ""
    property string lastErrorKind: ""
    function findSource(id) { return source }
    function colorKeyFor(id) { return "accent" }
    function refresh(start, end) {}
    function nativeRequest(source, operation, fields, callback) {}
  }

  QtObject {
    id: composerService
    property var recipientContacts: []
    property bool backendCanGoogleCalendars: true
    function refreshRecipientContacts() {}
  }
  QtObject {
    id: composerController
    property var service: composerService
    property bool creatingEvent: false
    property bool eventWriting: false
    property bool composerHeld: false
    property string accountId: ""
    property var updated: null
    property var writableSourceGroups: [{ id: "google:me@example.com", providerLabel: "Google", accountLabel: "me@example.com",
      calendars: [{ id: "google:me@example.com", name: "me@example.com", colorKey: "accent", kind: "google" }] }]
    function findSource(id) { return writableSourceGroups[0].calendars[0] }
    function updateEvent(sourceId, event, fields) { updated = { sourceId: sourceId, event: event, fields: fields }; return true }
    function createEvent(sourceId, fields) { return false }
    signal eventCreated(bool ok, string error)
    signal eventUpdated(bool ok, string error)
    signal composeRequested(var prefill)
    signal composeEnded()
  }

  QtObject {
    id: controllerService
    property bool backendCanDiscoverCalendars: false
    property bool backendCanGoogleCalendars: true
    property var backend: ({ ready: false, call: function() {} })
    property bool unifiedCalendarView: false
    property var accountSummaries: []
    function withGoogleAccessToken(_accountId, callback) { callback("", "not used by this test") }
    function writeConfig(name, payload, callback) {}
  }
  CalendarModule.CalendarController {
    id: realController
    service: controllerService
    pluginDir: "/tmp/omamail-test"
    accountId: ""
    sourceList: ({ version: 1, sources: [] })
  }

  property var deleteConfirmation: null

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
    onEditRequested: function(sourceId, event) { composer.beginEdit(sourceId, event) }
    onDeleteRequested: function(sourceId, event) { deleteConfirmation = realController.deleteRequest(sourceId, event) }
  }

  Views.CalendarEventComposer {
    id: composer
    anchors.fill: parent
    controller: composerController
    textColor: palette.text
    backgroundColor: palette.base
    accentColor: palette.highlight
    urgentColor: palette.highlight
    dimColor: palette.mid
    panelFontFamily: "sans-serif"
  }

  TestCase {
    name: "CalendarSignalEvents"
    when: windowShown

    function detail() {
      function find(item) {
        if (item && item !== view && typeof item.editRequested === "function"
            && typeof item.deleteRequested === "function" && item.event !== undefined) return item
        var kids = item ? (item.children || []) : []
        for (var i = 0; i < kids.length; i++) { var found = find(kids[i]); if (found) return found }
        return null
      }
      return find(view)
    }

    function init() {
      composer.close()
      composerController.updated = null
      deleteConfirmation = null
      view.closeDetail()
      view.activateEvent(viewController.events[0])
    }

    // Adding a guest keeps the answers the others already gave: the update
    // matches the typed addresses against the event's guests, and a list it
    // cannot read as one leaves every guest with an address and nothing else.
    function test_an_edit_keeps_the_guests_answers() {
      var shown = detail()
      verify(shown !== null)
      shown.editRequested(String(shown.event.sourceId), shown.event)
      verify(composer.opened)
      findChild(composer, "event-guests-field").text = "one@example.test, two@example.test, new@example.test"
      composer.submit("all")
      verify(composerController.updated !== null, "the composer saved")
      var update = composerController.updated
      verify(Array.isArray(update.event.attendees), "the edited event's guests are a list")
      var built = Calendar.updateEvent(update.fields, update.event, Date.now())
      verify(built.ok, built.error)
      var options = Calendar.googleOptions(built.google, update.fields, { kind: "google" }, update.event)
      verify(options.ok, options.error)
      compare(options.body.attendees.map(function(guest) {
        return [guest.email, guest.responseStatus || "", guest.displayName || ""].join("|")
      }), ["one@example.test|accepted|One", "two@example.test|declined|", "new@example.test||"])
    }

    // Deleting a repeating event says that the whole series goes.
    function test_a_delete_names_the_series() {
      var shown = detail()
      verify(shown !== null)
      shown.deleteRequested(String(shown.event.sourceId), shown.event)
      verify(deleteConfirmation !== null)
      compare(deleteConfirmation.message, "Every occurrence of this series will be deleted.")
      verify(Array.isArray(deleteConfirmation.event.recurrence))
    }
  }
}
