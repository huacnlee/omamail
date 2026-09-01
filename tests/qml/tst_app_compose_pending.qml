import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

Item {
  width: 900
  height: 600

  QtObject {
    id: mailService

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
    function undoSend() {
      if (!sendPending) return false
      sendPending = false
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
      app.opened = false
      app.loadComposeRecovery("")
      app.clearComposeRecovery()
      mailService.sendPending = false
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
      app.currentView = "list"
      app.cursorId = ""
      var compose = composeView()
      if (compose) {
        compose.reset()
        compose.opened = false
      }
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

    function test_open_previews_a_draft_and_compose_edits_it() {
      var compose = composeView()
      mailService.mailboxKey = "drafts"
      app.cursorId = "draft-7"

      app.runShortcut("open", "o")

      compare(mailService.selectedId, "draft-7")
      compare(app.currentView, "reader",
        "a draft opens in the same reader as every other message")
      compare(app.composing, false)

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

      compare(app.composing, false,
        "loading the draft body must not turn the preview into an editor")

      app.runShortcut("compose", "c")
      wait(30)

      compare(app.composing, true)
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
  }
}
