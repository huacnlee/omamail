import QtQuick 2.15
import QtTest 1.3
import "../../" as Omamail
import "BackendFixture.js" as BackendFixture
import "NativeIntentFixture.js" as NativeIntentFixture
import "../../account/Accounts.js" as Accounts

// The account hosts are built by an Instantiator after the account list that
// names them: at start-up, and again, every one of them, whenever the number of
// mailboxes changes. Settings, the switcher and the calendar a mailbox brings
// read a summary of its host, so the summary has to follow the hosts that exist
// rather than the ones that existed when the list was applied, and following
// them must not move the window while the rebuilt hosts sign in again. Through
// the real Service and App, starting the way the window does.
Item {
  width: 900
  height: 600

  QtObject { id: fakeShell; function hide(_id) {} }

  Omamail.Service {
    id: mailService
    shell: fakeShell
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-account-hosts-test" })
  }

  Omamail.App { id: app; service: mailService; shell: fakeShell }

  TestCase {
    id: testCase
    name: "AccountHosts"
    when: windowShown

    property var fixture: null
    readonly property string bob: "outlook:bob@example.net"
    readonly property string carol: "outlook:carol@example.net"
    // The mailboxes whose saved session the backend no longer holds.
    property var signedOut: []
    // Token exchanges held back, the way a real backend answers a little later.
    property bool holdTokens: false
    property var heldTokens: []
    readonly property var token: ({ access_token: "synthetic-access", token_type: "Bearer",
      expires_in: 3600, scope: "https://outlook.office.com/IMAP.AccessAsUser.All" })

    function initTestCase() {
      fixture = BackendFixture.install(mailService)
      // The read the window makes as soon as the backend is up finds nothing.
      fixture.answers = { "accounts.read": { revision: "empty", registry: Accounts.emptyList() } }
      BackendFixture.markReady(mailService, 7)
      NativeIntentFixture.install(mailService)
      tryVerify(function() { return mailService.accountsLoaded }, 3000)
    }

    function init() {
      signedOut = []
      holdTokens = false
      heldTokens = []
      fixture.answers = {
        "credentials.get": { found: false },
        "mail.watch": function(params) { return { accountId: params.accountId, sequence: 1, estimate: 0, messages: [], error: "synthetic" } },
        "mail.unwatch": {},
        "accounts.save": { revision: "saved" },
        // A saved Outlook session is restored by the backend's token exchange.
        "auth.token": function(params, request) {
          if (testCase.signedOut.indexOf(params.accountId) >= 0)
            BackendFixture.respond(mailService, request, null, { code: -32000, message: "auth_signed_out" })
          else if (testCase.holdTokens) testCase.heldTokens = testCase.heldTokens.concat([request])
          else return testCase.token
          return undefined
        }
      }
      // A fresh start: nothing loaded and no account hosts yet. What earlier
      // tests left unanswered would otherwise hold the backend's 64 slots.
      mailService.backend.pending = ({})
      mailService.accountsLoaded = false
      mailService.accountList = ({ version: 1, accounts: [], activeId: "" })
      app.resetNavigation()
      wait(0)
      compare(mailService.accountCount, 0)
    }

    function releaseTokens() {
      var held = heldTokens
      heldTokens = []
      holdTokens = false
      for (var i = 0; i < held.length; i++) BackendFixture.respond(mailService, held[i], token)
    }

    // What the window does when it starts: read the saved list and apply it.
    function start(addresses) {
      var list = Accounts.emptyList()
      for (var i = 0; i < addresses.length; i++) {
        list = Accounts.add(list, { email: addresses[i], provider: "outlook",
          clientId: "11111111-2222-3333-4444-555555555555" })
      }
      fixture.answers["accounts.read"] = { revision: "start-up",
        registry: Accounts.setActive(list, "outlook:" + addresses[0]) }
      mailService.restoreAccountRegistry()
      tryCompare(mailService, "accountCount", addresses.length, 3000)
    }

    function summary(id) {
      return mailService.accountSummaries.filter(function(entry) { return entry.id === id })[0]
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

    function typed(item, prefix) {
      if (String(item).indexOf(prefix) === 0) return item
      var children = item.children || []
      for (var i = 0; i < children.length; i++) {
        var found = typed(children[i], prefix)
        if (found) return found
      }
      return null
    }

    // What Settings' list of mailboxes says on a mailbox's row.
    function settingsRow(id) {
      app.openSettings()
      verify(app.showSettings, "Settings opens")
      function texts(item, out) {
        if (typeof item.text === "string") out.push(item.text)
        var values = item.children || []
        for (var i = 0; i < values.length; i++) texts(values[i], out)
        return out
      }
      function row(item) {
        if (String(item).indexOf("QQuickRectangle") === 0 && item.modelData && item.modelData.id === id)
          return item
        var values = item.children || []
        for (var i = 0; i < values.length; i++) {
          var found = row(values[i])
          if (found) return found
        }
        return null
      }
      var found = row(named(app, "settings-page"))
      verify(!!found, "Settings lists the mailbox")
      return texts(found, [])
    }

    function test_a_restored_mailbox_reads_as_signed_in() {
      start(["bob@example.net"])
      tryVerify(function() { return mailService.current && mailService.current.ready }, 3000,
        "the saved session is restored")
      compare(summary(bob).signedIn, true, "the summary follows the host that became ready")
      var row = settingsRow(bob)
      verify(row.indexOf("No unread mail") >= 0, "Settings counts its mail: " + row)
      verify(row.indexOf("Signed out") < 0, "and does not say Signed out")
      verify(named(named(app, "settings-page"), "calendar-discover-microsoft").text !== "Sign in...",
        "and its calendar does not ask to be signed in")
    }

    function test_a_restored_mailbox_offers_its_calendar_to_the_event_composer() {
      start(["bob@example.net"])
      tryVerify(function() { return mailService.current && mailService.current.ready }, 3000)
      app.showCalendar()
      waitForRendering(app)
      tryCompare(named(app, "key-router"), "context", "calendar")
      keyClick(Qt.Key_C)
      var composer = typed(app, "CalendarEventComposer")
      tryVerify(function() { return composer.opened }, 2000, "c opens the event composer")
      var selector = named(composer, "event-calendar-selector")
      compare(selector.contentItem.text, "bob@example.net",
        "the composer names the mailbox's calendar, not 'Choose a calendar'")
      compare(selector.count, 1, "and offers it")
      keyClick(Qt.Key_Escape)
      tryVerify(function() { return !composer.opened }, 2000)
    }

    // A host that never signs in changes nothing recount() hears, so this is
    // the summary following the host being built and nothing else.
    function test_a_restored_mailbox_that_cannot_sign_in_says_why() {
      signedOut = [bob]
      start(["bob@example.net"])
      var host = mailService.findAccount(bob)
      tryVerify(function() { return host && String(host.lastError) !== "" }, 3000,
        "the saved session is refused")
      compare(host.ready, false)
      compare(summary(bob).error, host.lastError, "the summary carries what the mailbox said")
      var row = settingsRow(bob)
      verify(row.indexOf(host.lastError) >= 0, "and Settings says it: " + row)
      verify(row.indexOf("Signed out") < 0, "rather than just Signed out")
    }

    // Adding a mailbox rebuilds every host, and none of them is signed in
    // until its token exchange answers. The form being filled in stays.
    function test_adding_a_mailbox_keeps_its_form_while_the_others_sign_in_again() {
      start(["bob@example.net"])
      var before = mailService.findAccount(bob)
      tryVerify(function() { return before && before.ready }, 3000)
      app.openSettings()
      app.addMailbox()
      holdTokens = true
      app.chooseProvider("outlook")
      compare(app.page, "setup")
      var rebuilt = mailService.findAccount(bob)
      if (rebuilt === before) skip("this Qt keeps the hosts when a mailbox is added")
      tryVerify(function() { return heldTokens.length > 0 }, 3000, "the hosts sign in again")
      wait(50)
      compare(app.page, "setup", "the new mailbox's form is still open")
      releaseTokens()
      tryVerify(function() { return rebuilt.ready }, 3000)
      compare(summary(bob).signedIn, true, "the summary follows the rebuilt host")
      compare(app.page, "setup")
    }

    function test_removing_a_mailbox_keeps_settings_while_the_other_signs_in_again() {
      start(["bob@example.net", "carol@example.net"])
      tryVerify(function() { return mailService.findAccount(bob) && mailService.findAccount(bob).ready
        && mailService.findAccount(carol) && mailService.findAccount(carol).ready }, 3000)
      var before = mailService.findAccount(carol)
      holdTokens = true
      app.confirmAccountRemoval(Accounts.removalRequest({ accounts: mailService.accountSummaries }, 0))
      tryCompare(mailService, "accountCount", 1)
      compare(app.page, "settings")
      var rebuilt = mailService.findAccount(carol)
      if (rebuilt === before) skip("this Qt keeps the hosts when a mailbox is removed")
      tryVerify(function() { return heldTokens.length > 0 }, 3000, "the mailbox left signs in again")
      wait(50)
      compare(app.page, "settings", "Settings is still open")
      releaseTokens()
      tryVerify(function() { return rebuilt.ready }, 3000)
      compare(summary(carol).signedIn, true, "the summary follows the rebuilt host")
      compare(app.page, "settings")
    }
  }
}
