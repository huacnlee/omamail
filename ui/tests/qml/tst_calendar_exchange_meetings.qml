import QtQuick 2.15
import QtTest 1.3
import "../../calendar" as Omamail
import "../../calendar/ExchangeEvents.js" as ExchangeEvents
import "../../components" as Views

// Meetings with other people on an Exchange calendar, from the screen to the backend call: nothing that reaches
// somebody is sent before the owner has been told who and said yes (in the composer, in the delete question and in
// the controller, which refuses without it); a meeting the owner organises is changed and cancelled as a meeting, a
// meeting its organizer cancelled says so and is removed, and each is told in plain words with the number of people.
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
      property int apiVersion: 9
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
    name: "CalendarExchangeMeetings"
    when: windowShown

    readonly property string sourceId: "exchange:exchange:alice@example.org"
    readonly property string account: "exchange:alice@example.org"
    readonly property string unconfirmed: "The server did not confirm it, and the guests may have been told. Look at your calendar and Sent Items before trying again"

    function cache() {
      for (var i = 0; i < controller.children.length; i++) {
        if (controller.children[i].cacheName !== undefined) return controller.children[i]
      }
      return null
    }

    function init() {
      mailService.requests = []
      mailService.answers = ({})
      controller.sourceList = ({ version: 1, sources: [] })
      controller.lastError = ""
      controller.loading = false
      controller.queue = []
      controller.events = []
      createdSpy.clear()
      updatedSpy.clear()
      deletedSpy.clear()
      deleteAsked.clear()
      composer.close()
      cache().loaded = true
    }

    function cleanup() { cache().loaded = false }

    function field(name) { return findChild(composer, name) }
    function sent() { return mailService.requests.map(function(r) { return r.method }) }
    function answer(method, result, code) {
      mailService.answers[method] = code ? { result: null, error: { code: -32000, message: code } } : { result: result, error: null }
    }

    function row(extra) {
      var value = { id: "m1", uid: "u-m1", title: "Lunch", location: "Canteen", organizer: "Alice Example", allDay: false,
        startMs: 1789999980000, endMs: 1790003580000, busy: "busy", meeting: true, response: "organizer", kind: "single",
        recurring: false, private: false, changeKey: "k1", editable: true, lock: "" }
      for (var key in extra) value[key] = extra[key]
      return value
    }

    // A meeting the owner organises, or an invitation, as the screen holds it once its detail was read.
    function read(listExtra, detailExtra) {
      var detailRow = { id: "m1", changeKey: "k1", title: "Lunch", location: "Canteen", notes: "", notesCut: false,
        allDay: false, startMs: 1789999980000, endMs: 1790003580000, organizer: { name: "Alice", email: "alice@example.org" },
        attendees: [
          { name: "Ada", email: "ada@example.org", kind: "required", response: "accept", self: false },
          { name: "Bob", email: "bob@example.org", kind: "required", response: "none", self: false },
          { name: "Cy", email: "cy@example.org", kind: "optional", response: "none", self: false },
          { name: "Alice", email: "alice@example.org", kind: "required", response: "organizer", self: true }],
        attendeesCut: false, response: "organizer", reminderMinutes: -1, joinUrl: "", sensitivity: "normal", meeting: true,
        recurring: false, cancelled: false, kind: "single", canRespond: false, canRemove: false, editable: true, lock: "" }
      for (var key in detailExtra) detailRow[key] = detailExtra[key]
      return ExchangeEvents.withDetail(ExchangeEvents.eventsFromExchange({ events: [row(listExtra)] }, sourceId)[0], detailRow)
    }
    function mine() { return read({}, {}) }
    function invitation(extra) {
      var more = { response: "none", canRespond: true, editable: false, lock: "meeting", changeKey: "k9" }
      for (var key in extra) more[key] = extra[key]
      return read({ response: "none", editable: false, lock: "meeting" }, more)
    }

    // A range was read, so a write is followed by reading it again; the requests forgotten.
    function ranged() {
      controller.refresh(1789999980000, 1792592000000)
      mailService.requests = []
    }

    function fields(extra) {
      var value = { title: "Lunch", location: "Canteen", description: "", allDay: false, startMs: 1789999980000,
        endMs: 1790003580000, recurrence: { enabled: false } }
      for (var key in extra) value[key] = extra[key]
      return value
    }

    // ---------------------------------------------------------------- the controller refuses to send unasked

    function test_guests_are_invited_only_when_the_form_says_the_owner_was_asked() {
      for (var wrong of [undefined, "yes", 1, "true", null]) {
        createdSpy.clear()
        compare(controller.createEvent(sourceId, fields({ guestEmails: "ada@example.org", confirmedSend: wrong })), false)
        compare(createdSpy.signalArguments[0][1], "Confirm what is sent to the guests first")
      }
      compare(mailService.requests.length, 0, "no request, not even a harmless one")
      ranged()
      answer("exchange.meetingCreate", { id: "n1", changeKey: "k", invited: 2 })
      compare(controller.createEvent(sourceId, fields({ guestEmails: "ada@example.org, bob@example.org", confirmedSend: true })), true)
      var params = mailService.requests[0].params
      compare([params.sendInvitations, JSON.stringify(params.requiredAttendees), params.title],
        [true, JSON.stringify(["ada@example.org", "bob@example.org"]), "Lunch"])
      compare(sent(), ["exchange.meetingCreate", "exchange.calendarEvents"], "and the range is read again")
      // No guests is a personal appointment that mails nobody, whatever the form said.
      mailService.requests = []
      answer("exchange.calendarCreate", { id: "n2", changeKey: "k" })
      compare(controller.createEvent(sourceId, fields({ guestEmails: " ", confirmedSend: true })), true)
      compare(mailService.requests[0].method, "exchange.calendarCreate")
      compare("sendInvitations" in mailService.requests[0].params || "requiredAttendees" in mailService.requests[0].params, false)
      // A guest that is not an address, or is the owner, is refused in the form's words.
      createdSpy.clear()
      mailService.requests = []
      compare(controller.createEvent(sourceId, fields({ guestEmails: "Alice@example.org", confirmedSend: true })), false)
      compare(createdSpy.signalArguments[0][1], "Leave your own address out of the guests: you are already on the meeting")
      compare(mailService.requests.length, 0)
    }

    function test_a_meeting_is_changed_only_after_the_question_and_its_people_only_when_the_field_changed() {
      var event = mine()
      var edit = fields({ title: "Lunch, moved" })
      compare(controller.updateEvent(sourceId, event, edit), false)
      compare(updatedSpy.signalArguments[0][1], "Confirm what is sent to the guests first")
      answer("exchange.meetingUpdate", { id: "m1", changeKey: "k2", sent: true })
      edit.confirmedSend = true
      compare(controller.updateEvent(sourceId, event, edit), true)
      var params = mailService.requests[0].params
      compare([mailService.requests[0].method, params.sendUpdates, params.title, params.changeKey, "requiredAttendees" in params],
        ["exchange.meetingUpdate", true, "Lunch, moved", "k1", false])
      // The same people in another order or case are not named: nothing changes for them.
      mailService.requests = []
      edit.guestEmails = "CY@example.org, bob@example.org, ada@example.org"
      compare(controller.updateEvent(sourceId, event, edit), true)
      compare("requiredAttendees" in mailService.requests[0].params, false)
      // The people typed are named whole; whoever was optional stays so.
      mailService.requests = []
      edit.guestEmails = "ada@example.org, cy@example.org, dee@example.org"
      compare(controller.updateEvent(sourceId, event, edit), true)
      params = mailService.requests[0].params
      compare([JSON.stringify(params.requiredAttendees), JSON.stringify(params.optionalAttendees)],
        [JSON.stringify(["ada@example.org", "dee@example.org"]), JSON.stringify(["cy@example.org"])])
      // Nobody left is a cancellation, not a change; people never read cannot be told.
      mailService.requests = []
      updatedSpy.clear()
      edit.guestEmails = "  "
      compare(controller.updateEvent(sourceId, event, edit), false)
      compare(updatedSpy.signalArguments[0][1], "A meeting needs at least one guest. To end it, cancel it")
      var listed = ExchangeEvents.eventsFromExchange({ events: [row()] }, sourceId)[0]
      compare(controller.updateEvent(sourceId, listed, fields({ confirmedSend: true })), false)
      compare(updatedSpy.signalArguments[1][1], "Open the meeting again to see who is on it")
      compare(mailService.requests.length, 0)
    }

    function test_an_unconfirmed_meeting_write_says_the_guests_may_have_been_told_and_is_not_repeated() {
      answer("exchange.meetingUpdate", null, "exchange_calendar_unconfirmed")
      compare(controller.updateEvent(sourceId, mine(), fields({ confirmedSend: true })), true)
      compare(updatedSpy.signalArguments[0][1], unconfirmed)
      answer("exchange.meetingCreate", null, "exchange_calendar_unconfirmed")
      compare(controller.createEvent(sourceId, fields({ guestEmails: "ada@example.org", confirmedSend: true })), true)
      compare(createdSpy.signalArguments[0][1], unconfirmed)
      compare(sent(), ["exchange.meetingUpdate", "exchange.meetingCreate"], "once each, and no refresh behind the person's back")
    }

    // ---------------------------------------------------------------- deleting is cancelling or removing

    function test_a_meeting_is_cancelled_through_the_question_naming_everybody_told() {
      ranged()
      var request = controller.deleteRequest(sourceId, mine())
      compare([request.title, request.focus], ["Cancel \"Lunch\"?", "dismiss"])
      compare(request.message, "This cancels the meeting for 3 people: ada@example.org, bob@example.org, cy@example.org. Each of them is sent a cancellation.")
      answer("exchange.meetingCancel", { cancelled: true, told: 3 })
      request.choice = "all"
      compare(controller.confirmDelete(request), true)
      compare(JSON.stringify(mailService.requests[0].params), JSON.stringify({ accountId: account, id: "m1", changeKey: "k1",
        sendCancellations: true }))
      compare(sent(), ["exchange.meetingCancel", "exchange.calendarEvents"])
      // Only the answered question cancels: a delete asked for any other way tells nobody anything.
      mailService.requests = []
      deletedSpy.clear()
      compare(controller.deleteEvent(sourceId, mine()), false)
      compare(deletedSpy.signalArguments[0][1], "Confirm what is sent to the guests first")
      compare(mailService.requests.length, 0)
      // A meeting whose people were never read is not cancelled: the question could not name them.
      mailService.requests = []
      var listed = ExchangeEvents.eventsFromExchange({ events: [row()] }, sourceId)[0]
      compare(controller.deleteEvent(sourceId, listed), false)
      compare(mailService.requests.length, 0)
    }

    function test_a_cancelled_meeting_is_removed_with_nobody_told_and_a_refusal_is_said() {
      var event = invitation({ canRespond: false, canRemove: true, cancelled: true })
      var request = controller.deleteRequest(sourceId, event)
      compare([request.message, request.choices[0].label], ["The organizer cancelled this meeting. Nobody is told.", "Remove from calendar"])
      answer("exchange.meetingRemove", { removed: true, because: "cancelled" })
      request.choice = "all"
      compare(controller.confirmDelete(request), true)
      compare(JSON.stringify(mailService.requests[0].params), JSON.stringify({ accountId: account, id: "m1", changeKey: "k9" }),
        "the version its detail was read at")
      answer("exchange.meetingRemove", null, "exchange_calendar_not_removable")
      var again = controller.deleteRequest(sourceId, event)
      again.choice = "all"
      controller.confirmDelete(again)
      compare(controller.lastError, "That meeting is neither cancelled nor declined, so it is not removed from here. Decline it to remove it")
    }

    // ---------------------------------------------------------------- the composer asks before it sends

    function begin() {
      composer.beginAt(0)
      composer.selectedSourceId = sourceId
      field("event-title-field").text = "Lunch"
    }

    function test_saving_a_new_event_with_guests_asks_first_and_sends_only_on_yes() {
      begin()
      compare([field("event-guests-field").visible, field("event-more-options").visible], [true, false])
      field("event-guests-field").text = "ada@example.org, bob@example.org"
      compare(field("event-save-button").text, "Create event...", "a button that opens a question says so")
      composer.submit("all")
      var ask = field("event-send-confirm")
      tryCompare(ask, "opened", true)
      compare([ask.request.message, ask.request.focus], ["This sends an invitation to 2 people: ada@example.org, bob@example.org.", "dismiss"])
      compare([mailService.requests.length, composer.writePending], [0, false])
      ask.close()
      tryCompare(ask, "opened", false)
      compare([mailService.requests.length, composer.opened], [0, true], "the way out sends nothing and keeps the form")
      answer("exchange.meetingCreate", { id: "n1", changeKey: "k", invited: 2 })
      composer.submit("all")
      tryCompare(ask, "opened", true)
      ask.confirm("all")
      compare([mailService.requests[0].method, mailService.requests[0].params.sendInvitations], ["exchange.meetingCreate", true])
      compare(composer.opened, false, "closed once it was made")
    }

    function test_a_hand_over_that_skipped_the_question_is_refused() {
      begin()
      composer.dispatch(fields({ guestEmails: "ada@example.org" }), false)
      compare(mailService.requests.length, 0)
      compare(field("event-save-error").text, "Confirm what is sent to the guests first")
    }

    function test_changing_a_meeting_asks_first_and_names_everybody_it_tells() {
      composer.beginEdit(sourceId, mine())
      compare(field("event-guests-field").text, "ada@example.org, bob@example.org, cy@example.org", "everybody but the owner")
      field("event-guests-field").text = "ada@example.org, bob@example.org"
      compare(field("event-save-button").text, "Save changes...")
      composer.submit("all")
      var ask = field("event-send-confirm")
      tryCompare(ask, "opened", true)
      compare(ask.request.message, "This tells 2 people the meeting changed: ada@example.org, bob@example.org. It tells cy@example.org they were removed.")
      compare(ask.request.dismiss, "Keep editing")
      answer("exchange.meetingUpdate", { id: "m1", changeKey: "k2", sent: true })
      ask.confirm("all")
      compare(mailService.requests[0].params.sendUpdates, true)
      compare(JSON.stringify(mailService.requests[0].params.requiredAttendees), JSON.stringify(["ada@example.org", "bob@example.org"]))
      // A personal appointment is edited with no guest field and no question.
      var plain = ExchangeEvents.eventsFromExchange({ events: [row({ meeting: false })] }, sourceId)[0]
      composer.beginEdit(sourceId, plain)
      compare([field("event-guests-field").visible, composer.reachesPeople], [false, false])
      compare(field("event-guests-column").visible, false, "and no empty band where the field would be")
    }

    function test_what_the_write_refuses_is_said_before_any_question() {
      var cases = [
        [mine(), { guestEmails: "Ada <ada@example.org>" }, "Enter valid guest email addresses separated by commas"],
        [mine(), { guestEmails: "alice@example.org" }, "Leave your own address out of the guests: you are already on the meeting"],
        [mine(), { guestEmails: " " }, "A meeting needs at least one guest. To end it, cancel it"]]
      for (var i = 0; i < cases.length; i++) {
        composer.beginEdit(sourceId, cases[i][0])
        field("event-guests-field").text = cases[i][1].guestEmails
        composer.submit("all")
        compare(field("event-send-confirm").opened, false, cases[i][2])
        compare(field("event-save-error").text, cases[i][2])
      }
      // A repeating new event with guests is refused as a series, not asked about.
      createdSpy.clear()
      compare(controller.reachRequest(sourceId, null, fields({ guestEmails: "ada@example.org", recurrence: { enabled: true } })), null)
      compare(controller.createEvent(sourceId, fields({ guestEmails: "ada@example.org", recurrence: { enabled: true, frequency: "weekly", interval: "1", count: "" } })), false)
      compare(createdSpy.signalArguments[0][1], "A repeating event on an Exchange calendar is made in Outlook")
      compare(mailService.requests.length, 0)
    }

    function test_a_button_says_it_opens_a_question_only_when_it_does() {
      begin()
      field("event-guests-field").text = "Ada <ada@example.org>"
      compare(field("event-save-button").text, "Create event", "refused before any question")
      field("event-guests-field").text = "ada@example.org"
      compare(field("event-save-button").text, "Create event...")
      composer.beginEdit(sourceId, mine())
      compare(field("event-save-button").text, "Save changes", "nothing changed yet")
      composer.reminderMode = "custom"
      findChild(composer, "event-reminder-minutes").text = "15"
      compare(field("event-save-button").text, "Save changes", "a reminder alone tells nobody")
      field("event-guests-field").text = "cy@example.org, BOB@example.org, ada@example.org"
      compare(field("event-save-button").text, "Save changes", "the same people in another order")
      field("event-title-field").text = "Lunch, moved"
      compare(field("event-save-button").text, "Save changes...")
      // The same people reordered with a real change: nobody is named as taken off or added.
      composer.submit("all")
      var ask = field("event-send-confirm")
      tryCompare(ask, "opened", true)
      compare(ask.request.message, "This tells 3 people the meeting changed: ada@example.org, bob@example.org, cy@example.org.")
      ask.close()
      tryCompare(ask, "opened", false)
    }

    function test_a_change_of_the_owners_reminder_alone_asks_nothing_and_names_nothing_else() {
      var event = mine()
      composer.beginEdit(sourceId, event)
      composer.reminderMode = "custom"
      findChild(composer, "event-reminder-minutes").text = "15"
      answer("exchange.meetingUpdate", { id: "m1", changeKey: "k2", sent: false })
      composer.submit("all")
      compare(field("event-send-confirm").opened, false, "nobody is told, so nobody is named")
      compare(mailService.requests[0].method, "exchange.meetingUpdate")
      var named = Object.keys(mailService.requests[0].params).sort()
      compare(named, ["accountId", "changeKey", "id", "reminderMinutes", "sendUpdates"])
      // Anything more is asked about.
      mailService.requests = []
      updatedSpy.clear()
      compare(controller.updateEvent(sourceId, event, fields({ title: "Lunch, moved" })), false)
      compare(updatedSpy.signalArguments[0][1], "Confirm what is sent to the guests first")
    }

    // ---------------------------------------------------------------- the detail says what deleting is

    function test_the_detail_names_what_its_delete_does_and_says_a_meeting_was_cancelled() {
      detail.event = invitation({ canRespond: false, canRemove: true, cancelled: true })
      compare([findChild(detail, "event-cancelled").visible, findChild(detail, "event-rsvp").visible,
        findChild(detail, "event-lock-reason").visible], [true, false, false])
      compare([detail.deleteLabel, detail.canWrite], ["Remove from calendar...", false])
      findChild(detail, "event-delete").clicked()
      compare(deleteAsked.count, 1, "it asks, and the question is what removes it")
      detail.event = mine()
      compare([detail.deleteLabel, detail.canWrite, findChild(detail, "event-cancelled").visible], ["Cancel meeting...", true, false])
      detail.event = invitation()
      compare(detail.deleteLabel, "Decline and remove...")
      // A meeting whose people were not read is neither changed nor cancelled from the detail.
      detail.event = ExchangeEvents.eventsFromExchange({ events: [row()] }, sourceId)[0]
      compare([detail.canWrite, detail.canDelete], [false, false])
    }
  }
}
