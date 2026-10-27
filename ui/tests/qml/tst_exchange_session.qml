import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture

// What happens to an Exchange mailbox after it has signed in: a restart finding
// it again, a password the server or the keyring no longer accepts, and the
// password leaving with the mailbox, or with the server it was typed for.
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

  ExchangeCase {
    id: t
    name: "ExchangeSession"
    service: mailService
    app: app

    function methods(requests) {
      return requests.map(function(request) { return request.method })
    }

    function test_a_restart_finds_the_password_and_never_sends_it() {
      keyring.entries[accountId] = secret
      server.script["exchange.verify"] = function() {
        return { result: Object.assign({}, checked, { refusals: { send: "No Sent folder was found on this server" } }) }
      }
      var account = seed()
      tryVerify(function() { return account.ready }, 2000)
      compare(account.auth.loggedIn, true)
      tryVerify(function() { return account.api.learned }, 2000, "the folders it has are learned")
      tryVerify(function() { return sent("exchange.list").length > 0 }, 2000)
      compare(fixture.requests.filter(function(r) { return r.method === "credentials.get" })[0].params,
        { kind: "exchange-password", accountId: accountId })
      verify(JSON.stringify(server.calls.map(function(r) { return r.params })).indexOf(secret) < 0,
        "no request carried the password")
      verify(JSON.stringify(fixture.requests.filter(function(r) { return r.method !== "credentials.put" }).map(function(r) { return r.params }))
        .indexOf(secret) < 0)
      // What the check taught the rail and the page: no Junk folder, and no sending.
      compare(account.absentMailboxes, ["spam"])
      verify(account.mailboxes.every(function(box) { return box.key !== "spam" }))
      compare(account.canSend, false)
      compare(openEditor().signedIn, true)
      verify(!named(app, "exchange-submit").visible || named(app, "exchange-submit").text === "Save changes")
      verify(named(app, "exchange-signed-in").text.indexOf("corp.example.test") > 0)
      var notes = []
      function collect(item) {
        if (typeof item.text === "string" && item.text.indexOf("Sending is not offered") === 0 && item.visible) notes.push(item)
        for (var i = 0; i < (item.children || []).length; i++) collect(item.children[i])
      }
      collect(page())
      compare(notes.length, 1, "the page says what this account cannot do")
    }

    function test_a_mailbox_with_no_password_in_the_keyring_asks_for_one_and_sends_nothing() {
      var account = seed()
      tryCompare(account.auth, "credentialLookupBusy", false, 2000)
      compare(account.ready, false)
      compare(account.auth.loggedIn, false)
      wait(100)
      compare(server.calls.length, 0, "nothing is asked of a server without a password")
      openEditor()
      verify(!named(app, "exchange-signed-in").visible)
      compare(named(app, "exchange-submit").text, "Connect the mailbox")
    }

    function test_a_password_that_is_no_longer_usable_is_asked_for_again_data() {
      return [{ tag: "refused by the server", code: "exchange_unauthorized" },
        { tag: "lost by the keyring", code: "auth_signed_out" }]
    }

    // The server refused the saved password, or the keyring lost it: either way
    // it has to be typed again, nothing is signed out, and nothing more is sent.
    function test_a_password_that_is_no_longer_usable_is_asked_for_again(data) {
      keyring.entries[accountId] = secret
      server.script["exchange.list"] = function() { return { error: data.code } }
      var account = seed()
      tryVerify(function() { return account.credentialsRejected }, 2000)
      compare(account.auth.loggedIn, true, "the account stays as it was")
      var calls = server.calls.length
      account.refresh()
      wait(100)
      compare(server.calls.length, calls, "and asks nothing more with the same password")
      var form = openEditor()
      verify(named(app, "exchange-rejected").visible)
      compare(named(app, "exchange-submit").text, "Sign in again")
      compare(named(app, "exchange-secret-field").text, "")
      verify(!named(app, "exchange-submit").enabled, "until a password is typed")

      // A password that works is the way back.
      server.script = ({})
      named(app, "exchange-secret-field").text = "another-synthetic-passw0rd"
      form.submit()
      tryVerify(function() { return !account.credentialsRejected }, 2000)
      compare(keyring.entries[accountId], "another-synthetic-passw0rd")
      tryVerify(function() { return sent("exchange.list").length > calls }, 2000, "and the mailbox is read again")
    }

    // The backend reads the password from the keyring, so the refusal stands
    // until the keyring has the new one: a request in between would send the
    // password the server just refused, and a directory counts that.
    function test_a_refused_password_stays_refused_until_the_keyring_has_the_new_one() {
      keyring.entries[accountId] = secret
      server.script["exchange.list"] = function() { return { error: "exchange_unauthorized" } }
      var account = seed()
      tryVerify(function() { return account.credentialsRejected }, 2000)
      var form = openEditor()
      server.script = ({})
      keyring.hold = true
      named(app, "exchange-secret-field").text = "another-synthetic-passw0rd"
      form.submit()
      tryVerify(function() { return keyring.pending.length === 1 }, 2000, "the new password goes to the keyring")
      compare(account.credentialsRejected, true, "the check passed, the keyring has not answered")
      release()
      tryVerify(function() { return !account.credentialsRejected }, 2000)
    }

    function test_signing_out_takes_the_password_and_the_session_with_it() {
      var account = signedIn()
      keyring.deletes = []
      account.signOut()
      tryVerify(function() { return keyring.deletes.length === 1 }, 2000)
      compare(keyring.deletes[0], accountId)
      compare(keyring.entries[accountId], undefined)
      compare(account.auth.loggedIn, false)
      tryVerify(function() {
        return fixture.requests.some(function(r) { return r.method === "exchange.invalidate" && r.params.accountId === accountId })
      }, 2000)
      var calls = server.calls.length
      wait(100)
      compare(server.calls.length, calls, "and nothing is sent afterwards")
    }

    function invalidations() {
      return fixture.requests.filter(function(r) {
        return r.method === "exchange.invalidate" && r.params.accountId === accountId
      }).length
    }

    // A sign-out whose keyring delete answers late: the delete holding a password
    // signed out.
    function signOutHeld(account) {
      var held = []
      fixture.answers["credentials.delete"] = function(params, request) {
        keyring.deletes.push(params.accountId)
        held.push(request)
        return undefined
      }
      account.signOut()
      tryVerify(function() { return held.length === 1 }, 2000, "the keyring is asked to let it go")
      return held
    }

    // The backend refuses a request that read the password before its session
    // went. Told only once the keyring had answered, a request that read it and
    // was waiting for its turn would sign in with it while the delete was slow;
    // told only at once, one that read it in between would. So it is told both.
    function test_the_session_goes_at_once_and_again_once_the_keyring_has_let_the_password_go() {
      var account = signedIn()
      var held = signOutHeld(account)
      compare(invalidations(), 1, "at once, before the keyring has answered")
      wait(100)
      compare(invalidations(), 1)
      delete keyring.entries[accountId]
      BackendFixture.respond(mailService, held[0], { deleted: true })
      tryVerify(function() { return invalidations() === 2 }, 2000, "and again once it has")
    }

    // Signed in again before the old delete answered: the second word would
    // refuse the requests reading the new password, so it is not said.
    function test_a_sign_in_begun_while_the_old_password_goes_is_not_signed_out_by_it() {
      var account = signedIn()
      var held = signOutHeld(account)
      compare(invalidations(), 1)
      delete keyring.entries[accountId]
      verify(account.auth.signIn("another-synthetic-passw0rd"))
      tryVerify(function() { return account.auth.loggedIn }, 2000, "signed in again")
      BackendFixture.respond(mailService, held[0], { deleted: true })
      wait(200)
      compare(invalidations(), 1, "the new sign-in's session is left alone")
      compare(account.auth.loggedIn, true)
    }

    // A mailbox added again under the same address must not find the old one's
    // password and send it to whichever server it names. It goes once the
    // removal is confirmed, and a removal called off takes nothing.
    function test_removing_a_mailbox_takes_its_password_with_it_once_confirmed() {
      var other = "exchange:ada@corp.example.test"
      keyring.entries[accountId] = secret
      keyring.entries[other] = "ada-synthetic-passw0rd"
      seed(null, [entryFor("ada@corp.example.test")])
      tryVerify(function() { return mailService.accountAt(1).ready }, 2000)
      openEditor(1)
      keyring.deletes = []
      app.removeCurrentAccountFromEditor()
      var dialog = removalDialog()
      tryVerify(function() { return dialog.opened }, 1000)
      var request = dialog.request
      compare(request.id, accountId)
      dialog.close()
      tryVerify(function() { return !dialog.opened }, 1000)
      wait(100)
      compare(keyring.deletes, [], "called off: nothing is taken")
      compare(keyring.entries[accountId], secret)
      verify(!fixture.requests.some(function(r) { return r.method === "exchange.invalidate" }))

      app.confirmAccountRemoval(request)
      tryVerify(function() { return keyring.deletes.length === 1 }, 2000)
      compare(keyring.deletes, [accountId])
      compare(keyring.entries[accountId], undefined)
      compare(keyring.entries[other], "ada-synthetic-passw0rd")
      tryVerify(function() {
        return fixture.requests.some(function(r) { return r.method === "exchange.invalidate" && r.params.accountId === accountId })
      }, 2000)
    }

    // The removal contract #381 set for every provider: the mailbox stays until
    // the keyring has confirmed its password gone, so a delegate is never
    // destroyed while it still owes the delete.
    function removable() {
      keyring.entries[accountId] = secret
      seed(null, [entryFor("ada@corp.example.test")])
      tryVerify(function() { return mailService.accountAt(1).ready }, 2000)
      keyring.deletes = []
      return { id: accountId, email: "jane@corp.example.test", index: 1 }
    }

    function present() {
      return mailService.accountList.accounts.some(function(entry) { return entry.id === accountId })
    }

    // What reached the backend for the keyring.
    function credentialRequests() {
      return fixture.requests.filter(function(request) { return request.method.indexOf("credentials.") === 0 })
    }

    function holdDeletes() {
      var held = []
      fixture.answers["credentials.delete"] = function(params, request) {
        keyring.deletes.push(params.accountId)
        held.push(request)
        return undefined
      }
      return held
    }

    function test_a_removal_keeps_the_mailbox_until_the_keyring_has_let_its_password_go() {
      var request = removable()
      var held = holdDeletes()
      app.confirmAccountRemoval(request)
      tryVerify(function() { return held.length === 1 }, 2000, "the keyring is asked to let it go")
      wait(50)
      verify(present(), "kept while the keyring has not answered")
      compare(mailService.findAccount(accountId).auth.removalBusy, true)
      delete keyring.entries[accountId]
      BackendFixture.respond(mailService, held[0], { deleted: true })
      tryVerify(function() { return !present() }, 2000, "and removed once it has")
      compare(mailService.accountCount, 1)
    }

    function test_a_removal_before_the_backend_is_up_keeps_the_mailbox_and_its_password() {
      var request = removable()
      mailService.backend.connected = false
      compare(mailService.backend.ready, false)
      app.confirmAccountRemoval(request)
      wait(50)
      verify(present(), "no delegate is destroyed with a delete it could not make")
      verify(mailService.findAccount(accountId).auth.lastError.indexOf("not removed") >= 0)
      compare(keyring.deletes, [], "the keyring was not asked")
      compare(keyring.entries[accountId], secret)
      BackendFixture.markReady(mailService, 9)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return !present() }, 2000, "asked again once it is up")
      compare(keyring.deletes, [accountId])
      compare(keyring.entries[accountId], undefined)
    }

    // The released 0.11.1 is API 8 and knows no Exchange password: restoring and
    // removing the mailbox ask it nothing and say why, and the mailbox stays.
    function test_a_backend_without_exchange_is_asked_nothing_of_the_keyring() {
      keyring.entries[accountId] = secret
      BackendFixture.markReady(mailService, 8)
      fixture.requests = []
      seed(null, [entryFor("ada@corp.example.test")])
      var account = mailService.findAccount(accountId)
      tryCompare(account.auth, "lastError", "Update the mail backend to sign in: the one installed has no Exchange support")
      verify(!account.auth.loggedIn)
      var request = { id: accountId, email: "jane@corp.example.test", index: 1 }
      app.confirmAccountRemoval(request)
      wait(50)
      verify(present(), "the mailbox stays while its password cannot be deleted")
      compare(account.auth.lastError,
        "The mailbox was not removed: the mail backend needs an update first. Update it, then try Remove account again")
      compare(credentialRequests().length, 0, "nothing was asked of the keyring")
      compare(keyring.entries[accountId], secret)
      BackendFixture.markReady(mailService, 9)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return !present() }, 2000, "removed once the backend can delete it")
      compare(keyring.entries[accountId], undefined)
    }

    // Signed in, then an older backend without Exchange starts in its place:
    // signing out asks it nothing and says the password is still there.
    function test_signing_out_on_a_backend_without_exchange_says_the_password_stays() {
      keyring.entries[accountId] = secret
      seed(null, [entryFor("ada@corp.example.test")])
      var account = mailService.accountAt(1)
      tryVerify(function() { return account.ready }, 2000)
      openEditor(1)
      BackendFixture.markReady(mailService, 8)
      fixture.requests = []
      mailService.signOut()
      wait(50)
      verify(!account.auth.loggedIn)
      compare(credentialRequests().length, 0, "nothing was asked of the keyring")
      compare(keyring.entries[accountId], secret)
      tryVerify(function() { return named(app, "exchange-error").visible }, 2000)
      compare(named(app, "exchange-error").text,
        "Signed out, but the mail backend needs an update before it can delete the saved password. Update it, then sign out again")
    }

    function test_a_removal_the_keyring_refuses_keeps_the_mailbox_and_says_so() {
      var request = removable()
      keyring.failDeletes = true
      app.confirmAccountRemoval(request)
      tryVerify(function() {
        return mailService.findAccount(accountId).auth.lastError.indexOf("not removed") >= 0
      }, 2000)
      verify(mailService.findAccount(accountId).auth.lastError.indexOf("keyring") >= 0)
      compare(mailService.accountCount, 2)
      compare(keyring.entries[accountId], secret, "the password is still there to be removed")
      keyring.failDeletes = false
      app.confirmAccountRemoval(request)
      tryVerify(function() { return !present() }, 2000, "a retry removes both")
      compare(keyring.entries[accountId], undefined)
    }

    function test_a_late_removal_cannot_remove_a_mailbox_replaced_while_it_waited() {
      var request = removable()
      var held = holdDeletes()
      app.confirmAccountRemoval(request)
      tryVerify(function() { return held.length === 1 }, 2000)
      var replacement = JSON.parse(JSON.stringify(mailService.accountList))
      replacement.accounts[1].label = "Work"
      mailService.accountList = replacement
      wait(0)
      BackendFixture.respond(mailService, held[0], { deleted: true })
      wait(100)
      verify(present(), "a stale completion leaves the edited mailbox alone")
      compare(mailService.accountCount, 2)
    }

    function test_a_failed_removal_is_shown_again_on_the_page_and_cleared_by_a_retry() {
      var request = removable()
      var held = holdDeletes()
      openEditor(1)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return held.length === 1 }, 2000)
      compare(named(app, "exchange-remove").enabled, false)
      compare(named(app, "exchange-submit").enabled, false)
      verify(named(app, "exchange-submit").text.indexOf("Removing") >= 0)
      BackendFixture.respond(mailService, held[0], undefined, { code: -32000, message: "credential_store_unavailable" })
      tryVerify(function() { return named(app, "exchange-error").visible }, 2000)
      verify(named(app, "exchange-error").text.indexOf("not removed") >= 0)
      verify(named(app, "exchange-remove").enabled)
      app.back()
      openEditor(1)
      verify(named(app, "exchange-error").visible, "a page opened again still explains it")
      verify(named(app, "exchange-error").text.indexOf("not removed") >= 0)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return held.length === 2 }, 2000)
      compare(named(app, "exchange-error").text, "", "a retry clears the last failure")
      delete keyring.entries[accountId]
      BackendFixture.respond(mailService, held[1], { deleted: true })
      tryVerify(function() { return !present() }, 2000)
    }

    // Sign-out is not a removal: it is at once in the window, and the password
    // the keyring could not be reached for goes once the backend is up.
    function test_signing_out_before_the_backend_is_up_deletes_the_password_once_it_is() {
      keyring.entries[accountId] = secret
      var account = seed()
      tryVerify(function() { return account.ready }, 2000)
      keyring.deletes = []
      mailService.backend.connected = false
      account.signOut()
      compare(account.auth.loggedIn, false, "signed out at once")
      wait(50)
      compare(keyring.deletes, [], "the keyring cannot be reached yet")
      compare(account.auth.removalBusy, false)
      verify(account.auth.lastError.indexOf("not removed") < 0, "no removal wording")
      account.auth.restoreSession()
      wait(50)
      compare(account.auth.loggedIn, false, "nothing finds the password meanwhile")
      BackendFixture.markReady(mailService, 9)
      tryVerify(function() { return keyring.deletes.length === 1 }, 2000, "deleted once it is up")
      compare(keyring.deletes, [accountId])
      compare(keyring.entries[accountId], undefined)
      tryVerify(function() { return invalidations() >= 1 }, 2000)
    }

    function test_signing_out_never_shows_removal_wording() {
      keyring.entries[accountId] = secret
      seed(null, [entryFor("ada@corp.example.test")])
      var account = mailService.accountAt(1)
      tryVerify(function() { return account.ready }, 2000)
      openEditor(1)
      fixture.answers["credentials.delete"] = function(params, request) {
        keyring.deletes.push(params.accountId)
        return refuse(request)
      }
      mailService.signOut()
      tryVerify(function() { return keyring.deletes.length === 1 }, 2000)
      compare(account.auth.removalBusy, false)
      verify(named(app, "exchange-submit").text.indexOf("Removing") < 0)
      tryVerify(function() { return named(app, "exchange-error").visible }, 2000)
      verify(named(app, "exchange-error").text.indexOf("Signed out") === 0)
      verify(named(app, "exchange-error").text.indexOf("not removed") < 0)
    }

    // A sign-in's keyring write and a removal's delete would race; the write
    // finishing after the delete would leave the password behind the mailbox.
    function test_a_removal_while_a_sign_in_is_finishing_waits_for_its_write() {
      var request = removable()
      delete keyring.entries[accountId]
      var account = mailService.findAccount(accountId)
      account.auth.lookedUp = true
      account.auth.stored = false
      openEditor(1)
      keyring.hold = true
      verify(account.auth.signIn(secret))
      tryVerify(function() { return keyring.pending.length === 1 }, 2000, "the write is waiting")
      compare(account.auth.loginBusy, true)
      compare(named(app, "exchange-remove").enabled, false, "Remove waits for the sign-in")
      app.confirmAccountRemoval(request)
      wait(50)
      verify(present(), "not removed while the write is in flight")
      compare(keyring.deletes, [], "and nothing deleted that the write would put back")
      verify(account.auth.lastError.indexOf("being finished") >= 0)
      release()
      tryCompare(account.auth, "loginBusy", false, 2000)
      compare(keyring.entries[accountId], secret)
      app.confirmAccountRemoval(request)
      tryVerify(function() { return !present() }, 2000)
      compare(keyring.entries[accountId], undefined, "the delete came after the write")
    }

    // The path a person can take: a new password being written, Sign out, then
    // Remove. The write lands after the sign-out, so the removal has to wait for
    // it, or the password it writes stays behind the mailbox.
    function test_a_removal_after_a_sign_out_waits_for_the_password_still_being_written() {
      var request = removable()
      var account = mailService.findAccount(accountId)
      tryVerify(function() { return account.ready }, 2000)
      openEditor(1)
      keyring.hold = true
      verify(account.auth.signIn("new-synthetic-passw0rd"))
      tryVerify(function() { return keyring.pending.length === 1 }, 2000, "the new password is being written")
      mailService.signOut()
      tryVerify(function() { return keyring.deletes.length === 1 }, 2000, "signed out by another way all the same")
      compare(account.auth.loginBusy, false)
      app.confirmAccountRemoval(request)
      wait(50)
      verify(present(), "not removed while the write is in flight")
      verify(account.auth.lastError.indexOf("being finished") >= 0)
      compare(named(app, "exchange-remove").enabled, false, "Remove waits for the write")
      release()
      tryVerify(function() { return keyring.entries[accountId] === undefined }, 2000, "the late write is taken out again")
      app.confirmAccountRemoval(request)
      tryVerify(function() { return !present() }, 2000)
      compare(keyring.entries[accountId], undefined, "nothing left behind the mailbox")
    }

    function test_signing_out_during_a_password_write_leaves_no_password() {
      keyring.entries[accountId] = secret
      var account = seed()
      tryVerify(function() { return account.ready }, 2000)
      keyring.hold = true
      openEditor(0)
      verify(account.auth.signIn("new-synthetic-passw0rd"))
      tryVerify(function() { return keyring.pending.length === 1 }, 2000)
      compare(named(app, "exchange-sign-out").enabled, false, "Sign out waits for the write")
      account.signOut()
      tryVerify(function() { return keyring.entries[accountId] === undefined }, 2000)
      release()
      tryVerify(function() { return keyring.deletes.length === 2 }, 2000, "the write that lands after it goes again")
      compare(keyring.entries[accountId], undefined)
      compare(account.auth.loggedIn, false)
    }

    function signedOutWhileDown() {
      keyring.entries[accountId] = secret
      var account = seed()
      tryVerify(function() { return account.ready }, 2000)
      mailService.backend.connected = false
      account.signOut()
      keyring.failDeletes = true
      BackendFixture.markReady(mailService, 9)
      tryVerify(function() { return keyring.deletes.length === 1 }, 2000)
      tryVerify(function() { return account.auth.lastError.indexOf("Signed out, but the keyring") === 0 }, 2000,
        "the refused delete has been answered")
      return account
    }

    function test_a_failed_owed_sign_out_says_so() {
      var account = signedOutWhileDown()
      compare(keyring.entries[accountId], secret)
      compare(account.auth.loggedIn, false)
    }

    function test_a_sign_in_after_a_failed_owed_sign_out_is_not_undone_by_a_restart() {
      var account = signedOutWhileDown()
      keyring.failDeletes = false
      verify(account.auth.signIn("new-synthetic-passw0rd"))
      tryVerify(function() { return account.auth.loggedIn }, 2000, "signed in again")
      compare(account.auth.signOutOwed, false)
      var deletes = keyring.deletes.length
      mailService.backend.connected = false
      BackendFixture.markReady(mailService, 9)
      wait(100)
      compare(keyring.deletes.length, deletes, "the restart deletes nothing")
      compare(keyring.entries[accountId], "new-synthetic-passw0rd")
      compare(account.auth.loggedIn, true)
    }

    // Account hosts are rebuilt whenever the list changes. A password write from
    // a host that is gone still counts, and the mailbox's removal waits for it.
    function test_a_removal_after_a_rebuild_waits_for_the_write_of_the_host_before() {
      var bob = "exchange:bob@corp.example.test"
      keyring.entries[accountId] = secret
      keyring.entries[bob] = "bob-synthetic-passw0rd"
      seed(null, [entryFor("ada@corp.example.test"), entryFor("bob@corp.example.test")])
      var jane = mailService.findAccount(accountId)
      tryVerify(function() { return jane.ready }, 2000)
      keyring.hold = true
      verify(jane.auth.signIn("new-synthetic-passw0rd"))
      tryVerify(function() { return keyring.pending.length === 1 }, 2000, "the new password is being written")
      app.confirmAccountRemoval({ id: bob, email: "bob@corp.example.test", index: 1 })
      tryVerify(function() {
        return !mailService.accountList.accounts.some(function(entry) { return entry.id === bob })
      }, 2000, "another mailbox is removed meanwhile")
      tryVerify(function() {
        var host = mailService.findAccount(accountId)
        return host !== null && host !== jane
      }, 2000, "the mailbox's host was rebuilt")
      var rebuilt = mailService.findAccount(accountId)
      var request = { id: accountId, email: "jane@corp.example.test", index: 1 }
      app.confirmAccountRemoval(request)
      wait(50)
      verify(present(), "not removed while the write of the host before is in flight")
      verify(rebuilt.auth.lastError.indexOf("being finished") >= 0)
      tryCompare(rebuilt.auth, "writesInFlight", 1, 2000, "and the rebuilt host shows it")
      release()
      tryCompare(rebuilt.auth, "writesInFlight", 0, 2000)
      compare(keyring.entries[accountId], "new-synthetic-passw0rd")
      app.confirmAccountRemoval(request)
      tryVerify(function() { return !present() }, 2000)
      compare(keyring.entries[accountId], undefined, "no password left behind the mailbox")
    }

    function test_a_sign_out_owed_across_a_rebuild_is_still_made_once_the_backend_is_up() {
      keyring.entries[accountId] = secret
      seed(null, [entryFor("ada@corp.example.test")])
      var jane = mailService.findAccount(accountId)
      tryVerify(function() { return jane.ready }, 2000)
      keyring.deletes = []
      mailService.backend.connected = false
      jane.signOut()
      var list = JSON.parse(JSON.stringify(mailService.accountList))
      list.accounts.unshift(entryFor("bob@corp.example.test"))
      mailService.accountList = list
      tryVerify(function() {
        var host = mailService.findAccount(accountId)
        return host !== null && host !== jane
      }, 2000, "the mailbox's host was rebuilt")
      compare(mailService.findAccount(accountId).auth.loggedIn, false, "still signed out")
      compare(keyring.deletes, [])
      BackendFixture.markReady(mailService, 9)
      tryVerify(function() { return keyring.deletes.indexOf(accountId) >= 0 }, 2000, "the owed delete is made")
      compare(keyring.entries[accountId], undefined)
    }

    function test_an_owed_sign_out_follows_its_address_not_the_row() {
      var jill = "exchange:jill@corp.example.test"
      keyring.entries[accountId] = secret
      keyring.entries[jill] = "jill-synthetic-passw0rd"
      seed(null, [entryFor("ada@corp.example.test")])
      var jane = mailService.findAccount(accountId)
      tryVerify(function() { return jane.ready }, 2000)
      keyring.deletes = []
      mailService.backend.connected = false
      jane.signOut()
      // The row takes another address before the backend is up.
      var list = JSON.parse(JSON.stringify(mailService.accountList))
      list.accounts[1].email = "jill@corp.example.test"
      list.accounts[1].id = jill
      if (list.activeId === accountId) list.activeId = jill
      mailService.accountList = list
      tryVerify(function() { return mailService.findAccount(jill) !== null }, 2000)
      BackendFixture.markReady(mailService, 9)
      tryVerify(function() { return keyring.deletes.length >= 1 }, 2000)
      wait(100)
      compare(keyring.deletes, [accountId], "the address that was signed out, and no other")
      compare(keyring.entries[jill], "jill-synthetic-passw0rd")
    }

    // Any Exchange mailbox's host may send an owed delete; a refusal is still
    // shown on the page of the mailbox that was signed out.
    function test_a_failed_owed_sign_out_is_shown_whichever_mailbox_sends_it() {
      keyring.entries[accountId] = secret
      keyring.entries["exchange:ada@corp.example.test"] = "ada-synthetic-passw0rd"
      seed(null, [entryFor("ada@corp.example.test")])
      var jane = mailService.findAccount(accountId)
      tryVerify(function() { return jane.ready && mailService.accountAt(0).ready }, 2000)
      keyring.deletes = []
      mailService.backend.connected = false
      jane.signOut()
      keyring.failDeletes = true
      BackendFixture.markReady(mailService, 9)
      tryVerify(function() { return keyring.deletes.indexOf(accountId) >= 0 }, 2000)
      tryVerify(function() { return jane.auth.lastError.indexOf("Signed out, but the keyring") === 0 }, 2000,
        "the signed-out mailbox says so")
      verify(mailService.accountAt(0).auth.lastError.indexOf("Signed out") < 0, "and only that one")
      compare(keyring.entries[accountId], secret)
    }

    // Signed out while a password was being written, the write it has to take
    // out again is still on its way: a sign-in now waits for it.
    function test_a_sign_in_waits_while_a_password_write_is_still_in_flight() {
      keyring.entries[accountId] = secret
      var account = seed()
      tryVerify(function() { return account.ready }, 2000)
      keyring.hold = true
      verify(account.auth.signIn("first-synthetic-passw0rd"))
      tryVerify(function() { return keyring.pending.length === 1 }, 2000)
      account.signOut()
      verify(!account.auth.signIn("second-synthetic-passw0rd"), "refused while the write is in flight")
      verify(account.auth.lastError.indexOf("still being finished") >= 0)
      release()
      tryVerify(function() { return keyring.entries[accountId] === undefined }, 2000, "the late write is taken out")
      tryCompare(account.auth, "writesInFlight", 0, 2000)
      verify(account.auth.signIn("second-synthetic-passw0rd"), "and then a sign-in goes")
      tryVerify(function() { return keyring.pending.length === 1 }, 2000)
      release()
      tryVerify(function() { return account.auth.loggedIn }, 2000)
      compare(keyring.entries[accountId], "second-synthetic-passw0rd")
    }

    // Rows are the hosts' places, not the mailboxes': removing the first leaves
    // its host to be the second mailbox, and what the keyring holds for that one
    // is its own.
    function test_removing_a_mailbox_leaves_the_password_of_the_one_that_takes_its_row() {
      var other = "exchange:ada@corp.example.test"
      keyring.entries[accountId] = secret
      keyring.entries[other] = "ada-synthetic-passw0rd"
      seed(null, [entryFor("ada@corp.example.test")])
      var first = mailService.accountAt(0)
      tryVerify(function() { return first.ready && mailService.accountAt(1).ready }, 2000)
      mailService.activeIndex = -1
      keyring.deletes = []
      app.confirmAccountRemoval({ id: other, email: "ada@corp.example.test", index: 0 })
      wait(200)
      compare(keyring.deletes, [other], "the one that was removed")
      compare(keyring.entries[accountId], secret, "and not the one that took its place")
      tryVerify(function() { return mailService.accountAt(0).ready }, 2000, "which is still signed in")
    }

    // The backend reads a mailbox's settings and its password separately, so the
    // old password has to be out of the keyring before settings that name another
    // server are saved: not asked of the new one in between, and not carried over.
    function test_changing_the_server_asks_for_the_password_again_and_releases_the_old_one_first() {
      var account = signedIn()
      var form = openEditor()
      var field = named(app, "exchange-server-field")
      field.text = "https://other.example.test/EWS/Exchange.asmx"
      compare(named(app, "exchange-submit").text, "Save changes")
      compare(named(app, "exchange-secret-field").text, "")
      var before = fixture.requests.length
      form.submit()
      compare(named(app, "exchange-error").text,
        "Enter the password again: it is only sent to the server it was entered for")
      compare(fixture.requests.length, before, "nothing was done")
      compare(keyring.entries[accountId], secret)

      named(app, "exchange-secret-field").text = "another-synthetic-passw0rd"
      form.submit()
      tryVerify(function() { return keyring.entries[accountId] === "another-synthetic-passw0rd" }, 2000)
      var order = methods(fixture.requests.slice(before))
      var released = order.indexOf("credentials.delete")
      var saved = order.indexOf("accounts.save")
      verify(released >= 0 && saved >= 0 && released < saved, "the old password went before the new settings: " + order)
      var checks = sent("exchange.verify").filter(function(r) { return r.params.settings !== undefined })
      compare(checks.length, 2)
      compare(checks[1].params.settings.ewsUrl, "https://other.example.test/EWS/Exchange.asmx")
      compare(checks[1].params.settings.authScheme, "auto",
        "the method the old server signed in with is not carried to the new one")
      compare(checks[1].params.secret, "another-synthetic-passw0rd")
      tryVerify(function() { return account.auth.loggedIn }, 2000)
    }

    // A new server with a password that cannot be one changes nothing: the old
    // password stays for the old server, which stays saved.
    function test_a_new_server_with_a_control_character_in_the_password_keeps_the_old_one() {
      var account = signedIn()
      var form = openEditor()
      named(app, "exchange-server-field").text = "https://other.example.test/EWS/Exchange.asmx"
      named(app, "exchange-secret-field").text = "another\u0001synthetic"
      var before = fixture.requests.length
      var checks = sent("exchange.verify").length
      form.submit()
      wait(100)
      compare(named(app, "exchange-error").text, "The password contains a control character. Enter it again")
      compare(fixture.requests.length, before, "nothing was done")
      compare(keyring.entries[accountId], secret)
      compare(mailService.accountList.accounts[0].exchange.ewsUrl, ewsUrl)
      compare(sent("exchange.verify").length, checks, "and the new server was asked nothing")
      compare(account.auth.loggedIn, true)
    }

    // A keyring that could not be read at start leaves the mailbox signed out
    // with its password still saved for the old server. Correcting the server
    // takes that password out before the new address is written down.
    function test_a_server_corrected_while_signed_out_releases_the_saved_password_first() {
      keyring.entries[accountId] = secret
      keyring.locked = true
      var account = seed()
      tryCompare(account.auth, "credentialLookupBusy", false, 2000)
      compare(account.auth.loggedIn, false)
      keyring.locked = false
      var form = openEditor()
      named(app, "exchange-server-field").text = "https://other.example.test/EWS/Exchange.asmx"
      named(app, "exchange-secret-field").text = "another-synthetic-passw0rd"
      var before = fixture.requests.length
      form.submit()
      tryVerify(function() { return keyring.entries[accountId] === "another-synthetic-passw0rd" }, 2000)
      var order = methods(fixture.requests.slice(before))
      var released = order.indexOf("credentials.delete")
      var saved = order.indexOf("accounts.save")
      verify(released >= 0 && saved >= 0 && released < saved, "the old password went before the new settings: " + order)
    }

    // A keyring that will not let the old password go keeps the old settings:
    // writing the new server beside it would pair the two.
    function test_a_password_the_keyring_will_not_remove_keeps_the_old_server() {
      signedIn()
      var form = openEditor()
      named(app, "exchange-server-field").text = "https://other.example.test/EWS/Exchange.asmx"
      named(app, "exchange-secret-field").text = "another-synthetic-passw0rd"
      keyring.failDeletes = true
      var before = fixture.requests.length
      var checks = sent("exchange.verify").length
      form.submit()
      tryVerify(function() { return keyring.deletes.length > 0 }, 2000)
      wait(100)
      verify(methods(fixture.requests.slice(before)).indexOf("accounts.save") < 0, "nothing was saved")
      compare(mailService.accountList.accounts[0].exchange.ewsUrl, ewsUrl)
      compare(sent("exchange.verify").length, checks, "and the new server was asked nothing")
      verify(named(app, "exchange-error").text.indexOf("could not be removed from the system keyring") >= 0)
    }

    // A removal whose keyring delete failed leaves a password under the address.
    // Adding that address again, perhaps on another server, takes it out before
    // the settings are saved, so nothing reads it as this server's password.
    function test_a_password_left_behind_for_an_address_is_removed_before_it_is_added_again() {
      keyring.entries[accountId] = "left-behind-passw0rd"
      var leftover = []
      server.script["exchange.list"] = function(request) {
        if (keyring.entries[accountId] === "left-behind-passw0rd") leftover.push(request.method)
        return undefined
      }
      // The first password typed is refused, so the keyring keeps whatever it had.
      server.script["exchange.verify"] = function(request) {
        return request.params.settings !== undefined ? { error: "exchange_unauthorized" } : undefined
      }
      var account = openForm()
      var before = fixture.requests.length
      pressSignIn(account)
      tryCompare(account.auth, "loginBusy", false, 2000)
      var order = methods(fixture.requests.slice(before))
      var released = order.indexOf("credentials.delete")
      var saved = order.indexOf("accounts.save")
      verify(released >= 0 && saved >= 0 && released < saved, "the old password went before the new settings: " + order)
      compare(keyring.entries[accountId], undefined)
      // A restart finds no password, so nothing is sent until one is typed.
      account.auth.restoreSession()
      tryCompare(account.auth, "credentialLookupBusy", false, 2000)
      compare(account.auth.loggedIn, false)
      wait(100)
      compare(leftover, [], "nothing was asked of the server with the password left behind")
    }

    // Taking the address of another mailbox in the list is refused as a
    // duplicate, and that mailbox keeps its password.
    function test_a_password_of_the_mailbox_whose_address_is_typed_is_left_alone() {
      var bob = "exchange:bob@corp.example.test"
      keyring.entries[bob] = "bob-synthetic-passw0rd"
      keyring.entries[accountId] = secret
      var account = seed(undefined, [entryFor("bob@corp.example.test")])
      tryVerify(function() { return account.ready }, 2000)
      var form = openEditor(1)
      named(app, "exchange-address-field").text = "bob@corp.example.test"
      named(app, "exchange-secret-field").text = "another-synthetic-passw0rd"
      form.submit()
      tryVerify(function() { return keyring.deletes.length > 0 }, 2000)
      wait(100)
      compare(keyring.deletes.indexOf(bob), -1)
      compare(keyring.entries[bob], "bob-synthetic-passw0rd")
    }

    function test_changing_the_address_asks_for_the_password_again() {
      signedIn()
      var form = openEditor()
      named(app, "exchange-address-field").text = "jane.doe@corp.example.test"
      var before = fixture.requests.length
      form.submit()
      compare(named(app, "exchange-error").text,
        "Enter the password again: it is only sent to the server it was entered for")
      compare(fixture.requests.length, before, "nothing was done")
      compare(keyring.entries[accountId], secret)
    }

    // A login that is only the address was not typed, so it is not shown as one,
    // and leaving it empty is not a change of login.
    function test_a_saved_login_that_is_only_the_address_is_not_shown_and_not_a_change() {
      keyring.entries[accountId] = secret
      var account = seed({ exchange: { ewsUrl: ewsUrl, username: "jane@corp.example.test", authScheme: "ntlm" } })
      tryVerify(function() { return account.ready }, 2000)
      var form = openEditor()
      compare(named(app, "exchange-username-field").text, "")
      compare(named(app, "exchange-server-field").text, ewsUrl)
      var before = fixture.requests.length
      form.submit()
      wait(100)
      compare(keyring.entries[accountId], secret, "the password stays")
      verify(methods(fixture.requests.slice(before)).indexOf("credentials.delete") < 0)
      compare(mailService.accountList.accounts[0].exchange.authScheme, "ntlm", "a pinned method is not lost")
    }

    function test_saving_what_leaves_the_server_and_login_alone_asks_nothing_of_the_server() {
      var account = signedIn()
      var form = openEditor()
      var before = fixture.requests.length
      var calls = server.calls.length
      form.submit()
      wait(100)
      compare(keyring.entries[accountId], secret, "the password stays")
      compare(sent("exchange.verify").filter(function(r) { return r.params.settings !== undefined }).length, 1,
        "and the server is not asked about it again")
      verify(methods(fixture.requests.slice(before)).indexOf("credentials.delete") < 0)
      compare(account.auth.loggedIn, true)
    }
  }
}
