import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

Item {
  width: 900
  height: 600

  QtObject {
    id: recoveryBackend
    property bool ready: false
    property int apiVersion: 3
    property var requests: []
    function call(method, params, callback) { requests = requests.concat([{method:method,params:params,done:callback}]) }
  }

  QtObject {
    id: recoveryRuntime
    property string state: "ready"
    property bool canInstall: false
    property int requiredApiVersion: 2
    property int latestApiVersion: 3
  }

  QtObject {
    id: mailService
    property var backend: recoveryBackend
    property var backendRuntime: null

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
    property string composeAccountId: "me@example.com"
    function signatureFor(account) { return "My signature" }
    function accountEmailFor(account) { return "me@example.com" }
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
    property bool deferAttachments: false
    property var attachmentCallback: null
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
      if (deferAttachments) { attachmentCallback = callback; return }
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
      mailService.backendRuntime = null
      app.draftSavedToast = ""
      app.composeRecoveryNotice = ""
      app.composeRecoveryUpdateNoticePending = false
      var exitDialog = named(app, "compose-exit-dialog")
      if (exitDialog) exitDialog.close()
      recoveryBackend.ready = false
      recoveryBackend.apiVersion = 3
      recoveryRuntime.requiredApiVersion = 2
      recoveryRuntime.latestApiVersion = 3
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
      mailService.activeAccountId = "me@example.com"
      mailService.failDraftSave = false
      mailService.deferDraftSave = false
      mailService.draftSaveCallbacks = []
      mailService.lastError = ""
      mailService.actionStatus = ""
      mailService.lastLoadedAttachmentId = ""
      mailService.pluginDir = ""
      mailService.deferAttachments = false
      mailService.attachmentCallback = null
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
    function test_edit_history_recovery_waits_for_fixed_api_three() {
      recoveryBackend.apiVersion = 2
      recoveryBackend.ready = true
      mailService.backendRuntime = recoveryRuntime
      compare(recoveryBackend.requests.length, 0)
      var record = {version:1,active:true,draft:{userModified:true,body:""}}
      app.writeComposeRecovery(JSON.stringify(record))
      compare(recoveryBackend.requests.length, 0, "old backend must not erase an emptied draft")
      verify(app.composeWriteQueued)
      verify(app.draftSavedNotice.indexOf("Keep this window open") >= 0)
      recoveryRuntime.requiredApiVersion = 3
      app.readComposeRecovery()
      compare(recoveryBackend.requests.length, 0, "release metadata cannot enable API 3 behavior")
      recoveryBackend.apiVersion = 3
      tryCompare(recoveryBackend.requests, "length", 1)
      lastNativeRequest("compose.recoveryRead").done({record:{active:false},revision:"initial"}, null)
      var saved = lastNativeRequest("compose.recoverySave")
      verify(saved !== null)
      compare(saved.params.record.draft.userModified, true)
      compare(saved.params.record.draft.body, "")
      saved.done({record:saved.params.record,revision:"next"}, null)
      compare(app.draftSavedNotice, "", "the update notice clears only after recovery is durable")
      recoveryRuntime.latestApiVersion = 4
      app.writeComposeRecovery(JSON.stringify(record))
      verify(lastNativeRequest("compose.recoverySave") !== saved, "later APIs must not disable API 3 recovery")
    }
    function lastNativeRequest(method) {
      for (var i = recoveryBackend.requests.length - 1; i >= 0; i--) if (recoveryBackend.requests[i].method === method) return recoveryBackend.requests[i]
      return null
    }
    function test_offline_recovery_warns_on_old_backend_connection_data() {
      return [{tag:"api-three",api:3},{tag:"later-api",api:4}]
    }
    function test_offline_recovery_warns_on_old_backend_connection(data) {
      recoveryBackend.apiVersion = 0
      var record = {version:1,active:true,draft:{userModified:true,body:"Offline edit"}}
      var raw = JSON.stringify(record)
      app.writeComposeRecovery(raw)
      verify(app.composeWriteQueued)
      compare(recoveryBackend.requests.length, 0)
      compare(app.draftSavedNotice, "")

      recoveryBackend.apiVersion = 2
      compare(app.draftSavedNotice, "", "disconnected version metadata alone cannot report a connection")
      recoveryBackend.ready = true
      verify(app.draftSavedNotice.indexOf("Keep this window open") >= 0,
        "connecting an old backend must warn about the pending recovery")
      compare(recoveryBackend.requests.length, 0)
      verify(app.composeWriteQueued)
      compare(app.composeWritePayload, raw)

      recoveryBackend.ready = false
      recoveryBackend.apiVersion = data.api
      recoveryBackend.ready = true
      tryCompare(recoveryBackend.requests, "length", 1)
      lastNativeRequest("compose.recoveryRead").done({record:{active:false},revision:"initial"}, null)
      var saved = lastNativeRequest("compose.recoverySave")
      verify(saved !== null)
      compare(saved.params.record, record)
      verify(app.draftSavedNotice.indexOf("Keep this window open") >= 0,
        "connecting a capable backend does not itself persist the draft")
      saved.done({record:saved.params.record,revision:"durable"}, null)
      compare(app.composeWriteQueued, false)
      compare(app.composeWritePayload, "")
      compare(app.composeRecovery, record)
      compare(app.draftSavedNotice, "")
    }
    function recoveredPending() {
      return {version:1,active:true,returnView:"list",draft:{body:"Recovered queued message",accountId:"me@example.com",pendingSendId:"receipt-one"},parked:[]}
    }
    function test_recovery_update_notice_survives_saved_toast_timeout() {
      app.startCompose("new")
      named(composeView(), "compose-subject-field").text = "Prior saved draft"
      app.saveAndLeaveCompose(true)
      verify(mailService.lastSavedDraft !== null)
      compare(app.draftSavedNotice, "Draft saved")
      var priorRequests = recoveryBackend.requests.length

      recoveryBackend.apiVersion = 2
      recoveryBackend.ready = true
      var record = {version:1,active:true,draft:{userModified:true,body:"Keep this draft"}}
      var raw = JSON.stringify(record)
      app.writeComposeRecovery(raw)
      var warning = app.draftSavedNotice
      verify(warning.indexOf("Keep this window open") >= 0)
      wait(4200)
      compare(app.draftSavedNotice, warning, "the prior save's timer cannot dismiss a recovery warning")
      compare(recoveryBackend.requests.length, priorRequests, "the old connection receives no recovery RPC")
      verify(app.composeWriteQueued)
      compare(app.composeWritePayload, raw)

      recoveryBackend.apiVersion = 3
      tryCompare(recoveryBackend.requests, "length", priorRequests + 1)
      lastNativeRequest("compose.recoveryRead").done({record:{active:false},revision:"initial"}, null)
      var saved = lastNativeRequest("compose.recoverySave")
      verify(saved !== null)
      compare(saved.params.record, record)
      compare(app.draftSavedNotice, warning)
      saved.done({record:saved.params.record,revision:"durable"}, null)
      compare(app.composeWriteQueued, false)
      compare(app.composeWritePayload, "")
      compare(app.draftSavedNotice, "")
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
      compare(field.text, "/review ")
      compare(mailService.agentRequests, 0)
      compare(field.activeFocus, true)
      keyClick(Qt.Key_Backspace)
      compare(field.text, "")
      compare(dock.commandTokens.length, 0)
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
      compare(field.text, "/review ")
      compare(mailService.agentRequests, 0)
      field.clear()
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

    function test_untouched_reply_leaves_without_saving() {
      app.open("{}")
      app.cursorId = "message-1"
      app.runShortcut("reply", "R")
      var compose = composeView()
      verify(compose.opened)
      var request = lastNativeRequest("message.composeText")
      verify(request !== null)
      request.done({body:"My signature\n\n> Original body",quote:"> Original body",replySubject:"Re: Original subject"}, null)
      compare(named(compose, "compose-body-editor").text, "My signature\n\n> Original body")
      mailService.deferDraftSave = true
      app.goBack()
      compare(compose.opened, false, "an untouched prefilled reply leaves immediately")
      compare(mailService.draftSaveCallbacks.length, 0, "prefill is not a user edit")
    }

    function editField(compose, fieldName) {
      var field = named(compose, fieldName)
      field.forceActiveFocus()
      keyClick(Qt.Key_X)
    }

    function test_untouched_forward_hydration_is_not_an_edit() {
      mailService.deferAttachments = true
      mailService.selectedAttachments = [{filename:"original.txt",data:"eA",size:1}]
      app.startCompose("forward")
      var compose = composeView()
      compare(compose.forwardAttachmentsLoading,true)
      wait(0)
      mailService.attachmentCallback([{filename:"original.txt",data:"eA",size:1}],"")
      lastNativeRequest("message.composeText").done({body:"My signature\n> Body",quote:"> Body"},null)
      compare(compose.forwardedAttachments.length, 1)
      compare(compose.userModified, false)
      app.goBack()
      compare(compose.opened, false)
      compare(mailService.lastSavedDraft, null)
    }

    function test_user_actions_prompt_data() {
      return [
        {tag:"sender"}, {tag:"acceptTo"}, {tag:"acceptCc"}, {tag:"acceptBcc"},
        {tag:"contacts"}, {tag:"cc"}, {tag:"bcc"}, {tag:"reply-to"},
        {tag:"attach"}, {tag:"remove"}, {tag:"replaceBody"}, {tag:"insertAtCursor"}
      ]
    }
    function test_user_actions_prompt(data) {
      app.open("{}")
      app.startCompose("new")
      var compose = composeView()
      wait(0)
      if (data.tag === "sender") compose.chooseFrom({email:"alias@example.com"})
      else if (data.tag.indexOf("accept") === 0) compose[data.tag]({email:"contact@example.com",name:"Contact"})
      else if (data.tag === "contacts") named(compose,"compose-contacts-picker").contactChosen({email:"contact@example.com"},"to")
      else if (data.tag === "attach") compose.finishAttach("read", JSON.stringify({ok:true,filename:"notes.txt",data:"eA",size:1}))
      else if (data.tag === "remove") {
        compose.draftAttachments = [{filename:"notes.txt",data:"eA",size:1}]
        compose.removeAttachment(0)
      } else if (data.tag === "replaceBody" || data.tag === "insertAtCursor") compose[data.tag]("AI edit")
      else named(compose,"compose-" + data.tag + "-toggle").clicked()
      compare(compose.userModified, true)
      app.goBack()
      var dialog = named(app,"compose-exit-dialog")
      verify(dialog)
      compare(dialog.opened, true)
      dialog.discard()
      compare(compose.opened, false)
      compare(compose.userModified, false)
      compare(mailService.lastSavedDraft, null)
    }

    function test_exit_dialog_keyboard_data() {
      return [{tag:"save",key:Qt.Key_Tab,tabs:0},
        {tag:"cancel",key:Qt.Key_Tab,tabs:1},
        {tag:"discard",key:Qt.Key_Backtab,tabs:1}]
    }
    function test_exit_dialog_keyboard(data) {
      app.open("{}")
      app.startCompose("new")
      var compose = composeView()
      wait(0)
      editField(compose,"compose-subject-field")
      keyClick(Qt.Key_Escape)
      var dialog = named(app,"compose-exit-dialog")
      verify(dialog)
      tryCompare(dialog,"opened",true)
      wait(0)
      for (var i = 0; i < data.tabs; i++) keyClick(data.key, data.key === Qt.Key_Backtab ? Qt.ShiftModifier : Qt.NoModifier)
      keyClick(Qt.Key_Return)
      tryCompare(dialog,"opened",false)
      compare(compose.opened, data.tag === "cancel")
      compare(mailService.lastSavedDraft !== null, data.tag === "save")
    }

    function test_popup_escape_restores_compose_focus_and_content() {
      app.open("{}")
      app.startCompose("new")
      var compose = composeView()
      wait(0)
      editField(compose,"compose-subject-field")
      var before = compose.snapshotDraft()
      keyClick(Qt.Key_Escape)
      var dialog = named(app,"compose-exit-dialog")
      verify(dialog)
      tryCompare(dialog,"opened",true)
      keyClick(Qt.Key_Escape)
      tryCompare(dialog,"opened",false)
      compare(compose.opened,true)
      compare(compose.snapshotDraft(),before)
      tryCompare(named(compose,"compose-subject-field"),"activeFocus",true)
      compare(mailService.lastSavedDraft,null)
    }

    function test_explicit_save_failure_restores_dirty_snapshot() {
      app.open("{}")
      app.startCompose("new")
      var compose = composeView()
      wait(0)
      editField(compose,"compose-body-editor")
      var before = compose.snapshotDraft()
      mailService.deferDraftSave = true
      app.goBack()
      var dialog = named(app,"compose-exit-dialog")
      verify(dialog)
      dialog.save()
      compare(mailService.draftSaveCallbacks.length,1)
      mailService.finishDraftSave(0,"server refused it")
      compare(compose.opened,true)
      compare(compose.snapshotDraft(),before)
      compare(compose.userModified,true)
      app.goBack()
      compare(dialog.opened,true)
    }

    function test_explicit_save_with_unavailable_service_keeps_draft() {
      app.open("{}")
      app.startCompose("new")
      var compose = composeView()
      wait(0)
      editField(compose,"compose-body-editor")
      var before = compose.snapshotDraft()
      app.goBack()
      try {
        app.service = null
        named(app,"compose-exit-dialog").save()
        compare(compose.opened,true)
        compare(compose.snapshotDraft(),before)
      } finally { app.service = mailService }
    }

    function test_exit_choice_cannot_act_on_a_restored_send_data() {
      return [{tag:"save"},{tag:"discard"},{tag:"cancel"},
        {tag:"saveRequested"},{tag:"discardRequested"}]
    }
    function test_exit_choice_cannot_act_on_a_restored_send(data) {
      app.open("{}")
      app.startCompose("new")
      var compose = composeView()
      named(compose,"compose-to-field").text = "first@example.com"
      named(compose,"compose-subject-field").text = "Queued A"
      wait(0)
      editField(compose,"compose-body-editor")
      var first = compose.snapshotDraft()
      compose.submit()

      app.startCompose("new")
      named(compose,"compose-subject-field").text = "Edited B"
      wait(0)
      editField(compose,"compose-body-editor")
      var second = compose.snapshotDraft()
      app.goBack()
      var dialog = named(app,"compose-exit-dialog")
      compare(dialog.opened,true)
      mailService.deferDraftSave = true
      mailService.replyFailed()
      compare(compose.snapshotDraft(),first,"the failed send restores A")
      compare(dialog.opened,false,"restoring A immediately invalidates B's choice")
      compare(compose.interruptedDraft,second,"B remains held until its save succeeds")
      compare(mailService.draftSaveCallbacks.length,1)
      compare(mailService.lastSavedDraft.subject,"Edited B")

      dialog[data.tag](second.draftKey)
      compare(compose.snapshotDraft(),first,"B's old dialog cannot discard or save A")
      compare(compose.opened,true)
      compare(dialog.opened,false,"replacement invalidates the open choice")
      compare(mailService.draftSaveCallbacks.length,1,"only displaced B is saved")
      mailService.finishDraftSave(0,"server refused it")
      compare(compose.interruptedDraft,second)
      compose.finish()
      compare(compose.snapshotDraft(),second,"B stays reachable through the existing recovery path")
    }

    function test_exit_choice_is_invalidated_by_compose_lifecycle_data() {
      return [{tag:"begin"},{tag:"beginDraft"},{tag:"clear"},{tag:"account"},{tag:"window"}]
    }
    function test_exit_choice_is_invalidated_by_compose_lifecycle(data) {
      app.open("{}")
      app.startCompose("new")
      var compose = composeView()
      wait(0)
      editField(compose,"compose-body-editor")
      app.goBack()
      var dialog = named(app,"compose-exit-dialog")
      compare(dialog.opened,true)
      if (data.tag === "begin") app.startCompose("new")
      else if (data.tag === "beginDraft") compose.beginDraft({subject:"Replacement",body:"Preserve this"})
      else if (data.tag === "clear") compose.clearCurrentDraft(true)
      else if (data.tag === "window") app.close()
      else mailService.activeAccountId = "other@example.com"
      compare(dialog.opened,false)
      var current = compose.snapshotDraft()
      dialog.discard()
      dialog.save()
      dialog.cancel()
      compare(compose.opened,true)
      compare(compose.snapshotDraft(),current)
      compare(mailService.lastSavedDraft,null)
    }

    function test_emptied_provider_draft_can_be_explicitly_saved() {
      app.open("{}")
      var compose = composeView()
      compose.beginDraft({mode:"draft",subject:"Remove me"},"draft-empty",[])
      wait(0)
      var subject = named(compose,"compose-subject-field")
      subject.forceActiveFocus()
      subject.selectAll()
      keyClick(Qt.Key_Backspace)
      app.goBack()
      var dialog = named(app,"compose-exit-dialog")
      verify(dialog)
      compare(dialog.opened,true)
      dialog.save()
      compare(mailService.lastSavedDraft.draftId,"draft-empty")
      compare(mailService.lastSavedDraft.subject,"")
      compare(compose.opened,false)
    }

    function test_dirty_snapshot_restoration_and_fresh_compose_reset() {
      var compose = composeView()
      compose.restoreDraft({subject:"Recovered old format"})
      compare(compose.userModified,true)
      compose.finish()
      app.startCompose("new")
      compare(compose.userModified,false)
      app.goBack()
      compare(compose.opened,false)
      compare(mailService.lastSavedDraft,null)
    }

    function test_bottom_discard_exits_immediately_without_prompt() {
      app.open("{}")
      app.startCompose("new")
      var compose = composeView()
      wait(0)
      editField(compose,"compose-body-editor")
      named(compose,"compose-discard-button").clicked()
      compare(compose.opened,false)
      compare(named(app,"compose-exit-dialog").opened,false)
      compare(mailService.lastSavedDraft,null)
    }

    function test_late_attachment_cannot_modify_the_next_compose() {
      app.open("{}")
      app.startCompose("new")
      var compose = composeView()
      mailService.pluginDir = "/synthetic-plugin"
      recoveryBackend.ready = true
      compose.enqueueAttach("read","/synthetic-attachment")
      var request = lastNativeRequest("attachment.read")
      verify(request !== null)
      compose.finish()
      app.startCompose("new")
      request.done({ok:true,filename:"old-draft.txt",data:"eA",size:1},null)
      compare(compose.draftAttachments.length,0,"a completion belongs to the draft that requested it")
      compare(compose.userModified,false)
      app.goBack()
      compare(compose.opened,false)
      compare(mailService.lastSavedDraft,null)
    }

    function test_late_attachment_helper_results_stay_with_their_draft_data() {
      return [
        {tag:"picker",mode:"pick",result:{ok:true,paths:["/synthetic-old-file"]}},
        {tag:"clipboard-files",mode:"clipboard",result:{ok:true,paths:["/synthetic-old-file"]}},
        {tag:"clipboard-text",mode:"clipboard",result:{ok:false,error:"no-image"}},
        {tag:"clipboard-image",mode:"clipboard",result:{ok:true,path:"/synthetic-old-image",data:"eA",filename:"old.png",size:1}}
      ]
    }
    function test_late_attachment_helper_results_stay_with_their_draft(data) {
      app.startCompose("new")
      var compose = composeView()
      var owner = compose.draftKey
      compose.finish()
      app.startCompose("new")
      recoveryBackend.ready = true
      mailService.pluginDir = "/synthetic-plugin"
      compose.pasteInFlight = true
      compose.finishAttach(data.mode,JSON.stringify(data.result),owner)
      compare(compose.draftAttachments.length,0)
      compare(compose.userModified,false)
      compare(compose.pasteInFlight,true,"an old clipboard answer cannot finish the next draft's paste")
      compare(lastNativeRequest("attachment.read"),null)
      if (data.tag === "clipboard-image") {
        verify(lastNativeRequest("attachment.forget") !== null)
        compare(lastNativeRequest("attachment.forget").params.path,"/synthetic-old-image")
        lastNativeRequest("attachment.forget").done({ok:true},null)
      }
    }

    function test_modified_fields_prompt_data() {
      return [
        {tag:"to",field:"compose-to-field"},
        {tag:"cc",field:"compose-cc-field"},
        {tag:"bcc",field:"compose-bcc-field"},
        {tag:"replyTo",field:"compose-reply-to-field"},
        {tag:"subject",field:"compose-subject-field"},
        {tag:"body",field:"compose-body-editor"}
      ]
    }
    function test_modified_fields_prompt(data) {
      app.open("{}")
      app.startCompose("new")
      var compose = composeView()
      compose.ccVisible = true
      compose.bccVisible = true
      compose.replyToVisible = true
      wait(0)
      editField(compose, data.field)
      compare(compose.userModified, true)
      app.goBack()
      compare(compose.opened, true)
      var dialog = named(app, "compose-exit-dialog")
      verify(dialog)
      compare(dialog.opened, true)
      compare(mailService.lastSavedDraft, null)
      dialog.cancel()
      compare(compose.opened, true)
    }

    function test_escape_prompts_then_explicit_save_closes_it() {
      var compose = composeView()
      app.open("{}")
      app.startCompose("new")
      named(compose, "compose-subject-field").text = "Quarterly plan"
      named(compose, "compose-body-editor").text = "First draft"
      wait(0)
      editField(compose, "compose-subject-field")

      app.goBack()
      compare(compose.opened, true)
      var dialog = named(app, "compose-exit-dialog")
      verify(dialog)
      compare(dialog.opened, true)
      dialog.save()

      verify(mailService.lastSavedDraft,
        "Escape must hand the composition to the provider's Drafts storage")
      compare(mailService.lastSavedDraft.subject, "Quarterly planx")
      compare(mailService.lastSavedDraft.body, "First draft")
      compare(app.composing, false)
      compare(app.draftSavedNotice, "Draft saved")
    }

    function test_an_older_save_cannot_clear_a_newer_drafts_recovery() {
      var compose = composeView()
      mailService.deferDraftSave = true

      app.startCompose("new")
      named(compose, "compose-body-editor").text = "First draft"
      app.saveAndLeaveCompose()

      app.startCompose("new")
      named(compose, "compose-body-editor").text = "Second draft"
      app.saveAndLeaveCompose()
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
      app.saveAndLeaveCompose()
      app.startCompose("new")
      named(compose, "compose-body-editor").text = "Second draft"
      app.saveAndLeaveCompose()

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

      app.goBack()
      compare(compose.opened, false)
      compare(mailService.lastSavedDraft, null, "an unchanged provider draft is not rewritten")
      compose.beginDraft({mode:"draft", subject:"Saved subject", body:"Saved body"}, "draft-7", [])
      named(compose, "compose-subject-field").text = "Updated subject"
      compose.noteUserModified()
      app.goBack()
      named(app, "compose-exit-dialog").save()

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
