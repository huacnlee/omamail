import QtQuick
import QtTest
import "../../account" as Accounts
import "../../backend" as BackendModule

Item {
  Component {
    id: backendFactory
    BackendModule.Backend {
      executable: "/synthetic/runtime/bin/omamail"
      expectedVersion: "0.8.2"
      expectedApiVersion: 1
      launchEnabled: false
    }
  }
  Component {
    id: clientFactory
    QtObject {
      property int calls: 0
      function getProfile(done) {
        calls++
        Qt.callLater(function() { done({ email: "ada@example.org" }, null) })
      }
      function getLabels(done) {
        calls++
        Qt.callLater(function() { done([{ id: "INBOX", name: "Inbox" }], null) })
      }
      function getSendAs(done) {
        calls++
        Qt.callLater(function() { done([{ email: "alias@example.org" }], null) })
      }
      function listMessages(_query, _limit, _token, done) {
        calls++
        Qt.callLater(function() { done({ ids: [], estimate: 0, nextPageToken: "" }, null) })
        return { aborted: false }
      }
      function abortRequest(handle) { if (handle) handle.aborted = true }
    }
  }
  Component {
    id: accountFactory
    Accounts.MailAccount {
      pluginDir: "/synthetic/plugin"
      providerId: "imap"
      configuredEmail: "ada@example.org"
      imapSettings: ({ imapHost: "imap.example.org", imapPort: 993,
        smtpHost: "smtp.example.org", smtpPort: 465, username: "ada@example.org" })
      clientOverride: clientFactory
      active: true
      windowOpen: true
    }
  }
  TestCase {
    name: "AccountBackendReadiness"
    function test_authenticated_account_initializes_after_handshake_without_reopening() {
      var backend = createTemporaryObject(backendFactory, parent)
      var account = createTemporaryObject(accountFactory, parent, { backend: backend })
      verify(account !== null)
      account.auth.toolsChecked = true
      account.auth.missingTools = []
      account.auth.passwordChecked = true
      account.auth.password = "synthetic-password"
      compare(account.setupState, "ready")
      compare(account.api.calls, 0, "metadata and listing must wait for validation")
      compare(account.ready, false)

      backend.launchEnabled = true
      wait(0)
      var process = null
      for (var i = 0; i < backend.children.length; i++) {
        var child = backend.children[i]
        if (child.command && child.command[1] === "serve") process = child
      }
      verify(process !== null)
      process.started()
      compare(account.api.calls, 0, "launch alone is not a handshake")
      var request = JSON.parse(process.written.trim())
      process.stdout.read(JSON.stringify({ jsonrpc: "2.0", id: request.id,
        result: { apiVersion: 1, protocol: 1, version: "0.8.2" } }))
      tryCompare(account, "ready", true)
      tryCompare(account, "listLoaded", true)
      compare(account.profile.email, "ada@example.org")
      compare(account.labels[0].id, "INBOX")
      compare(account.sendAsAliases[0].email, "alias@example.org")
      compare(account.sendAsLoaded, true)
      compare(account.windowOpen, true)
    }
  }
}
