import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture

// A saved password the server starts refusing while the mailbox is in use.
//
// One IMAP mailbox, signed in and polled by the backend's watch, which reads
// the keyring for itself. Then the server stops accepting the password. The
// first sign of it is a background update that failed, and from then on the
// watch would send the refused password on every check. This runs the real
// window, service and host over the stubbed transport.
Item {
  width: 900
  height: 600

  QtObject {
    id: fakeShell
    function hide(_id) {}
  }

  Omamail.Service {
    id: mailService
    shell: fakeShell
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  Omamail.App {
    id: app
    service: mailService
    shell: fakeShell
  }

  TestCase {
    name: "AppImapRefusedInBackground"
    when: windowShown

    property var fixture: null
    property bool refusing: false
    readonly property string imapId: "imap:shawn@example.test"
    readonly property var empty: ({folders: [], special: {}, capabilities: [], labels: []})

    function refused(params, request) {
      if (!refusing || params.credential !== undefined) return false
      BackendFixture.respond(mailService, request, undefined, {code: -32000, message: "mail_auth_failed"})
      return true
    }

    function initTestCase() {
      fixture = BackendFixture.markReady(mailService, 4)
      var info = mailService.backend.protocolInfo
      mailService.backend.protocolInfo = { apiVersion: info.apiVersion, protocol: info.protocol,
        version: info.version, methods: ["mail.watch"] }
      fixture.answers = {
        "credentials.get": {found: true, secret: "old-password"},
        "credentials.delete": {deleted: true},
        "mail.watch": function(params) {
          return {accountId: params.accountId, sequence: 1, estimate: 0, fingerprint: "", error: "", messages: []}
        },
        "mail.unwatch": {unwatched: true},
        "imap.folders": function(params, request) { return refused(params, request) ? undefined : empty },
        "imap.list": function(params, request) {
          return refused(params, request) ? undefined : {page: {ids: [], estimate: 0, nextPageToken: ""}, messages: []}
        },
        "imap.count": function(params, request) { return refused(params, request) ? undefined : {count: 0} }
      }
    }

    function sent(method) {
      return fixture.requests.filter(function(request) { return request.method === method })
    }

    function test_a_refusal_in_the_background_goes_back_to_connect_the_mailbox() {
      app.opened = true
      mailService.accountsLoaded = true
      mailService.accountList = ({ version: 1, accounts: [
        { id: imapId, email: "shawn@example.test", provider: "imap",
          imap: { imapHost: "imap.example.test", imapPort: 993, smtpHost: "smtp.example.test",
            smtpPort: 465, username: "shawn@example.test", aliases: [], insecure: false } } ],
        activeId: imapId })
      var imap = null
      tryVerify(function() { imap = mailService.findAccount(imapId); return !!imap && imap.ready }, 2000)
      tryVerify(function() { return sent("mail.watch").length === 1 }, 2000, "the backend watches the mailbox")
      wait(100)

      var folders = sent("imap.folders").length
      mailService.backend.receive(JSON.stringify({jsonrpc: "2.0", method: "mail.updated",
        params: {accountId: imapId, sequence: 2, estimate: 0, fingerprint: "", error: "request_timed_out", messages: []}}))
      wait(100)
      compare(sent("imap.folders").length, folders, "a check that timed out refused nothing")
      verify(imap.ready)

      refusing = true
      mailService.backend.receive(JSON.stringify({jsonrpc: "2.0", method: "mail.updated",
        params: {accountId: imapId, sequence: 3, estimate: 0, fingerprint: "", error: "mail_auth_failed", messages: []}}))
      tryVerify(function() { return sent("imap.folders").length === folders + 1 }, 1000,
        "the refusal is checked once with the saved password")
      tryCompare(imap, "setupState", "signed_out")
      tryVerify(function() {
        return sent("mail.unwatch").some(function(request) { return request.params.accountId === imapId })
      }, 1000, "and the watch stops sending it")
      tryCompare(app, "page", "setup")
      tryCompare(findChild(app, "imap-error"), "text", "The server refused the saved password. Enter it again")
      verify(findChild(app, "imap-connect-button").visible)
      compare(sent("credentials.delete").length, 0, "the keyring item stays")
    }
  }
}
