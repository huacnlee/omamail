import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture
import "../../account/Accounts.js" as Accounts
import "../../account/Unified.js" as Unified

// The export dispatch boundary, against a real `Service` with real account
// hosts. Two properties matter here that a mocked menu callback cannot show:
// the advertised backend method is asked before anything is dispatched, and a
// menu captured on account A cannot reach account B's mailbox after a switch.
// The accounts are real but credentialless, so the synthetic backend answers
// the export and nothing touches a server.
Item {
  id: fixtureRoot
  width: 900
  height: 600

  QtObject {
    id: shellStore
    function updateEntryInline(_id, _entry) {}
    function hide(_id) {}
  }

  Component {
    id: controlledClient
    QtObject {
      property var refusals: null
      property var absentMailboxes: null
      property string email: ""
      function handle() { return { aborted: false } }
      function later(fn) { Qt.callLater(fn); return handle() }
      function listMessages() { return handle() }
      function getMessages() { return handle() }
      function getMessage() { return handle() }
      function getLabels() { return handle() }
      function getLabelCounts() { return handle() }
      function getProfile(callback) {
        return later(function() { callback({ email: email }, "") })
      }
      function getSendAs(callback) {
        return later(function() { callback([], "") })
      }
      function abortRequest(handle) { if (handle) handle.aborted = true }
    }
  }

  Omamail.Service {
    id: service
    shell: shellStore
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-export-test" })
  }

  TestCase {
    name: "ExportRouting"
    when: windowShown

    readonly property string ada: "imap:ada@example.org"
    readonly property string bob: "imap:bob@example.org"
    property var fixture: null
    property int exportBaseline: 0

    function entry(email) {
      return { email: email, provider: "imap", clientId: "", clientSecret: "",
        imap: { imapHost: "imap.example.org", imapPort: 993,
          smtpHost: "smtp.example.org", smtpPort: 465,
          username: email, aliases: [], insecure: false },
        label: "", signature: "", monitored: [] }
    }

    function seed() {
      var list = Accounts.emptyList()
      list = Accounts.add(list, entry("ada@example.org"))
      list = Accounts.add(list, entry("bob@example.org"))
      list = Accounts.setActive(list, ada)
      service.activeIndex = -1
      service.accountList = list
      service.accountsLoaded = true
      wait(0)
      service.refreshCurrent()
      for (var i = 0; i < 2; i++) {
        var account = service.accountAt(i)
        verify(account !== null)
        account.clientOverride = controlledClient
        account.auth.toolsChecked = true
        account.auth.missingTools = []
        account.auth.passwordChecked = true
        account.auth.password = "synthetic-password"
        account.exportingEml = false
        account.exportingEmlId = ""
        tryCompare(account, "ready", true)
      }
    }

    function init() {
      service.applySettings({ unifiedMailboxes: false })
      fixture = BackendFixture.markReady(service, 7)
      service.backendRuntime.requiredApiVersion = 6
      service.backendRuntime.latestApiVersion = 7
      service.backendRuntime.unreleasedMethods = ["mail.exportEml"]
      // Every dispatch completes, so no test inherits an in-flight flag from
      // another. A test that wants a specific filename or an error overrides
      // this answer or adds an error for the method.
      fixture.answers = { "mail.exportEml": function(params) {
        return { accountId: params.account, messageId: params.id,
          path: "/tmp/Downloads/message.eml", filename: "message.eml", bytes: 1 }
      } }
      fixture.errors = ({})
      seed()
      service.backend.protocolInfo = { apiVersion: 7, protocol: 1, version: "0.0.0",
        methods: ["mail.exportEml"] }
      wait(0)
      exportBaseline = exportRequests().length
    }

    function exportRequests() {
      var requests = []
      for (var i = 0; i < service.backend.children.length; i++) {
        var child = service.backend.children[i]
        if (!child.written) continue
        var lines = child.written.split("\n")
        for (var j = 0; j < lines.length; j++) {
          if (!lines[j]) continue
          var request = JSON.parse(lines[j])
          if (request.method === "mail.exportEml") requests.push(request.params)
        }
      }
      return requests
    }

    // With the method absent, both entry points are refused before anything is
    // sent — the keyboard path used to dispatch because it asked the provider
    // rather than the advertised method list.
    function test_the_export_requires_the_advertised_method() {
      service.backend.protocolInfo = { apiVersion: 6, protocol: 1, version: "0.0.0",
        methods: ["mail.read"] }
      wait(0)
      compare(service.backend.ready, true, "the released API 6 handshake remains ready")
      compare(service.canExportEmlFor("42:INBOX"), false,
        "the menu row is unavailable")
      compare(service.exportEml("42:INBOX"), false,
        "and the keyboard entry point is refused")
      compare(service.exportFromView("list", "42:INBOX"), false)
      compare(exportRequests().length - exportBaseline, 0, "nothing was dispatched")
    }

    function test_the_keyboard_export_reaches_the_owning_mailbox() {
      compare(service.activeAccountId, ada)
      compare(service.canExportEmlFor("42:INBOX"), true)
      compare(service.exportEml("42:INBOX"), true)
      var requests = exportRequests().slice(exportBaseline)
      compare(requests.length, 1)
      compare(requests[0].account, ada)
      compare(requests[0].id, "42:INBOX")
    }

    // A menu opened on A keeps A's id and account. Switching to B, where
    // 42:INBOX is a different message, must not re-route the saved file.
    function test_a_menu_stale_after_an_account_switch_is_refused() {
      var captured = service.accountForMessage("42:INBOX")
      var native = service.sourceIdFor("42:INBOX")
      compare(captured, ada)
      service.switchTo(bob)
      wait(0)
      compare(service.activeAccountId, bob, "B is on screen now")
      var before = exportRequests().length
      compare(service.exportEmlFor(captured, native), false,
        "the captured owner is no longer the mailbox on screen")
      compare(exportRequests().length, before, "and nothing was dispatched")
    }

    // A conversation-rail member is one message with a composed id. The
    // service keeps its account and hands the provider the member's native id.
    function test_a_unified_member_reaches_its_owning_mailbox() {
      service.applySettings({ unifiedMailboxes: true })
      wait(0)
      compare(service.unified, true)
      var memberId = Unified.unifiedId(ada, "17:INBOX")
      compare(service.accountForMessage(memberId), ada)
      compare(service.sourceIdFor(memberId), "17:INBOX")
      compare(service.exportEmlFor(service.accountForMessage(memberId),
        service.sourceIdFor(memberId)), true)
      var requests = exportRequests().slice(exportBaseline)
      compare(requests[requests.length - 1].account, ada)
      compare(requests[requests.length - 1].id, "17:INBOX")
    }

    function test_a_busy_notice_then_the_saved_file() {
      fixture.answers["mail.exportEml"] = function(params) {
        return { accountId: params.account, messageId: params.id,
          path: "/tmp/Downloads/Project update.eml",
          filename: "Project update.eml", bytes: 12 }
      }
      var account = service.findAccount(ada)
      account.clearNotice()
      account.messages = [{ id: "42:INBOX", subject: "Project update" }]
      compare(account.exportingEml, false)
      compare(account.exportEml("42:INBOX"), true)
      compare(account.exportingEml, true, "the write is in flight")
      verify(account.actionStatus.indexOf("Saving") === 0,
        "the busy state is visible at once")
      wait(0)
      compare(account.exportingEml, false)
      compare(account.actionStatus, "Saved Project update.eml to /tmp/Downloads",
        "the completion names the file, then its folder, each once")
      verify(account.lastError === "", "and it is not reported as a failure")
    }

    function test_a_successful_retry_clears_the_previous_failure() {
      fixture.errors["mail.exportEml"] = { code: -32000, message: "mail_export_write_failed" }
      var account = service.findAccount(ada)
      compare(account.exportEml("42:INBOX"), true)
      wait(0)
      compare(account.lastError, "Could not write the .eml file to Downloads",
        "a backend code is said in words")
      fixture.errors = ({})
      compare(account.exportEml("42:INBOX"), true)
      compare(account.lastError, "", "the retry clears the prior failure")
      wait(0)
      compare(account.exportingEml, false)
      verify(account.actionStatus.indexOf("Saved") === 0)
      compare(account.lastError, "", "the old error must not return after success")
    }

    function test_a_failed_export_is_reported_safely() {
      fixture.errors["mail.exportEml"] = { code: -32000, message: "mail_export_write_failed" }
      var account = service.findAccount(ada)
      account.clearNotice()
      compare(account.exportEml("42:INBOX"), true)
      compare(account.exportingEml, true)
      wait(0)
      compare(account.exportingEml, false)
      verify(account.lastError !== "", "the backend error reaches the status line")
    }
  }
}
