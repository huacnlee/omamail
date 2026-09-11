import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture
import "../../account/Accounts.js" as Accounts

// Delivery failures cross two ownership boundaries: a MailAccount reports the
// result to Service, and Service tells the one composer shared by every
// account. These tests keep those real boundaries in place. A mock handed
// straight to App would miss both the relay and the global send guard.
Item {
  width: 900
  height: 600

  QtObject {
    id: shellStore
    function updateEntryInline(_id, _entry) {}
    function hide(_id) {}
  }

  Omamail.Service {
    id: mailService
    shell: shellStore
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  Omamail.App { id: app; service: mailService }

  SignalSpy {
    id: failureSpy
    target: mailService
    signalName: "replyFailed"
  }

  TestCase {
    name: "SendFailures"
    when: windowShown

    function initTestCase() { BackendFixture.markReady(mailService) }

    readonly property string ada: "ada@example.com"
    readonly property string bob: "bob@example.com"
    readonly property string adaId: "imap:ada@example.com"
    readonly property string bobId: "imap:bob@example.com"

    function entry(email, smtp) {
      return {
        email: email, provider: "imap", clientId: "", clientSecret: "",
        imap: {
          imapHost: "imap.example.com", imapPort: 993,
          smtpHost: smtp === false ? "" : "smtp.example.com", smtpPort: 465,
          username: email, aliases: [], insecure: false
        },
        label: "", signature: ""
      }
    }

    function seed(entries, activeId) {
      var list = Accounts.emptyList()
      for (var i = 0; i < entries.length; i++) list = Accounts.add(list, entries[i])
      list = Accounts.setActive(list, activeId)
      mailService.activeIndex = -1
      mailService.accountList = list
      mailService.accountsLoaded = true
      wait(0)
      mailService.refreshCurrent()
      for (var h = 0; h < entries.length; h++) readyAccount(mailService.accountAt(h))
    }

    function readyAccount(account) {
      verify(account !== null)
      verify(account.auth !== null)
      account.auth.toolsChecked = true
      account.auth.missingTools = []
      account.auth.passwordChecked = true
      account.auth.password = "test-password"
      tryCompare(account, "ready", true)
    }

    function named(item, objectName) {
      if (!item) return null
      if (item.objectName === objectName) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = named(values[i], objectName)
        if (found) return found
      }
      return null
    }

    function composeView() {
      var item = named(app, "compose-to-field")
      while (item && typeof item.resumePendingSend !== "function") item = item.parent
      return item
    }

    function resetApp() {
      app.opened = false
      app.loadComposeRecovery("")
      app.clearComposeRecovery()
      app.resetNavigation()
      var compose = composeView()
      verify(compose !== null)
      compose.reset()
      compose.opened = false
    }

    property int outboxRevision: 1
    function pending(method, accountId) {
      var fixture = BackendFixture.install(mailService)
      for (var i = fixture.requests.length - 1; i >= 0; i--) {
        var request = fixture.requests[i]
        if (request.method === method && (!accountId || request.params.accountId === accountId) && !request.answered) return request
      }
      return null
    }
    function answerQueued(accountId) {
      tryVerify(function() { return pending("outbox.enqueue", accountId) !== null })
      var request = pending("outbox.enqueue", accountId)
      request.answered = true
      var entry = { id:request.params.sendId, state:"queued", order:request.params.order,
        queuedAt:Date.now(),dueAt:Date.now()+10000 }
      BackendFixture.respond(mailService,request,{snapshot:{accountId:accountId,revision:++outboxRevision,entries:[entry]}})
      wait(0)
      return entry
    }
    function stopSends() {
      for (var i = 0; i < mailService.accountCount; i++) {
        var account = mailService.accountAt(i)
        if (account) {
          account.sendQueue.parked = []
          account.sendQueue.submitted = ({})
          account.sendQueue.arm()
        }
      }
    }

    function init() {
      failureSpy.clear()
      stopSends()
      mailService.applySettings({ undoSendSeconds: 10 })
      resetApp()
    }

    function cleanup() {
      stopSends()
      var compose = composeView()
      if (compose) compose.reset()
      app.clearComposeRecovery()
    }

    function test_failure_returns_to_the_account_that_owns_the_parked_draft() {
      seed([entry(ada), entry(bob)], adaId)
      var compose = composeView()
      app.startCompose("new")
      named(compose, "compose-to-field").text = "person@example.com"
      named(compose, "compose-body-editor").text = "Keep Ada's words"
      compose.submit()
      tryCompare(compose, "parkedForSend", true)
      answerQueued(adaId)

      verify(mailService.switchToIndex(1))
      compare(mailService.activeAccountId, bobId)
      var failed = mailService.accountAt(0)
      failed.sendQueue.parked = []
      failed.replyFailed("")

      compare(mailService.activeAccountId, adaId,
        "the failing account must be active before its draft is restored")
      compare(compose.opened, true)
      compare(named(compose, "compose-body-editor").text, "Keep Ada's words")
    }

    function test_zero_delay_native_failure_restores_the_composer_data() {
      return [{tag:"rejected",state:"failed"},{tag:"delivery-unknown",state:"unknown"}]
    }

    function test_zero_delay_native_failure_restores_the_composer(data) {
      mailService.applySettings({ undoSendSeconds: 0 })
      seed([entry(ada, false)], adaId)
      var compose = composeView()
      app.startCompose("new")
      named(compose, "compose-to-field").text = "person@example.com"
      named(compose, "compose-subject-field").text = "No SMTP"
      named(compose, "compose-body-editor").text = "Keep every word"
      compose.submit()
      tryCompare(compose, "opened", false, 5000,
        "an accepted immediate send parks before its deferred result")
      tryVerify(function() { return pending("outbox.enqueue", adaId) !== null })
      var request = pending("outbox.enqueue", adaId)
      request.answered = true
      compare(request.params.provider, "imap")
      compare(request.params.delaySeconds, 0)
      // Rust's authoritative failure must cross account and Service boundaries;
      // the UI does not issue an imap.send or replay the uncertain delivery.
      BackendFixture.respond(mailService, request, {snapshot:{accountId:adaId,
        revision:++outboxRevision,entries:[{id:request.params.sendId,state:data.state}]}})
      tryCompare(compose, "opened", true)
      compare(named(compose, "compose-subject-field").text, "No SMTP")
      compare(named(compose, "compose-body-editor").text, "Keep every word")
      tryCompare(app.composeRecovery, "active", true)
      compare(app.composeRecovery.draft.body, "Keep every word")
      var requests = BackendFixture.install(mailService).requests
      for (var i = 0; i < requests.length; i++)
        verify(requests[i].method !== "imap.send", "UI cannot send or retry mail after a backend result")
    }

    function test_a_second_send_parks_behind_the_first_and_undo_takes_back_the_newest() {
      seed([entry(ada), entry(bob)], adaId)
      var compose = composeView()
      app.startCompose("new")
      named(compose, "compose-to-field").text = "first@example.com"
      named(compose, "compose-body-editor").text = "Ada's pending message"
      compose.submit()
      tryCompare(mailService.accountAt(0), "sendPending", true)
      answerQueued(adaId)
      compare(compose.pendingDraft.body, "Ada's pending message")

      verify(app.switchAccount(1))
      app.startCompose("new")
      named(compose, "compose-to-field").text = "second@example.com"
      named(compose, "compose-body-editor").text = "Bob's newer draft"

      app.runShortcut("send", "Ctrl+Return")

      tryCompare(compose, "opened", false, 5000, "a second send parks like the first")
      answerQueued(bobId)
      compare(mailService.accountAt(1).sendPending, true)
      compare(mailService.sendPendingCount, 2)
      compare(compose.pendingDraft.body, "Bob's newer draft",
        "the newest parked draft is the one Undo would take back")

      verify(app.undoPendingSend())
      tryVerify(function() { return pending("outbox.undo", bobId) !== null })
      var undo = pending("outbox.undo", bobId)
      undo.answered = true
      BackendFixture.respond(mailService,undo,{id:undo.params.sendId,snapshot:{accountId:bobId,
        revision:++outboxRevision,entries:[{id:undo.params.sendId,state:"cancelled"}]}})
      tryCompare(named(compose, "compose-body-editor"), "text", "Bob's newer draft")
      compare(mailService.accountAt(1).sendPending, false)
      compare(mailService.accountAt(0).sendPending, true,
        "undoing the newest send leaves the older one parked")
      compare(compose.pendingDraft.body, "Ada's pending message")
    }

    function test_repeated_failures_preserve_every_parked_draft() {
      var compose = composeView()
      compose.parkedDrafts = [
        { sendId: "send-1", draft: { body: "First" } },
        { sendId: "send-2", draft: { body: "Second" } },
        { sendId: "send-3", draft: { body: "Third" } }
      ]

      verify(compose.resumePendingSend("send-1", true))
      verify(compose.resumePendingSend("send-2", true))
      verify(compose.resumePendingSend("send-3", true))

      compare(compose.snapshotDraft().body, "Third")
      compare(compose.interruptedDraft.body, "First")
      compare(compose.recoveryDrafts.length, 1)
      compare(compose.recoveryDrafts[0].body, "Second")
    }

    function test_unified_failure_is_relayed_once_without_switching_account() {
      seed([entry(ada), entry(bob)], adaId)
      mailService.applySettings({ unifiedMailboxes: true, undoSendSeconds: 10 })
      tryCompare(mailService, "unified", true)

      mailService.forwardReplyFailure(1, "send-7")

      compare(failureSpy.count, 1)
      compare(mailService.activeAccountId, adaId)
    }
  }
}
