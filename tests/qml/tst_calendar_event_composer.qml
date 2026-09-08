import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

Item {
  width: 900
  height: 600

  QtObject {
    id: eventController
    property bool creatingEvent: false
    property bool eventWriting: false
    property int createCalls: 0
    property int updateCalls: 0
    property string accountId: ""
    property bool composerHeld: false
    property var writableSourceGroups: [{
      id: "google:me@example.com", providerLabel: "Google", accountLabel: "me@example.com",
      calendars: [{ id: "google:me@example.com", name: "me@example.com", colorKey: "accent" }]
    }, {
      id: "account:imap:bob@example.com", providerLabel: "CalDAV", accountLabel: "bob@example.com",
      calendars: [{ id: "caldav:bob-home", name: "Home", colorKey: "accent" }]
    }]

    signal eventCreated(bool ok, string error)
    signal eventUpdated(bool ok, string error)
    signal composeRequested(var prefill)
    signal composeEnded()

    function createEvent(_sourceId, _fields) {
      if (creatingEvent || eventWriting) return false
      createCalls++
      creatingEvent = true
      return true
    }

    function updateEvent(_sourceId, _event, _fields) {
      if (creatingEvent || eventWriting) return false
      updateCalls++
      eventWriting = true
      return true
    }
  }

  Omamail.CalendarEventComposer {
    id: composer
    anchors.fill: parent
    controller: eventController
    textColor: Qt.rgba(1, 1, 1, 1)
    backgroundColor: Qt.rgba(0.06, 0.06, 0.06, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    urgentColor: Qt.rgba(1, 0.2, 0.2, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "CalendarEventComposer"
    when: windowShown

    function init() {
      eventController.creatingEvent = false
      eventController.eventWriting = false
      eventController.createCalls = 0
      eventController.updateCalls = 0
      composer.close()
      composer.writePending = false
    }

    // A suggestion from a message opens the form filled in, on the
    // calendar the reading mailbox prefers, with nothing written yet.
    function test_begin_with_fills_the_fields_and_writes_nothing() {
      var start = new Date(2026, 8, 12, 19, 0).getTime()
      eventController.composeRequested({ title: "Dinner with Bob", startMs: start, endMs: start + 7200000,
        location: "Luigi's", description: "Table for four" })
      compare(composer.opened, true)
      compare(composer.titleText(), "Dinner with Bob")
      compare(composer.whenText(), "2026-09-12 19:00 21:00")
      compare(composer.locationText(), "Luigi's")
      compare(composer.notesText(), "Table for four")
      compare(eventController.createCalls, 0, "nothing is written until the owner says so")
      composer.submit()
      compare(eventController.createCalls, 1)
    }

    // A form the owner is in the middle of is not replaced by a suggestion;
    // an empty one is. The suggestion's own mailbox chooses the calendar.
    function test_a_suggestion_does_not_clobber_a_form_in_use() {
      composer.beginAt(new Date(2026, 7, 25, 9, 0).getTime())
      compare(composer.pristine, true)
      compare(eventController.composerHeld, false)
      compare(composer.beginWith({ title: "Dinner", startMs: new Date(2026, 8, 12, 19, 0).getTime(),
        endMs: new Date(2026, 8, 12, 20, 0).getTime(), accountId: "imap:bob@example.com" }), true,
        "an empty form gives way")
      compare(composer.titleText(), "Dinner")
      compare(composer.selectedSourceId, "caldav:bob-home", "on the mailbox's own calendar")
      compare(eventController.composerHeld, true, "and now the form is in use")
      compare(composer.beginWith({ title: "Other", startMs: new Date(2026, 8, 13, 19, 0).getTime(),
        endMs: new Date(2026, 8, 13, 20, 0).getTime() }), false, "a second suggestion does not replace it")
      compare(composer.titleText(), "Dinner")
      var ended = 0
      eventController.composeEnded.connect(function() { ended++ })
      composer.close()
      compare(ended, 1, "closing says so")
      compare(eventController.composerHeld, false)
    }

    function test_old_update_completion_does_not_close_a_new_create_form() {
      eventController.eventWriting = true
      composer.beginAt(new Date(2026, 7, 25, 9, 0).getTime())

      composer.submit()
      compare(eventController.createCalls, 0)
      compare(composer.writePending, false,
        "a busy controller did not accept this form's write")

      eventController.eventWriting = false
      eventController.eventUpdated(true, "")
      compare(composer.opened, true,
        "the old update completion belongs to the cancelled form")
    }

    // Under the unified view every account's calendars are offered at once, and
    // `groupByAccount` orders them by the stored accounts rather than by which
    // mailbox is open. Opening the composer from mailbox B has to preselect B's
    // calendar: the first group is A's, and an event written there without the
    // user noticing the picker lands in the wrong account.
    function test_the_composer_opens_on_the_mailbox_being_read() {
      eventController.writableSourceGroups = [{
        id: "account:one@gmail.com", providerLabel: "Google", accountLabel: "one@gmail.com",
        calendars: [{ id: "google:one@gmail.com", name: "one", colorKey: "accent" }]
      }, {
        id: "account:two@gmail.com", providerLabel: "Google", accountLabel: "two@gmail.com",
        calendars: [{ id: "google:two@gmail.com", name: "two", colorKey: "accent" }]
      }]

      eventController.accountId = "two@gmail.com"
      composer.beginAt(new Date(2026, 0, 5, 10, 0), false)
      compare(composer.selectedSourceId, "google:two@gmail.com")
      composer.close()

      eventController.accountId = "one@gmail.com"
      composer.beginAt(new Date(2026, 0, 5, 10, 0), false)
      compare(composer.selectedSourceId, "google:one@gmail.com")
      composer.close()

      // A mailbox with no calendar of its own still gets a usable default.
      eventController.accountId = "imap:work@example.com"
      composer.beginAt(new Date(2026, 0, 5, 10, 0), false)
      compare(composer.selectedSourceId, "google:one@gmail.com")
      composer.close()
    }
  }
}
