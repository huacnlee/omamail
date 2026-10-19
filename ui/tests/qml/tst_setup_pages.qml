import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture
import "../../account/Accounts.js" as Accounts
import "../../providers/Registry.js" as Provider

// Every kind the chooser offers opens its own page, through the window and
// back. The pages are built in SetupPages, so each signal crosses one more
// object than it did: a kind missing from its map opens Gmail's page instead,
// and a handler written without its call drops Remove on the floor, with every
// page still drawing.
Item {
  width: 900
  height: 600

  QtObject {
    id: shellStore
    function updateEntryInline(id, entry) {}
    function hide(id) {}
  }

  Omamail.Service {
    id: mailService
    shell: shellStore
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  Omamail.App { id: app; service: mailService }

  TestCase {
    name: "SetupPages"
    when: windowShown

    function initTestCase() { BackendFixture.markReady(mailService) }

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

    function seed() {
      var list = Accounts.add(Accounts.emptyList(), { email: "ada@example.com", provider: "imap",
        clientId: "", clientSecret: "", label: "", signature: "",
        imap: { imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com",
                smtpPort: 465, username: "ada@example.com", aliases: [], insecure: false } })
      mailService.activeIndex = -1
      mailService.accountList = Accounts.setActive(list, "imap:ada@example.com")
      mailService.accountsLoaded = true
      mailService.refreshCurrent()
    }

    // A page is named after its kind; Gmail's, the first, is plain SetupPage.
    function pageType(id) {
      return id === "gmail" ? "SetupPage" : id.charAt(0).toUpperCase() + id.slice(1) + "SetupPage"
    }

    function typeOf(item) {
      return String(item).split("_QMLTYPE_")[0].split("(")[0]
    }

    function init() {
      seed()
      app.opened = true
      app.resetNavigation()
    }

    function test_each_kind_opens_its_own_page_data() {
      return Provider.ids().map(function(id) { return { tag: id, id: id } })
    }

    function test_each_kind_opens_its_own_page(data) {
      app.addMailbox()
      var setup = named(app, "setup-page")
      tryVerify(function() { return !!setup.item && typeOf(setup.item) === "ProviderPicker" })

      setup.item.chosen(data.id)
      tryVerify(function() { return !!setup.item && typeOf(setup.item) !== "ProviderPicker" })
      compare(typeOf(setup.item), pageType(data.id), "the chooser's choice reaches the window")
      compare(mailService.accountCount, 2, "choosing made the mailbox's row")
      if (setup.item.accountCount !== undefined)
        compare(setup.item.accountCount, 2, "the page counts the mailboxes there are")

      setup.item.removeRequested()
      tryCompare(mailService, "accountCount", 1)
    }
  }
}
