import QtQuick 2.15
import QtTest 1.3
import "../../calendar" as Omamail

Item {
  width: 400
  height: 300

  QtObject {
    id: mailService

    property var requests: []
    property var credentialWrites: []
    property var backend: ({ call: function(method, params, callback) {
      mailService.requests.push({ method: method, params: params })
      callback({ body: "{}", status: 200 }, null)
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

    property var originalSummaries: JSON.parse(JSON.stringify(mailService.accountSummaries))

    function init() {
      // Reset here rather than at the end of each case: a failed compare aborts
      // the function, so a restore on its last line does not run and one real
      // failure becomes a cascade that hides it.
      mailService.accountSummaries = JSON.parse(JSON.stringify(originalSummaries))
      mailService.requests = []
      mailService.credentialWrites = []
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
