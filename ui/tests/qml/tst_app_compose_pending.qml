import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

Item {
  width: 900
  height: 600

  QtObject {
    id: recoveryBackend
    property bool ready: false
    property var requests: []
    function call(method, params, callback) { requests = requests.concat([{method:method,params:params,done:callback}]) }
  }

  QtObject {
    id: mailService
    property var backend: recoveryBackend

    property bool hasAgent: true
    property bool agentStarting: false
    property string agentError: ""
    property string agentShownId: ""
    property string agentShownOutput: ""
    property var agentShownTranscript: []
    property int agentRequests: 0
    property string lastAgentPrompt: ""
    function askAgentDraft(fields, prompt) { agentRequests++; lastAgentPrompt = prompt; return true }
    property var agentJobs: ({})
    property var agentAttentionByMessage: ({})
    property var draftAgentJobs: []
    property string cancelledAgentId: ""
    function agentJobsForDraft(fields) { return draftAgentJobs }
    function cancelAgentJob(id) { cancelledAgentId=id; return true }
    function showAgentJob(id) { agentShownId=id }
    function acknowledgeAgentJob(id) {}
    function agentJobWantsAttention(job) { return false }
    function agentJobFor(id, owner) { return null }
    function agentSelectionJob(ids, owner) { return null }
    function refreshAgentJobs() {}
    property bool ready: true
    property bool anyAccountReady: true
    property bool sendPending: true
    property bool sending: false
    property bool windowOpen: false
    property bool sidebarCollapsed: false
    property bool alwaysShowImages: false
    property bool unifiedCalendarView: false
    property bool selectedReaderEmpty: false
    property bool selectedReaderTooHeavy: false
    property bool selectedTooHeavy: false
    property bool detailLoading: false
    property bool detailPainted: false
    property bool canOpenOnWeb: false
    property bool canRespondToInvite: false
    property bool rsvpSending: false
    property bool canArchive: true
    property bool canStar: true
    property bool canSpam: true
    property bool canTrash: true
    property bool canMarkRead: true
    property bool canMarkUnread: true
    property bool accountDraftOpen: false
    property int sendSecondsRemaining: 10
    property int accountCount: 1
    property int inboxUnread: 0
    property real bodyZoom: 1
    property string bodyMode: "reader"
    property string providerId: "gmail"
    property string pluginDir: ""
    property string accountEmail: "me@example.com"
    property string activeAccountId: "me@example.com"
    property string mailboxKey: "inbox"
    property string searchQuery: ""
    property string rawQuery: ""
    property string selectedId: "message-1"
    property string lastError: ""
    property string actionStatus: ""
    property string syncedLabel: ""
    property string recipientContactStatus: ""
    property var auth: null
    property var accountSummaries: []
    property var mailboxes: []
    property var labels: []
    property var messages: []
    property var selectedAttachments: []
    property var selectedInvite: null
    property var selectedResponse: ""
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: []
    property var calendarController: null
    property var lastSavedDraft: null
    property string lastLoadedAttachmentId: ""
    property bool failDraftSave: false
    property bool deferDraftSave: false
    property var draftSaveCallbacks: []
    property var selectedBody: ({ text: "Original body" })
    property var selectedMessage: ({
      id: "message-1",
      messageId: "<message-1@example.com>",
      threadId: "thread-1",
      subject: "Original subject",
      from: ({ email: "sender@example.com", display: "Sender" }),
      replyTo: ({ email: "sender@example.com" }),
      to: [],
      cc: [],
      fullTime: "today"
    })

    function preferredSendAs(_recipients) { return null }
    function refreshRecipientContacts() {}
    function cursorOffset(_id, _delta) { return "" }
    function clearSelection() {}
    function select(id) {
      selectedId = String(id || "")
      selectedMessage = null
      selectedBody = ({ text: "", source: "" })
      selectedAttachments = []
      detailPainted = false
      detailLoading = true
    }
    function loadAttachments(messageId, attachments, callback) {
      lastLoadedAttachmentId = String(messageId || "")
      var listed = Array.isArray(attachments) ? attachments : []
      var loaded = []
      for (var i = 0; i < listed.length; i++) {
        loaded.push({
          filename: String(listed[i].filename || "attachment"),
          mimeType: String(listed[i].mimeType || "application/octet-stream"),
          size: Number(listed[i].size || 0),
          data: "ZHJhZnQgZmlsZQ"
        })
      }
      callback(loaded, "")
    }
    function send(_fields) {
      sendPending = true
      return true
    }
    function undoSend(callback) {
      if (!sendPending) return false
      sendPending = false
      if (typeof callback === "function") callback(true)
      return true
    }
    function saveDraft(fields, callback) {
      lastSavedDraft = fields
      if (deferDraftSave) {
        var queued = draftSaveCallbacks.slice()
        queued.push(callback)
        draftSaveCallbacks = queued
        return
      }
      callback(failDraftSave ? null : "draft-1",
        failDraftSave ? "server refused it" : "")
    }
    function finishDraftSave(index, error) {
      var queued = draftSaveCallbacks.slice()
      var callback = queued[index]
      queued.splice(index, 1)
      draftSaveCallbacks = queued
      callback(error ? null : "draft-1", String(error || ""))
    }
    function refresh() {}
    function fail(text) { lastError = String(text || "") }
    function note(text) { actionStatus = String(text || "") }
    signal replySent()
    signal replyFailed()
  }

  Omamail.App {
    id: app
    service: mailService
  }

  TestCase {
    name: "AppComposePending"
    when: windowShown

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

    function init() {
      recoveryBackend.ready = false
      recoveryBackend.requests = []
      app.composeWriting = false
      app.composeReading = false
      app.composeRecoveryConflict = false
      app.composeStorageRevision = ""
      app.composeReceiptChecking = false
      app.composeReceiptAcks = []
      app.composeReceiptAckBusy = ({})
      app.composeCommittedRevision = 0
      app.composeDeliveryStates = ({})
      app.composeWritePayload = ""
      app.composeWriteQueued = false

      var assistant = named(app, "compose-agent")
      if (assistant) {
        assistant.close()
        named(assistant, "agent-prompt-field").text = ""
      }
      app.opened = false
      app.loadComposeRecovery("")
      app.clearComposeRecovery()
      mailService.sendPending = false
      var aiDock = named(app,"compose-agent")
      if (aiDock) { aiDock.submittedPrompt=""; findChild(aiDock,"agent-pending-queue").messages=[] }
      app.preferredAssistantWidth = 0
      mailService.draftAgentJobs = []; mailService.cancelledAgentId = ""
      mailService.agentRequests = 0
      mailService.lastAgentPrompt = ""
      mailService.sending = false
      mailService.lastSavedDraft = null
      mailService.failDraftSave = false
      mailService.deferDraftSave = false
      mailService.draftSaveCallbacks = []
      mailService.lastError = ""
      mailService.actionStatus = ""
      mailService.lastLoadedAttachmentId = ""
      mailService.mailboxKey = "inbox"
      mailService.detailLoading = false
      mailService.detailPainted = false
      mailService.selectedId = "message-1"
      mailService.selectedBody = ({ text: "Original body", source: "plain" })
      mailService.selectedAttachments = []
      mailService.selectedMessage = ({
        id: "message-1",
        messageId: "<message-1@example.com>",
        threadId: "thread-1",
        subject: "Original subject",
        from: ({ email: "sender@example.com", display: "Sender" }),
        replyTo: ({ email: "sender@example.com" }),
        to: [],
        cc: [],
        bcc: [],
        fullTime: "today"
      })
      app.resetNavigation()
      app.cursorId = ""
      var compose = composeView()
      if (compose) {
        compose.reset()
        compose.opened = false
      }
    }

    function beginNativeRecovery() {
      app.composeWritePayload = ""
      app.composeWriteQueued = false
      recoveryBackend.ready = true
      compare(recoveryBackend.requests.length, 1)
      compare(recoveryBackend.requests[0].method, "compose.recoveryRead")
      recoveryBackend.requests[0].done({record:{active:false,returnView:"",draft:null,parked:[]},revision:"initial"}, null)
    }
    function lastNativeRequest(method) {
      for (var i = recoveryBackend.requests.length - 1; i >= 0; i--) if (recoveryBackend.requests[i].method === method) return recoveryBackend.requests[i]
      return null
    }
    function recoveredPending() {
      return {version:1,active:true,returnView:"list",draft:{body:"Recovered queued message",accountId:"me@example.com",pendingSendId:"receipt-one"},parked:[]}
    }
    function test_sent_receipt_is_not_restored_and_is_acknowledged_only_after_durable_save() {
      recoveryBackend.ready = true
      lastNativeRequest("compose.recoveryRead").done({record:recoveredPending(),revision:"r1"},null)
      var receipt = lastNativeRequest("outbox.snapshot")
      verify(receipt !== null);compare(receipt.params.sendId,"receipt-one")
      receipt.done({accountId:"me@example.com",entries:[{id:"receipt-one",state:"sent"}]},null)
      tryVerify(function(){return lastNativeRequest("compose.recoverySave") !== null})
      verify(app.composeRecovery.active !== true);verify(!composeView().opened)
      compare(lastNativeRequest("outbox.forget"),null)
      var saved = lastNativeRequest("compose.recoverySave")
      saved.done({record:saved.params.record,revision:"r2"},null)
      lastNativeRequest("outbox.snapshot").done({entries:[{state:"sent"}]},null)
      verify(lastNativeRequest("outbox.forget") !== null)
    }
    function test_queued_receipt_stays_parked_instead_of_opening_a_duplicate_composer() {
      recoveryBackend.ready = true
      lastNativeRequest("compose.recoveryRead").done({record:recoveredPending(),revision:"r1"},null)
      lastNativeRequest("outbox.snapshot").done({accountId:"me@example.com",entries:[{id:"receipt-one",state:"queued"}]},null)
      tryVerify(function(){return composeView().parkedDrafts.length > 0})
      compare(composeView().parkedDrafts[0].sendId,"receipt-one")
      app.opened = true;app.restoreComposeRecovery();verify(!composeView().opened)
    }
    function test_recovered_identical_send_ids_in_different_accounts_are_not_deduplicated() {
      recoveryBackend.ready = true
      var record = recoveredPending()
      record.parked = [{body:"Other queued message",accountId:"other@example.org",pendingSendId:"receipt-one"}]
      lastNativeRequest("compose.recoveryRead").done({record:record,revision:"r1"},null)
      lastNativeRequest("outbox.snapshot").done({entries:[{id:"receipt-one",state:"queued"}]},null)
      wait(1)
      lastNativeRequest("outbox.snapshot").done({entries:[{id:"receipt-one",state:"queued"}]},null)
      tryCompare(composeView(),"parkedForSend",true)
      compare(composeView().parkedDrafts.length,2)
      verify(composeView().parkedDrafts[0].draft.accountId !== composeView().parkedDrafts[1].draft.accountId)
    }
    function test_unknown_receipt_is_retained_and_no_send_is_replayed() {
      recoveryBackend.ready = true
      lastNativeRequest("compose.recoveryRead").done({record:recoveredPending(),revision:"r1"},null)
      lastNativeRequest("outbox.snapshot").done({accountId:"me@example.com",entries:[{id:"receipt-one",state:"unknown"}]},null)
      tryVerify(function(){return app.composeRecovery.draft && app.composeRecovery.draft.deliveryUnknown === true})
      compare(lastNativeRequest("outbox.enqueue"),null);compare(lastNativeRequest("outbox.forget"),null)
      verify(!app.composeRecovery.draft.pendingSendId)
    }
    function test_native_recovered_draft_discard_persists_a_tombstone() {
      beginNativeRecovery()
      app.loadComposeRecovery({active:true,returnView:"list",draft:{body:"Recovered",accountId:"one@example.org"},parked:[]})
      verify(app.clearComposeRecovery())
      compare(recoveryBackend.requests.length,2)
      compare(recoveryBackend.requests[1].params.record.active,false)
      compare(recoveryBackend.requests[1].params.expectedRevision,"initial")
    }
    function test_native_recovery_serializes_writes_and_stale_reply_keeps_newer_snapshot() {
      beginNativeRecovery()
      app.saveComposeRecovery({body:"First",accountId:"one@example.org"})
      compare(recoveryBackend.requests.length,2)
      var first = recoveryBackend.requests[1]
      compare(first.params.expectedRevision,"initial")
      app.saveComposeRecovery({body:"Second",accountId:"two@example.org"})
      compare(recoveryBackend.requests.length,2)
      first.done({record:{active:true,draft:{body:"First"}},revision:"first"},null)
      compare(app.composeRecovery.draft.body,"Second")
      compare(recoveryBackend.requests.length,3)
      var second = recoveryBackend.requests[2]
      compare(second.params.expectedRevision,"first")
      compare(second.params.record.draft.accountId,"two@example.org")
      second.done({record:{active:true,draft:{body:"Second"}},revision:"second"},null)
      compare(app.composeWritePayload,"")
      compare(app.composeWriting,false)
    }
    function test_native_recovery_conflict_never_retries_over_another_instance() {
      beginNativeRecovery()
      app.saveComposeRecovery({body:"Keep local draft"})
      recoveryBackend.requests[1].done(null,{message:"recovery_conflict"})
      compare(app.composeRecoveryConflict,true)
      compare(app.composeRecovery.draft.body,"Keep local draft")
      app.saveComposeRecovery({body:"New local edit"})
      compare(recoveryBackend.requests.length,2)
      recoveryBackend.ready = false
      recoveryBackend.ready = true
      compare(recoveryBackend.requests.length,3)
      recoveryBackend.requests[2].done({record:{active:true,draft:{body:"Other instance"}},revision:"other"},null)
      compare(app.composeRecovery.draft.body,"New local edit")
      compare(recoveryBackend.requests.length,3)
    }
    function test_ai_dock_reserves_space_and_escape_keeps_the_draft() {
      app.open("{}")
      app.startCompose("new")
      var compose=composeView()
      var originalWidth=compose.width
      var body=named(compose,"compose-body-editor")
      body.text="Keep draft"
      body.forceActiveFocus()
      app.runShortcut("askAgent", "Alt+G")
      var dock=named(app,"compose-agent")
      tryCompare(dock,"opened",true)
      verify(compose.width < originalWidth)
      compare(compose.width + named(app,"assistant-dock").width, originalWidth)
      tryCompare(app,"assistantEditing",true)
      var field=named(dock,"agent-prompt-field")
      tryCompare(field,"activeFocus",true)
      keyClick(Qt.Key_E)
      verify(field.text.indexOf("e") === 0)
      keyClick(Qt.Key_Escape)
      tryCompare(dock,"opened",false)
      compare(app.composing,true)
      compare(body.text,"Keep draft")
      compare(compose.width,originalWidth)
      tryCompare(body,"activeFocus",true)
    }

    function test_ai_dock_resizes_from_left_edge_and_keeps_width() {
      app.open("{}")
      app.startCompose("new")
      app.runShortcut("askAgent", "Alt+G")
      var dock=named(app,"assistant-dock")
      var splitter=named(app,"assistant-splitter")
      verify(waitForRendering(dock))
      var before=dock.width
      mouseDrag(splitter,2,100,-60,0)
      verify(dock.width > before)
      verify(dock.width <= app.assistantMaxWidth)
      var resized=dock.width
      named(app,"compose-agent").close()
      app.runShortcut("askAgent", "Alt+G")
      compare(dock.width,resized)
      app.preferredAssistantWidth=9999
      compare(dock.width,app.assistantMaxWidth)
      mouseDoubleClickSequence(splitter,2,100)
      compare(app.preferredAssistantWidth,0)
    }
    function test_escape_interrupts_running_ai_and_keeps_chat_open() {
      app.open("{}")
      app.startCompose("new")
      app.runShortcut("askAgent", "Alt+G")
      var dock=named(app,"compose-agent")
      mailService.draftAgentJobs=[{id:"running",state:"running",created:1}]
      tryCompare(dock,"working",true)
      var field=named(dock,"agent-prompt-field")
      tryCompare(field,"activeFocus",true)
      keyClick(Qt.Key_Escape)
      compare(mailService.cancelledAgentId,"running")
      compare(dock.opened,true)
    }
    function test_enter_queues_multiple_messages_while_ai_is_running() {
      app.open("{}")
      app.startCompose("new")
      app.runShortcut("askAgent", "Alt+G")
      var dock=named(app,"compose-agent")
      mailService.draftAgentJobs=[{id:"active",state:"running",created:1}]
      var field=named(dock,"agent-prompt-field")
      tryCompare(field,"activeFocus",true)
      field.text="Second question"
      keyClick(Qt.Key_Return)
      field.text="Third question"
      keyClick(Qt.Key_Return)
      compare(field.text,"")
      compare(mailService.agentRequests,0)
      var queue=findChild(dock,"agent-pending-queue")
      compare(queue.messages.length,2)
      queue.messages=[]
    }
    function test_header_ai_toggle_and_multiline_send() {
      app.open("{}")
      app.startCompose("new")
      var toggle = named(app, "header-ai-button")
      verify(toggle)
      verify(waitForRendering(toggle))
      verify(toggle.x >= 0 && toggle.x + toggle.width <= toggle.parent.width)
      mouseClick(toggle, toggle.width / 2, toggle.height / 2)
      var dock = named(app, "compose-agent")
      tryCompare(dock, "opened", true)
      var field = named(dock, "agent-prompt-field")
      tryCompare(field, "activeFocus", true)
      field.text = "First line"
      field.cursorPosition = field.length
      keyClick(Qt.Key_Return, Qt.ShiftModifier)
      compare(field.text, "First line\n")
      keyClick(Qt.Key_X)
      compare(mailService.agentRequests, 0)
      keyClick(Qt.Key_Return)
      compare(mailService.agentRequests, 1)
      compare(mailService.lastAgentPrompt, "First line\nx")
      compare(field.text, "")
      keyClick(Qt.Key_Enter)
      compare(mailService.agentRequests, 1)
      field.text = "Next question"
      keyClick(Qt.Key_Enter)
      compare(mailService.agentRequests, 1)
      field.text = "Another question"
      keyClick(Qt.Key_Enter, Qt.ControlModifier)
      compare(mailService.agentRequests, 1)
      compare(findChild(dock,"agent-pending-queue").messages.length, 2)
      findChild(dock,"agent-pending-queue").messages=[]
      dock.submittedPrompt=""
      compare(app.composing, true)
      mouseClick(toggle, toggle.width / 2, toggle.height / 2)
      tryCompare(dock, "opened", false)
    }

    function test_ai_command_keys_fill_without_sending_and_escape_in_order() {
      app.open("{}")
      app.startCompose("new")
      app.runShortcut("askAgent", "Alt+G")
      var dock = named(app, "compose-agent")
      var field = named(dock, "agent-prompt-field")
      tryCompare(field, "activeFocus", true)
      field.text = "/"
      field.cursorPosition = field.length
      tryCompare(dock, "commandsOpen", true)
      tryCompare(named(app, "key-router"), "context", "assistantCommands")
      wait(0)
      keyClick(Qt.Key_Down)
      compare(dock.commandIndex, 1, "Down must route to command selection")
      keyClick(Qt.Key_Up)
      compare(dock.commandIndex, 0, "Up must route to command selection")
      keyClick(Qt.Key_Return)
      tryCompare(dock, "commandsOpen", false)
      verify(field.text.length > 1)
      verify(field.text.indexOf("/") !== 0)
      compare(mailService.agentRequests, 0)
      compare(field.activeFocus, true)
      field.text = "/"
      field.cursorPosition = field.length
      tryCompare(dock, "commandsOpen", true)
      keyClick(Qt.Key_Enter, Qt.ShiftModifier)
      compare(field.text, "/\n")
      compare(mailService.agentRequests, 0)
      field.text = "/r"
      tryCompare(dock, "commandsOpen", true)
      keyClick(Qt.Key_Enter)
      tryCompare(dock, "commandsOpen", false)
      verify(field.text.indexOf("/") !== 0)
      compare(mailService.agentRequests, 0)
      field.text = "/"
      tryCompare(dock, "commandsOpen", true)
      wait(0)
      keyClick(Qt.Key_Escape)
      tryCompare(dock, "commandsOpen", false)
      compare(dock.opened, true)
      keyClick(Qt.Key_Escape)
      tryCompare(dock, "opened", false)
      compare(app.composing, true)
    }

    function test_ai_dock_allows_returning_to_draft_fields() {
      app.open("{}")
      app.startCompose("new")
      var compose=composeView()
      app.runShortcut("askAgent", "Alt+G")
      var dock=named(app,"compose-agent")
      tryCompare(dock,"opened",true)
      var field=named(dock,"agent-prompt-field")
      tryCompare(field,"activeFocus",true)
      var subject=named(compose,"compose-subject-field")
      subject.forceActiveFocus()
      tryCompare(app,"assistantEditing",false)
      wait(0)
      compare(subject.activeFocus,true)
      compare(dock.opened,true)
      dock.close()
    }

    function test_shell_close_flushes_and_restores_the_current_draft() {
      var compose = composeView()
      app.open("{}")
      app.startCompose("new")
      named(compose, "compose-subject-field").text = "Quarterly plan"
      named(compose, "compose-body-editor").text = "Keep every word"

      app.close()

      compare(app.composeRecovery.active, true)
      compare(app.composeRecovery.draft.subject, "Quarterly plan")
      compare(app.composeRecovery.draft.body, "Keep every word")

      compose.reset()
      compose.opened = false
      app.open("{}")
      wait(20)

      compare(compose.opened, true)
      compare(named(compose, "compose-subject-field").text, "Quarterly plan")
      compare(named(compose, "compose-body-editor").text, "Keep every word")
    }

    function test_reply_starts_while_another_send_is_pending() {
      compare(app.composing, false)
      app.startCompose("reply")
      compare(app.composing, true,
        "the undo window must not block a reply")
      mailService.replySent()
      compare(app.composing, true,
        "the queued send must not close the new reply")
    }

    function test_undo_saves_the_new_compose_before_forgetting_it() {
      var compose = composeView()
      verify(compose)
      app.startCompose("new")
      named(compose, "compose-to-field").text = "first@example.com"
      named(compose, "compose-body-editor").text = "First message"
      compose.submit()

      app.startCompose("new")
      named(compose, "compose-to-field").text = "second@example.com"
      named(compose, "compose-subject-field").text = "Second subject"
      named(compose, "compose-body-editor").text = "Second message"

      verify(app.undoPendingSend())
      compare(named(compose, "compose-to-field").text, "first@example.com")
      compare(named(compose, "compose-body-editor").text, "First message")
      verify(mailService.lastSavedDraft)
      compare(mailService.lastSavedDraft.to, "second@example.com")
      compare(mailService.lastSavedDraft.subject, "Second subject")
      compare(mailService.lastSavedDraft.body, "Second message")
      compare(compose.interruptedDraft, null,
        "the server copy replaces the in-memory fallback after saving")
      compare(app.draftSavedNotice, "Draft saved")
      verify(compose.restoreRevision > 0,
        "restoring the queued message must trigger field feedback")
    }

    function test_failed_save_keeps_the_newer_compose_in_memory() {
      var compose = composeView()
      app.startCompose("new")
      named(compose, "compose-to-field").text = "first@example.com"
      named(compose, "compose-body-editor").text = "First message"
      compose.submit()

      app.startCompose("new")
      named(compose, "compose-to-field").text = "second@example.com"
      named(compose, "compose-body-editor").text = "Second message"
      mailService.failDraftSave = true

      verify(app.undoPendingSend())
      verify(compose.interruptedDraft,
        "a failed provider save must keep the in-memory fallback")
      verify(mailService.lastError.indexOf("server refused it") >= 0)
      compose.finish()
      compare(named(compose, "compose-to-field").text, "second@example.com")
      compare(named(compose, "compose-body-editor").text, "Second message")
    }

    function test_escape_saves_a_nonempty_compose_before_closing_it() {
      var compose = composeView()
      app.startCompose("new")
      named(compose, "compose-subject-field").text = "Quarterly plan"
      named(compose, "compose-body-editor").text = "First draft"

      app.goBack()

      verify(mailService.lastSavedDraft,
        "Escape must hand the composition to the provider's Drafts storage")
      compare(mailService.lastSavedDraft.subject, "Quarterly plan")
      compare(mailService.lastSavedDraft.body, "First draft")
      compare(app.composing, false)
      compare(app.draftSavedNotice, "Draft saved")
    }

    function test_an_older_save_cannot_clear_a_newer_drafts_recovery() {
      var compose = composeView()
      mailService.deferDraftSave = true

      app.startCompose("new")
      named(compose, "compose-body-editor").text = "First draft"
      app.goBack()

      app.startCompose("new")
      named(compose, "compose-body-editor").text = "Second draft"
      app.goBack()
      compare(mailService.draftSaveCallbacks.length, 2)
      compare(app.composeRecovery.draft.body, "Second draft")

      mailService.finishDraftSave(0, "")

      compare(app.composeRecovery.active, true)
      compare(app.composeRecovery.draft.body, "Second draft",
        "the first request must not clear the newer recovery snapshot")
    }

    function test_failed_older_save_waits_behind_newer_recovery() {
      var compose = composeView()
      mailService.deferDraftSave = true

      app.startCompose("new")
      named(compose, "compose-body-editor").text = "First draft"
      app.goBack()
      app.startCompose("new")
      named(compose, "compose-body-editor").text = "Second draft"
      app.goBack()

      mailService.finishDraftSave(0, "server refused it")
      compare(app.composeRecovery.draft.body, "Second draft",
        "the newer in-flight draft keeps the durable recovery slot")
      compare(named(compose, "compose-body-editor").text, "First draft",
        "the older failed draft remains available in memory")

      mailService.finishDraftSave(0, "")
      wait(350)
      compare(app.composeRecovery.draft.body, "First draft",
        "once the newer draft is durable, recovery follows the older failed draft")
    }

    // A click on a draft previews it, as a click does in every mailbox; the
    // keys are what edit it.
    function test_a_click_previews_a_draft() {
      mailService.mailboxKey = "drafts"
      app.openMessage("draft-7")
      wait(30)
      compare(mailService.selectedId, "draft-7")
      compare(app.currentView, "reader")
      compare(app.composing, false)
      app.back()
      mailService.mailboxKey = "inbox"
    }

    // In Drafts, opening a draft is editing it: `o` selects the draft and,
    // once its body has loaded, the composer opens on it with what was
    // written — no second key. `c` still does the same.
    function test_open_edits_a_draft_once_its_body_has_loaded() {
      var compose = composeView()
      mailService.mailboxKey = "drafts"
      app.cursorId = "draft-7"

      app.runShortcut("open", "o")

      compare(mailService.selectedId, "draft-7")
      compare(app.composing, false, "nothing to edit until the body is here")

      mailService.selectedMessage = ({
        id: "draft-7",
        messageId: "<draft-7@example.com>",
        threadId: "thread-7",
        inReplyTo: "<earlier@example.com>",
        subject: "Saved subject",
        from: ({ email: "me@example.com", display: "Me" }),
        replyTo: ({ email: "" }),
        to: [{ email: "first@example.com" }, { email: "second@example.com" }],
        cc: [{ email: "copy@example.com" }],
        bcc: [{ email: "hidden@example.com" }],
        fullTime: "today",
        isDraft: true
      })
      mailService.selectedBody = ({ text: "Saved body", source: "plain" })
      mailService.selectedAttachments = [{
        filename: "plan.txt", mimeType: "text/plain", size: 10,
        attachmentId: "part:1"
      }]
      mailService.detailPainted = true
      mailService.detailLoading = false
      wait(30)

      compare(app.composing, true, "the loaded body opens the composer")
      compare(compose.mode, "draft")
      compare(compose.fromEmail, "me@example.com")
      compare(named(compose, "compose-to-field").text,
        "first@example.com, second@example.com")
      compare(named(compose, "compose-cc-field").text, "copy@example.com")
      compare(named(compose, "compose-bcc-field").text, "hidden@example.com")
      compare(named(compose, "compose-subject-field").text, "Saved subject")
      compare(named(compose, "compose-body-editor").text, "Saved body")
      compare(compose.threadId, "thread-7")
      compare(compose.inReplyTo, "<earlier@example.com>")
      compare(mailService.lastLoadedAttachmentId, "draft-7")
      compare(compose.draftAttachments.length, 1)
      compare(compose.draftAttachments[0].filename, "plan.txt")

      named(compose, "compose-subject-field").text = "Updated subject"
      app.goBack()

      verify(mailService.lastSavedDraft)
      compare(mailService.lastSavedDraft.draftId, "draft-7",
        "closing an edited draft must update the source draft")
      compare(mailService.lastSavedDraft.subject, "Updated subject")
    }

    // A send that failed leaves the message in the parked draft and nowhere
    // else — not in Drafts, not in Sent, not in an outbox. The composer coming
    // back holding it is the only thing between a timeout and a lost message.
    function test_a_failed_send_puts_the_message_back_in_the_composer() {
      var compose = composeView()
      verify(compose)
      app.startCompose("new")
      named(compose, "compose-to-field").text = "first@example.com"
      named(compose, "compose-subject-field").text = "Quarterly plan"
      named(compose, "compose-body-editor").text = "Keep every word"
      compose.submit()
      compare(compose.opened, false, "sending parks the composer")

      mailService.replyFailed()

      compare(compose.opened, true, "a failed send must reopen the composer")
      compare(named(compose, "compose-to-field").text, "first@example.com")
      compare(named(compose, "compose-subject-field").text, "Quarterly plan")
      compare(named(compose, "compose-body-editor").text, "Keep every word")

      wait(350)
      compare(app.composeRecovery.active, true,
        "the words are still unsent, so recovery goes on holding them")
      compare(app.composeRecovery.draft.body, "Keep every word")
    }

    // The collision undo already has: a draft started during the undo window
    // is in the composer when the parked one comes back, and saving it is what
    // keeps the parked one from overwriting it.
    function test_a_failed_send_saves_a_draft_started_over_it() {
      var compose = composeView()
      app.startCompose("new")
      named(compose, "compose-to-field").text = "first@example.com"
      named(compose, "compose-body-editor").text = "First message"
      compose.submit()

      app.startCompose("new")
      named(compose, "compose-to-field").text = "second@example.com"
      named(compose, "compose-subject-field").text = "Second subject"
      named(compose, "compose-body-editor").text = "Second message"

      mailService.replyFailed()

      compare(named(compose, "compose-to-field").text, "first@example.com")
      compare(named(compose, "compose-body-editor").text, "First message")
      verify(mailService.lastSavedDraft)
      compare(mailService.lastSavedDraft.to, "second@example.com")
      compare(mailService.lastSavedDraft.subject, "Second subject")
      compare(mailService.lastSavedDraft.body, "Second message")
    }

    function test_recovered_drafts_survive_a_subsequent_recovery_write() {
      var compose = composeView()
      app.open("{}")
      app.startCompose("new")
      named(compose, "compose-body-editor").text = "Current recovered draft"
      compose.recoveryDrafts = [
        { body: "Second recovered draft" },
        { body: "Third recovered draft" }
      ]

      app.saveComposeRecovery()

      compare(app.composeRecovery.parked.length, 2)
      compare(app.composeRecovery.parked[0].body, "Second recovered draft")
      compare(app.composeRecovery.parked[1].body, "Third recovered draft")
    }
  }
}
