import QtQuick 2.15
import QtTest 1.3
import "../../calendar" as Omamail

Item {
  width: 400
  height: 300

  QtObject {
    id: mailService

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

    function init() {
      // Reset here rather than at the end of each case: a failed compare aborts
      // the function, so a restore on its last line does not run and one real
      // failure becomes a cascade that hides it.
      mailService.unifiedCalendarView = false
      controller.accountId = "imap:work@example.com"
      controller.refreshScope = ""
      controller.refreshAccountId = ""
      controller.loading = false
      controller.rangeStart = 0
      controller.rangeEnd = 0
      controller.pendingRangeStart = 0
      controller.pendingRangeEnd = 0
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
  }
}
