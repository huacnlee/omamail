import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture

// The shared Gmail OAuth client section in Settings ("Shared by every
// mailbox above") opens the same setup page regardless of which mailbox is
// on screen. With one IMAP mailbox saved and no Gmail one yet, clicking
// "Set up..." left the active account exactly where it was — the IMAP row —
// so the page's `service.auth` bound to that row's ImapAuth. ImapAuth has no
// `saveCredentials`, and calling it threw the moment the OAuth client form
// was saved: no browser opened, no error shown, nothing happened. This runs
// the real window, service and account hosts over the stubbed transport, the
// way `tst_app_edit_connect.qml` does, so the fix is checked against the
// real per-provider auth objects rather than a stand-in.
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
    name: "AppClientSetupWrongAccount"
    when: windowShown

    function initTestCase() {
      var fixture = BackendFixture.markReady(mailService, 4)
      fixture.answers = {
        "credentials.get": {found:true,secret:"hunter2"},
        "credentials.put": {stored:true},
        "credentials.delete": {deleted:true}
      }
    }

    readonly property string imapId: "imap:shawn@example.test"
    readonly property string gmailId: "ada@example.test"

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

    function init() {
      app.opened = true
      mailService.accountList = ({ version: 1, accounts: [], activeId: "" })
      wait(0)
    }

    function cleanup() {
      mailService.accountList = ({ version: 1, accounts: [], activeId: "" })
      wait(0)
    }

    function test_client_setup_switches_off_a_non_gmail_active_account() {
      mailService.accountsLoaded = true
      mailService.accountList = ({
        version: 1,
        accounts: [
          { id: imapId, email: "shawn@example.test", provider: "imap",
            imap: { imapHost: "imap.example.test", imapPort: 993,
              smtpHost: "smtp.example.test", smtpPort: 465,
              username: "shawn@example.test", aliases: [], insecure: false } }
        ],
        activeId: imapId
      })
      tryCompare(mailService, "accountCount", 1)
      var imap = mailService.findAccount(imapId)
      verify(!!imap, "the service builds a host for the IMAP row")
      tryVerify(function() { return !!imap.auth }, 1000, "with its ImapAuth ready")
      tryCompare(mailService, "current", imap)
      tryCompare(app, "anyReady", true)
      app.resetNavigation()
      waitForRendering(app)
      compare(app.page, "list")

      // The user opens Settings and presses "Set up..." on the shared Google
      // OAuth client section, without ever selecting a Gmail mailbox first —
      // there is not one yet.
      app.openSettings()
      compare(app.page, "settings")
      app.openClientSetup()
      waitForRendering(app)

      compare(app.page, "setup", "the OAuth client form opens")
      compare(app.editingProvider, "gmail")
      verify(mailService.current !== imap,
        "the active account moved off the IMAP row onto a Gmail one")
      verify(!!mailService.current && mailService.current.providerId === "gmail",
        "so the page's service.auth is a Gmail auth handler")

      tryVerify(function() { return !!mailService.auth }, 1000,
        "the auth object the setup page reads is ready")
      compare(typeof mailService.auth.saveCredentials, "function",
        "and it is the Gmail handler's, not ImapAuth's — this is what threw before the fix")

      var page = named(app, "setup-page").item
      verify(!!page, "the Gmail setup page is showing")

      // The IMAP mailbox is untouched: still there, still the one it was.
      // Adding the Gmail row grew the account list, which the Instantiator's
      // count-based model may answer with a fresh delegate rather than the
      // one `imap` was captured from — so this asks the service again rather
      // than trusting that earlier reference is still the live one.
      compare(mailService.accountList.accounts[0].id, imapId)
      var imapNow = mailService.findAccount(imapId)
      verify(!!imapNow && !!imapNow.auth, "the IMAP host still exists and still has its auth")
      verify(imapNow.auth.loginBusy === false, "and its own sign-in was never disturbed")
    }

    function test_client_setup_uses_an_existing_gmail_account() {
      mailService.accountsLoaded = true
      mailService.accountList = ({
        version: 1,
        accounts: [
          { id: imapId, email: "shawn@example.test", provider: "imap",
            imap: { imapHost: "imap.example.test", imapPort: 993,
              smtpHost: "smtp.example.test", smtpPort: 465,
              username: "shawn@example.test", aliases: [], insecure: false } },
          { id: gmailId, email: gmailId, provider: "gmail" }
        ],
        activeId: imapId
      })
      tryCompare(mailService, "accountCount", 2)
      var gmail = mailService.findAccount(gmailId)
      verify(!!gmail, "the saved Gmail account has a host")
      tryVerify(function() { return !!gmail.auth }, 1000, "with its Gmail auth ready")
      app.resetNavigation()
      waitForRendering(app)

      app.openSettings()
      app.openClientSetup()
      waitForRendering(app)

      compare(app.page, "setup")
      compare(app.editingProvider, "gmail")
      tryVerify(function() {
        return !!mailService.current && mailService.current.accountId === gmailId
      }, 1000, "the shared client editor switches to the saved Gmail account")
      compare(mailService.accountCount, 2,
        "opening the editor does not create a second Gmail row")
      compare(typeof mailService.auth.saveCredentials, "function")
    }
  }
}
