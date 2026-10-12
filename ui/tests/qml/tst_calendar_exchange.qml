import QtQuick 2.15
import QtTest 1.3
import "../../calendar" as Omamail
import "../../calendar/Calendar.js" as Calendar
import "../../calendar/ExchangeEvents.js" as ExchangeEvents
import "../../components" as Views

// An on-premises Exchange mailbox's calendar through the real controller: where it comes from, how it
// is asked for and how a failure is told, that a plain appointment can be made, changed and deleted
// and nothing else can, by every path that offers a write, and that an invitation is answered with
// the version its detail was read at, a decline only after the person was asked.
Item {
  id: top
  width: 600
  height: 500
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
      property int apiVersion: 9
      function call(method, params, callback) {
        if (method.indexOf("exchange.") === 0) mailService.requests.push({ method: method, params: params })
        var answer = mailService.answers[method] || { result: { events: [], truncated: false }, error: null }
        callback(answer.result, answer.error)
      }
    }
    property bool unifiedCalendarView: false
    property var accountSummaries: [
      { id: "exchange:alice@example.org", email: "alice@example.org", provider: "exchange", signedIn: true },
      { id: "one@gmail.com", email: "one@gmail.com", provider: "gmail", signedIn: true }
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

  Component {
    id: detailComponent
    Views.CalendarEventDetail {
      width: 400
      height: 400
      textColor: palette.text
      backgroundColor: palette.base
      accentColor: palette.highlight
      urgentColor: palette.highlight
      dimColor: palette.mid
      panelFontFamily: "sans-serif"
    }
  }

  TestCase {
    name: "CalendarExchange"
    when: windowShown

    readonly property string sourceId: "exchange:exchange:alice@example.org"

    function cache() {
      for (var i = 0; i < controller.children.length; i++) {
        if (controller.children[i].cacheName !== undefined) return controller.children[i]
      }
      return null
    }

    function init() {
      mailService.requests = []
      mailService.answers = ({})
      mailService.backend.apiVersion = 9
      mailService.unifiedCalendarView = false
      controller.accountId = "exchange:alice@example.org"
      controller.sourceList = ({ version: 1, sources: [] })
      controller.lastError = ""
      controller.loading = false
      controller.queue = []
      controller.events = []
      createdSpy.clear()
      updatedSpy.clear()
      deletedSpy.clear()
      cache().loaded = true
    }

    function cleanup() { cache().loaded = false }

    function row(extra) {
      var value = { id: "a1", uid: "u1", title: "Dentist", location: "", organizer: "", allDay: false,
        startMs: 1790000000000, endMs: 1790003600000, busy: "busy", private: false,
        changeKey: "k1", editable: true, lock: "" }
      for (var key in extra) value[key] = extra[key]
      return value
    }

    // The range read, its events on the controller, and the requests forgotten.
    function loaded(rows, truncated) {
      mailService.answers["exchange.calendarEvents"] = { error: null, result: { truncated: truncated === true, events: rows } }
      controller.refresh(1790000000000, 1792592000000)
      mailService.requests = []
      return controller.events
    }

    function sent() { return mailService.requests.map(function(r) { return r.method }) }

    function test_a_signed_in_mailbox_brings_one_calendar_that_is_read_through_its_own_method() {
      var found = controller.availableSources.sources.filter(function(s) { return s.kind === "exchange" })
      compare(found.length, 1)
      compare(found[0].id, sourceId)
      compare(found[0].readOnly, false)
      mailService.answers["exchange.calendarEvents"] = { error: null, result: { truncated: false, events: [
        row(), row({ id: "a2", title: "Holiday", allDay: true, startDate: "2026-10-05", endDate: "2026-10-06", busy: "free" })] } }
      controller.refresh(1790000000000, 1792592000000)
      compare(JSON.stringify(mailService.requests), JSON.stringify([{ method: "exchange.calendarEvents",
        params: { accountId: "exchange:alice@example.org", startMs: 1790000000000, endMs: 1792592000000 } }]))
      compare(controller.lastError, "")
      var holiday = controller.events.filter(function(e) { return e.summary === "Holiday" })[0]
      compare(holiday.start.ms, new Date(2026, 9, 5).getTime(), "midnight of its own day, here")
      compare(holiday.sourceId, sourceId)
      // A hidden calendar is not asked for, and a signed-out mailbox has none.
      controller.sourceList = ({ version: 1, sources: [{ id: sourceId, kind: "exchange", accountId: "exchange:alice@example.org",
        readOnly: true, enabled: false }] })
      compare(controller.findSource(sourceId).readOnly, false, "a saved stamp does not hide Edit")
      mailService.requests = []
      controller.refresh(1000, 2000)
      compare(mailService.requests.length, 0)
    }

    function test_an_exchange_mailbox_alone_keeps_the_calendar_entry_and_a_signed_out_one_does_not() {
      // The window offers its calendar only while one is connected (#375).
      var saved = mailService.accountSummaries
      var loaded = controller.sourcesLoaded
      controller.sourceList = ({ version: 1, sources: [] })
      controller.sourcesLoaded = true
      mailService.accountSummaries = [saved[0]]
      compare(controller.noCalendars, false)
      mailService.accountSummaries = [{ id: saved[0].id, email: saved[0].email, provider: "exchange", signedIn: false }]
      compare(controller.noCalendars, true)
      mailService.accountSummaries = saved
      controller.sourcesLoaded = loaded
    }

    function test_a_partial_range_and_a_failure_are_told_under_the_calendars_name() {
      loaded([row()], true)
      compare(controller.events.length, 1, "what was read is shown")
      compare(controller.lastError, "alice@example.org: Only part of this range could be read, so some events are not shown")
      var cases = [["exchange_unauthorized", "Sign in to this mailbox again"],
        ["exchange_folder_unavailable", "A folder this needs was not found on the server"],
        ["something_new", "The mail server could not complete this request"]]
      for (var i = 0; i < cases.length; i++) {
        controller.lastError = ""
        mailService.answers["exchange.calendarEvents"] = { result: null, error: { code: -32000, message: cases[i][0] } }
        controller.refresh(1000, 2000)
        compare(controller.lastError, "alice@example.org: " + cases[i][1], cases[i][0])
        compare(controller.loading, false)
      }
    }

    function test_a_backend_older_than_api_9_is_told_to_update_and_never_asked() {
      mailService.backend.apiVersion = 8
      controller.refresh(1000, 2000)
      compare(controller.lastError, "alice@example.org: Update the mail backend to use this mailbox")
      mailService.backend.apiVersion = 9
      var events = loaded([row()])
      mailService.backend.apiVersion = 8
      compare(controller.updateEvent(sourceId, events[0], { title: "x", startMs: events[0].start.ms, endMs: events[0].end.ms }), true)
      compare(updatedSpy.signalArguments[0][1], "Update the mail backend to use this mailbox")
      compare(controller.rescheduleRefusal(events[0]), "Update the backend to move events by dragging")
      compare(mailService.requests.length, 0)
    }

    function test_an_appointment_is_made_changed_and_deleted_by_naming_its_version() {
      loaded([])
      mailService.answers["exchange.calendarCreate"] = { error: null, result: { id: "n1", changeKey: "k" } }
      compare(controller.createEvent(sourceId, { title: "Dentist", location: "Room 4", description: "Bring the card",
        startMs: 1790000000000, endMs: 1790001800000, allDay: false, recurrence: { enabled: false } }), true)
      compare(JSON.stringify(mailService.requests[0].params), JSON.stringify({ allDay: false, startMs: 1790000000000,
        endMs: 1790001800000, accountId: "exchange:alice@example.org", title: "Dentist", location: "Room 4", notes: "Bring the card" }))
      compare(createdSpy.signalArguments[0][0], true)
      compare(sent(), ["exchange.calendarCreate", "exchange.calendarEvents"], "and nothing else")
      var events = loaded([row()])
      mailService.answers["exchange.calendarUpdate"] = { error: null, result: { id: "a1", changeKey: "k2" } }
      compare(controller.updateEvent(sourceId, events[0], { title: "Dentist, renamed", location: "",
        startMs: events[0].start.ms, endMs: events[0].end.ms, allDay: false }), true)
      compare(JSON.stringify(mailService.requests[0].params), JSON.stringify({ accountId: "exchange:alice@example.org",
        id: "a1", changeKey: "k1", title: "Dentist, renamed" }), "the place and the time are left alone")
      compare(updatedSpy.signalArguments[0][0], true)
      events = loaded([row()])
      mailService.answers["exchange.calendarDelete"] = { error: null, result: { deleted: true } }
      var request = controller.deleteRequest(sourceId, events[0])
      compare(request.message, "This appointment moves to Deleted Items. Nobody is told.")
      compare(controller.confirmDelete(request), true)
      compare(JSON.stringify(mailService.requests[0].params), JSON.stringify({ accountId: "exchange:alice@example.org",
        id: "a1", changeKey: "k1" }))
      compare(deletedSpy.signalArguments[0][0], true)
      compare(controller.eventWriting, false)
    }

    function test_a_repeat_the_server_cannot_be_told_is_refused_and_a_dragged_appointment_moves_through_the_same_update() {
      loaded([])
      compare(controller.createEvent(sourceId, { title: "Yearly", startMs: 1000, endMs: 2000,
        recurrence: { enabled: true, frequency: "YEARLY", interval: "2", count: "" } }), false)
      compare(createdSpy.signalArguments[0][1], "A yearly repeat is every year")
      compare(mailService.requests.length, 0)
      var events = loaded([row()])
      compare(controller.rescheduleRefusal(events[0]), "")
      mailService.answers["exchange.calendarUpdate"] = { error: null, result: { id: "a1", changeKey: "k2" } }
      compare(controller.updateEvent(sourceId, events[0], Calendar.rescheduleFields(events[0],
        events[0].start.ms + 1800000, events[0].end.ms + 1800000)), true)
      var params = mailService.requests[0].params
      compare([params.changeKey, params.allDay, params.startMs].join(), ["k1", false, events[0].start.ms + 1800000].join())
    }

    function test_whatever_is_not_a_plain_appointment_is_refused_with_its_reason_and_nothing_is_sent() {
      var locks = ["meeting", "recurring", "cancelled", "foreign", "private", "unknown"]
      for (var i = 0; i < locks.length; i++) {
        var event = loaded([row({ editable: false, lock: locks[i] })])[0]
        verify(event.lockReason !== "", locks[i])
        updatedSpy.clear()
        deletedSpy.clear()
        compare(controller.updateEvent(sourceId, event, { title: "x", startMs: event.start.ms, endMs: event.end.ms }), false)
        compare(updatedSpy.signalArguments[0][1], event.lockReason)
        compare(controller.deleteEvent(sourceId, event), false)
        compare(deletedSpy.signalArguments[0][1], event.lockReason)
        compare(controller.rescheduleRefusal(event), event.lockReason)
        compare(mailService.requests.length, 0, locks[i] + ": nothing reached the backend")
      }
    }

    function test_a_conflict_or_an_unknown_outcome_is_said_and_nothing_is_retried() {
      var events = loaded([row()])
      var cases = [["exchange_calendar_conflict", "This event changed elsewhere. Refresh and try again."],
        ["exchange_calendar_unconfirmed", "The server did not confirm the change. Look at your calendar before trying again"]]
      for (var i = 0; i < cases.length; i++) {
        updatedSpy.clear()
        mailService.requests = []
        mailService.answers["exchange.calendarUpdate"] = { result: null, error: { code: -32000, message: cases[i][0] } }
        compare(controller.updateEvent(sourceId, events[0], { title: "x", startMs: events[0].start.ms, endMs: events[0].end.ms }), true)
        compare(updatedSpy.signalArguments[0][1], cases[i][1])
        compare(controller.lastError, cases[i][1])
        compare(sent(), ["exchange.calendarUpdate"], "no second try and no refresh behind the person's back")
        compare(controller.eventWriting, false)
      }
    }

    function test_the_detail_panel_offers_edit_and_delete_for_an_appointment_and_the_reason_for_anything_else() {
      var event = { sourceId: sourceId, exchangeId: "id", exchangeKey: "k1", lockReason: "", summary: "Planning",
        start: { ms: 1000, allDay: false }, end: { ms: 2000, allDay: false } }
      var detail = createTemporaryObject(detailComponent, this, { controller: controller, event: event })
      compare(detail.canDelete && detail.canWrite, true)
      compare(findChild(detail, "event-lock-reason").visible, false)
      var locked = JSON.parse(JSON.stringify(event))
      locked.lockReason = "This meeting can only be changed in Outlook"
      detail = createTemporaryObject(detailComponent, this, { controller: controller, event: locked })
      compare(detail.canDelete || detail.canWrite, false)
      compare(findChild(detail, "event-lock-reason").text, "This meeting can only be changed in Outlook")
      // The owner's file marks it read only: the flag, not a missing reason, is what refuses.
      var marked = { availableSources: { sources: [{ id: sourceId, kind: "exchange", readOnly: true }] }, service: mailService }
      detail = createTemporaryObject(detailComponent, this, { controller: marked, event: event })
      compare(detail.canDelete || detail.canWrite, false)
      compare(controller.writableSourceGroups.length, 1, "the composer and the agent are offered it")
    }

    // An invitation as the list draws it, and the detail of it read when it is opened.
    function invited() {
      var event = loaded([row({ id: "i1", uid: "u-i1", title: "Planning", editable: false, lock: "meeting",
        meeting: true, response: "none", kind: "single" })])[0]
      mailService.answers["exchange.calendarEvent"] = { error: null, result: { id: "i1", changeKey: "k2",
        title: "Planning", location: "", allDay: false, startMs: 1790000000000, endMs: 1790003600000,
        notes: "Agenda", notesCut: false, organizer: { name: "Bob", email: "bob@example.org" },
        attendees: [{ name: "Alice", email: "alice@example.org", kind: "required", response: "none", self: true }],
        attendeesCut: false, response: "none", reminderMinutes: 10, joinUrl: "", sensitivity: "normal",
        meeting: true, recurring: false, cancelled: false, kind: "single", canRespond: true,
        editable: false, lock: "meeting" } }
      var merged = null
      controller.exchangeDetail(controller.findSource(sourceId), event, function(found, error) { merged = found })
      compare(JSON.stringify(mailService.requests.pop()), JSON.stringify({ method: "exchange.calendarEvent",
        params: { accountId: "exchange:alice@example.org", id: "i1" } }))
      return merged
    }

    function test_yes_and_maybe_answer_at_once_with_the_details_version_and_the_list_is_read_again() {
      var event = invited()
      compare([event.canRespond, event.answerKey, event.exchangeKey, event.description].join(), "true,k2,k1,Agenda")
      mailService.answers["exchange.calendarRespond"] = { error: null, result: { id: "i9", changeKey: "k3",
        response: "accept", sent: true } }
      compare(controller.respondToInvitation(sourceId, event, "declined"), false, "No asks first")
      compare(controller.respondToInvitation(sourceId, event, "accepted"), true)
      compare(JSON.stringify(mailService.requests[0].params), JSON.stringify({ accountId: "exchange:alice@example.org",
        id: "i1", changeKey: "k2", response: "accept", send: true }))
      compare(sent(), ["exchange.calendarRespond", "exchange.calendarEvents"])
      compare([controller.responding, controller.answeredKey === ExchangeEvents.stableKey(event)].join(), "false,true")
      // What is not answerable here, or while something else is written, sends nothing.
      mailService.requests = []
      var plain = loaded([row()])[0]
      compare(controller.respondToInvitation(sourceId, plain, "accepted"), false)
      var keyless = JSON.parse(JSON.stringify(event))
      keyless.answerKey = ""
      compare(controller.respondToInvitation(sourceId, keyless, "accepted"), false)
      controller.eventWriting = true
      compare(controller.respondToInvitation(sourceId, event, "tentative"), false)
      controller.eventWriting = false
      compare(mailService.requests.length, 0)
      // An answer whose fate is not known says so, and nothing is read or sent behind it.
      controller.answeredKey = ""
      mailService.answers["exchange.calendarRespond"] = { result: null, error: { code: -32000, message: "exchange_calendar_unconfirmed" } }
      compare(controller.respondToInvitation(sourceId, event, "tentative"), true)
      compare(controller.lastError, "The server did not confirm your answer. Look at your calendar before answering again")
      compare([sent().join(), controller.answeredKey].join(), "exchange.calendarRespond,")
    }

    function test_no_is_a_decline_the_person_confirms_that_takes_the_meeting_off_the_calendar() {
      var event = invited()
      var request = controller.deleteRequest(sourceId, event)
      compare([request.title, request.dismiss, request.focus, request.choices[0].label].join("|"),
        "Decline \"Planning\"?|Keep meeting|dismiss|Decline and remove")
      compare(request.message, "This tells the organizer you decline. The meeting is removed from your calendar.")
      mailService.answers["exchange.calendarRespond"] = { error: null, result: { id: "", changeKey: "",
        response: "decline", sent: true, removed: true } }
      compare(controller.confirmDelete(request), true)
      compare(JSON.stringify(mailService.requests[0].params), JSON.stringify({ accountId: "exchange:alice@example.org",
        id: "i1", changeKey: "k2", response: "decline", send: true, remove: true }))
      compare(deletedSpy.signalArguments[0][0], true)
      // Not beside another answer on its way.
      mailService.requests = []
      deletedSpy.clear()
      controller.responding = true
      compare(controller.deleteEvent(sourceId, event), false)
      compare(deletedSpy.signalArguments[0][1], "Another answer is still being sent")
      controller.responding = false
      compare(mailService.requests.length, 0)
      // An invitation as the list drew it, before its detail said it may be answered, cannot be declined.
      mailService.requests = []
      deletedSpy.clear()
      var listed = loaded([row({ id: "i1", editable: false, lock: "meeting" })])[0]
      compare(controller.deleteEvent(sourceId, listed), false)
      compare(deletedSpy.signalArguments[0][1], "This meeting can only be changed in Outlook")
      compare(mailService.requests.length, 0)
    }

    function test_a_reminder_goes_with_a_new_appointment_and_an_edit_names_it_only_when_chosen() {
      loaded([])
      compare(controller.createEvent(sourceId, { title: "Dentist", startMs: 1790000000000, endMs: 1790001800000,
        reminderMode: "custom", reminderMinutes: "1e2", recurrence: { enabled: false } }), false)
      compare(createdSpy.signalArguments[0][1], "Reminder minutes must be a whole number from 0 to 40320")
      compare(controller.createEvent(sourceId, { title: "Dentist", startMs: 1790000000000, endMs: 1790001800000,
        reminderMode: "custom", reminderMinutes: "15", recurrence: { enabled: false } }), true)
      compare(mailService.requests[0].params.reminderMinutes, 15)
      var events = loaded([row({ reminderMinutes: 15 })])
      compare(events[0].reminders.overrides[0].minutes, 15, "what the desktop reminders read")
      var modes = [["none", -1], ["preserve", undefined]]
      for (var i = 0; i < modes.length; i++) {
        mailService.requests = []
        compare(controller.updateEvent(sourceId, events[0], { title: "Dentist", location: "", reminderMode: modes[i][0],
          startMs: events[0].start.ms, endMs: events[0].end.ms, allDay: false }), true)
        compare(mailService.requests[0].params.reminderMinutes, modes[i][1], modes[i][0])
      }
    }

    function test_the_detail_panel_draws_what_the_detail_read_and_answers_through_the_controller() {
      var event = invited()
      event.notesCut = true
      var calls = []
      var answering = { availableSources: controller.availableSources, service: mailService, responding: false,
        answeredKey: ExchangeEvents.stableKey(event),
        respondToInvitation: function(id, value, answer) { calls.push(answer); return true } }
      var detail = createTemporaryObject(detailComponent, top, { controller: answering, event: event })
      var shown = ["event-rsvp", "event-organizer", "event-reminder", "event-notes-cut", "event-answer-sent", "event-cancelled"]
      compare(shown.map(function(name) { return findChild(detail, name).visible }).join(), "true,true,true,true,true,false")
      compare(findChild(detail, "rsvp-declined").text, "No...", "No asks first")
      compare(findChild(detail, "event-reminder").text, "Reminder · 10 minutes before")
      compare([detail.canDelete, detail.canWrite, findChild(detail, "event-delete").text].join(), "true,false,Decline and remove...")
      var asked = []
      detail.deleteRequested.connect(function(id, value) { asked.push(value.exchangeId) })
      findChild(detail, "rsvp-tentative").clicked()
      findChild(detail, "rsvp-declined").clicked()
      compare([calls.join(), asked.join()].join("|"), "tentative|i1")
      // While an answer is on its way, the decline waits too.
      var busy = Object.assign({}, answering, { responding: true })
      var waiting = createTemporaryObject(detailComponent, top, { controller: busy, event: event })
      compare([findChild(waiting, "event-delete").enabled, findChild(waiting, "rsvp-tentative").enabled].join(), "false,false")
      // And while a decline (a write) is on its way, every answer waits.
      var declining = Object.assign({}, answering, { eventWriting: true })
      waiting = createTemporaryObject(detailComponent, top, { controller: declining, event: event })
      compare(["rsvp-accepted", "rsvp-tentative", "rsvp-declined", "event-delete"].map(function(name) {
        return findChild(waiting, name).enabled }).join(), "false,false,false,false")
      // Somebody else's meeting says who may change it, under the answers.
      compare(findChild(detail, "event-lock-reason").text, "Only its organizer can change this meeting.")
      // A meeting its organizer cancelled is said to be, and offers no answer.
      var cancelled = JSON.parse(JSON.stringify(event))
      cancelled.canRespond = false
      cancelled.cancelledByOrganizer = true
      detail = createTemporaryObject(detailComponent, top, { controller: answering, event: cancelled })
      compare([findChild(detail, "event-cancelled").visible, findChild(detail, "event-rsvp").visible].join(), "true,false")
      compare(findChild(detail, "event-cancelled").text, "The organizer cancelled this meeting.")
      // Another event of the series was cancelled and this one does not say whether it is that one.
      var doubt = JSON.parse(JSON.stringify(event))
      doubt.canRespond = false
      doubt.cancellationUnplaced = true
      detail = createTemporaryObject(detailComponent, top, { controller: answering, event: doubt })
      compare([findChild(detail, "event-cancelled").visible, findChild(detail, "event-rsvp").visible].join(), "true,false")
      compare(findChild(detail, "event-cancelled").text, "An event of this meeting was cancelled; answer it in Outlook.")
      // The owner's own appointment does not name the owner as its organizer.
      var own = { sourceId: sourceId, exchangeId: "a1", exchangeKey: "k1", lockReason: "", summary: "Dentist",
        myResponse: "organizer", attendees: [], organizer: { displayName: "Alice", email: "alice@example.org" },
        start: { ms: 1000, allDay: false }, end: { ms: 2000, allDay: false } }
      detail = createTemporaryObject(detailComponent, top, { controller: answering, event: own })
      compare(findChild(detail, "event-organizer").visible, false)
      var listed = loaded([row({ id: "i1", editable: false, lock: "meeting" })])[0]
      detail = createTemporaryObject(detailComponent, top, { controller: controller, event: listed })
      compare([findChild(detail, "event-rsvp").visible, detail.canDelete].join(), "false,false")
    }
  }
}
