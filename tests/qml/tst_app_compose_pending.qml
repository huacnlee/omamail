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
    property bool failDraftSave: false
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
      callback(failDraftSave ? null : "draft-1",
        failDraftSave ? "server refused it" : "")
    }
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
      mailService.sendPending = false
      mailService.sending = false
      mailService.lastSavedDraft = null
      mailService.failDraftSave = false
      mailService.lastError = ""
      mailService.actionStatus = ""
      var compose = composeView()
      if (compose) {
        compose.reset()
        compose.opened = false
      }
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
  }
}
