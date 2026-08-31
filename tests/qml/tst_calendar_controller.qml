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
      mailService.unifiedCalendarView = false
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
