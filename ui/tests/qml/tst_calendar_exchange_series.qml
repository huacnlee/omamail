import QtQuick 2.15
import QtTest 1.3
import "../../calendar" as Omamail
import "../../calendar/ExchangeEvents.js" as ExchangeEvents
import "../../components" as Views

// Repeating events on an Exchange calendar, from the screen to the backend call: a new series goes out as the server
// can be told it; an event of a series is changed, deleted, cancelled, declined, answered or removed as this event or,
// only where the backend said so, all of them, the form or the question having said which, with that part's version.
Item {
  width: 700
  height: 600
  SystemPalette { id: palette }

  QtObject {
    id: mailService
    property var requests: []
    property var answers: ({})
    property bool backendCanDiscoverCalendars: true
    property bool backendCanGoogleCalendars: false
    property string calendarPalettePath: ""
    property QtObject backend: QtObject {
      property bool ready: true
      property int apiVersion: 8
      function call(method, params, callback) {
        if (method.indexOf("exchange.") === 0) mailService.requests.push({ method: method, params: params })
        var answer = mailService.answers[method] || { result: { events: [], truncated: false }, error: null }
        callback(answer.result, answer.error)
      }
    }
    property bool unifiedCalendarView: false
    property var accountSummaries: [
      { id: "exchange:alice@example.org", email: "alice@example.org", provider: "exchange", signedIn: true }
    ]
    function writeConfig(name, payload, callback) { callback(true, "") }
  }

  Omamail.CalendarController {
    id: controller
    service: mailService
    pluginDir: "/tmp/omamail-test"
    accountId: "exchange:alice@example.org"
    sourceList: ({ version: 1, sources: [] })
  }

  SignalSpy { id: createdSpy; target: controller; signalName: "eventCreated" }
  SignalSpy { id: updatedSpy; target: controller; signalName: "eventUpdated" }
  SignalSpy { id: deletedSpy; target: controller; signalName: "eventDeleted" }

  Views.CalendarEventComposer {
    id: composer
    width: 600
    height: 560
    controller: controller
    textColor: palette.text
    backgroundColor: palette.base
    accentColor: palette.highlight
    urgentColor: palette.highlight
    dimColor: palette.mid
    panelFontFamily: "sans-serif"
  }

  Views.CalendarEventDetail {
    id: detail
    width: 400
    height: 500
    controller: ({ availableSources: controller.availableSources, service: mailService })
    event: ({})
    textColor: palette.text
    backgroundColor: palette.base
    accentColor: palette.highlight
    urgentColor: palette.highlight
    dimColor: palette.mid
    panelFontFamily: "sans-serif"
  }
  SignalSpy { id: deleteAsked; target: detail; signalName: "deleteRequested" }

  TestCase {
    name: "CalendarExchangeSeries"
    when: windowShown

    readonly property string sourceId: "exchange:exchange:alice@example.org"
    readonly property string account: "exchange:alice@example.org"

    function cache() {
      for (var i = 0; i < controller.children.length; i++) {
        if (controller.children[i].cacheName !== undefined) return controller.children[i]
      }
      return null
    }

    function init() {
      mailService.requests = []
      mailService.answers = ({})
      controller.lastError = ""
      controller.events = []
      createdSpy.clear()
      updatedSpy.clear()
      deletedSpy.clear()
      composer.close()
      cache().loaded = true
    }

    function cleanup() { cache().loaded = false }

    function field(name) { return findChild(composer, name) }
    function params() { return mailService.requests[0].params }
    function answer(method, result) { mailService.answers[method] = { result: result, error: null } }

    // An event of a weekly series as the screen holds it once its detail was read.
    function event(listExtra, detailExtra) {
      var listed = { id: "o2", uid: "u-s", title: "Backup", location: "", organizer: "Alice Example", allDay: false,
        startMs: 1790000000000, endMs: 1790003600000, busy: "busy", meeting: false, response: "organizer", kind: "occurrence",
        recurring: true, private: false, changeKey: "k1", editable: true, lock: "" }
      for (var key in listExtra) listed[key] = listExtra[key]
      var read = { id: "o2", changeKey: "k1", title: "Backup", location: "", allDay: false, startMs: 1790000000000,
        endMs: 1790003600000, attendees: [], response: "organizer", meeting: false, kind: "occurrence", recurring: true,
        canRespond: false, canRemove: false, editable: true, lock: "",
        series: { text: "Every week on Monday", kind: "weekly", key: "s5", editable: true, lock: "", timeEditable: true,
          canRespond: false, attendees: [], attendeesCut: false } }
      for (var more in detailExtra) read[more] = detailExtra[more]
      return ExchangeEvents.withDetail(ExchangeEvents.eventsFromExchange({ events: [listed] }, sourceId)[0], read)
    }
    function invitation(extra) {
      var series = { text: "Every week on Monday", kind: "weekly", key: "s5", editable: false, canRespond: true }
      var read = { meeting: true, response: "none", canRespond: true, editable: false, lock: "meeting", series: series,
        attendees: [{ name: "Bob", email: "bob@example.org", kind: "required", response: "unknown", self: false }] }
      for (var key in extra) read[key] = extra[key]
      return event({ meeting: true, response: "none", editable: false, lock: "meeting" }, read)
    }

    function fields(extra) {
      var value = { title: "Backup", location: "", description: "", allDay: false, startMs: 1790000000000,
        endMs: 1790003600000, recurrence: { enabled: false } }
      for (var key in extra) value[key] = extra[key]
      return value
    }

    function test_a_new_series_goes_out_with_its_rule_and_a_meeting_that_repeats_is_said_to() {
      answer("exchange.calendarCreate", { id: "n1", changeKey: "k" })
      var weekly = { enabled: true, frequency: "WEEKLY", interval: "1", count: "3", days: [] }
      compare(controller.createEvent(sourceId, fields({ recurrence: weekly })), true)
      var rule = params().recurrence
      compare([rule.frequency, rule.end, rule.count, rule.firstDate, rule.days.length],
        ["weekly", "count", 3, ExchangeEvents.dayText(1790000000000), 1])
      var asked = controller.reachRequest(sourceId, null, fields({ guestEmails: "bob@example.org", recurrence: weekly }))
      compare(asked.message, "This sends an invitation to 1 person: bob@example.org. The meeting repeats, so the invitation is for every event of it.")
    }

    function test_an_event_of_a_series_is_changed_as_the_part_the_form_names_with_its_version() {
      compare(controller.updateEvent(sourceId, event(), fields({ title: "Moved" })), false)
      compare(updatedSpy.signalArguments[0][1], "Choose whether to change this event or all of them")
      answer("exchange.calendarUpdate", { id: "o2", changeKey: "k2" })
      compare(controller.updateEvent(sourceId, event(), fields({ title: "Moved", scope: "occurrence" })), true)
      compare([params().scope, params().changeKey, params().title], ["occurrence", "k1", "Moved"])
      mailService.requests = []
      var later = fields({ scope: "series", startMs: 1790000000000 + 1800000, endMs: 1790003600000 + 1800000 })
      compare(controller.updateEvent(sourceId, event(), later), true)
      compare([params().scope, params().changeKey, params().durationMinutes, "startMs" in params()], ["series", "s5", 60, false])
      // All of it only where the backend said so; one event of a meeting names no people.
      mailService.requests = []
      updatedSpy.clear()
      var blocked = event({}, { series: { text: "Every week on Monday", key: "s5", editable: false, canRespond: false } })
      compare(controller.updateEvent(sourceId, blocked, fields({ scope: "series" })), false)
      compare([updatedSpy.signalArguments[0][1], mailService.requests.length], ["This repeating series can only be changed one event at a time", 0])
      // The editor offers both parts, and every event keeps its days and its kind.
      composer.beginEdit(sourceId, event())
      compare([field("event-scope").visible, field("event-scope-series").visible, field("event-start-date-field").enabled], [true, true, true])
      field("event-scope-series").clicked()
      compare([composer.seriesScope, field("event-start-date-field").enabled], [true, false])
      mailService.requests = []
      composer.submit("all")
      compare([params().scope, params().changeKey], ["series", "s5"], "the part the form names, with its version")
    }

    function test_deleting_cancelling_or_declining_asks_which_part_and_names_that_parts_version() {
      var bob = { name: "Bob", email: "bob@example.org", kind: "required", self: false }
      var cases = [
        [event(), "exchange.calendarDelete", "Delete all events"],
        [event({ meeting: true }, { meeting: true, attendees: [bob],
          series: { text: "Every week on Monday", key: "s5", editable: true, attendees: [bob] } }), "exchange.meetingCancel", "Cancel all events for 1 person"],
        [invitation(), "exchange.calendarRespond", "Decline all events and remove"]]
      for (var i = 0; i < cases.length; i++) {
        mailService.requests = []
        var request = controller.deleteRequest(sourceId, cases[i][0])
        compare([request.choices[0].value, request.choices[0].label, request.focus], ["series", cases[i][2], "dismiss"])
        if (cases[i][1] === "exchange.meetingCancel")
          compare(request.message, "This cancels this event, or every event of the series (every week on Monday), for 1 person: "
            + "bob@example.org. They are sent a cancellation.", "one guest is told in the singular")
        answer(cases[i][1], { id: "o2", changeKey: "k2" })
        request.choice = "series"
        compare(controller.confirmDelete(request), true)
        compare([mailService.requests[0].method, params().scope, params().changeKey], [cases[i][1], "series", "s5"])
        if (cases[i][1] === "exchange.meetingCancel") compare(params().seriesAttendees, ["bob@example.org"])
      }
      compare(params().remove, true, "a series declined whole leaves the calendar")
      // A removal that stops at its bound says so.
      var cancelled = invitation({ canRespond: false, canRemove: true, cancelled: true, canRemoveSeries: true, cancelledEvents: 0 })
      var removal = controller.deleteRequest(sourceId, cancelled)
      compare(removal.choices.map(function(c) { return c.label }), ["Remove this series from your calendar", "Remove this event"])
      answer("exchange.meetingRemove", { removed: true, because: "cancelled", count: 50, more: true })
      removal.choice = "series"
      controller.confirmDelete(removal)
      compare(controller.lastError, "Removed 50 cancelled events. More are left on your calendar. Open one and remove it again")
    }

    function test_an_invitation_to_a_series_is_answered_for_this_event_until_the_person_says_all() {
      var scopes = []
      var stub = detail.controller
      detail.controller = ({ availableSources: controller.availableSources, service: mailService,
        respondToInvitation: function(sourceId, event, answer, scope) { scopes.push(scope) } })
      detail.event = invitation()
      compare([findChild(detail, "event-repeat").text, findChild(detail, "event-answer-scope").visible],
        ["Repeats · Every week on Monday", true])
      findChild(detail, "event-rsvp").answered("accepted")
      findChild(detail, "event-answer-series").clicked()
      findChild(detail, "event-rsvp").answered("accepted")
      compare(scopes, ["", "series"], "this event until the person says all of them")
      detail.controller = stub
      compare(controller.respondToInvitation(sourceId, invitation({ series: { key: "s5", canRespond: false } }), "accepted", "series"), false)
      answer("exchange.calendarRespond", { id: "o2", changeKey: "k2", response: "accept", sent: true })
      compare(controller.respondToInvitation(sourceId, invitation(), "accepted", "series"), true)
      compare([params().scope, params().changeKey], ["series", "s5"])
      detail.event = invitation({ canRespond: false, canRemove: true, cancelled: true, canRemoveSeries: true, cancelledEvents: 3 })
      compare(findChild(detail, "event-cancelled").text, "The organizer cancelled 3 events of this series.")
    }

    // A meeting the owner organises whose event is an exception with fewer people than the series.
    function exception(seriesExtra) {
      var alice = { name: "Alice", email: "alice@example.org", kind: "required", response: "organizer", self: true }
      var bob = { name: "Bob", email: "bob@example.org", kind: "required", response: "accept", self: false }
      var cy = { name: "Cy", email: "cy@example.org", kind: "optional", response: "none", self: false }
      var series = { text: "Every week on Monday", kind: "weekly", key: "s5", editable: true, lock: "", timeEditable: true,
        canRespond: false, attendees: [alice, bob, cy], attendeesCut: false }
      for (var key in seriesExtra) series[key] = seriesExtra[key]
      return event({ meeting: true, kind: "exception" }, { meeting: true, kind: "exception", attendees: [alice, bob], series: series })
    }

    function test_all_of_a_repeating_meeting_tells_the_series_people_its_question_named() {
      composer.beginEdit(sourceId, exception())
      compare(field("event-guests-field").text, "bob@example.org")
      field("event-scope-series").clicked()
      compare(field("event-guests-field").text, "bob@example.org, cy@example.org", "the series' people, not this event's")
      var asked = controller.reachRequest(sourceId, exception(), fields({ title: "Moved", scope: "series" }))
      compare(asked.message, "This tells 2 people every event of the meeting (every week on Monday) changed: bob@example.org, cy@example.org.")
      // Unasked, nothing is sent; asked, the write names the people the question named.
      compare(controller.updateEvent(sourceId, exception(), fields({ title: "Moved", scope: "series" })), false)
      compare([updatedSpy.signalArguments[0][1], mailService.requests.length], [ExchangeEvents.UNCONFIRMED_SEND, 0])
      answer("exchange.meetingUpdate", { id: "o2", changeKey: "k2", sent: true })
      compare(controller.updateEvent(sourceId, exception(), fields({ title: "Moved", scope: "series", confirmedSend: true })), true)
      compare([params().scope, params().changeKey, params().seriesAttendees], ["series", "s5", ["bob@example.org", "cy@example.org"]])
      // The series' people not read: all of it is not sent, whoever is on this event.
      mailService.requests = []
      updatedSpy.clear()
      var nobody = exception({ attendees: [{ name: "Alice", email: "alice@example.org", kind: "required", self: true }] })
      compare(controller.updateEvent(sourceId, nobody, fields({ title: "Moved", scope: "series", confirmedSend: true })), false)
      compare([updatedSpy.signalArguments[0][1], mailService.requests.length], [ExchangeEvents.PEOPLE_UNKNOWN, 0])
      // A new time of every event mails them too: asked about, and refused unasked.
      mailService.requests = []
      updatedSpy.clear()
      var later = fields({ scope: "series", startMs: 1790000000000 + 1800000, endMs: 1790003600000 + 1800000 })
      verify(controller.reachRequest(sourceId, exception(), later) !== null, "a new time of all of it is asked about")
      compare(controller.updateEvent(sourceId, exception(), later), false)
      compare([updatedSpy.signalArguments[0][1], mailService.requests.length], [ExchangeEvents.UNCONFIRMED_SEND, 0])
      // A cancellation of all of it names and carries the series' people; of this event, its own.
      var cancel = controller.deleteRequest(sourceId, exception())
      compare(cancel.choices.map(function(c) { return c.label }), ["Cancel all events for 2 people", "Cancel this event for 1 person"])
      answer("exchange.meetingCancel", { cancelled: true, told: 2 })
      cancel.choice = "series"
      compare(controller.confirmDelete(cancel), true)
      compare([params().scope, params().seriesAttendees], ["series", ["bob@example.org", "cy@example.org"]])
    }

    function test_all_of_a_series_keeps_its_days_and_its_time_where_the_backend_said_so() {
      composer.beginEdit(sourceId, exception())
      field("event-scope-series").clicked()
      compare([field("event-start-date-field").enabled, field("event-start-time-field").enabled, field("event-end-time-field").enabled],
        [false, true, true])
      compare([field("event-series-when").visible, field("event-series-when").text], [true, "Every event keeps its own day; only the time changes."])
      verify(field("event-start-date-field").opacity < 1, "a field that cannot be typed in looks it")
      composer.beginEdit(sourceId, exception({ timeEditable: false }))
      compare(field("event-series-when").visible, false, "this event until the person says all of them")
      field("event-scope-series").clicked()
      compare([field("event-start-time-field").enabled, field("event-end-time-field").enabled], [false, false])
      verify(field("event-series-when").text.indexOf("Change the time of all of them in Outlook") > 0)
      var later = fields({ scope: "series", startMs: 1790000000000 + 1800000, endMs: 1790003600000 + 1800000, confirmedSend: true })
      compare(controller.updateEvent(sourceId, exception({ timeEditable: false }), later), false)
      compare([updatedSpy.signalArguments[0][1], mailService.requests.length], ["The time of every event can only be changed in Outlook", 0])
      // An event of the series has guests of its own: all of it is not offered, and the form says why.
      composer.beginEdit(sourceId, exception({ editable: false, lock: "exceptionGuests" }))
      compare([field("event-scope-series"), field("event-series-lock").text], [null,
        "Only this event can be changed here. Some events of this series have their own guests: change all of them in Outlook"])
      compare(controller.deleteRequest(sourceId, exception({ editable: false, lock: "exceptionGuests" })).choices.map(function(c) { return c.value }),
        ["occurrence"])
      // The series' people not all read: all of it is not offered, and the form says why.
      composer.beginEdit(sourceId, exception({ attendeesCut: true }))
      compare([field("event-scope-series"), field("event-series-lock").visible], [null, true])
      compare(field("event-series-lock").text, "Only this event can be changed here. Not every guest's address could be read: change it in Outlook")
    }

    function test_one_cancelled_event_of_a_series_is_removed_through_its_scope() {
      var cancelled = invitation({ canRespond: false, canRemove: true, cancelled: true, canRemoveSeries: false })
      var removal = controller.deleteRequest(sourceId, cancelled)
      compare(removal.choices, [{ value: "occurrence", label: "Remove this event" }])
      answer("exchange.meetingRemove", { removed: true, because: "cancelled" })
      removal.choice = "occurrence"
      compare(controller.confirmDelete(removal), true)
      compare([mailService.requests[0].method, params().scope, params().changeKey], ["exchange.meetingRemove", "occurrence", "k1"])
    }

    function test_a_new_time_of_every_event_says_it_undoes_the_events_changed_on_their_own() {
      var undoes = "Changing the time of every event also undoes changes made to single events."
      var changed = { text: "Every week on Monday", kind: "weekly", key: "s5", editable: true, lock: "", timeEditable: true,
        canRespond: false, attendees: [], attendeesCut: false, exceptions: 1 }
      composer.beginEdit(sourceId, event({}, { series: changed }))
      field("event-scope-series").clicked()
      compare(field("event-series-exceptions").visible, false, "nothing said before the time changes")
      field("event-title-field").text = "Backup, renamed"
      compare(field("event-series-exceptions").visible, false, "a new title keeps them")
      field("event-start-time-field").text = "05:00"
      field("event-end-time-field").text = "05:30"
      compare([field("event-series-exceptions").visible, field("event-series-exceptions").text], [true, undoes])
      field("event-scope-occurrence").clicked()
      compare(field("event-series-exceptions").visible, false, "one event undoes nothing")
      // A series with no event changed on its own has nothing to lose.
      composer.beginEdit(sourceId, event())
      field("event-scope-series").clicked()
      field("event-start-time-field").text = "05:00"
      field("event-end-time-field").text = "05:30"
      compare(field("event-series-exceptions").visible, false)
    }
  }
}
