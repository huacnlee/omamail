import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../.." as Omamail

// A JMAP sign-in has to leave the account able to sign in again.
//
// The page saves an address, a typed server and a secret. What the check then
// *learns* — the session URL that finally answered, the scheme the server
// accepted and the account id its session named — is what every later request
// needs, and none of it exists until the check has run. If nothing writes those
// three onto the account entry, the auth object built from that entry is never
// configured: the mailbox says "sign in first" to every fetch, starts no push
// stream, and opens on its setup page again after every restart, however many
// times the check succeeds.
//
// The route runs through the real objects on purpose — the window's setup
// page, the service's account list, the account, its auth object and its
// client — because every one of them was individually right while the value
// went nowhere. The transport is the stubbed `Process` under
// `tests/qml/imports`, which never exits on its own, so each of the two
// requests sign-in makes is answered here by hand and nothing touches the
// network, the keyring or the disk.
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
    name: "JmapSignIn"
    when: windowShown

    readonly property string accountId: "jmap:jane@example.test"
    readonly property string sessionUrl: "https://mail.example.test/jmap/session"

    // The least a session can carry and pass `Jmap.verifySession`: core and
    // mail, one mail-capable primary account, and a `receivedAt` sort.
    readonly property var session: ({
      capabilities: {
        "urn:ietf:params:jmap:core": {},
        "urn:ietf:params:jmap:mail": {}
      },
      accounts: {
        "acc-7": {
          name: "jane@example.test",
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: {
            "urn:ietf:params:jmap:mail": { emailQuerySortOptions: ["receivedAt"] }
          }
        }
      },
      primaryAccounts: {
        "urn:ietf:params:jmap:core": "acc-7",
        "urn:ietf:params:jmap:mail": "acc-7"
      },
      apiUrl: "https://api.example.test/jmap/",
      state: "s0"
    })

    readonly property var mailboxes: ({
      methodResponses: [["Mailbox/get", {
        accountId: "acc-7", state: "m0", notFound: [],
        list: [
          { id: "a", name: "Inbox", role: "inbox", parentId: null,
            totalEmails: 0, unreadEmails: 0 },
          { id: "b", name: "Trash", role: "trash", parentId: null,
            totalEmails: 0, unreadEmails: 0 }
        ]
      }, "0"]],
      sessionState: "s0"
    })

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

    // First run, the way a person meets it: the chooser, then the JMAP page,
    // then the form filled in and the check answered by the canned server.
    // Hands back the account with both of sign-in's requests answered.
    function signIn() {
      // The nameless row a first run starts with, exactly as `applyAccounts`
      // seeds it when there is no file yet.
      mailService.accountsLoaded = true
      mailService.accountList = ({
        version: 1,
        accounts: [{ id: "", email: "", provider: "gmail", clientId: "", clientSecret: "",
          pending: true }],
        activeId: ""
      })
      tryCompare(mailService, "accountCount", 1)
      tryVerify(function() { return mailService.current !== null }, 1000,
        "the real Service creates a host for the first-run row")
      wait(0)
      tryCompare(app, "anyReady", false)
      // The window works its first page out at startup and when a mailbox
      // becomes ready, not on every save; installing the row after the window
      // was built means asking it to look again, the way a restart would.
      app.resetNavigation()
      waitForRendering(app)

      var loader = named(app, "setup-page")
      verify(loader, "first run opens on a setup page")
      verify(!!loader.item && typeof loader.item.chosen === "function", "which is the chooser")
      loader.item.chosen("jmap")
      waitForRendering(app)
      var page = loader.item
      verify(!!page && typeof page.plannedServer === "function", "choosing JMAP opens its page")

      var account = mailService.current
      tryCompare(account, "providerId", "jmap")
      tryVerify(function() { return !!account.auth && !!account.api }, 1000,
        "the row's host builds the JMAP pair once its kind is chosen")
      compare(account.ready, false, "nothing is signed in yet")

      named(app, "jmap-address-field").text = "jane@example.test"
      page.openServerField()
      named(app, "jmap-server-field").text = "mail.example.test"
      named(app, "jmap-secret-field").text = "app-password"

      var before = Transports.transports(account.api)
      page.signIn()
      // The save names the row — it is `jmap:jane@example.test` from here —
      // and the sign-in is a tick behind it by design; the session GET is what
      // says it has begun.
      tryCompare(account, "accountId", accountId)
      tryVerify(function() { return Transports.newSince(account.api, before).length === 1 }, 1000,
        "sign-in sends the session GET")
      var sessionRequest = Transports.newSince(account.api, before)[0]
      compare(Transports.requested(sessionRequest).verb, "session")
      compare(Transports.requested(sessionRequest).url, sessionUrl,
        "a bare typed host becomes the session URL under it")

      var beforeMailboxes = Transports.transports(account.api)
      Transports.answer(sessionRequest, 200, session)
      var calls = Transports.newSince(account.api, beforeMailboxes)
      compare(calls.length, 1, "a good session is followed by one Mailbox/get")
      compare(Transports.requested(calls[0]).verb, "call")
      Transports.answer(calls[0], 200, mailboxes)
      return account
    }

    // One sign-in, read three ways: what landed on the entry, what the account
    // makes of it, and what the client keeps through the write. One test
    // rather than three because a second sign-in would need the first host
    // torn down, and a window whose only ready mailbox has gone is not a state
    // the service recounts on its own.
    function test_signing_in_writes_what_it_learned_onto_the_account() {
      var account = signIn()

      var entry = mailService.accountList.accounts[0]
      compare(entry.jmap.sessionUrl, sessionUrl, "the URL that answered is on the entry")
      compare(entry.jmap.authScheme, "basic", "and the scheme that worked")
      compare(entry.jmap.accountId, "acc-7", "and the account id the session named")
      compare(entry.jmap.username, "", "the username stays what was typed: nothing")
      compare(entry.email, "jane@example.test")
      compare(entry.id, accountId, "the row is the same mailbox, not a new one")

      compare(account.auth.configured, true, "the auth object built from the entry is configured")
      compare(account.auth.loggedIn, true)
      tryVerify(function() { return account.ready }, 2000,
        "so the mailbox is ready without a restart")
      compare(account.auth.lastError, "")

      tryCompare(app, "anyReady", true)
      verify(app.page !== "setup" && app.page !== "picker",
        "and the window leaves setup for the mailbox, without a restart")

      // ---- the write keeps the session sign-in just read
      verify(!!account.api.session, "the check left the session on the client")
      compare(account.api.mailboxesLoaded, true, "and the mailboxes it read")
      compare(account.api.mailboxList.length, 2)

      // The entry is rewritten again for a reason that has nothing to do with
      // the server: the list is saved, every settings object is rebuilt, and
      // the client must recognise its own server in the new one.
      mailService.setAccountLabel(accountId, "Jane")
      wait(0)
      compare(mailService.accountList.accounts[0].label, "Jane")
      verify(!!account.api.session, "naming the mailbox does not forget its server")
      compare(account.api.mailboxesLoaded, true)

      // A different server is a different mailbox, and is forgotten.
      mailService.configureAccount(0, { jmap: {
        sessionUrl: "https://elsewhere.example.test/jmap/session",
        username: "", authScheme: "basic", accountId: "acc-7"
      } })
      wait(0)
      compare(account.api.session, null, "a new server drops the old server's session")
      compare(account.api.mailboxesLoaded, false)
    }
  }
}
