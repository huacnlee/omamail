import QtQuick 2.15
import QtTest 1.3
import "../../calendar" as Calendars
import "../../components" as Omamail
import "../../calendar/Calendar.js" as Calendar

// Run with TZ=America/Los_Angeles (tests/test_calendar_zones_qml.py): the local
// clock springs forward on 8 March 2026 and repeats 01:00-02:00 on 1 November.
// An event whose TZID has no VTIMEZONE is parsed, opened in the real editor and
// saved through the real controller; the CalDAV body it would PUT is read back.
Item {
  width: 900
  height: 700

  QtObject {
    id: mailService
    property var requests: []
    property var recipientContacts: []
    property bool backendCanGoogleCalendars: true
    property bool backendCanDiscoverCalendars: true
    property var settings: ({})
    property bool unifiedCalendarView: false
    property var accountSummaries: [{ id: "imap:work@example.com", email: "work@example.com",
      provider: "imap", signedIn: true }]
    property var backend: ({ ready: false, apiVersion: 10, call: function(method, params, callback) {
      mailService.requests.push({ method: method, params: params })
      callback({ body: "", status: 204 }, null)
    } })
    function refreshRecipientContacts() {}
    function persistSetting(name, value) {}
    function withGoogleAccessToken(_accountId, callback) { callback("", "not used by this test") }
    function writeConfig(name, payload, callback) { callback(true, "") }
  }

  Calendars.CalendarController {
    id: calendarController
    service: mailService
    pluginDir: "/tmp/omamail-test"
    accountId: "imap:work@example.com"
    sourceList: ({ version: 1, sources: [{
      id: "caldav:team", kind: "caldav", name: "Team",
      url: "https://calendar.example/team/", username: "work@example.com",
      enabled: true, readOnly: false, colorKey: "accent"
    }] })
  }

  Omamail.CalendarEventComposer {
    id: composer
    anchors.fill: parent
    controller: calendarController
    textColor: Qt.rgba(1, 1, 1, 1)
    backgroundColor: Qt.rgba(0.06, 0.06, 0.06, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    urgentColor: Qt.rgba(1, 0.2, 0.2, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "UnresolvedZoneComposer"
    when: windowShown

    function init() {
      composer.close()
      composer.writePending = false
      calendarController.eventWriting = false
      calendarController.creatingEvent = false
      mailService.requests = []
    }

    function caldav(start, end) {
      return '<?xml version="1.0"?>'
        + '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        + '<d:response><d:href>/team/review.ics</d:href><d:propstat><d:prop>'
        + '<c:calendar-data>BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'
        + 'PRODID:Microsoft Exchange Server 2010\r\n'
        + 'BEGIN:VEVENT\r\nUID:review\r\nSUMMARY:Review\r\n'
        + start + '\r\n' + (end ? end + '\r\n' : '') + 'END:VEVENT\r\nEND:VCALENDAR</c:calendar-data>'
        + '</d:prop></d:propstat></d:response></d:multistatus>'
    }

    function field(name) { return findChild(composer, name).text }

    // Opens the event as the calendar does, renames it, saves, and returns
    // the body of the CalDAV update the controller sent.
    function renameAndSave(event) {
      composer.beginEdit("caldav:team", event)
      wait(0)
      findChild(composer, "event-title-field").text = "Review, renamed"
      verify(composer.dateRange.ok, "the range the editor shows is a valid one")
      verify(findChild(composer, "event-save-button").enabled, "Save is available")
      composer.submit("all")
      var updates = mailService.requests.filter(function(request) {
        return request.method === "calendar.request" && request.params.operation === "update"
      })
      compare(updates.length, 1, "one CalDAV update was sent")
      return String(updates[0].params.body)
    }

    function test_the_zone_runs_these_tests() {
      compare(new Date(2026, 10, 1, 12, 0).getTimezoneOffset(), 480,
        "TZ=America/Los_Angeles: run through tests/test_calendar_zones_qml.py")
    }

    function test_title_only_saves_keep_unresolved_times_data() {
      return [
        { tag: "autumn repeated hour, 01:45-02:30",
          start: "DTSTART;TZID=Europe/Berlin:20261101T014500",
          end: "DTEND;TZID=Europe/Berlin:20261101T023000",
          shown: ["2026-11-01", "01:45", "2026-11-01", "02:30"] },
        { tag: "autumn repeated hour, 01:45-03:00",
          start: "DTSTART;TZID=Europe/Berlin:20261101T014500",
          end: "DTEND;TZID=Europe/Berlin:20261101T030000",
          shown: ["2026-11-01", "01:45", "2026-11-01", "03:00"] },
        { tag: "spring gap, 01:45-02:30",
          start: "DTSTART;TZID=Europe/Berlin:20260308T014500",
          end: "DTEND;TZID=Europe/Berlin:20260308T023000",
          shown: ["2026-03-08", "01:45", "2026-03-08", "03:30"] },
        { tag: "wall-clock start, UTC end",
          start: "DTSTART;TZID=Europe/Berlin:20261105T170000",
          end: "DTEND:20261105T174500Z",
          shown: ["2026-11-05", "17:00", "2026-11-05", "17:45"] },
        { tag: "#461 invitation",
          start: "DTSTART;TZID=Europe/Berlin:20261105T170000",
          end: "DTEND;TZID=Europe/Berlin:20261105T174500",
          shown: ["2026-11-05", "17:00", "2026-11-05", "17:45"] }
      ]
    }

    function test_title_only_saves_keep_unresolved_times(data) {
      var event = Calendar.eventsFromCaldav(caldav(data.start, data.end), "caldav:team")[0]
      compare(event.start.resolved, false)
      verify(event.end.ms > event.start.ms, "the end is after the start")
      var body = renameAndSave(event)
      verify(body.indexOf(data.start + "\r\n") >= 0, "DTSTART is kept as it arrived: " + body)
      verify(body.indexOf(data.end + "\r\n") >= 0, "DTEND is kept as it arrived: " + body)
      compare(body.match(/^DTSTART/gm).length, 1)
      compare(body.match(/^DTEND/gm).length, 1)
      verify(body.indexOf("SUMMARY:Review\\, renamed") >= 0)
      verify(body.indexOf("SEQUENCE:1") >= 0)
      composer.close()
      composer.beginEdit("caldav:team", event)
      wait(0)
      compare([field("event-start-date-field"), field("event-start-time-field"),
        field("event-end-date-field"), field("event-end-time-field")], data.shown,
        "the editor shows the times as written")
    }

    // Only a DTSTART, in the repeated hour: the week view lays it out at half an
    // hour and the editor opens it at an hour, both counted from the start.
    function test_an_event_without_an_end_stays_usable_in_the_repeated_hour() {
      var event = Calendar.eventsFromCaldav(caldav("DTSTART;TZID=Europe/Berlin:20261101T014500", ""),
        "caldav:team")[0]
      compare(event.end, null)
      var day = { startMs: new Date(2026, 10, 1).getTime(), endMs: new Date(2026, 10, 2).getTime() }
      compare(Calendar.eventHeight(event, day, 60), 30, "a half-hour block at 60 pixels an hour")
      composer.beginEdit("caldav:team", event)
      wait(0)
      compare([field("event-start-date-field"), field("event-start-time-field"),
        field("event-end-date-field"), field("event-end-time-field")],
        ["2026-11-01", "01:45", "2026-11-01", "02:45"])
      composer.close()
      var body = renameAndSave(event)
      verify(body.indexOf("DTSTART;TZID=Europe/Berlin:20261101T014500\r\n") >= 0, body)
      compare(body.match(/^DTSTART/gm).length, 1)
      verify(!/^(DTEND|DURATION)/m.test(body), "no end is invented: " + body)
    }

    function test_a_changed_time_is_written_as_typed_on_the_local_clock() {
      var event = Calendar.eventsFromCaldav(caldav("DTSTART;TZID=Europe/Berlin:20261105T170000",
        "DTEND;TZID=Europe/Berlin:20261105T174500"), "caldav:team")[0]
      composer.beginEdit("caldav:team", event)
      wait(0)
      findChild(composer, "event-end-time-field").text = "18:30"
      verify(findChild(composer, "event-save-button").enabled)
      composer.submit("all")
      var body = String(mailService.requests.filter(function(request) {
        return request.params && request.params.operation === "update"
      })[0].params.body)
      verify(body.indexOf("DTSTART:20261106T010000Z\r\n") >= 0, body)
      verify(body.indexOf("DTEND:20261106T023000Z\r\n") >= 0, body)
      verify(body.indexOf("TZID=Europe/Berlin") < 0, "the replaced lines are gone")
    }
  }
}
