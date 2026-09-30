import QtQuick 2.15
import QtTest 1.3
import "../../calendar" as Omamail

Item {
  width: 400
  height: 300

  QtObject {
    id: mailService

    property var requests: []
    property var nextResult: ({ body: "{}", status: 200 })
    property var nextError: null
    property bool backendCanDiscoverCalendars: true
    property bool backendCanGoogleCalendars: false
    property var discoveryCallback: null
    property var credentialWrites: []
    property var configWrites: []
    property var configCallback: null
    property var backend: ({ ready: false, call: function(method, params, callback) {
      mailService.requests.push({ method: method, params: params })
      if (method === "calendar.discover") {
        mailService.discoveryCallback = callback
        return
      }
      callback(mailService.nextResult, mailService.nextError)
    } })
    property bool unifiedCalendarView: false
    property var accountSummaries: [
      { id: "imap:work@example.com", email: "work@example.com",
        provider: "imap", signedIn: true },
      { id: "one@gmail.com", email: "one@gmail.com",
        provider: "gmail", signedIn: true },
      { id: "two@gmail.com", email: "two@gmail.com",
        provider: "gmail", signedIn: true }
    ]

    function withGoogleAccessToken(_accountId, callback) {
      callback("", "not used by this test")
    }
    function credentialPut(kind, accountId, clientId, secret, callback) {
      credentialWrites.push({kind:kind,accountId:accountId,clientId:clientId,secret:secret})
      callback(true, "")
      return true
    }
    function writeConfig(name, payload, callback) {
      configWrites.push({name:name, payload:payload})
      configCallback = callback
    }
  }

  Omamail.CalendarController {
    id: controller
    service: mailService
    pluginDir: "/tmp/omamail-test"
    accountId: "imap:work@example.com"
    sourceList: ({
      version: 1,
      sources: [{
        id: "caldav:team", kind: "caldav", name: "Team",
        url: "https://calendar.example/team/", username: "work@example.com",
        enabled: true, readOnly: false, colorKey: "accent"
      }]
    })
  }

  TestCase {
    name: "CalendarController"
    SignalSpy { id: discoverySpy; target: controller; signalName: "discoveryFinished" }

    property var originalSummaries: JSON.parse(JSON.stringify(mailService.accountSummaries))

    function test_settings_can_target_another_accounts_calendar() {
      controller.accountId = "one@gmail.com"
      verify(controller.findSource("google:two@gmail.com") === null,
        "event writes remain scoped to the current mailbox")
      controller.setReminderPolicy("google:two@gmail.com", false, -1)
      compare(mailService.configWrites.length, 1)
      var saved = JSON.parse(mailService.configWrites[0].payload).sources.filter(function(s) {
        return s.id === "google:two@gmail.com"
      })[0]
      compare(saved.remindersEnabled, false)
      mailService.configCallback(true, "")
      controller.setDefaultCalendar("google:two@gmail.com")
      compare(mailService.configWrites.length, 2)
      saved = JSON.parse(mailService.configWrites[1].payload).sources.filter(function(s) {
        return s.id === "google:two@gmail.com"
      })[0]
      compare(saved.preferred, true)
      mailService.configCallback(true, "")
    }

    function test_legacy_sources_cannot_enter_reminder_polling_or_settings() {
      var kinds = ["microsoft", "icloud", "caldav", "hey"]
      for (var i = 0; i < kinds.length; i++) {
        var source = {id:"legacy",kind:kinds[i],enabled:true,remindersEnabled:true,reminderMinutes:10}
        controller.reminderMode = false
        compare(controller.sourceIncluded(source), true)
        controller.reminderMode = true
        compare(controller.sourceIncluded(source), false)
        controller.sourceList = {version:1,sources:[source]}
        var writes = mailService.configWrites.length
        controller.setReminderPolicy("legacy", true, 5)
        compare(mailService.configWrites.length, writes)
      }
      compare(controller.sourceIncluded({kind:"google",enabled:false,remindersEnabled:true}), true)
      controller.reminderMode = false
    }

    function test_confirmed_delete_carries_the_chosen_consequence() {
      mailService.backendCanGoogleCalendars = true
      controller.accountId = "one@gmail.com"
      controller.sourceList = {version:1,sources:[
        {id:"google:one@gmail.com",kind:"google",accountId:"one@gmail.com",calendarId:"primary",enabled:true}]}
      var event = {sourceId:"google:one@gmail.com",googleId:"meeting",recurringEventId:"series",
        summary:"Review",eventType:"default",etag:"e1",organizer:{self:true},
        attendees:[{self:true},{email:"sam@example.test"}]}
      var request = controller.deleteRequest("google:one@gmail.com", event)
      compare(request.choices.length, 3)
      request.choice = "none"
      verify(controller.confirmDelete(request))
      compare(mailService.requests[mailService.requests.length - 1].params.operation, "delete")
      compare(mailService.requests[mailService.requests.length - 1].params.sendUpdates, "none")
      compare(event.deleteSendUpdates, undefined, "the event on screen is not changed")
      controller.eventWriting = false
      mailService.requests = []
      mailService.nextResult = {body:JSON.stringify({id:"series",etag:"s1",summary:"Review",
        recurrence:["RRULE:FREQ=WEEKLY"],start:{dateTime:"2026-10-01T10:00:00Z"},end:{dateTime:"2026-10-01T11:00:00Z"},
        organizer:{self:true}})}
      request.choice = "series"
      verify(controller.confirmDelete(request))
      compare(mailService.requests[0].params.operation, "get")
      compare(mailService.requests[0].params.eventId, "series")
      compare(mailService.requests[1].params.operation, "delete")
      compare(mailService.requests[1].params.eventId, "series")
      controller.eventWriting = false
    }

    function test_undo_does_not_follow_the_view_to_another_account() {
      mailService.backendCanGoogleCalendars = true
      controller.accountId = "one@gmail.com"
      var change = {source:{id:"google:one@gmail.com",kind:"google",accountId:"one@gmail.com",calendarId:"primary"},
        eventId:"meeting",ifMatch:"etag",body:"{}",sendUpdates:"none",scope:controller.calendarScope}
      controller.undoChange = change
      controller.accountId = "two@gmail.com"
      mailService.requests = []
      controller.undoLastChange()
      compare(mailService.requests.length, 0)
      compare(controller.undoChange, null)
    }

    function test_old_backend_refuses_google_options_instead_of_dropping_them() {
      controller.accountId = "one@gmail.com"
      controller.sourceList = {version:1,sources:[
        {id:"google:one@gmail.com",kind:"google",accountId:"one@gmail.com",calendarId:"primary",enabled:true,canCreateMeet:true}]}
      var start = new Date(2026, 9, 1, 10).getTime()
      var base = {title:"Planning",allDay:false,startMs:start,endMs:start + 3600000,location:"",description:"",
        recurrence:{enabled:false}}
      var asks = [{guestEmails:"guest@example.org"}, {createMeet:true}]
      for (var i = 0; i < asks.length; i++) {
        var fields = JSON.parse(JSON.stringify(base))
        for (var key in asks[i]) fields[key] = asks[i][key]
        compare(controller.createEvent("google:one@gmail.com", fields), false)
      }
      compare(mailService.requests.length, 0)
      var event = {sourceId:"google:one@gmail.com",googleId:"meeting",eventType:"default",organizer:{self:true},
        start:{ms:start},end:{ms:start + 3600000}}
      verify(controller.rescheduleRefusal(event) !== "")
      mailService.backendCanGoogleCalendars = true
      compare(controller.rescheduleRefusal(event), "")
    }

    function test_immediate_transfer_sends_only_move_and_uses_new_event_identity() {
      mailService.backendCanGoogleCalendars = true
      controller.accountId = "one@gmail.com"
      controller.sourceList = {version:1,sources:[
        {id:"google:one@gmail.com",kind:"google",accountId:"one@gmail.com",calendarId:"primary",enabled:true},
        {id:"google:family",kind:"google",accountId:"one@gmail.com",calendarId:"family",enabled:true}]}
      controller.rangeStart = 0
      controller.rangeEnd = 0
      var event = {googleId:"meeting",eventType:"default",etag:"before",organizer:{self:true}}
      mailService.nextResult = {body:JSON.stringify({id:"meeting",etag:"after",summary:"Saved title",
        start:{dateTime:"2026-10-01T10:00:00Z"},end:{dateTime:"2026-10-01T11:00:00Z"},organizer:{self:true}})}
      var moved = null
      verify(controller.transferEvent("google:one@gmail.com","google:family",event,function(value,error) {
        compare(error,""); moved=value
      }))
      compare(mailService.requests.length,1)
      compare(mailService.requests[0].params.operation,"move")
      compare(mailService.requests[0].params.destination,"family")
      compare(mailService.requests[0].params.ifMatch,"before")
      compare(mailService.requests[0].params.body,undefined)
      compare(moved.sourceId,"google:family")
      compare(moved.etag,"after")
      compare(controller.eventWriting,false)
    }

    function init() {
      // Reset here rather than at the end of each case: a failed compare aborts
      // the function, so a restore on its last line does not run and one real
      // failure becomes a cascade that hides it.
      mailService.accountSummaries = JSON.parse(JSON.stringify(originalSummaries))
      mailService.requests = []
      mailService.nextResult = ({ body: "{}", status: 200 })
      mailService.nextError = null
      mailService.backendCanDiscoverCalendars = true
      mailService.backendCanGoogleCalendars = false
      mailService.discoveryCallback = null
      mailService.backend.ready = false
      mailService.accountSummaries = [
        { id: "imap:work@example.com", email: "work@example.com",
          provider: "imap", signedIn: true },
        { id: "one@gmail.com", email: "one@gmail.com",
          provider: "gmail", signedIn: true },
        { id: "two@gmail.com", email: "two@gmail.com",
          provider: "gmail", signedIn: true }
      ]
      mailService.credentialWrites = []
      mailService.configWrites = []
      mailService.configCallback = null
      discoverySpy.clear()
      mailService.unifiedCalendarView = false
      controller.accountId = "imap:work@example.com"
      controller.refreshScope = ""
      controller.refreshAccountId = ""
      controller.loading = false
      controller.rangeStart = 0
      controller.rangeEnd = 0
      controller.pendingRangeStart = 0
      controller.pendingRangeEnd = 0
      controller.savingSource = false
      controller.sourceBeingSaved = null
      controller.sourceSecret = ""
      controller.discoveringCalendars = false
      controller.discoveringAccountId = ""
      controller.discoverySaving = false
      controller.discoveryPendingCount = 0
      controller.discoveryError = ""
      controller.refreshAfterSourceWrite = false
      controller.sourceList = ({version:1, sources:[{
        id:"caldav:team", kind:"caldav", name:"Team",
        url:"https://calendar.example/team/", username:"work@example.com",
        enabled:true, readOnly:false, colorKey:"accent"
      }]})
    }

    function test_discovery_persists_through_platform_settings_data() {
      return [{tag:"saved", ok:true}, {tag:"failed", ok:false}]
    }

    function test_discovery_persists_through_platform_settings(data) {
      var before = JSON.stringify(controller.sourceList)
      mailService.accountSummaries = [{id:"outlook:work@example.com",
        calendarProvider:"microsoft", signedIn:true}]
      mailService.backend.ready = true
      verify(controller.discoverAccountCalendars("outlook:work@example.com"))
      mailService.discoveryCallback({provider:"microsoft", accountId:"outlook:work@example.com",
        calendars:[{sourceId:"microsoft:work", calendarId:"work", name:"Work", readOnly:false}]}, null)
      compare(mailService.configWrites.length, 1)
      compare(mailService.configWrites[0].name, "calendars.json")
      compare(JSON.parse(mailService.configWrites[0].payload).sources.length, 2)
      compare(JSON.stringify(controller.sourceList), before, "no optimistic replacement before persistence")
      compare(controller.savingSource, true)
      compare(controller.discoverySaving, true)
      compare(discoverySpy.count, 0)
      controller.setSourceEnabled("caldav:team", false)
      compare(mailService.configWrites.length, 1, "no concurrent writer while saving discovery")
      mailService.configCallback(data.ok, data.ok ? "" : "synthetic write refusal")
      compare(controller.savingSource, false)
      compare(controller.discoverySaving, false)
      compare(controller.discoveryPendingCount, 0)
      compare(controller.refreshAfterSourceWrite, false)
      compare(discoverySpy.count, 1)
      compare(Array.prototype.slice.call(discoverySpy.signalArguments[0]), data.ok ? [true, "", 1]
        : [false, "The discovered calendars could not be saved", 0])
      compare(mailService.credentialWrites.length, 0, "discovery never writes a credential")
      if (data.ok) compare(controller.sourceList.sources.length, 2)
      else compare(JSON.stringify(controller.sourceList), before)
    }

    function test_network_requests_are_owned_by_backend() {
      var source = {kind: "google", accountId: "one@gmail.com", id: "google:one@gmail.com"}
      var called = false
      controller.nativeRequest(source, "list", {start: "a", end: "b"}, function(result, error) {
        compare(error, "")
        compare(result.body, "{}")
        called = true
      })
      verify(called)
      compare(mailService.requests.length, 1)
      compare(mailService.requests[0].method, "calendar.request")
      compare(mailService.requests[0].params.source.accountId, "one@gmail.com")
      verify(mailService.requests[0].params.token === undefined)
    }

    function test_z_icloud_requests_and_discovery_never_carry_credentials() {
      var source = {kind: "icloud", accountId: "imap:person@icloud.com",
        id: "icloud:one", url: "https://p37-caldav.icloud.com/123/calendars/one/"}
      controller.nativeRequest(source, "list", {start: "a", end: "b", body: "report"},
        function(_result, error) { compare(error, "") })
      compare(mailService.requests.length, 1)
      compare(mailService.requests[0].method, "calendar.request")
      compare(mailService.requests[0].params.source.accountId, "imap:person@icloud.com")
      verify(mailService.requests[0].params.password === undefined)
      verify(mailService.requests[0].params.credentials === undefined)

      mailService.accountSummaries = [{ id: "imap:person@icloud.com",
        email: "person@icloud.com", provider: "imap", calendarProvider: "icloud",
        signedIn: true }]
      mailService.backend.ready = true
      verify(controller.discoverAccountCalendars("imap:person@icloud.com"))
      compare(mailService.requests.length, 2)
      compare(mailService.requests[1].method, "calendar.discover")
      compare(JSON.stringify(mailService.requests[1].params),
        JSON.stringify({accountId: "imap:person@icloud.com"}))
      verify(mailService.discoveryCallback !== null)
      controller.setSourceEnabled("caldav:team", false)
      compare(controller.savingSource, false,
        "calendar settings cannot race the discovery result writer")
      mailService.discoveryCallback(null, {code: -32000, message: "calendar_auth_refused"})
      compare(controller.discoveringCalendars, false)
      compare(controller.discoveryError, "Sign in to this mailbox again")

      verify(controller.discoverAccountCalendars("imap:person@icloud.com"))
      mailService.accountSummaries = []
      mailService.discoveryCallback({ provider: "icloud",
        accountId: "imap:person@icloud.com", calendars: [] }, null)
      compare(controller.savingSource, false)
      compare(controller.discoveryError, "Calendars could not be discovered")
    }

    function test_discovery_failure_uses_only_known_rpc_messages() {
      var cases = [
        {message: "auth_signed_out", expected: "Sign in to this mailbox again"},
        {message: "calendar_auth_refused", expected: "Sign in to this mailbox again"},
        {message: "calendar_provider_unsupported", expected: "This mailbox does not support calendar discovery"},
        {message: "calendar_timeout", expected: "Calendar discovery timed out"},
        {message: "private diagnostic <img src='https://example.org/tracker'>", expected: "Calendars could not be discovered"}
      ]
      for (var i = 0; i < cases.length; i++) {
        compare(controller.discoveryFailure({code: -32000, message: cases[i].message}), cases[i].expected)
      }
      compare(controller.discoveryFailure(null), "Calendars could not be discovered")
    }

    function test_discovery_on_an_old_backend_makes_no_request_or_settings_write() {
      mailService.accountSummaries = [{ id: "imap:person@icloud.com",
        calendarProvider: "icloud", signedIn: true }]
      mailService.backend.ready = true
      mailService.backendCanDiscoverCalendars = false
      compare(controller.discoverAccountCalendars("imap:person@icloud.com"), false)
      compare(mailService.requests.length, 0)
      compare(mailService.configWrites.length, 0)
      compare(mailService.credentialWrites.length, 0)
      compare(controller.savingSource, false)
      compare(controller.discoveringCalendars, false)
    }
    function test_old_backend_never_reads_or_writes_a_discovered_calendar_as_default() {
      mailService.backendCanDiscoverCalendars = false
      var sources = [{kind: "microsoft", calendarId: "other-calendar"}, {kind: "icloud"}]
      var operations = ["list", "create", "update", "delete"]
      var replies = 0
      for (var s = 0; s < sources.length; s++) {
        for (var op = 0; op < operations.length; op++) {
          controller.nativeRequest(sources[s], operations[op], {}, function(result, error) {
            compare(result, null)
            compare(error, "Update the backend to access this calendar")
            replies++
          })
        }
      }
      compare(replies, 8)
      compare(mailService.requests.length, 0)
      controller.nativeRequest({kind: "microsoft", calendarId: ""}, "list", {}, function() {})
      compare(mailService.requests.length, 1, "the established default calendar still works")
    }

    // Discovery stores the default calendar's real Graph id. A backend one
    // API step behind cannot address a calendar by id, but the default is
    // the one calendar it reaches without one, so the source degrades to the
    // pre-discovery request instead of being refused.
    function test_old_backend_reaches_the_discovered_default_calendar_without_its_identity() {
      mailService.backendCanDiscoverCalendars = false
      var defaultCalendar = {id: "microsoft:outlook:me@contoso.com", kind: "microsoft",
        accountId: "outlook:me@contoso.com", calendarId: "default-id", discovered: true}
      var replies = 0
      controller.nativeRequest(defaultCalendar, "list", {}, function(result, error) {
        compare(error, "")
        replies++
      })
      compare(replies, 1)
      compare(mailService.requests.length, 1)
      compare(mailService.requests[0].params.source.calendarId, "")
      compare(mailService.requests[0].params.source.id, "microsoft:outlook:me@contoso.com")
      compare(defaultCalendar.calendarId, "default-id", "the saved source keeps its identity")
      var secondary = {id: "microsoft:outlook:me@contoso.com:hash", kind: "microsoft",
        accountId: "outlook:me@contoso.com", calendarId: "holiday-id", discovered: true}
      controller.nativeRequest(secondary, "list", {}, function(result, error) {
        compare(error, "Update the backend to access this calendar")
        replies++
      })
      compare(replies, 2)
      compare(mailService.requests.length, 1, "a secondary calendar has no request an old backend can make")
    }

    function test_native_request_explains_icloud_recovery() {
      mailService.nextResult = null
      mailService.nextError = ({ code: -32000, message: "calendar_auth_refused" })
      var called = false
      controller.nativeRequest({ kind: "icloud" }, "list", {}, function(result, error) {
        compare(result, null)
        compare(error, "iCloud calendar request failed. Check the mailbox's app-specific password in Settings")
        called = true
      })
      verify(called)
    }

    function test_a_calendar_error_names_a_discovered_calendar_with_its_mailbox() {
      mailService.accountSummaries = [
        { id: "outlook:me@contoso.com", email: "me@contoso.com", provider: "outlook", signedIn: true },
        { id: "outlook:other@contoso.com", email: "other@contoso.com", provider: "outlook", signedIn: true }
      ]
      controller.refreshScope = controller.calendarScope
      controller.activeSource = { id: "microsoft:outlook:other@contoso.com", kind: "microsoft",
        name: "Calendar", accountId: "outlook:other@contoso.com", calendarId: "default-id",
        discovered: true }
      controller.failSource("Something refused", "microsoft")
      compare(controller.lastError, "Calendar · other@contoso.com: Something refused")
      controller.refreshScope = controller.calendarScope
      controller.activeSource = { id: "caldav:team", kind: "caldav", name: "Team" }
      controller.failSource("Something refused", "caldav")
      compare(controller.lastError, "Team: Something refused")
    }

    function test_native_request_explains_microsoft_recovery() {
      mailService.nextResult = null
      mailService.nextError = ({ code: -32000, message: "calendar_auth_refused" })
      var called = false
      controller.nativeRequest({ kind: "microsoft" }, "list", {}, function(result, error) {
        compare(result, null)
        compare(error, "Microsoft calendar request failed. Check Graph permissions in Settings, then sign in again")
        called = true
      })
      verify(called)
    }

    function test_native_request_does_not_display_backend_diagnostics() {
      mailService.nextResult = null
      mailService.nextError = ({ code: -32000, message: "private backend diagnostic" })
      var called = false
      controller.nativeRequest({ kind: "microsoft" }, "list", {}, function(_result, error) {
        compare(error, "Microsoft calendar request failed. Check Graph permissions in Settings, then sign in again")
        called = true
      })
      verify(called)
    }

    function sourceIds(list) {
      return list.sources.map(function(source) { return source.id })
    }

    function test_calendar_follows_the_active_mailbox_by_default() {
      var expected = ["caldav:team"]
      compare(JSON.stringify(sourceIds(controller.contextSources)),
        JSON.stringify(expected))
      compare(JSON.stringify(sourceIds(controller.sourcesForAccount(controller.accountId))),
        JSON.stringify(expected))
    }

    function test_unified_calendar_combines_every_signed_in_account() {
      mailService.unifiedCalendarView = true
      var expected = ["caldav:team", "google:one@gmail.com", "google:two@gmail.com"]
      compare(JSON.stringify(sourceIds(controller.contextSources)),
        JSON.stringify(expected))
      compare(JSON.stringify(sourceIds(controller.sourcesForAccount(controller.accountId))),
        JSON.stringify(expected))
    }

    // The cache is keyed by what the visible calendar depends on. Under the
    // unified view that is not the mailbox — the same calendars are shown
    // whichever one is open — so keying by the account stored a copy of the
    // same events per account and made every mailbox switch a cache miss.
    function test_the_scope_is_the_mailbox_only_when_the_view_follows_it() {
      compare(controller.calendarScope, "imap:work@example.com")
      mailService.unifiedCalendarView = true
      compare(controller.calendarScope, "__unified__")
      controller.accountId = "one@gmail.com"
      compare(controller.calendarScope, "__unified__",
        "and it does not move when the mailbox does")
    }

    // An answer that is still correct is not thrown away. Under the unified
    // view a refresh started while one mailbox was open is still an answer
    // about the same calendars after switching to another.
    function test_a_mailbox_switch_does_not_discard_a_unified_refresh() {
      mailService.unifiedCalendarView = true
      controller.rangeStart = 1000
      controller.rangeEnd = 2000
      controller.refreshScope = controller.calendarScope
      controller.accountId = "two@gmail.com"
      compare(controller.refreshScope, controller.calendarScope,
        "the fetch in flight still belongs to the view on screen")
    }

    // And the default mode is unchanged: there the scope is the account, so a
    // switch does invalidate what was in flight.
    function test_the_default_mode_still_follows_the_mailbox() {
      controller.rangeStart = 1000
      controller.rangeEnd = 2000
      controller.refreshScope = controller.calendarScope
      controller.accountId = "one@gmail.com"
      verify(controller.refreshScope !== controller.calendarScope)
    }

    // A controller with no mailbox is already showing every source, so the
    // setting cannot change what it shows — and renaming its scope would
    // orphan the bar preview's cache entry and refetch every calendar.
    function test_a_controller_with_no_mailbox_keeps_its_scope() {
      controller.accountId = ""
      compare(controller.calendarScope, "")
      mailService.unifiedCalendarView = true
      compare(controller.calendarScope, "", "the bar preview was always unified")
    }

    function test_changing_calendar_scope_reloads_the_visible_range() {
      controller.rangeStart = 1000
      controller.rangeEnd = 2000
      controller.loading = true

      mailService.unifiedCalendarView = true

      compare(controller.pendingRangeStart, 1000)
      compare(controller.pendingRangeEnd, 2000)
    }

    function test_updating_a_caldav_password_refreshes_the_visible_range() {
      controller.rangeStart = 1000
      controller.rangeEnd = 2000
      controller.loading = true
      controller.updateCalendarPassword(controller.sourceList.sources[0], "new-secret")
      compare(mailService.credentialWrites, [{kind:"calendar-password",
        accountId:"caldav:team",clientId:"",secret:"new-secret"}])
      compare(controller.pendingRangeStart, 1000)
      compare(controller.pendingRangeEnd, 2000)
    }

    // Google and Microsoft calendars arrive with their account's sign-in,
    // after a view that was already open asked for its range.
    function test_a_calendar_arriving_with_a_sign_in_reloads_the_range() {
      var summaries = JSON.parse(JSON.stringify(mailService.accountSummaries))
      summaries[1].signedIn = false
      mailService.accountSummaries = summaries
      controller.accountId = "one@gmail.com"
      var cache = null
      for (var i = 0; i < controller.children.length; i++) {
        if (controller.children[i].cacheName !== undefined) cache = controller.children[i]
      }
      verify(cache !== null, "the controller owns an event cache")
      cache.loaded = true
      controller.refresh(1000, 2000)
      mailService.requests = []
      mailService.accountSummaries = JSON.parse(JSON.stringify(summaries))
      compare(mailService.requests.length, 0, "a poll that changes nothing asks nothing")
      summaries = JSON.parse(JSON.stringify(summaries))
      summaries[1].signedIn = true
      mailService.accountSummaries = summaries
      var asked = mailService.requests.map(function(r) { return r.params.source.id })
      verify(asked.indexOf("google:one@gmail.com") >= 0, "asked " + JSON.stringify(asked))
      compare(mailService.requests[0].params.start, new Date(1000).toISOString())
      cache.loaded = false
    }

    // The sources file is watched, and its directory is touched by the
    // backend on every registry read. Learning again that the file is still
    // absent is not a change of sources: announcing one refreshed every
    // calendar, which read the registry, which touched the directory.
    function test_a_still_missing_sources_file_is_not_a_change() {
      var sourcesFile = null
      for (var i = 0; i < controller.data.length; i++) {
        if (controller.data[i] && typeof controller.data[i].loadFailed === "function")
          sourcesFile = controller.data[i]
      }
      verify(sourcesFile !== null, "the controller watches its sources file")
      var originalList = controller.sourceList
      var announced = 0
      var count = function() { announced++ }
      controller.sourceListChanged.connect(count)
      sourcesFile.loadFailed()
      compare(announced, 1, "an absent file empties a loaded list once")
      sourcesFile.loadFailed()
      sourcesFile.loadFailed()
      controller.sourceListChanged.disconnect(count)
      controller.sourceList = originalList
      compare(announced, 1)
      compare(controller.sourcesLoaded, true)
    }
  }
}
