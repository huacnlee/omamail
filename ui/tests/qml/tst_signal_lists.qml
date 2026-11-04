import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture
import "../../account/Accounts.js" as Accounts

// Lists that reach their reader through a QML signal. Qt 6.12 hands a `var`
// signal argument over as a sequence or a reference object, which
// `Array.isArray` refuses, so each of these read its list as empty. Every test
// emits through the app's own signal: the backend's `notification` (fed a
// line, as the process would), the reader's `addressMenuRequested`, and the
// agent runner's `jobFinished`.
Item {
  width: 900
  height: 600

  QtObject {
    id: shellStore
    function updateEntryInline(_id, _entry) {}
    function hide(_id) {}
  }

  QtObject {
    id: record
    property var renames: []
    property var deletes: []
    property var creates: []
    property var listing: ({})
    property string listingError: ""
    property int inFlight: 0
    property int mostInFlight: 0
    property int counted: 0
    function reset() { renames = []; deletes = []; creates = []; listing = {}; listingError = ""; inFlight = 0; mostInFlight = 0; counted = 0 }
  }

  Component {
    id: controlledClient
    QtObject {
      property var auth: null
      property string email: ""
      function handle() { return ({ aborted: false }) }
      function later(fn) { Qt.callLater(fn); return handle() }
      function listMessages() { return handle() }
      function getMessages() { return handle() }
      function getMessage() { return handle() }
      function trashMessage() { return handle() }
      function untrashMessage() { return handle() }
      function batchModify() { return handle() }
      function modifyMessage() { return handle() }
      function getLabels(callback) {
        var mine = record.listing[email] || []
        var refused = record.listingError
        record.listingError = ""
        return later(function() { callback(refused !== "" ? [] : mine, refused) })
      }
      function getLabelCounts(id, callback) {
        record.inFlight++
        if (record.inFlight > record.mostInFlight) record.mostInFlight = record.inFlight
        return later(function() {
          record.inFlight--
          record.counted++
          callback({ id: id, unread: 1, total: 1, threadsUnread: 1 }, "")
        })
      }
      function getProfile(callback) { return later(function() { callback({ email: email }, "") }) }
      function getSendAs(callback) { return later(function() { callback([], "") }) }
      function getAttachment() { return handle() }
      function saveDraft() { return handle() }
      function deleteDraft() { return handle() }
      function sendMessage() { return handle() }
      function createLabel(name, callback) {
        record.creates = record.creates.concat([email + ":" + name])
        return later(function() { callback(null, "") })
      }
      function renameLabel(id, name, callback) {
        record.renames = record.renames.concat([email + ":" + id + ">" + name])
        return later(function() { callback(null, "") })
      }
      function deleteLabel(id, callback) {
        record.deletes = record.deletes.concat([email + ":" + id])
        return later(function() { callback(null, "") })
      }
      function abortRequest(h) { if (h) h.aborted = true }
    }
  }

  Omamail.Service {
    id: mailService
    shell: shellStore
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  Omamail.App { id: app; service: mailService }

  TestCase {
    name: "SignalLists"
    when: windowShown
    property var listener

    function initTestCase() { listener = BackendFixture.markReady(mailService) }

    // A send one test left behind must not answer for the next.
    function cleanup() {
      var account = mailService.accountAt(0)
      if (account) {
        account.sendQueue.parked = []
        account.sendQueue.submitted = ({})
        account.sendQueue.revision = -1
      }
      var compose = composeView()
      if (compose) compose.reset()
      app.clearComposeRecovery()
    }

    function seed() {
      var list = Accounts.add(Accounts.emptyList(), {
        email: "ada@example.com", provider: "imap", clientId: "", clientSecret: "",
        imap: { imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 465,
          username: "ada@example.com", aliases: [], insecure: false },
        label: "", signature: "", monitored: [] })
      mailService.activeIndex = -1
      mailService.accountList = Accounts.setActive(list, "imap:ada@example.com")
      mailService.accountsLoaded = true
      wait(0)
      mailService.refreshCurrent()
      var account = mailService.accountAt(0)
      account.clientOverride = controlledClient
      account.auth.toolsChecked = true
      account.auth.missingTools = []
      account.auth.passwordChecked = true
      account.auth.password = "test-password"
      tryCompare(account, "ready", true)
      account.api.email = "ada@example.com"
      return account
    }

    // One line from the backend process, the way `Process` hands it over.
    function notify(method, params) {
      mailService.backend.receive(JSON.stringify({ jsonrpc: "2.0", method: method, params: params }))
    }

    function find(item, test) {
      if (item && test(item)) return item
      var kids = item ? (item.children || []) : []
      for (var i = 0; i < kids.length; i++) { var found = find(kids[i], test); if (found) return found }
      return null
    }

    function composeView() {
      var item = find(app, function(candidate) { return candidate.objectName === "compose-to-field" })
      while (item && typeof item.resumePendingSend !== "function") item = item.parent
      return item
    }

    function field(name) {
      return find(composeView(), function(candidate) { return candidate.objectName === name })
    }

    // A message the backend could not send comes back: the parked draft opens
    // again with its words, and the account says what happened.
    function test_a_failed_send_reopens_its_draft() {
      var account = seed()
      mailService.applySettings({ undoSendSeconds: 10 })
      app.opened = false
      app.loadComposeRecovery("")
      app.clearComposeRecovery()
      app.resetNavigation()
      var compose = composeView()
      verify(compose !== null)
      compose.reset()
      compose.opened = false
      var before = listener.requests.length
      app.startCompose("new")
      field("compose-to-field").text = "person@example.com"
      field("compose-body-editor").text = "Keep these words"
      compose.submit()
      tryCompare(compose, "parkedForSend", true)
      var enqueue = null
      tryVerify(function() {
        var asked = listener.requests.slice(before).filter(function(r) { return r.method === "outbox.enqueue" })
        enqueue = asked.length ? asked[0] : null
        return enqueue !== null
      }, 1000, "the message goes to the outbox")
      var now = Date.now()
      var entry = { id: enqueue.params.sendId, state: "queued", order: enqueue.params.order, queuedAt: now, dueAt: now + 10000 }
      BackendFixture.respond(mailService, enqueue, { snapshot: { accountId: account.accountId, revision: 2000, entries: [entry] } })
      tryCompare(account, "sendPendingCount", 1)
      compare(compose.opened, false, "the draft is parked while it waits")

      entry.state = "failed"
      notify("outbox.changed", { accountId: account.accountId, revision: 2001, entries: [entry] })
      tryCompare(compose, "opened", true, 1000, "the failed message's draft opens again")
      compare(compose.parkedForSend, false)
      compare(field("compose-body-editor").text, "Keep these words")
      compare(account.lastError, "The message could not be sent. Your draft has been kept.")
    }

    // The outbox says what it holds: a queued message is waiting, and a sent
    // one is reported as sent.
    function test_the_outbox_reaches_the_send_queue() {
      var account = seed()
      var now = Date.now()
      notify("outbox.changed", { accountId: account.accountId, revision: 1000, entries: [
        { id: "send-1", state: "queued", order: 1, queuedAt: now, dueAt: now + 60000 }] })
      tryCompare(account, "sendPendingCount", 1, 1000, "the queued message is waiting")
      notify("outbox.changed", { accountId: account.accountId, revision: 1001, entries: [
        { id: "send-1", state: "sent", order: 1, queuedAt: now, dueAt: now, result: {} }] })
      tryCompare(account, "sendPendingCount", 0)
      compare(account.actionStatus, "Sent")
    }

    // A background check's unread messages reach the bar's preview.
    function test_a_mail_update_prepares_its_messages() {
      var account = seed()
      var info = mailService.backend.protocolInfo
      mailService.backend.protocolInfo = { apiVersion: info.apiVersion, protocol: info.protocol, version: info.version,
        methods: ["mail.watch"] }
      tryCompare(account, "nativePolling", true)
      var before = listener.requests.length
      notify("mail.updated", { accountId: account.accountId, sequence: 1e12, estimate: 1, fingerprint: "one", error: "",
        messages: [{ id: "unread-1", threadId: "unread-1", labelIds: ["INBOX", "UNREAD"], snippet: "Hello",
          payload: { headers: [{ name: "Subject", value: "Hello" }] } }] })
      var asked = []
      tryVerify(function() {
        asked = listener.requests.slice(before).filter(function(r) { return r.method === "message.summaries" })
        return asked.length === 1
      }, 1000, "the update's messages are sent to be summarised")
      compare(asked[0].params.messages.length, 1)
      compare(asked[0].params.messages[0].id, "unread-1")
      tryVerify(function() {
        return mailService.barMessages.some(function(message) { return message.id === "unread-1" })
      }, 1000, "and the bar previews it")
      compare(account.previewMessages.length, 1)
    }

    // Clicking a sender opens a menu of the addresses.
    function test_the_address_menu_lists_the_addresses() {
      seed()
      var reader = find(app, function(item) { return typeof item.addressMenuRequested === "function" && item.summary !== undefined })
      var menu = find(app, function(item) { return item.objectName === "address-menu" })
      verify(reader !== null && menu !== null)
      reader.addressMenuRequested([{ name: "Bob", email: "bob@example.com" }, { name: "Cy", email: "cy@example.com" }], 20, 20)
      compare(menu.addresses.length, 2)
      tryCompare(menu, "opened", true)
      menu.close()
    }

    // A look for events that found some says how many.
    function test_the_agent_says_how_many_events_it_found() {
      var account = seed()
      account.note("")
      mailService.agentRunner.jobFinished({ kind: "events", state: "done", subject: "Lunch",
        accountId: account.accountId, events: [{ title: "Lunch" }, { title: "Dinner" }] })
      compare(account.actionStatus, "The agent found 2 events in “Lunch”")
    }
  }
}
