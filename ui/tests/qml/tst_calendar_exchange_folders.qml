import QtQuick 2.15
import QtTest 1.3
import "../../calendar" as Omamail
import "../../calendar/Calendar.js" as Calendar
import "../../calendar/Sources.js" as Sources
import "../../components" as Views

// More than one calendar on an Exchange mailbox, through the controller: discovery of the mailbox's own and adding
// another mailbox's by its address, each calendar read by its own reference and its events kept apart, what may be
// written to a calendar that is not the default one, and that nothing that reaches people can be started from one.
Item {
  width: 600
  height: 500
  SystemPalette { id: palette }

  QtObject {
    id: mailService

    property var requests: []
    property var answers: ({})
    property bool backendCanDiscoverCalendars: true
    property bool backendCanGoogleCalendars: false
    property var configWrites: []
    property string calendarPalettePath: ""
    // An `exchange.calendarShared` held unanswered while this is true, so a test can act while it is on its way.
    property bool holdShared: false
    property var held: null
    // An answer is chosen by the method and, for a read, by the calendar it names.
    property QtObject backend: QtObject {
      property bool ready: true
      property int apiVersion: 9
      function call(method, params, callback) {
        mailService.requests.push({ method: method, params: params })
        if (method === "exchange.calendarShared" && mailService.holdShared) { mailService.held = callback; return }
        var answer = mailService.answers[method + "|" + String(params && params.calendar || "")]
          || mailService.answers[method] || { result: { events: [], truncated: false }, error: null }
        callback(answer.result, answer.error)
      }
    }
    property bool unifiedCalendarView: false
    property var accountSummaries: []

    function writeConfig(name, payload, callback) {
      configWrites.push({ name: name, payload: payload })
      callback(true, "")
    }
  }

  Omamail.CalendarController {
    id: controller
    service: mailService
    pluginDir: "/tmp/omamail-test"
    accountId: "exchange:alice@example.org"
    sourceList: ({ version: 1, sources: [] })
  }

  SignalSpy { id: createdSpy; target: controller; signalName: "eventCreated" }
  SignalSpy { id: finishedSpy; target: controller; signalName: "discoveryFinished" }

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

  TestCase {
    name: "CalendarExchangeFolders"
    when: windowShown

    readonly property string account: "exchange:alice@example.org"
    readonly property string defaultId: "exchange:exchange:alice@example.org"
    readonly property string teamId: "exchange:exchange:alice@example.org:" + "1".repeat(64)
    readonly property string sharedId: "exchange:exchange:alice@example.org:" + "2".repeat(64)
    readonly property string teamRef: "aaaaaanfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuws2ljnfuwsq"
    readonly property string sharedRef: teamRef + ":colleague@example.org"

    function cache() {
      for (var i = 0; i < controller.children.length; i++) {
        if (controller.children[i].cacheName !== undefined) return controller.children[i]
      }
      return null
    }

    function init() {
      mailService.requests = []
      mailService.answers = ({})
      mailService.configWrites = []
      mailService.holdShared = false
      mailService.held = null
      mailService.backend.apiVersion = 9
      mailService.unifiedCalendarView = false
      mailService.accountSummaries = [{ id: account, email: "alice@example.org", provider: "exchange",
        calendarProvider: "exchange", signedIn: true }]
      controller.accountId = account
      // No range is on screen, so a change of the calendars reads nothing behind the test's back.
      controller.rangeStart = 0
      controller.rangeEnd = 0
      controller.sourceList = ({ version: 1, sources: [] })
      controller.lastError = ""
      controller.loading = false
      controller.queue = []
      controller.events = []
      controller.sharedError = ""
      controller.savingSource = false
      controller.discoveringCalendars = false
      controller.sharedOpening = false
      controller.sharedRequest = null
      controller.discoveryNotice = ""
      composer.close()
      createdSpy.clear()
      finishedSpy.clear()
      cache().loaded = true
    }

    function cleanup() { cache().loaded = false }

    function sent() { return mailService.requests.map(function(r) { return r.method }) }

    // The mailbox's own calendars: the default one and a folder beside it, with a folder search that answered.
    function found() {
      return { provider: "exchange", accountId: account, truncated: false,
        steps: { folders: { found: 1, code: null } }, calendars: [
        { sourceId: defaultId, calendarId: "", name: "Calendar", isDefault: true, own: true, mailbox: "",
          readOnly: false, accessRole: "owner", origin: "default" },
        { sourceId: teamId, calendarId: teamRef, name: "Team", isDefault: false, own: true, mailbox: "",
          readOnly: false, accessRole: "owner", origin: "folder" }] }
    }

    function saved() { return JSON.parse(mailService.configWrites[mailService.configWrites.length - 1].payload).sources }

    // ------------------------------------------------------------------ discovery

    function test_a_signed_in_exchange_mailbox_can_be_discovered_and_a_signed_out_one_cannot() {
      compare(controller.discoverableAccount(account), true)
      var summaries = JSON.parse(JSON.stringify(mailService.accountSummaries))
      summaries[0].signedIn = false
      mailService.accountSummaries = summaries
      compare(controller.discoverableAccount(account), false)
      compare(controller.discoverAccountCalendars(account), false)
      compare(sent(), [])
    }

    function test_discovery_asks_the_mailboxs_own_method_and_saves_a_source_for_each_calendar() {
      mailService.answers["exchange.calendars"] = { error: null, result: found() }
      compare(controller.discoverAccountCalendars(account), true)
      compare(sent(), ["exchange.calendars"], "not the generic discovery, which knows no Exchange")
      compare(JSON.stringify(mailService.requests[0].params), JSON.stringify({ accountId: account }))
      var sources = saved()
      compare(sources.map(function(s) { return s.id }).sort(), [defaultId, teamId].sort())
      var team = sources.filter(function(s) { return s.id === teamId })[0]
      compare([team.readOnly, team.calendarId, team.remindersEnabled, team.discovered], [false, teamRef, false, true])
      var own = sources.filter(function(s) { return s.id === defaultId })[0]
      compare([own.remindersEnabled, own.name], [true, "alice@example.org"])
      compare(finishedSpy.count, 1)
      compare([finishedSpy.signalArguments[0][0], finishedSpy.signalArguments[0][2]], [true, 2])
      compare(controller.discoveryNotice, "", "a whole discovery says nothing more")
    }

    // The reviewer's sequence: a colleague's calendar added by address, then a discovery whose folder search
    // failed. Neither the calendar added by hand nor the folder found before is lost, and the owner is told why
    // the list may be old.
    function test_a_discovery_that_did_not_see_everything_keeps_what_it_did_not_see_and_says_so() {
      mailService.answers["exchange.calendars"] = { error: null, result: found() }
      controller.discoverAccountCalendars(account)
      controller.sourceList = Sources.load(mailService.configWrites[0].payload)
      mailService.answers["exchange.calendarShared"] = { error: null, result: shared() }
      controller.addSharedCalendar(account, "colleague@example.org")
      controller.sourceList = Sources.load(mailService.configWrites[1].payload)
      compare(controller.sourceList.sources.length, 3)
      var partial = found()
      partial.calendars = partial.calendars.slice(0, 1)
      partial.steps = { folders: { found: 0, code: "exchange_server_error" } }
      mailService.answers["exchange.calendars"] = { error: null, result: partial }
      finishedSpy.clear()
      controller.discoverAccountCalendars(account)
      compare(saved().map(function(s) { return s.id }).sort(), [defaultId, teamId, sharedId].sort())
      var kept = saved().filter(function(s) { return s.id === sharedId })[0]
      compare([kept.discovered, kept.calendarId], [false, sharedRef], "still the owner's, removed only by hand")
      compare(finishedSpy.signalArguments[0][0], true)
      verify(controller.discoveryNotice.indexOf("could not be read") >= 0, controller.discoveryNotice)
      // A shared calendar added afterwards does not repeat the old notice.
      mailService.answers["exchange.calendarShared"] = { error: null, result: shared() }
      controller.addSharedCalendar(account, "colleague@example.org")
      compare(controller.discoveryNotice, "")
    }

    function test_a_failed_discovery_is_told_in_the_mailboxs_words_and_saves_nothing() {
      mailService.answers["exchange.calendars"] = { result: null, error: { code: -32000, message: "exchange_folder_unavailable" } }
      compare(controller.discoverAccountCalendars(account), true)
      compare(mailService.configWrites.length, 0)
      compare(controller.discoveryError, "A folder this needs was not found on the server")
      compare(finishedSpy.signalArguments[0][0], false)
      compare(controller.discoveringCalendars, false)
      // An answer for another mailbox is not saved either, and an old backend is not asked.
      var wrong = found()
      wrong.accountId = "exchange:bob@example.org"
      mailService.answers["exchange.calendars"] = { error: null, result: wrong }
      controller.discoverAccountCalendars(account)
      compare(mailService.configWrites.length, 0)
      mailService.backend.apiVersion = 8
      mailService.requests = []
      compare(controller.discoverAccountCalendars(account), false)
      compare(sent(), [])
    }

    // ------------------------------------------------------------------ added by address

    function shared() {
      return { provider: "exchange", accountId: account, calendar: { sourceId: sharedId, calendarId: sharedRef,
        name: "Calendar", isDefault: false, own: false, mailbox: "colleague@example.org", readOnly: true,
        accessRole: "reader", origin: "address" } }
    }

    function test_a_shared_calendar_is_opened_by_the_address_and_saved_as_a_source_with_its_reminders_off() {
      mailService.answers["exchange.calendarShared"] = { error: null, result: shared() }
      compare(controller.addSharedCalendar(account, "  Colleague@Example.org "), true)
      compare(sent(), ["exchange.calendarShared"])
      var params = mailService.requests[0].params
      compare([params.accountId, params.mailbox], [account, "colleague@example.org"])
      verify(/^calendar-shared:/.test(params.requestToken), "a token a Cancel can name")
      var added = saved().filter(function(s) { return s.id === sharedId })[0]
      verify(added !== undefined)
      compare([added.calendarId, added.discovered, added.remindersEnabled, added.readOnly], [sharedRef, false, false, true])
      compare([controller.sharedError, controller.sharedOpening, controller.discoveringCalendars], ["", false, false])
    }

    function test_a_calendar_that_is_not_shared_saves_nothing_and_says_so_in_one_sentence() {
      mailService.answers["exchange.calendarShared"] = { result: null, error: { code: -32000, message: "exchange_calendar_not_shared" } }
      compare(controller.addSharedCalendar(account, "nobody@example.org"), true)
      compare(mailService.configWrites.length, 0)
      compare(controller.sharedError, "That calendar is not shared with you, or no mailbox on this server has that address. Use the primary address of the mailbox")
      compare([controller.sharedOpening, controller.discoveringCalendars], [false, false], "the form is usable again")
    }

    // Cancel while the calendar is being opened: the backend is told to stop by the request's own token, and an
    // answer that arrives anyway saves nothing.
    function test_cancel_while_a_shared_calendar_is_opened_saves_nothing_and_stops_the_request() {
      mailService.holdShared = true
      compare(controller.addSharedCalendar(account, "colleague@example.org"), true)
      compare([controller.sharedOpening, controller.discoveringCalendars], [true, true])
      var token = mailService.requests[0].params.requestToken
      controller.cancelShared()
      compare([controller.sharedOpening, controller.discoveringCalendars], [false, false])
      compare(sent(), ["exchange.calendarShared", "exchange.cancel"])
      compare(JSON.stringify(mailService.requests[1].params), JSON.stringify({ accountId: account, requestToken: token }))
      mailService.held(shared(), null)
      compare(mailService.configWrites.length, 0, "the answer came after the Cancel")
      compare([controller.sharedError, controller.sharedOpening], ["", false])
      // A Cancel with nothing on its way asks nothing.
      controller.cancelShared()
      compare(sent().length, 2)
    }

    function test_an_alias_of_the_owners_own_mailbox_is_refused_in_its_own_words() {
      mailService.answers["exchange.calendarShared"] = { result: null, error: { code: -32000, message: "exchange_calendar_own_mailbox" } }
      controller.addSharedCalendar(account, "alice.alias@example.org")
      compare(controller.sharedError, "That address is another name for your own mailbox: its calendar is already here")
      compare(mailService.configWrites.length, 0)
    }

    function test_an_address_that_is_not_one_and_the_mailboxs_own_are_refused_before_the_backend_is_asked() {
      var bad = ["", "   ", "colleague", "Ada <ada@example.org>", "a b@example.org", "ALICE@example.ORG"]
      for (var i = 0; i < bad.length; i++) {
        compare(controller.addSharedCalendar(account, bad[i]), false, JSON.stringify(bad[i]))
        verify(controller.sharedError !== "", JSON.stringify(bad[i]))
      }
      verify(controller.sharedError.indexOf("your own mailbox") >= 0)
      compare(sent(), [])
    }

    function test_an_answer_that_is_not_a_calendar_of_this_mailbox_is_not_saved() {
      var other = shared()
      other.accountId = "exchange:bob@example.org"
      mailService.answers["exchange.calendarShared"] = { error: null, result: other }
      controller.addSharedCalendar(account, "colleague@example.org")
      compare(mailService.configWrites.length, 0)
      verify(controller.sharedError !== "")
      mailService.answers["exchange.calendarShared"] = { error: null, result: { provider: "exchange", accountId: account } }
      controller.addSharedCalendar(account, "colleague@example.org")
      compare(mailService.configWrites.length, 0)
    }

    function test_nothing_is_added_while_something_else_is_saved_or_found_or_to_another_kind_of_mailbox() {
      controller.savingSource = true
      compare(controller.addSharedCalendar(account, "colleague@example.org"), false)
      controller.savingSource = false
      controller.discoveringCalendars = true
      compare(controller.addSharedCalendar(account, "colleague@example.org"), false)
      controller.discoveringCalendars = false
      compare(controller.addSharedCalendar("one@gmail.com", "colleague@example.org"), false)
      mailService.backend.apiVersion = 8
      compare(controller.addSharedCalendar(account, "colleague@example.org"), false)
      verify(controller.sharedError.indexOf("Update the mail backend") >= 0)
      compare(sent(), [])
    }

    // ------------------------------------------------------------------ reading

    function row(id, title, extra) {
      var value = { id: id, uid: "u-" + id, title: title, location: "", organizer: "", allDay: false,
        startMs: 1790000000000, endMs: 1790003600000, busy: "busy", private: false, changeKey: "k-" + id,
        editable: true, lock: "", kind: "single", meeting: false, recurring: false, response: "organizer" }
      for (var key in extra) value[key] = extra[key]
      return value
    }

    function threeCalendars() {
      controller.sourceList = ({ version: 1, sources: [
        { id: defaultId, kind: "exchange", name: "alice@example.org", accountId: account, discovered: true },
        { id: teamId, kind: "exchange", name: "Team", accountId: account, calendarId: teamRef, discovered: true },
        { id: sharedId, kind: "exchange", name: "Calendar · colleague@example.org", accountId: account,
          calendarId: sharedRef, discovered: true, readOnly: true }] })
      mailService.answers["exchange.calendarEvents|"] = { error: null, result: { truncated: false,
        events: [row("d1", "In the default")] } }
      mailService.answers["exchange.calendarEvents|" + teamRef] = { error: null, result: { truncated: false,
        events: [row("t1", "In the team folder")] } }
      mailService.answers["exchange.calendarEvents|" + sharedRef] = { error: null, result: { truncated: false,
        events: [row("s1", "In the colleague's", { editable: false, lock: "calendar" })] } }
      controller.refresh(1790000000000, 1792592000000)
    }

    function test_each_calendar_is_asked_by_its_own_reference_and_the_default_names_none() {
      threeCalendars()
      var reads = mailService.requests.filter(function(r) { return r.method === "exchange.calendarEvents" })
      compare(reads.map(function(r) { return String(r.params.calendar || "") }).sort(), ["", teamRef, sharedRef].sort())
      var plain = reads.filter(function(r) { return r.params.calendar === undefined })[0]
      compare(JSON.stringify(plain.params), JSON.stringify({ accountId: account, startMs: 1790000000000, endMs: 1792592000000 }),
        "the default calendar is asked as it always was")
      compare(controller.lastError, "")
    }

    function test_every_event_belongs_to_its_own_calendar_and_remembers_which() {
      threeCalendars()
      compare(controller.events.length, 3)
      var byTitle = {}
      controller.events.forEach(function(e) { byTitle[e.summary] = e })
      compare([byTitle["In the default"].sourceId, byTitle["In the default"].exchangeCalendar], [defaultId, ""])
      compare([byTitle["In the team folder"].sourceId, byTitle["In the team folder"].exchangeCalendar], [teamId, teamRef])
      compare([byTitle["In the colleague's"].sourceId, byTitle["In the colleague's"].exchangeCalendar], [sharedId, sharedRef])
      compare(byTitle["In the colleague's"].lockReason, "The owner of this calendar has not let you change its events")
      compare(byTitle["In the team folder"].lockReason, "")
    }

    function test_the_range_cache_keeps_each_calendars_events_under_its_own_source() {
      threeCalendars()
      var scope = controller.refreshScope
      compare(cache().get(scope, 1790000000000, 1792592000000, [defaultId, teamId, sharedId]).length, 3)
      compare(cache().get(scope, 1790000000000, 1792592000000, [teamId]).map(function(e) { return e.summary }), ["In the team folder"])
      controller.sourceList = Sources.setEnabled(controller.sourceList, teamId, false)
      mailService.requests = []
      controller.refresh(1790000000000, 1792592000000)
      compare(controller.events.length, 2, "a hidden calendar is not shown")
      compare(cache().get(scope, 1790000000000, 1792592000000, [teamId]).length, 1, "and what was read of it is kept")
    }

    function test_a_calendar_that_cannot_be_read_says_so_and_the_others_are_still_read() {
      threeCalendars()
      mailService.answers["exchange.calendarEvents|" + sharedRef] = { result: null,
        error: { code: -32000, message: "exchange_access_denied" } }
      controller.refresh(1790000000001, 1792592000000)
      verify(controller.lastError.indexOf("refused access") >= 0, controller.lastError)
      compare(controller.events.filter(function(e) { return e.sourceId === defaultId }).length, 1)
    }

    // ------------------------------------------------------------------ writing

    function form(title, extra) {
      var value = { title: title, startMs: 1790000000000, endMs: 1790001800000, allDay: false, recurrence: { enabled: false } }
      for (var key in extra) value[key] = extra[key]
      return value
    }

    function test_an_appointment_is_made_in_the_calendar_chosen_and_names_it() {
      threeCalendars()
      mailService.requests = []
      mailService.answers["exchange.calendarCreate"] = { error: null, result: { id: "n1", changeKey: "k" } }
      compare(controller.createEvent(teamId, form("Dentist")), true)
      compare([mailService.requests[0].method, mailService.requests[0].params.calendar], ["exchange.calendarCreate", teamRef])
      mailService.requests = []
      compare(controller.createEvent(defaultId, form("Dentist")), true)
      compare("calendar" in mailService.requests[0].params, false, "the default calendar names none")
    }

    function test_a_calendar_the_owner_may_only_read_is_nowhere_to_write_and_is_not_offered() {
      threeCalendars()
      mailService.requests = []
      compare(controller.createEvent(sharedId, form("No")), false)
      compare(createdSpy.signalArguments[0][1], "This calendar is read-only")
      compare(sent(), [])
      var writable = []
      controller.writableSourceGroups.forEach(function(g) { g.calendars.forEach(function(c) { writable.push(c.id) }) })
      compare(writable.sort(), [defaultId, teamId].sort())
      var offered = Calendar.calendarChoiceRows(controller.writableSourceGroups, "").map(function(row) { return row.source.id })
      compare(offered.indexOf(sharedId), -1, "the composer's picker leaves it out")
      verify(offered.indexOf(teamId) >= 0)
    }

    function test_an_event_the_backend_locked_in_another_calendar_is_not_written() {
      threeCalendars()
      mailService.requests = []
      var theirs = controller.events.filter(function(e) { return e.sourceId === sharedId })[0]
      compare(controller.updateEvent(sharedId, theirs, form("x", { location: "", startMs: theirs.start.ms, endMs: theirs.end.ms })), false)
      compare(sent(), [])
    }

    function test_guests_are_not_invited_from_a_calendar_that_takes_no_meetings() {
      threeCalendars()
      mailService.requests = []
      compare(controller.createEvent(teamId, form("Meeting", { guestEmails: "guest@example.org", confirmedSend: true })), false)
      compare(createdSpy.signalArguments[0][1], "Meetings are made on your own default calendar. Choose it, or leave the guests out")
      compare(sent(), [])
      // On the default calendar it goes as a meeting, naming no calendar.
      mailService.answers["exchange.meetingCreate"] = { error: null, result: { id: "m", changeKey: "k", invited: 1 } }
      compare(controller.createEvent(defaultId, form("Meeting", { guestEmails: "guest@example.org", confirmedSend: true })), true)
      compare(mailService.requests[0].method, "exchange.meetingCreate")
      compare("calendar" in mailService.requests[0].params, false)
    }

    function test_the_detail_of_an_event_is_read_from_its_own_calendar() {
      threeCalendars()
      mailService.requests = []
      var theirs = controller.events.filter(function(e) { return e.sourceId === sharedId })[0]
      mailService.answers["exchange.calendarEvent"] = { error: null, result: { id: "s1", changeKey: "k-s1",
        title: "In the colleague's", location: "", allDay: false, startMs: theirs.start.ms, endMs: theirs.end.ms,
        notes: "", attendees: [], editable: false, lock: "calendar", canRespond: false, kind: "single" } }
      var merged = null
      controller.exchangeDetail(controller.findSource(sharedId), theirs, function(event) { merged = event })
      compare(JSON.stringify(mailService.requests[0].params), JSON.stringify({ accountId: account, id: "s1", calendar: sharedRef }))
      compare([merged.exchangeCalendar, merged.canRespond], [sharedRef, false])
    }

    // In another person's calendar an event the server lets the owner change is changed and never deleted from
    // here, and the panel says why there is no delete; in the owner's own other calendar it is deleted as anywhere.
    function test_the_detail_panel_offers_no_delete_in_another_persons_calendar_and_says_why() {
      controller.sourceList = ({ version: 1, sources: [
        { id: teamId, kind: "exchange", name: "Team", accountId: account, calendarId: teamRef, discovered: true },
        { id: sharedId, kind: "exchange", name: "Calendar · colleague@example.org", accountId: account,
          calendarId: sharedRef, discovered: false }] })
      var event = { sourceId: sharedId, exchangeId: "s1", exchangeKey: "k1", exchangeCalendar: sharedRef, lockReason: "",
        summary: "Editable", start: { ms: 1000, allDay: false }, end: { ms: 2000, allDay: false } }
      // Made in a visible parent, so what the panel draws can be asked whether it is drawn (a TestCase is not).
      var detail = createTemporaryObject(detailComponent, composer.parent, { controller: controller, event: event })
      compare([detail.canWrite, detail.canDelete], [true, false])
      compare(findChild(detail, "event-delete").visible, false)
      compare(findChild(detail, "event-delete-reason").visible, true)
      compare(findChild(detail, "event-delete-reason").text, "Events in another person's calendar are not deleted from here")
      // The controller refuses it too, before anything is asked.
      mailService.requests = []
      compare(controller.deleteEvent(sharedId, event), false)
      compare(sent(), [])
      var own = JSON.parse(JSON.stringify(event))
      own.sourceId = teamId
      own.exchangeCalendar = teamRef
      detail = createTemporaryObject(detailComponent, composer.parent, { controller: controller, event: own })
      compare([detail.canWrite, detail.canDelete, findChild(detail, "event-delete-reason").visible], [true, true, false])
    }

    function field(name) { return findChild(composer, name) }

    function test_the_form_for_a_calendar_that_takes_no_meetings_has_no_guest_field_and_names_no_guests() {
      threeCalendars()
      mailService.requests = []
      composer.beginAt(1790000000000)
      composer.selectedSourceId = defaultId
      compare(field("event-guests-field").visible, true, "the default calendar takes meetings")
      field("event-guests-field").text = "ada@example.org"
      composer.selectedSourceId = teamId
      compare(field("event-guests-field").visible, false)
      compare(composer.reachesPeople, false, "nothing here reaches anybody")
      field("event-title-field").text = "Lunch"
      mailService.answers["exchange.calendarCreate"] = { error: null, result: { id: "n1", changeKey: "k" } }
      composer.submit("all")
      compare(mailService.requests[0].method, "exchange.calendarCreate", "an appointment, whatever was typed before")
      compare(mailService.requests[0].params.calendar, teamRef)
      compare(field("event-send-confirm").opened, false)
    }
  }
}
