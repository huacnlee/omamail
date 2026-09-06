import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../.." as Omamail

// Connect on an edited mailbox signs *that* mailbox in.
//
// Two saved rows: an IMAP one that is signed in and on screen, and a JMAP one
// with a typed server that has never been signed in. Settings, Edit on the
// JMAP row, the app password, Connect. The secret has to reach the JMAP
// account and the page has to stay on it. What the user saw instead was the
// window snapping to the IMAP mailbox's own setup page with the JMAP row
// untouched — so this runs the real window, service and hosts over the
// stubbed transport, the way `tst_jmap_sign_in.qml` does.
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
    name: "AppEditConnect"
    when: windowShown

    readonly property string imapId: "imap:shawn@example.test"
    readonly property string jmapId: "jmap:admin@example.test"
    readonly property string sessionUrl: "https://mail.example.test/jmap/session"

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

    // The stubbed `Process` an auth object started for a keyring read.
    function keyringLookup(auth) {
      var kids = auth ? auth.data : null
      for (var i = 0; kids && i < kids.length; i++) {
        var kid = kids[i]
        var command = kid && kid.command ? kid.command : []
        if (kid && kid.running && command.length > 1 && command[0] === "secret-tool"
            && command[1] === "lookup") return kid
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

    function twoRows() {
      mailService.accountsLoaded = true
      mailService.accountList = ({
        version: 1,
        accounts: [
          { id: imapId, email: "shawn@example.test", provider: "imap",
            imap: { imapHost: "imap.example.test", imapPort: 993,
              smtpHost: "smtp.example.test", smtpPort: 465,
              username: "shawn@example.test", aliases: [], insecure: false } },
          { id: jmapId, email: "admin@example.test", provider: "jmap",
            jmap: { sessionUrl: sessionUrl, username: "", authScheme: "basic", accountId: "" } }
        ],
        activeId: jmapId
      })
      tryCompare(mailService, "accountCount", 2)
      var imap = mailService.findAccount(imapId)
      var jmap = mailService.findAccount(jmapId)
      verify(!!imap && !!jmap, "the service builds a host for each row")
      tryVerify(function() { return !!imap.auth && !!imap.api && !!jmap.auth && !!jmap.api },
        1000, "and each host its provider pair")

      // The IMAP mailbox is signed in: its password comes back from the keyring.
      var lookup = keyringLookup(imap.auth)
      verify(!!lookup, "a configured IMAP account reads its password on start")
      lookup.stdout.text = "hunter2\n"
      lookup.exited(0)
      tryVerify(function() { return imap.ready }, 1000, "the IMAP mailbox is ready")
      compare(jmap.ready, false, "the JMAP one is not: it has no account id yet")
      tryCompare(app, "anyReady", true)
      app.resetNavigation()
      waitForRendering(app)
      compare(app.page, "list", "a window with a working mailbox opens on it")
      return { imap: imap, jmap: jmap }
    }

    function test_connect_on_an_edited_row_signs_that_row_in() {
      var hosts = twoRows()

      app.openSettings()
      compare(app.page, "settings")
      app.editAccount(1)
      compare(app.page, "setup", "Edit opens the row's setup page")
      compare(app.editingProvider, "jmap", "the JMAP one")
      compare(mailService.current, hosts.jmap, "over the JMAP host")
      waitForRendering(app)

      var page = named(app, "setup-page").item
      verify(!!page && typeof page.plannedServer === "function", "which is the JMAP page")
      compare(named(app, "jmap-address-field").text, "admin@example.test",
        "filled in from the row")
      named(app, "jmap-secret-field").text = "app-password"

      var beforeJmap = Transports.transports(hosts.jmap.api)
      var beforeImap = Transports.transports(hosts.imap.api)
      page.signIn()
      wait(0)
      wait(0)

      compare(app.page, "setup", "Connect keeps the page it was pressed on")
      compare(app.editingProvider, "jmap")
      compare(mailService.current, hosts.jmap, "and the mailbox it was pressed for")
      compare(mailService.accountList.accounts[1].id, jmapId, "the JMAP row is still the JMAP row")
      compare(mailService.accountList.accounts[1].jmap.sessionUrl, sessionUrl)

      tryVerify(function() { return Transports.newSince(hosts.jmap.api, beforeJmap).length === 1 },
        1000, "the secret is tried against the JMAP server")
      var request = Transports.newSince(hosts.jmap.api, beforeJmap)[0]
      compare(Transports.requested(request).verb, "session")
      compare(Transports.requested(request).url, sessionUrl)
      compare(Transports.newSince(hosts.imap.api, beforeImap).length, 0,
        "and not against the IMAP one")
      compare(hosts.imap.auth.loginBusy, false, "whose sign-in was never asked for")
      verify(hosts.imap.ready, "and which is still signed in")
    }
  }
}
