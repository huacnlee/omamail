import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture

// Save changes with a replacement password keeps the setup page open.
//
// One IMAP mailbox, signed in with a password the server now refuses. Settings,
// Edit, a new password, Save changes, and the server refuses that one too. The
// refusal has to be read where it was typed. What the user saw instead was the
// window rebuilding its root while the password was checked and again when the
// answer came, landing on the list with the error only in the status bar — so
// this runs the real window, service and host over the stubbed transport.
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
    name: "AppImapPasswordReplacement"
    when: windowShown

    property var fixture: null
    // The verification of a typed password: it carries the credential, which
    // a request on the saved one does not.
    property var held: null
    readonly property string imapId: "imap:shawn@example.test"

    function initTestCase() {
      fixture = BackendFixture.markReady(mailService, 4)
      fixture.answers = {
        "credentials.get": {found: true, secret: "old-password"},
        "credentials.put": {stored: true},
        "credentials.delete": {deleted: true},
        "imap.folders": function(params, request) {
          if (params.credential) { held = request; return undefined }
          return {folders: [], special: {}, capabilities: [], labels: []}
        }
      }
    }

    // The sentence follows the RFC 5530 code the backend read off the
    // refusal: an outage and an expired password each get their own, instead
    // of both reading as a wrong password.
    function test_a_refused_replacement_is_shown_on_the_page_that_typed_it_data() {
      return [
        {tag: "refused", code: "mail_auth_failed",
          text: "The server rejected the sign-in. Sign in again."},
        {tag: "unavailable", code: "mail_auth_unavailable",
          text: "The server could not check the sign-in right now. Wait a few minutes, then sign in again."},
        {tag: "expired", code: "mail_auth_expired",
          text: "The server says this password has expired. Create a new password or app password, then sign in again."},
        {tag: "contact admin", code: "mail_auth_contact_admin",
          text: "The server refused the sign-in and asks you to contact your mail administrator."}
      ]
    }

    function test_a_refused_replacement_is_shown_on_the_page_that_typed_it(data) {
      held = null
      app.opened = true
      mailService.accountsLoaded = true
      mailService.accountList = ({ version: 1, accounts: [
        { id: imapId, email: "shawn@example.test", provider: "imap",
          imap: { imapHost: "imap.example.test", imapPort: 993, smtpHost: "smtp.example.test",
            smtpPort: 465, username: "shawn@example.test", aliases: [], insecure: false } } ],
        activeId: imapId })
      var imap = null
      tryVerify(function() { imap = mailService.findAccount(imapId); return !!imap && imap.ready }, 2000)
      tryCompare(app, "anyReady", true)
      app.resetNavigation()
      app.openSettings()
      app.editAccount(0)
      compare(app.page, "setup")
      waitForRendering(app)

      var page = findChild(app, "setup-page").item
      var password = findChild(app, "imap-password-field")
      password.text = "wrong-password"
      findChild(app, "imap-save-button").clicked()
      tryVerify(function() { return held !== null }, 1000, "the replacement is verified")
      compare(held.params.credential, "shawn@example.test:wrong-password")

      compare(imap.setupState, "ready", "the mailbox stays in service while it is checked")
      compare(app.page, "setup")
      verify(findChild(app, "setup-page").item === page, "and the page is the same one")

      BackendFixture.respond(mailService, held, undefined, {code: -32000, message: data.code})
      tryCompare(findChild(app, "imap-error"), "text", data.text)
      compare(app.page, "setup", "the refusal is read where it was typed")
      compare(findChild(app, "imap-password-field").text, "wrong-password", "and the field keeps it")
      verify(!fixture.requests.some(function(request) { return request.method === "credentials.put" }),
        "nothing refused is stored")
    }
  }
}
