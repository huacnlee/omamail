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

  QtObject {
    id: agentBackend
    property bool ready: true
    property int apiVersion: 6
    function call(method, params, callback) {
      if (method === "agent.providerStatus") callback({available:true,provider:"claude"}, "")
      // Tests inject completed jobs/proposals; no agent process is started.
    }
  }

  SignalSpy {
    id: failureSpy
    target: mailService
    signalName: "replyFailed"
  }

  TestCase {
    name: "SendFailures"
    when: windowShown

    function initTestCase() {
      var fixture = BackendFixture.install(mailService)
      // Repeated API/account setup must not fill the bounded RPC queue with
      // unanswered background cache reads and starve the send under test.
      fixture.answers = {"cache.calendarRead":null, "cache.queryRestore":null}
      BackendFixture.markReady(mailService)
      mailService.agentRunner.backend = agentBackend
    }

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

    function test_ai_card_send_keeps_displayed_body_and_uses_normal_outbox() {
      BackendFixture.markReady(mailService, 6)
      var owner = entry(ada)
      owner.signature = "Do not append this changed signature"
      seed([owner], adaId)
      mailService.accountAt(0).profile = {email:ada}
      var fixture = BackendFixture.install(mailService)
      var start = fixture.requests.length
      var displayed = "Hi Bob,\n\nThursday works.  \n\nAda\n\n> Original question\n"
      var id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0"
      var compose = composeView()
      var sendId = compose.sendProposal({accountId:adaId,from:ada,to:bob,cc:"",bcc:"",
        subject:"Re: Check-in",body:displayed,attachments:[],threadId:"thread",inReplyTo:"message",draftId:""}, id, "chat")
      compare(sendId, "agent-" + id)
      var queued = answerQueued(adaId)
      compare(queued.id, sendId)
      var composed = null
      for (var i = start; i < fixture.requests.length; i++)
        if (fixture.requests[i].method === "message.compose") composed = fixture.requests[i].params.fields
      verify(composed !== null)
      compare(composed.body, displayed)
      compare(composed.signature, "")
      compare(composed.signatureHtml, "")
      compare(composed.to, bob)
      compare(composed.inReplyTo, "message")
      compare(mailService.accountAt(0).sendQueue.latest.id, sendId)
      compare(compose.parkedDrafts.length, 1)
      compare(compose.pendingDraft.body, displayed)
      compare(compose.pendingDraft.agentParentJobId, "chat")
      BackendFixture.markReady(mailService)
    }

    function proposal() {
      return {accountId:adaId,from:ada,to:bob,cc:"",bcc:"",replyTo:"",
        subject:"Re: Proposal",body:"Exact reply\n\n> Quoted history\n",attachments:[],
        threadId:"thread",inReplyTo:"message",replyMessageId:"source",draftId:""}
    }

    function test_proposal_routing_edits_block_card_dispatch_data() {
      var rows = []
      var fields = ["to", "cc", "bcc", "replyTo", "from"]
      for (var i = 0; i < fields.length; i++) {
        rows.push({tag:fields[i]+"-pending", field:fields[i], pending:true})
        rows.push({tag:fields[i]+"-displayed", field:fields[i], pending:false})
      }
      return rows
    }

    function test_proposal_routing_edits_block_card_dispatch(data) {
      BackendFixture.markReady(mailService, 6)
      seed([entry(ada)], adaId)
      mailService.accountAt(0).profile = {email:ada}
      app.opened = true
      app.startCompose("new")
      var compose = composeView()
      named(compose, "compose-to-field").text = "original@example.test"
      compose.replaceBody("Manual draft")
      var envelope = compose.outgoingEnvelope()
      var card = {id:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-3", jobId:"routing-chat",
        accountId:adaId,draftKey:compose.draftKey,subject:"Proposed subject",body:"Proposed body",
        applicable:true,envelope:envelope}
      var job = {id:card.jobId, accountId:adaId, draftKey:compose.draftKey,
        state:"done",canContinue:true,created:Date.now()/1000}
      var runner = mailService.agentRunner
      runner.providerAvailable = true
      runner.jobs = [job]
      var scopes = {}; scopes["draft:" + compose.draftKey] = {jobs:[job],history:[job]}
      var accounts = {}; accounts[adaId] = scopes
      runner.scopesByAccount = accounts
      app.composeAgent.open()
      runner.shownId = job.id
      runner.shownTranscript = [{role:"assistant",text:"Here's a draft."}]
      if (!data.pending) runner.shownProposals = [card]
      if (data.field === "from") compose.fromEmail = "corrected@example.test"
      else named(compose, "compose-" + (data.field === "replyTo" ? "reply-to" : data.field) + "-field").text = "corrected@example.test"
      if (data.pending) runner.shownProposals = [card]
      verify(waitForRendering(app.composeAgent))
      var send = named(app.composeAgent, "agent-send-email")
      var fixture = BackendFixture.install(mailService)
      var start = fixture.requests.length
      verify(!app.composeAgent.useProposal(card, true), "Imperative entry also refuses stale routing")
      verify(!compose.sendProposal(envelope, card.id, job.id), "Composer rechecks at dispatch")
      mouseClick(send)
      wait(0)
      compare(fixture.requests.slice(start).filter(function(r) {
        return r.method === "message.compose" || r.method === "outbox.enqueue"
      }).length, 0, "No MIME construction or outbox enqueue for the old destination")
      compare(compose.parkedDrafts.length, 0)
      verify(!send.enabled)
      var recipients = named(app.composeAgent, "agent-proposal-recipients")
      verify(recipients !== null)
      compare(recipients.textFormat, Text.PlainText)
      verify(recipients.text.indexOf("From: " + ada) >= 0)
      verify(recipients.text.indexOf("To: original@example.test") >= 0)
      verify(named(app.composeAgent, "agent-proposal-routing-changed").visible)
      if (data.field === "to") {
        verify(app.composeAgent.useProposal(card, false))
        compare(named(compose, "compose-to-field").text, "corrected@example.test")
        compare(named(compose, "compose-body-editor").text, card.body)
        compose.submit()
        answerQueued(adaId)
        var composed = fixture.requests.slice(start).filter(function(r) { return r.method === "message.compose" })
        compare(composed.length, 1)
        compare(composed[0].params.fields.to, "corrected@example.test")
        compare(composed[0].params.fields.body, card.body)
      }
      runner.shownProposals = []
      runner.jobs = []; runner.scopesByAccount = ({})
      app.composeAgent.close()
      BackendFixture.markReady(mailService)
    }

    function test_ai_card_undo_restores_its_draft_and_queues_receipt_ack() {
      seed([entry(ada)], adaId)
      mailService.accountAt(0).profile = {email:ada}
      var compose = composeView()
      var envelope = proposal()
      var id = compose.sendProposal(envelope, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1", "chat")
      verify(!!id)
      answerQueued(adaId)
      app.saveComposeRecovery()
      compare(app.composeRecovery.draft.pendingSendId, id)
      compare(app.composeRecovery.draft.body, envelope.body)
      verify(app.undoPendingSend())
      var request = pending("outbox.undo", adaId)
      verify(request !== null)
      request.answered = true
      BackendFixture.respond(mailService, request, {id:id,snapshot:{accountId:adaId,
        revision:++outboxRevision,entries:[{id:id,state:"cancelled"}]}})
      tryCompare(compose, "opened", true)
      compare(named(compose,"compose-body-editor").text, envelope.body)
      compare(named(compose,"compose-to-field").text, envelope.to)
      compare(compose.threadId, envelope.threadId)
      compare(compose.parkedDrafts.length, 0)
      compare(app.composeReceiptAcks.filter(function(entry) { return entry.sendId === id }).length, 1)
    }

    function test_ai_card_failure_restores_snapshot_without_losing_manual_edits() {
      seed([entry(ada)], adaId)
      mailService.accountAt(0).profile = {email:ada}
      var compose = composeView()
      app.startCompose("new")
      named(compose,"compose-to-field").text = "other@example.com"
      named(compose,"compose-body-editor").text = "Newer manual edits"
      var originalKey = compose.draftKey
      var envelope = proposal()
      var id = compose.sendProposal(envelope, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-2", "chat")
      verify(!!id)
      compare(compose.draftKey, originalKey)
      compare(named(compose,"compose-body-editor").text, "Newer manual edits")
      tryVerify(function() { return pending("outbox.enqueue", adaId) !== null })
      var request = pending("outbox.enqueue", adaId)
      verify(request !== null)
      request.answered = true
      BackendFixture.respond(mailService, request, {snapshot:{accountId:adaId,
        revision:++outboxRevision,entries:[{id:id,state:"failed"}]}})
      tryCompare(compose, "parkedForSend", false)
      compare(named(compose,"compose-body-editor").text, envelope.body)
      verify(compose.interruptedDraft !== null)
      compare(compose.interruptedDraft.body, "Newer manual edits")
      compare(compose.interruptedDraft.draftKey, originalKey)
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
