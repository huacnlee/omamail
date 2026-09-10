import QtQuick 2.15
import QtTest 1.3
import "../../account" as Account

// The read-on-open path belongs to MailAccount, not only to the model helper:
// this test drives the real detail callback and records whether it dispatches
// an automatic provider mutation.
Item {
  width: 400
  height: 300

  QtObject {
    id: record
    property var modified: []

    function reset() { modified = [] }
  }

  Component {
    id: client

    QtObject {
      property var refusals: ({})
      property var absentMailboxes: []
      property string email: "ada@example.org"

      function handle() { return ({ aborted: false }) }

      function getMessage(id, full, callback) {
        callback({
          id: String(id),
          labelIds: ["INBOX", "UNREAD"],
          payload: {
            mimeType: "text/plain",
            body: ({ data: "Qm9keQ" }),
            headers: [
              { name: "From", value: "Ada <ada@example.org>" },
              { name: "Subject", value: "A message" },
              { name: "Date", value: "Mon, 01 Sep 2026 00:00:00 +0000" }
            ]
          }
        }, "")
        return handle()
      }

      function modifyMessage(id, add, remove, callback) {
        record.modified = record.modified.concat([String(id)])
        if (typeof callback === "function") callback({}, "")
        return handle()
      }

      function listMessages() { return handle() }
      function getMessages() { return handle() }
      function getLabels(callback) {
        if (typeof callback === "function") callback([], "")
        return handle()
      }
      function getProfile(callback) {
        if (typeof callback === "function") callback({ email: email }, "")
        return handle()
      }
      function getSendAs(callback) {
        if (typeof callback === "function") callback([], "")
        return handle()
      }
      function getAttachment() { return handle() }
      function abortRequest(handle) { if (handle) handle.aborted = true }
    }
  }

  Account.MailAccount {
    id: account
    pluginDir: "/tmp/omamail-manual-read-test"
    accountId: "ada@example.org"
    configuredEmail: "ada@example.org"
    providerId: "gmail"
    clientOverride: client
    active: false
    windowOpen: false
    settings: ({ markReadAutomatically: false })
  }

  TestCase {
    name: "ManualRead"
    when: windowShown

    function row() {
      return {
        id: "m1", subject: "A message", unread: true, starred: false,
        inInbox: true, labelIds: ["INBOX", "UNREAD"]
      }
    }

    function init() {
      record.reset()
      account.messages = [row()]
      account.previewMessages = []
      account.listLoaded = true
      account.listLoading = false
      account.settings = ({ markReadAutomatically: false })
      account.auth.credentials = ({
        clientId: "123-test.apps.googleusercontent.com",
        clientSecret: "synthetic",
        projectId: "test"
      })
      account.auth.toolsChecked = true
      account.auth.missingTools = []
      account.auth.loggedIn = true
      account.auth.refreshBusy = true
    }

    function ready() {
      tryVerify(function() { return account.ready }, 2000,
        "the test mailbox is ready")
      tryVerify(function() { return account.api !== null }, 2000,
        "the test client is loaded")
    }

    function test_opening_does_not_mark_read_in_manual_mode() {
      ready()
      account.select("m1", false)
      tryVerify(function() { return account.detailPainted }, 1000,
        "the message detail arrived")
      compare(record.modified.length, 0,
        "opening does not dispatch a read mutation")
    }

    function test_explicit_mark_read_still_dispatches() {
      ready()
      verify(account.act("m1", "markRead"), "the explicit action is accepted")
      compare(record.modified, ["m1"],
        "manual mark-read still reaches the provider")
    }
  }
}
