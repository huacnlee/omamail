import QtQuick
import QtTest
import "../../components" as Views
import "../../calendar/Calendar.js" as Calendar
import "../../calendar/ExchangeEvents.js" as ExchangeEvents

// An Exchange event opened in the month view: its detail is read when it is opened and laid over the
// event drawn from the list, with the calm states other sources have (loading, a failure said under the
// event); the event it is laid over is the one that stays, whatever late answers say; and an answer to an
// invitation gives the item a new id, so the same event is opened again from the list read after it.
Item {
  width: 1000
  height: 700
  SystemPalette { id: palette }
  QtObject {
    id: serviceFixture
    property bool backendCanGoogleCalendars: true
    property string calendarPalettePath: ""
  }
  QtObject {
    id: fixture
    property var service: serviceFixture
    property var source: ({ id: "exchange:exchange:alice@example.org", kind: "exchange",
      accountId: "exchange:alice@example.org", readOnly: false })
    property var availableSources: ({ sources: [source] })
    property var events: []
    property var pending: []
    property int refreshes: 0
    property var nativeCalls: []
    property bool sourcesLoaded: false
    property bool loading: false
    property bool clockRunning: false
    property bool eventWriting: false
    property bool responding: false
    property string answeredKey: ""
    property double nowMs: Date.now()
    property string lastError: ""
    property string lastErrorKind: ""
    function findSource(id) { return source }
    function colorKeyFor(id) { return "accent" }
    function refresh(start, end) { refreshes++ }
    function nativeRequest(source, operation, fields, callback) { nativeCalls = nativeCalls.concat([operation]) }
    function exchangeDetail(source, event, callback) {
      pending = pending.concat([{ id: event.exchangeId, callback: callback }])
    }
  }
  Views.CalendarView {
    id: view
    anchors.fill: parent
    controller: fixture
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
    name: "CalendarExchangeDetail"
    when: windowShown

    function row(id, key, extra) {
      var value = { id: id, uid: "u-" + id, title: "Planning " + id, location: "", organizer: "Ada Example", allDay: false,
        startMs: Date.UTC(2026, 9, 25, 10, 0), endMs: Date.UTC(2026, 9, 25, 11, 0), busy: "busy", meeting: true,
        response: "none", kind: "single", recurring: false, private: false, changeKey: key, editable: false,
        lock: "meeting", reminderMinutes: 10 }
      for (var name in extra) value[name] = extra[name]
      return value
    }
    function listed(rows) { return ExchangeEvents.eventsFromExchange({ events: rows }, fixture.source.id) }
    function detail(id, key, extra) {
      var value = { id: id, changeKey: key, title: "Planning " + id, location: "", notes: "Agenda for " + id, notesCut: false,
        allDay: false, startMs: Date.UTC(2026, 9, 25, 10, 0), endMs: Date.UTC(2026, 9, 25, 11, 0),
        organizer: { name: "Ada Example", email: "ada@example.org" },
        attendees: [{ name: "Alice Example", email: "alice@example.org", kind: "required", response: "none", self: true }],
        attendeesCut: false, response: "none", reminderMinutes: 10, joinUrl: "", sensitivity: "normal", meeting: true,
        recurring: false, cancelled: false, kind: "single", canRespond: true, editable: false, lock: "meeting" }
      for (var name in extra) value[name] = extra[name]
      return value
    }
    // Answers the read the way the controller does: the merged event, or a sentence.
    function answer(index, merged, error) { fixture.pending[index].callback(merged, error || "") }

    function init() {
      view.closeDetail()
      fixture.source = { id: "exchange:exchange:alice@example.org", kind: "exchange",
        accountId: "exchange:alice@example.org", readOnly: false }
      fixture.pending = []
      fixture.nativeCalls = []
      fixture.refreshes = 0
      fixture.answeredKey = ""
      fixture.loading = false
      fixture.events = listed([row("one", "k1"), row("two", "k1")])
    }

    function test_opening_an_event_reads_its_detail_and_draws_the_event_meanwhile() {
      view.activateEvent(fixture.events[0])
      compare(fixture.pending.length, 1)
      compare(fixture.pending[0].id, "one")
      compare(view.detailLoading, true)
      compare(view.detailEvent.description, "", "the list holds no notes")
      compare(view.detailEvent.canRespond, false, "and nothing can be answered before the detail says so")
      answer(0, ExchangeEvents.withDetail(fixture.events[0], detail("one", "k1")))
      compare(view.detailLoading, false)
      compare(view.detailError, "")
      compare(view.detailEvent.description, "Agenda for one")
      compare(view.detailEvent.canRespond, true)
      compare(view.detailEvent.attendees.length, 1)
      compare(view.detailEvent.summary, "Planning one")
    }

    function test_a_new_version_in_the_list_is_read_again() {
      view.activateEvent(fixture.events[0])
      answer(0, ExchangeEvents.withDetail(fixture.events[0], detail("one", "k1")))
      fixture.events = listed([row("one", "k2", { title: "Planning, moved" }), row("two", "k1")])
      compare(fixture.pending.length, 2)
      compare(view.detailEvent.summary, "Planning, moved", "drawn from the new list meanwhile")
      compare(view.detailEvent.exchangeKey, "k2")
    }

    function test_a_failed_read_is_said_under_the_event_and_the_event_stays_drawn() {
      view.activateEvent(fixture.events[0])
      answer(0, null, "The mail server took too long to answer")
      compare(view.detailLoading, false)
      compare(view.detailError, "The mail server took too long to answer")
      compare(view.detailOpen, true)
      compare(view.detailEvent.summary, "Planning one")
      compare(view.detailEvent.canRespond, false)
    }

    function test_a_detail_that_is_not_what_the_list_drew_is_a_conflict_and_the_range_is_read_again() {
      view.activateEvent(fixture.events[0])
      answer(0, ExchangeEvents.withDetail(fixture.events[0], detail("one", "k9", { title: "Planning, moved" })))
      compare(view.detailError, Calendar.CONFLICT)
      compare(view.detailEvent.canRespond, false)
      compare(view.detailEvent.exchangeKey, "k1", "the version it was drawn from, so a write is a conflict")
      verify(fixture.refreshes > 0)
    }

    function test_another_version_key_of_what_looks_the_same_is_no_conflict() {
      view.activateEvent(fixture.events[0])
      answer(0, ExchangeEvents.withDetail(fixture.events[0], detail("one", "k9")))
      compare(view.detailError, "")
      compare(view.detailEvent.canRespond, true)
      compare(view.detailEvent.answerKey, "k9")
      compare(view.detailEvent.exchangeKey, "k1")
      compare(fixture.refreshes, 0)
    }

    function test_the_answer_for_another_event_or_for_a_closed_detail_is_not_laid_over_anything() {
      view.activateEvent(fixture.events[0])
      view.activateEvent(fixture.events[1])
      answer(0, ExchangeEvents.withDetail(fixture.events[0], detail("one", "k1")))
      compare(view.detailEvent.exchangeId, "two")
      compare(view.detailEvent.description, "")
      compare(view.detailLoading, true)
      answer(1, ExchangeEvents.withDetail(fixture.events[1], detail("two", "k1")))
      compare(view.detailEvent.description, "Agenda for two")
      view.activateEvent(fixture.events[0])
      view.closeDetail()
      answer(2, ExchangeEvents.withDetail(fixture.events[0], detail("one", "k1")))
      compare(view.detailOpen, false)
    }

    function test_an_event_that_is_not_exchanges_is_not_asked_of_the_mailbox() {
      var other = Calendar.eventsFromGoogle({ items: [{ id: "g1", iCalUID: "g1", summary: "Google",
        start: { dateTime: "2026-10-25T10:00:00Z" }, end: { dateTime: "2026-10-25T11:00:00Z" } }] }, "google:test")[0]
      fixture.source = { id: "google:test", kind: "google", calendarId: "primary", readOnly: false }
      view.activateEvent(other)
      compare(fixture.pending.length, 0, "no Exchange detail is asked for a Google event")
      compare(fixture.nativeCalls.length, 1, "it is read the way it always was")
    }

    function test_an_answered_invitation_is_opened_again_from_the_list_read_after_it() {
      view.activateEvent(fixture.events[0])
      answer(0, ExchangeEvents.withDetail(fixture.events[0], detail("one", "k1")))
      fixture.answeredKey = ExchangeEvents.stableKey(view.detailEvent)
      // The server re-created the item under another id: the list read after the answer has it so.
      fixture.events = listed([row("one-again", "k2", { uid: "u-one", response: "accept" }), row("two", "k1")])
      compare(view.detailOpen, true, "the detail is not closed under the person who answered")
      compare(view.detailEvent.exchangeId, "one-again")
      compare(fixture.pending.length, 2, "and its detail is read for the new item")
      answer(1, ExchangeEvents.withDetail(view.detailEvent, detail("one-again", "k2", { response: "accept",
        attendees: [{ name: "Alice Example", email: "alice@example.org", kind: "required", response: "accept", self: true }] })))
      compare(view.detailEvent.myResponse, "accept")
      compare(view.detailEvent.attendees[0].responseStatus, "accepted")
      compare(fixture.answeredKey, ExchangeEvents.stableKey(view.detailEvent), "so the panel can still say it was sent")
    }

    function test_an_event_that_is_gone_closes_the_detail_and_clears_the_note() {
      view.activateEvent(fixture.events[0])
      answer(0, ExchangeEvents.withDetail(fixture.events[0], detail("one", "k1")))
      fixture.answeredKey = ExchangeEvents.stableKey(view.detailEvent)
      fixture.events = listed([row("two", "k1")])
      compare(view.detailOpen, false)
      compare(fixture.answeredKey, "")
    }

    function test_a_different_event_with_the_same_start_is_not_taken_for_it() {
      view.activateEvent(fixture.events[0])
      answer(0, ExchangeEvents.withDetail(fixture.events[0], detail("one", "k1")))
      // Same start, another identity: not the event that was open.
      fixture.events = listed([row("other", "k1", { uid: "u-other" }), row("two", "k1")])
      compare(view.detailOpen, false)
    }
  }
}
