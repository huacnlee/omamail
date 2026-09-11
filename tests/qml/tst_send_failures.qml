import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
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

    function stopSends() {
      for (var i = 0; i < mailService.accountCount; i++) {
        var account = mailService.accountAt(i)
        if (account && account.sendPending) account.undoSend()
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
      compare(compose.parkedForSend, true)

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

    function test_zero_delay_synchronous_rejection_restores_the_composer() {
      mailService.applySettings({ undoSendSeconds: 0 })
      seed([entry(ada, false)], adaId)
      var compose = composeView()
      app.startCompose("new")
      named(compose, "compose-to-field").text = "person@example.com"
      named(compose, "compose-subject-field").text = "No SMTP"
      named(compose, "compose-body-editor").text = "Keep every word"

      compose.submit()

      compare(compose.opened, false,
        "an accepted immediate send parks before its deferred result")
      tryCompare(compose, "opened", true)
      compare(named(compose, "compose-subject-field").text, "No SMTP")
      compare(named(compose, "compose-body-editor").text, "Keep every word")
      tryCompare(app.composeRecovery, "active", true)
      compare(app.composeRecovery.draft.body, "Keep every word")
    }

    function test_a_second_send_parks_behind_the_first_and_undo_takes_back_the_newest() {
      seed([entry(ada), entry(bob)], adaId)
      var compose = composeView()
      app.startCompose("new")
      named(compose, "compose-to-field").text = "first@example.com"
      named(compose, "compose-body-editor").text = "Ada's pending message"
      compose.submit()
      compare(mailService.accountAt(0).sendPending, true)
      compare(compose.pendingDraft.body, "Ada's pending message")

      verify(app.switchAccount(1))
      app.startCompose("new")
      named(compose, "compose-to-field").text = "second@example.com"
      named(compose, "compose-body-editor").text = "Bob's newer draft"

      app.runShortcut("send", "Ctrl+Return")

      compare(compose.opened, false, "a second send parks like the first")
      compare(mailService.accountAt(1).sendPending, true)
      compare(mailService.sendPendingCount, 2)
      compare(compose.pendingDraft.body, "Bob's newer draft",
        "the newest parked draft is the one Undo would take back")

      verify(app.undoPendingSend())
      compare(named(compose, "compose-body-editor").text, "Bob's newer draft")
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
