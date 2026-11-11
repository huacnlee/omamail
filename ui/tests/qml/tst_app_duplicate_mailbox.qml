import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture

// Connect on the Add form for an address that is already a mailbox says so on
// the form.
//
// The service refuses the save — two rows cannot hold one address — and says
// why through `duplicateAccount`. Only the status bar listened, for six
// seconds, at the far edge of the window: the form under the pressed button
// stayed as it was, nothing was tried, and to the user Connect did nothing.
// A first sign-in that failed is the usual way here, because the row is saved
// before its password is verified.
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
    name: "AppDuplicateMailbox"
    when: windowShown

    readonly property string imapId: "imap:shawn@example.test"
    readonly property string jmapId: "jmap:admin@example.test"

    function initTestCase() {
      var fixture = BackendFixture.markReady(mailService, 4)
      fixture.answers = {
        "credentials.get": {found:true,secret:"hunter2"},
        "credentials.put": {stored:true},
        "credentials.delete": {deleted:true}
      }
    }

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

    function savedRows() {
      mailService.accountsLoaded = true
      mailService.accountList = ({
        version: 1,
        accounts: [
          { id: imapId, email: "shawn@example.test", provider: "imap",
            imap: { imapHost: "imap.example.test", imapPort: 993,
              smtpHost: "smtp.example.test", smtpPort: 465,
              username: "shawn@example.test", aliases: [], insecure: false } },
          { id: jmapId, email: "admin@example.test", provider: "jmap",
            jmap: { sessionUrl: "https://mail.example.test/jmap/session",
              username: "", authScheme: "basic", accountId: "" } }
        ],
        activeId: imapId
      })
      tryCompare(mailService, "accountCount", 2)
      tryVerify(function() { return mailService.hasSavedAccounts === true }, 1000)
      waitForRendering(app)
    }

    function addForm(provider) {
      app.addMailbox()
      app.chooseProvider(provider)
      compare(app.page, "setup", "Add opens the provider's form")
      tryCompare(mailService, "accountCount", 3, 1000, "over a draft row")
      waitForRendering(app)
    }

    function test_imap_connect_with_an_added_address_says_so_on_the_form() {
      savedRows()
      var existing = mailService.findAccount(imapId)
      addForm("imap")
      var draft = mailService.current

      named(app, "imap-address-field").text = "shawn@example.test"
      named(app, "imap-password-field").text = "app-password"
      var before = Transports.transports(existing.api)
      named(app, "setup-page").item.signIn()
      wait(0)
      wait(0)

      var error = named(app, "imap-error")
      verify(error.visible, "the form shows why nothing was connected")
      verify(error.text.indexOf("shawn@example.test is already added") === 0, error.text)
      compare(app.page, "setup", "and stays where it was pressed")
      compare(mailService.current, draft, "on the draft")
      compare(mailService.accountList.accounts[0].imap.imapHost, "imap.example.test",
        "the saved mailbox keeps its servers")
      compare(Transports.newSince(existing.api, before).length, 0,
        "and is not signed in with the secret typed for the refused one")
    }

    function test_jmap_connect_with_an_added_address_says_so_on_the_form() {
      savedRows()
      addForm("jmap")

      named(app, "jmap-address-field").text = "admin@example.test"
      named(app, "jmap-secret-field").text = "app-password"
      named(app, "setup-page").item.signIn()
      wait(0)
      wait(0)

      var error = named(app, "jmap-error")
      verify(error.visible, "the form shows why nothing was connected")
      verify(error.text.indexOf("admin@example.test is already added") === 0, error.text)
      compare(app.page, "setup")
    }
  }
}
