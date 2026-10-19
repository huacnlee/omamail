import QtQuick 2.15
import QtTest 1.3
import "../../calendar" as Omamail

// A Microsoft 365 mailbox's calendar comes with its one sign-in: the Graph source
// appears for a signed-in `m365:` account the way it does for an Outlook one, is
// asked for through the same native requests, and its failures are told without
// a second permission to look for.
Item {
  width: 400
  height: 300

  QtObject {
    id: mailService

    property var requests: []
    property var answers: ({})
    property bool backendCanDiscoverCalendars: true
    property bool backendCanGoogleCalendars: false
    property var backend: ({ ready: true, call: function(method, params, callback) {
      mailService.requests.push({ method: method, params: JSON.parse(JSON.stringify(params)) })
      var answer = mailService.answers[method] || { result: { body: "{\"value\":[]}", status: 200 }, error: null }
      callback(answer.result, answer.error)
    } })
    property bool unifiedCalendarView: false
    property var accountSummaries: []
  }

  Omamail.CalendarController {
    id: controller
    service: mailService
    pluginDir: "/tmp/omamail-test"
    accountId: "m365:jane@corp.example.test"
    sourceList: ({ version: 1, sources: [] })
  }

  TestCase {
    name: "CalendarM365"
    when: windowShown

    readonly property string accountId: "m365:jane@corp.example.test"
    readonly property string sourceId: "microsoft:m365:jane@corp.example.test"

    function cache() {
      for (var i = 0; i < controller.children.length; i++) {
        if (controller.children[i].cacheName !== undefined) return controller.children[i]
      }
      return null
    }

    function init() {
      mailService.requests = []
      mailService.answers = ({})
      mailService.accountSummaries = [
        { id: accountId, email: "jane@corp.example.test", provider: "m365", calendarProvider: "microsoft", signedIn: true },
        { id: "outlook:me@example.org", email: "me@example.org", provider: "outlook", calendarProvider: "microsoft",
          signedIn: true }]
      controller.accountId = accountId
      controller.sourceList = ({ version: 1, sources: [] })
      controller.lastError = ""
      controller.loading = false
      controller.queue = []
      controller.events = []
      cache().loaded = true
    }

    function cleanup() { cache().loaded = false }

    function mine() {
      return controller.availableSources.sources.filter(function(source) {
        return source.kind === "microsoft" && source.accountId === accountId })
    }

    function test_a_signed_in_mailbox_brings_its_graph_calendar_and_a_signed_out_one_none() {
      compare(mine().length, 1, "one calendar for the mailbox")
      compare(mine()[0].id, sourceId)
      compare(mine()[0].readOnly, false)
      compare(mine()[0].enabled, true)
      compare(controller.discoverableAccount(accountId), true, "its other calendars can be found")
      var summaries = JSON.parse(JSON.stringify(mailService.accountSummaries))
      summaries[0].signedIn = false
      mailService.accountSummaries = summaries
      compare(mine().length, 0)
      compare(controller.discoverableAccount(accountId), false)
    }

    function test_the_range_is_asked_of_the_shared_native_request_for_this_account_and_nothing_else() {
      controller.refresh(1790000000000, 1792592000000)
      var asked = mailService.requests.filter(function(request) { return request.params.source
        && request.params.source.accountId === accountId })
      compare(asked.length, 1)
      compare(asked[0].method, "calendar.request", "no method of its own: the Graph calendar code is shared")
      compare(asked[0].params.operation, "list")
      compare(asked[0].params.source.id, sourceId)
      verify(!/token|secret|password|bearer|authorization|clientId/i.test(JSON.stringify(asked[0].params)),
        "nothing that could authenticate")
      compare(controller.lastError, "")
    }

    function test_a_refused_calendar_says_to_sign_in_again_and_names_no_second_permission() {
      var told = null
      // Refused, signed out, an app ID gone, a refresh refused or a saved sign-in that cannot be
      // read: the mail side asks for the sign-in again for each, and so does the calendar.
      for (var refused of ["calendar_auth_refused", "auth_signed_out", "auth_client_missing",
          "auth_client_invalid", "auth_refresh_failed", "auth_secret_invalid"]) {
        told = null
        mailService.answers["calendar.request"] = { result: null, error: { code: -32000, message: refused } }
        controller.nativeRequest({ id: sourceId, kind: "microsoft", accountId: accountId }, "list", {},
          function(result, error) { told = error })
        compare(told, "Microsoft calendar request failed. Sign in to this mailbox again", refused)
      }
      // Consent is an administrator's to give for the app, and the one sign-in follows it: there is
      // still no second permission to grant, and no page with a code that a private window would help.
      mailService.answers["calendar.request"] = { result: null,
        error: { code: -32000, message: "auth_consent_required" } }
      controller.nativeRequest({ id: sourceId, kind: "microsoft", accountId: accountId }, "list", {},
        function(result, error) { told = error })
      compare(told, "Microsoft calendar request failed. An administrator has to approve this app for your "
        + "organization. Then sign in to this mailbox again")
      // A network or a throttle that fails is not a sign-in to redo.
      for (var code of ["calendar_network_failed", "calendar_timeout", "calendar_request_failed", "auth_transport_failed"]) {
        mailService.answers["calendar.request"] = { result: null, error: { code: -32000, message: code } }
        controller.nativeRequest({ id: sourceId, kind: "microsoft", accountId: accountId }, "list", {},
          function(result, error) { told = error })
        compare(told, "Microsoft calendar request failed. Try again in a moment", code)
      }
      // Outlook's own words are as they were: its settings have a Graph step to look at.
      var other = null
      controller.nativeRequest({ id: "microsoft:outlook:me@example.org", kind: "microsoft",
        accountId: "outlook:me@example.org" }, "list", {}, function(result, error) { other = error })
      compare(other, "Microsoft calendar request failed. Check Graph permissions in Settings, then sign in again")
    }
  }
}
