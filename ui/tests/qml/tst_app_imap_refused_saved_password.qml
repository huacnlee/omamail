import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture

// A saved password the server has started refusing takes the mailbox back to
// Connect the mailbox.
//
// One IMAP mailbox, restored from the keyring with a password the server now
// refuses at LOGIN. What the user saw was a mailbox that still counted as
// signed in: the list stayed, the status bar said to sign in again, and the
// setup page offered no way to. This runs the real window, service and host
// over the stubbed transport, from the refusal to a new password connecting.
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
    name: "AppImapRefusedSavedPassword"
    when: windowShown

    property var fixture: null
    property bool refusing: true
    // Requests made with the saved password, which the backend reads from the
    // keyring: they name the account and carry no credential.
    property var withSaved: []
    property var verified: null
    readonly property string imapId: "imap:shawn@example.test"
    readonly property var empty: ({folders: [], special: {}, capabilities: [], labels: []})

    function savedPasswordRequest(params, request) {
      if (params.credential !== undefined) return false
      withSaved = withSaved.concat([request.method])
      if (!refusing) return false
      BackendFixture.respond(mailService, request, undefined, {code: -32000, message: "mail_auth_failed"})
      return true
    }

    function initTestCase() {
      fixture = BackendFixture.markReady(mailService, 4)
      fixture.answers = {
        "credentials.get": {found: true, secret: "old-password"},
        "credentials.put": {stored: true},
        "credentials.delete": {deleted: true},
        "imap.folders": function(params, request) {
          if (savedPasswordRequest(params, request)) return undefined
          if (params.credential !== undefined) { verified = request; return undefined }
          return empty
        },
        "imap.list": function(params, request) {
          if (savedPasswordRequest(params, request)) return undefined
          return {page: {ids: [], estimate: 0, nextPageToken: ""}, messages: []}
        },
        "imap.count": function(params, request) {
          if (savedPasswordRequest(params, request)) return undefined
          return {count: 0}
        }
      }
    }

    function test_a_refused_saved_password_goes_back_to_connect_the_mailbox() {
      app.opened = true
      mailService.accountsLoaded = true
      mailService.accountList = ({ version: 1, accounts: [
        { id: imapId, email: "shawn@example.test", provider: "imap",
          imap: { imapHost: "imap.example.test", imapPort: 993, smtpHost: "smtp.example.test",
            smtpPort: 465, username: "shawn@example.test", aliases: [], insecure: false } } ],
        activeId: imapId })
      var imap = null
      tryVerify(function() { imap = mailService.findAccount(imapId); return !!imap }, 2000)

      tryVerify(function() { return withSaved.length > 0 }, 2000, "the saved password is used")
      tryCompare(imap, "setupState", "signed_out")
      compare(app.anyReady, false)
      tryCompare(app, "page", "setup")
      waitForRendering(app)
      tryCompare(findChild(app, "imap-error"), "text", "The server refused the saved password. Enter it again")
      var connect = findChild(app, "imap-connect-button")
      verify(connect.visible, "Connect the mailbox, not Save changes")
      verify(!findChild(app, "imap-save-button").visible)
      verify(!fixture.requests.some(function(request) { return request.method === "credentials.delete" }),
        "the keyring item stays")

      refusing = false
      findChild(app, "imap-password-field").text = "new-password"
      connect.clicked()
      tryVerify(function() { return verified !== null }, 1000, "the new password is verified")
      compare(verified.params.credential, "shawn@example.test:new-password")
      BackendFixture.respond(mailService, verified, empty)
      tryVerify(function() {
        return fixture.requests.some(function(request) {
          return request.method === "credentials.put" && request.params.secret === "new-password"
        })
      }, 1000, "and stored over the refused one")
      tryCompare(imap, "setupState", "ready")
    }
  }
}
