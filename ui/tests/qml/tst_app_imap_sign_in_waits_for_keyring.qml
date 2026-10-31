import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture

// A new IMAP mailbox opens on its mail, not on "Sign in again".
//
// Only the check of a typed password carries the credential. Every read after
// it names the account, and the backend finds the password in the keyring —
// so a mailbox that went ready while the accepted password was still being
// written sent its first list ahead of the write, the backend found nothing and
// answered auth_signed_out, and a mailbox that had just signed in said the
// server rejected it. This runs the real window, service and host, holds the
// keyring write open, and watches what reaches the backend meanwhile.
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
    name: "AppImapSignInWaitsForKeyring"
    when: windowShown

    property var fixture: null
    property var held: null

    function initTestCase() {
      fixture = BackendFixture.markReady(mailService, 4)
      fixture.answers = {
        // Pat's startup lookup is never answered: the Add form signs in
        // without waiting for it.
        "credentials.get": function(params) {
          return params.accountId === "imap:pat@example.test" ? undefined : {found: false}
        },
        "credentials.put": function(params, request) { held = request; return undefined },
        "credentials.delete": {deleted: true},
        "imap.folders": {folders: [], special: {}, capabilities: [], labels: []},
        "imap.list": {messages: [], nextPageToken: ""}
      }
    }

    // A read the backend answers from the keyring: one naming the account
    // rather than carrying a credential. A cancel names it too but reads nothing.
    function keyringReads(id) {
      return fixture.requests.filter(function(request) {
        var params = request.params || {}
        return request.method.indexOf("imap.") === 0 && request.method !== "imap.cancel"
          && params.accountId === id && !params.credential
      })
    }

    // A mailbox the keyring holds no password for, signed in with one the
    // server accepts, its write held open.
    function newMailboxAwaitingTheKeyring(user) {
      var id = "imap:" + user + "@example.test"
      held = null
      app.opened = true
      mailService.accountsLoaded = true
      // Both tests' mailboxes from the start, so each is its own account.
      mailService.accountList = ({ version: 1, accounts: ["shawn", "pat"].map(function(name) {
        return { id: "imap:" + name + "@example.test", email: name + "@example.test", provider: "imap",
          imap: { imapHost: "imap.example.test", imapPort: 993, smtpHost: "smtp.example.test",
            smtpPort: 465, username: name + "@example.test", aliases: [], insecure: false } }
      }), activeId: id })
      var imap = null
      tryVerify(function() { imap = mailService.findAccount(id); return !!imap }, 2000)
      tryVerify(function() { return !!imap.auth }, 2000)
      if (user !== "pat")
        tryVerify(function() { return imap.auth.passwordChecked }, 2000,
          "the keyring has said it holds no password yet")
      verify(!imap.ready)
      verify(mailService.signInWithPassword("app-password"))
      tryVerify(function() { return held !== null }, 2000, "the accepted password is being stored")
      compare(held.params.secret, "app-password")
      wait(50)
      return imap
    }

    function test_nothing_reads_the_keyring_before_the_password_is_in_it() {
      var imap = newMailboxAwaitingTheKeyring("shawn")
      compare(keyringReads(imap.accountId).length, 0,
        "no read may look for a password that is not stored yet")
      verify(!imap.ready, "and the mailbox is not in service until it is")

      BackendFixture.respond(mailService, held, {stored: true})
      tryVerify(function() { return imap.ready }, 2000)
      tryVerify(function() { return keyringReads(imap.accountId).length > 0 }, 2000,
        "then the mailbox loads")
      compare(imap.lastError, "")
    }

    // Without the password in the keyring every read would fail the same way,
    // so a refused write is a sign-in that did not finish.
    function test_a_password_the_keyring_refused_is_not_a_sign_in() {
      var imap = newMailboxAwaitingTheKeyring("pat")
      BackendFixture.respond(mailService, held, undefined, {code: -32000, message: "auth_keyring_failed"})
      tryVerify(function() { return !imap.auth.loginBusy }, 2000)
      wait(50)
      verify(!imap.ready)
      compare(keyringReads(imap.accountId).length, 0)
      verify(imap.auth.lastError.indexOf("could not be saved") >= 0, imap.auth.lastError)
      compare(imap.setupState, "signed_out", "not a saved session waiting to reconnect")

      // Unlocked, the same password is accepted again and this time kept.
      held = null
      verify(mailService.signInWithPassword("app-password"), "the form can be sent again")
      tryVerify(function() { return held !== null }, 2000)
      BackendFixture.respond(mailService, held, {stored: true})
      tryVerify(function() { return imap.ready }, 2000)
      compare(imap.auth.lastError, "")
    }
  }
}
