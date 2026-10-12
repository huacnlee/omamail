import QtQuick
import QtTest
import "../../providers" as Providers

// The Microsoft 365 sign-in on its own: the code, the poll until the person has
// finished, the check that proves the mailbox, the restore of a saved session and
// the sign-out. The backend is a recorder whose answers the test gives by hand;
// nothing here reaches Microsoft, a keyring or a disk.
Item {
  id: root
  width: 400
  height: 300

  readonly property string account: "m365:ada@corp.example.test"
  readonly property string client: "11111111-2222-3333-4444-555555555555"
  readonly property string page: "https://microsoft.com/devicelogin"

  QtObject {
    id: platformStub
    property var opened: []
    function openExternal(url) { opened = opened.concat([url]); return true }
  }

  QtObject {
    id: backendStub
    property bool ready: true
    property int apiVersion: 8
    property var calls: []
    function call(method, params, callback) {
      calls = calls.concat([{ method: method, params: JSON.parse(JSON.stringify(params)), callback: callback,
        answered: false }])
    }
  }

  // Time passes a hundred times as fast: a poll every five seconds is every fifty
  // milliseconds and the first retry of a restore comes after fifty as well.
  Component {
    id: authFactory
    Providers.M365Auth {
      backend: backendStub
      platform: platformStub
      accountId: root.account
      address: "ada@corp.example.test"
      clientId: root.client
      timeScale: 0.01
    }
  }

  SignalSpy { id: succeeded; signalName: "loginSucceeded" }
  SignalSpy { id: loggedOut; signalName: "loggedOut" }
  SignalSpy { id: unavailable; signalName: "sessionUnavailable" }

  TestCase {
    name: "M365Auth"
    when: windowShown

    readonly property var mailbox: ({ ok: true, email: "ada@corp.example.test",
      roles: { inbox: { total: 4, unread: 2 }, junk: null, archive: { total: 7, unread: 0 } } })

    function init() {
      backendStub.calls = []
      backendStub.ready = true
      backendStub.apiVersion = 8
      platformStub.opened = []
    }

    function calls(method) {
      return backendStub.calls.filter(function(call) { return call.method === method })
    }

    function answer(call, result, code) {
      verify(!call.answered, "answered twice: " + call.method)
      call.answered = true
      call.callback(result === undefined ? null : result, code === undefined ? null : { code: -32000, message: code })
    }

    function begin(overrides) {
      return Object.assign({ requestId: "req-1", userCode: "ABCD1234E", verificationUri: root.page,
        expiresIn: 900, interval: 5 }, overrides || {})
    }

    // A built auth object, its spies on it and nothing asked of it yet.
    function built() {
      var auth = createTemporaryObject(authFactory, root)
      verify(auth)
      for (var spy of [succeeded, loggedOut, unavailable]) { spy.target = auth; spy.clear() }
      return auth
    }

    // A mailbox that was just added: its owed restore is answered "nothing saved".
    function made() {
      var auth = built()
      auth.restoreSession()
      answer(calls("m365.verify")[0], null, "m365_signed_out")
      backendStub.calls = []
      return auth
    }

    function polled(count) {
      tryVerify(function() { return calls("m365.signInPoll").length >= count }, 2000, "poll number " + count)
    }

    // The press and the answer with the code, then the first poll answered as given.
    function codeShown(auth, first) {
      auth.beginLogin()
      compare(calls("m365.signInBegin").length, 1)
      answer(calls("m365.signInBegin")[0], begin())
      if (first === undefined) return
      polled(1)
      answer(calls("m365.signInPoll")[0], first)
    }

    // ------------------------------------------------------------- the sign-in

    function test_one_code_is_asked_shown_polled_and_the_mailbox_checked() {
      var auth = made()
      auth.beginLogin()
      compare(calls("m365.signInBegin")[0].params, { accountId: root.account, address: "ada@corp.example.test",
        clientId: root.client }, "the ID is the one typed, and no tenant is chosen")
      compare(auth.signInStage, "starting")
      compare(auth.recoveringSession, false, "a sign-in is not a restore")
      answer(calls("m365.signInBegin")[0], begin())
      compare(auth.userCode, "ABCD1234E")
      compare(auth.verificationUri, root.page)
      compare(auth.signInStage, "waiting")
      compare(platformStub.opened, [root.page], "Microsoft's page is opened once")
      compare(calls("m365.signInPoll").length, 0, "the first poll waits for the interval")

      polled(1)
      compare(calls("m365.signInPoll")[0].params, { requestId: "req-1" })
      wait(150)
      compare(calls("m365.signInPoll").length, 1, "one answer at a time")
      auth.beginLogin()
      compare(calls("m365.signInBegin").length, 1, "one code at a time")
      answer(calls("m365.signInPoll")[0], { state: "pending", warning: "m365_network_failed" })
      polled(2)
      compare(auth.loginBusy, true, "a pending answer, warning or not, is not the end of the wait")
      compare(calls("m365.verify").length, 0, "a code not entered proves nothing")
      answer(calls("m365.signInPoll")[1], { state: "signedIn" })
      compare(auth.signInStage, "checking")
      compare(auth.userCode, "", "the used code is gone")
      compare(calls("m365.verify")[0].params, { accountId: root.account })
      compare(auth.loggedIn, false, "not signed in until the mailbox has answered")
      answer(calls("m365.verify")[0], mailbox)
      compare(auth.loggedIn, true)
      compare(auth.loginBusy, false)
      compare(auth.lastError, "")
      compare(auth.checked.roles.junk, null, "what the check found is kept for the rail")
      compare(succeeded.count, 1)
      compare(calls("m365.signOut").length, 0)
    }

    function test_each_way_a_sign_in_ends_without_a_mailbox() {
      var cases = [[{ state: "declined" }, "declined"], [{ state: "expired" }, "ran out"],
        [{ state: "failed", error: "m365_consent_required" }, "administrator"],
        [{ state: "failed", error: "m365_tenant_invalid" }, "organization"],
        [{ state: "failed", error: "m365_auth_failed" }, "Application (client) ID"],
        [{ state: "failed" }, "Application (client) ID"], [{ state: "failed", error: "never_heard_of_it" }, "Application (client) ID"],
        [{ state: "unheard" }, "not what Omamail expected"], [null, "not what Omamail expected"],
        [{ state: "failed", error: "m365_wrong_account", signedInAs: "bob@other.example.org" }, "bob@other.example.org"],
        [{ state: "failed", error: "auth_keyring_failed" }, "could not be saved"]]
      for (var i = 0; i < cases.length; i++) {
        init()
        var auth = made()
        codeShown(auth, cases[i][0])
        verify(auth.lastError.indexOf(cases[i][1]) >= 0 && auth.lastError.indexOf("m365_") < 0, JSON.stringify(cases[i][0]) + ": " + auth.lastError)
        compare(auth.loginBusy, false)
        compare(auth.userCode, "", "the code is gone")
        compare(calls("m365.verify").length, 0, "nothing is checked")
        compare(calls("m365.signOut").length, 0, "nothing was stored, so nothing is removed")
      }
    }

    function test_a_begin_or_a_poll_that_fails_or_cannot_be_used_ends_the_sign_in() {
      var auth = made()
      auth.beginLogin()
      answer(calls("m365.signInBegin")[0], null, "m365_network_failed")
      compare(auth.lastError, "Microsoft 365 could not be reached. Check your connection")
      compare(auth.loginBusy, false)
      var unusable = [{ verificationUri: "https://evil.example/devicelogin" }, { userCode: "<b>x</b>" }]
      for (var i = 0; i < unusable.length; i++) {
        backendStub.calls = []
        auth.beginLogin()
        answer(calls("m365.signInBegin")[0], begin(unusable[i]))
        compare(auth.lastError, "Microsoft's answer was not what Omamail expected. Try again in a moment", JSON.stringify(unusable[i]))
        compare(auth.userCode, "")
        compare(auth.loginBusy, false)
      }
      compare(platformStub.opened, [], "a page that cannot be trusted is not opened")
      backendStub.calls = []
      auth.beginLogin()
      answer(calls("m365.signInBegin")[0], begin())
      polled(1)
      answer(calls("m365.signInPoll")[0], null, "m365_invalid_request")
      compare(auth.lastError, "Omamail could not make that request. Try again")
      compare(auth.loginBusy, false)
    }

    // ------------------------------------------------------------------ cancel

    function test_cancel_while_waiting_stops_the_poll_and_says_nothing() {
      var auth = made()
      codeShown(auth)
      polled(1)
      auth.cancelLogin()
      compare(auth.loginBusy, false)
      compare(auth.userCode, "")
      compare(auth.lastError, "", "a cancel is not a failure")
      answer(calls("m365.signInPoll")[0], { state: "signedIn" })
      wait(150)
      compare(calls("m365.verify").length, 0, "the code that was cancelled is not proved")
      compare(calls("m365.signOut").length, 1, "and the sign-in the backend kept for it is removed")
      compare(calls("m365.signOut")[0].params, { accountId: root.account, clientId: root.client })
      compare(auth.loggedIn, false)
      compare(calls("m365.signInPoll").length, 1, "and nothing asks again")
      auth.cancelLogin()
      compare(unavailable.count, 0, "cancel with nothing under way does nothing")
    }

    function test_a_poll_answered_after_a_cancel_with_no_sign_in_removes_nothing() {
      var auth = made()
      codeShown(auth)
      polled(1)
      auth.cancelLogin()
      answer(calls("m365.signInPoll")[0], { state: "pending" })
      wait(100)
      compare(calls("m365.signOut").length, 0, "nothing was kept, so nothing is removed")
    }

    function test_cancel_before_the_code_arrives_drops_the_code_when_it_does() {
      var auth = made()
      auth.beginLogin()
      auth.cancelLogin()
      answer(calls("m365.signInBegin")[0], begin())
      compare(auth.userCode, "")
      compare(platformStub.opened, [])
      wait(150)
      compare(calls("m365.signInPoll").length, 0)
    }

    function test_cancel_after_the_code_was_entered_removes_the_sign_in_the_backend_holds() {
      var auth = made()
      codeShown(auth, { state: "signedIn" })
      compare(auth.signInStage, "checking")
      auth.cancelLogin()
      compare(calls("m365.signOut")[0].params, { accountId: root.account, clientId: root.client })
      answer(calls("m365.verify")[0], mailbox)
      compare(auth.loggedIn, false, "the answer of a check nobody wants any more is dropped")
      compare(succeeded.count, 0)
    }

    // A cancelled sign-in's poll answers after a new one was asked for: the newer one
    // writes the same keyring item, and a sign-out for the old one would end it.
    function cancelledThenAgain() {
      var auth = made()
      codeShown(auth)
      polled(1)
      auth.cancelLogin()
      auth.beginLogin()
      answer(calls("m365.signInBegin")[1], begin({ requestId: "req-2" }))
      return auth
    }

    function test_a_late_sign_in_of_a_cancelled_code_leaves_the_newer_sign_in_alone() {
      var auth = cancelledThenAgain()
      answer(calls("m365.signInPoll")[0], { state: "signedIn" })
      compare(calls("m365.signOut").length, 0, "a sign-out now would end the newer sign-in")
      compare(auth.loginBusy, true)
      polled(2)
      compare(calls("m365.signInPoll")[1].params, { requestId: "req-2" })
      answer(calls("m365.signInPoll")[1], { state: "signedIn" })
      answer(calls("m365.verify")[0], mailbox)
      compare(auth.loggedIn, true)
      compare(calls("m365.signOut").length, 0, "the newer sign-in is the one saved")

      // The other order: the newer one is done before the old answer comes.
      init()
      auth = cancelledThenAgain()
      polled(2)
      answer(calls("m365.signInPoll")[1], { state: "signedIn" })
      answer(calls("m365.verify")[0], mailbox)
      answer(calls("m365.signInPoll")[0], { state: "signedIn" })
      compare(auth.loggedIn, true)
      compare(calls("m365.signOut").length, 0, "a sign-out now would remove the session in use")
    }

    function test_a_late_sign_in_left_for_a_newer_one_goes_when_that_one_ends_without_a_mailbox() {
      var auth = cancelledThenAgain()
      answer(calls("m365.signInPoll")[0], { state: "signedIn" })
      compare(calls("m365.signOut").length, 0)
      auth.cancelLogin()
      compare(calls("m365.signOut").length, 1, "the newer one was cancelled too: nobody wants either")
      compare(calls("m365.signOut")[0].params, { accountId: root.account, clientId: root.client })

      init()
      auth = cancelledThenAgain()
      answer(calls("m365.signInPoll")[0], { state: "signedIn" })
      polled(2)
      answer(calls("m365.signInPoll")[1], { state: "declined" })
      compare(calls("m365.signOut").length, 1, "the newer one was declined")
    }

    // The newer sign-in saved its grant and its check failed on the way: the window asks the
    // check again, and the item the late answer would sign out is the one it is about to read.
    function test_a_late_sign_in_leaves_a_newer_one_whose_check_is_to_be_asked_again() {
      var auth = cancelledThenAgain()
      polled(2)
      answer(calls("m365.signInPoll")[1], { state: "signedIn" })
      answer(calls("m365.verify")[0], null, "m365_network_failed")
      compare(auth.loginBusy, false)
      compare(auth.recoveringSession, true, "saved, and checked again with no new code")
      answer(calls("m365.signInPoll")[0], { state: "signedIn" })
      compare(calls("m365.signOut").length, 0, "a sign-out now would delete what the newer sign-in saved")
      tryVerify(function() { return calls("m365.verify").length === 2 }, 2000, "the check is asked again")
      answer(calls("m365.verify")[1], mailbox)
      compare(auth.loggedIn, true)
      compare(calls("m365.signOut").length, 0)
    }

    // Only the application ID changed between the two: the late one is signed out by its own
    // ID at once, which the backend keeps to that ID's sign-ins, and the newer one goes on.
    function test_a_late_sign_in_of_the_id_typed_before_is_signed_out_by_that_id() {
      var auth = made()
      codeShown(auth)
      polled(1)
      auth.cancelLogin()
      var typedNow = "99999999-2222-3333-4444-555555555555"
      auth.clientId = typedNow
      auth.beginLogin()
      compare(calls("m365.signInBegin")[1].params.clientId, typedNow)
      answer(calls("m365.signInBegin")[1], begin({ requestId: "req-2" }))
      answer(calls("m365.signInPoll")[0], { state: "signedIn" })
      compare(calls("m365.signOut").length, 1)
      compare(calls("m365.signOut")[0].params, { accountId: root.account, clientId: root.client })
      compare(auth.loginBusy, true, "the newer sign-in goes on")
      polled(2)
      answer(calls("m365.signInPoll")[1], { state: "signedIn" })
      answer(calls("m365.verify")[0], mailbox)
      compare(auth.loggedIn, true)
      compare(calls("m365.signOut").length, 1, "and what it saved stays")
    }

    // The sign-in of the ID typed before may still be exchanging its code at the backend, which
    // ends only the sign-ins of the ID a sign-out names: removing the mailbox names both IDs, or
    // that grant could be saved afterwards and restored at the next start.
    function test_a_removal_signs_out_every_application_id_a_sign_in_was_asked_with() {
      var auth = made()
      codeShown(auth)
      polled(1)
      auth.cancelLogin()
      var typedNow = "99999999-2222-3333-4444-555555555555"
      auth.clientId = typedNow
      auth.beginLogin()
      answer(calls("m365.signInBegin")[1], begin({ requestId: "req-2" }))
      compare(calls("m365.signOut").length, 0, "nothing is known to be saved yet")
      auth.forgetCredential()
      compare(calls("m365.signOut").map(function(call) { return call.params }),
        [{ accountId: root.account, clientId: typedNow }, { accountId: root.account, clientId: root.client }])
      // Asked again with an ID already asked with, a sign-out still names each ID once.
      init()
      auth = made()
      codeShown(auth)
      auth.cancelLogin()
      auth.beginLogin()
      auth.logout()
      compare(calls("m365.signOut").map(function(call) { return call.params }),
        [{ accountId: root.account, clientId: root.client }])
    }

    // ---------------------------------------------- an answer that never came

    function test_a_poll_whose_answer_was_lost_asks_the_same_request_again() {
      var lost = ["request_timed_out", "Backend request timed out", "Backend response timed out"]
      for (var i = 0; i < lost.length; i++) {
        init()
        var auth = made()
        codeShown(auth)
        polled(1)
        answer(calls("m365.signInPoll")[0], null, lost[i])
        compare(auth.loginBusy, true, lost[i] + " is not a failed sign-in")
        compare(auth.lastError, "")
        polled(2)
        compare(calls("m365.signInPoll")[1].params, { requestId: "req-1" }, "the same request, which kept its outcome")
        answer(calls("m365.signInPoll")[1], { state: "signedIn" })
        answer(calls("m365.verify")[0], mailbox)
        compare(auth.loggedIn, true)
        compare(calls("m365.signOut").length, 0)
      }
    }

    function test_a_cancel_after_a_poll_with_no_outcome_yet_removes_what_it_may_have_saved() {
      // Lost on the way back, or still at Microsoft's or the keyring's when the poll stopped waiting.
      var unsettled = [[null, "request_timed_out"], [null, "Backend response timed out"],
        [{ state: "pending", warning: "m365_exchange_running" }, undefined]]
      for (var i = 0; i < unsettled.length; i++) {
        init()
        var auth = made()
        codeShown(auth)
        polled(1)
        answer(calls("m365.signInPoll")[0], unsettled[i][0], unsettled[i][1])
        auth.cancelLogin()
        compare(calls("m365.signOut").length, 1, JSON.stringify(unsettled[i]))
        compare(calls("m365.signOut")[0].params, { accountId: root.account, clientId: root.client })
      }
      // A poll still in the air at the cancel that then turns out lost is the same.
      init()
      auth = made()
      codeShown(auth)
      polled(1)
      auth.cancelLogin()
      answer(calls("m365.signInPoll")[0], null, "request_timed_out")
      compare(calls("m365.signOut").length, 1)
      // A token request that itself timed out is over and saved nothing.
      init()
      auth = made()
      codeShown(auth)
      polled(1)
      answer(calls("m365.signInPoll")[0], { state: "pending", warning: "m365_timeout" })
      auth.cancelLogin()
      compare(calls("m365.signOut").length, 0, "nothing was saved, so nothing is removed")
    }

    // ------------------------------------------------------------- the check

    function test_a_check_that_fails_leaves_nothing_signed_in_behind() {
      var cases = [["m365_access_denied", true], ["m365_consent_required", true], ["m365_network_failed", false],
        ["m365_timeout", false], [undefined, true]]
      for (var i = 0; i < cases.length; i++) {
        init()
        var auth = made()
        codeShown(auth, { state: "signedIn" })
        if (cases[i][0] === undefined) answer(calls("m365.verify")[0], { ok: false })
        else answer(calls("m365.verify")[0], null, cases[i][0])
        compare(auth.loggedIn, false, String(cases[i][0]))
        compare(auth.loginBusy, false)
        verify(auth.lastError !== "")
        compare(calls("m365.signOut").length, cases[i][1] ? 1 : 0,
          "a failure that stays removes the sign-in; the network failing leaves it")
        auth.reset()
      }
    }

    function test_a_check_the_network_failed_right_after_the_sign_in_is_asked_again_with_no_new_code() {
      var auth = made()
      codeShown(auth, { state: "signedIn" })
      answer(calls("m365.verify")[0], null, "m365_network_failed")
      compare(auth.loginBusy, false)
      compare(auth.recoveringSession, true, "reconnecting, not asking for a code")
      compare(auth.lastError, "Microsoft 365 could not be reached. Check your connection")
      tryVerify(function() { return calls("m365.verify").length === 2 }, 2000, "the check is asked again")
      answer(calls("m365.verify")[1], mailbox)
      compare(auth.loggedIn, true)
      compare(auth.lastError, "")
      compare(calls("m365.signInBegin").length, 1, "and the code was asked for once")
      compare(calls("m365.signOut").length, 0)
    }

    function test_a_backend_that_cannot_be_asked_is_told_so_and_sent_nothing() {
      var auth = made()
      backendStub.apiVersion = 7
      auth.beginLogin()
      compare(auth.lastError, "Update the mail backend to use this mailbox")
      backendStub.apiVersion = 8
      backendStub.ready = false
      auth.beginLogin()
      compare(auth.lastError, "Mail backend is unavailable")
      auth.clientId = "not a guid"
      backendStub.ready = true
      auth.beginLogin()
      compare(auth.lastError, "Add this mailbox's Application (client) ID first")
      compare(auth.credentialsPresent, false)
      compare(backendStub.calls.length, 0)
      compare(auth.loginBusy, false)
    }

    // ----------------------------------------------------------- saved session

    function test_a_saved_session_is_restored_by_the_check_alone() {
      var auth = built()
      auth.restoreSession()
      compare(calls("m365.verify")[0].params, { accountId: root.account })
      compare(auth.recoveringSession, true, "reconnecting, not signed out")
      compare(auth.sessionBusy, true)
      answer(calls("m365.verify")[0], mailbox)
      compare(auth.loggedIn, true)
      compare(auth.recoveringSession, false)
      compare(calls("m365.signInBegin").length + platformStub.opened.length, 0, "no code and no browser for a restore")
    }

    function test_a_restore_that_finds_nothing_is_quiet_and_one_that_fails_says_why() {
      // What the check says, whether the mailbox still waits for a session, the sentence.
      var cases = [["m365_signed_out", false, ""], ["auth_account_missing", false, ""],
        ["m365_consent_required", false, "administrator"], [{ ok: false }, false, "not what Omamail expected"],
        ["m365_network_failed", true, "could not be reached"]]
      for (var i = 0; i < cases.length; i++) {
        init()
        var auth = built()
        auth.restoreSession()
        if (typeof cases[i][0] === "string") answer(calls("m365.verify")[0], null, cases[i][0])
        else answer(calls("m365.verify")[0], cases[i][0])
        compare(auth.recoveringSession, cases[i][1], JSON.stringify(cases[i][0]))
        verify(cases[i][2] === "" ? auth.lastError === "" : auth.lastError.indexOf(cases[i][2]) >= 0, auth.lastError)
        compare(unavailable.count, cases[i][2] === "" ? 0 : 1)
        compare(auth.loggedIn, false)
        wait(120)
        compare(calls("m365.verify").length, cases[i][1] ? 2 : 1, "only a network that is down is asked again")
        compare(calls("m365.signOut").length, 0, "and no session is thrown away for it")
      }
    }

    function test_a_locked_keyring_at_restore_is_waited_out_with_no_new_code() {
      var auth = built()
      auth.restoreSession()
      answer(calls("m365.verify")[0], null, "auth_keyring_failed")
      compare(auth.recoveringSession, true, "the saved sign-in is still there, behind the lock")
      verify(auth.lastError.indexOf("Unlock") >= 0 && auth.lastError.indexOf("could not be saved") < 0, auth.lastError)
      tryVerify(function() { return calls("m365.verify").length === 2 }, 2000, "asked again on the retry schedule")
      answer(calls("m365.verify")[1], mailbox)
      compare(auth.loggedIn, true)
      compare(calls("m365.signInBegin").length + calls("m365.signOut").length, 0, "no new code, nothing removed")
    }

    function test_the_restore_waits_for_the_backend_and_an_old_one_is_not_waited_for() {
      backendStub.ready = false
      var auth = built()
      auth.restoreSession()
      wait(50)
      compare(backendStub.calls.length, 0)
      compare(auth.recoveringSession, true, "owed, so not shown as signed out")
      compare(unavailable.count, 0)
      backendStub.ready = true
      tryVerify(function() { return calls("m365.verify").length === 1 }, 2000, "asked when the backend comes up")
      answer(calls("m365.verify")[0], mailbox)
      compare(auth.loggedIn, true)

      var old = built()
      backendStub.calls = []
      backendStub.apiVersion = 7
      old.restoreSession()
      compare(calls("m365.verify").length, 0)
      compare(old.recoveringSession, false)
      compare(old.lastError, "Update the mail backend to use this mailbox")
      compare(unavailable.count, 1)
    }

    function test_a_press_while_the_restore_is_out_wins_and_the_restore_is_let_go_of() {
      var auth = built()
      auth.restoreSession()
      auth.beginLogin()
      compare(auth.sessionBusy, false)
      answer(calls("m365.verify")[0], mailbox)
      compare(auth.loggedIn, false, "the answer of the restore is dropped")
      answer(calls("m365.signInBegin")[0], begin())
      compare(auth.signInStage, "waiting")
    }

    // ---------------------------------------------------------------- signing out

    function test_signing_out_removes_the_saved_sign_in_and_tells_the_account() {
      var auth = built()
      auth.restoreSession()
      answer(calls("m365.verify")[0], mailbox)
      auth.logout()
      compare(calls("m365.signOut")[0].params, { accountId: root.account, clientId: root.client })
      compare(auth.loggedIn, false)
      compare(auth.checked, null)
      compare(loggedOut.count, 1)
      answer(calls("m365.signOut")[0], null, "auth_keyring_failed")
      verify(auth.lastError.indexOf("could not be removed") >= 0 && auth.lastError.indexOf("keyring") >= 0, auth.lastError)
      auth.restoreSession()
      compare(calls("m365.verify").length, 1, "a signed-out mailbox is not restored")
    }

    // A refresh that holds the sign-in (a keyring waiting to be unlocked) outlasts the backend's
    // wait: the sign-out may not have happened, and the window does not take it as done.
    function test_a_sign_out_that_could_not_wait_for_the_sign_in_says_it_was_not_completed() {
      var auth = built()
      auth.restoreSession()
      answer(calls("m365.verify")[0], mailbox)
      auth.logout()
      answer(calls("m365.signOut")[0], null, "m365_timeout")
      verify(auth.lastError.indexOf("could not be completed") >= 0
        && auth.lastError.indexOf("may still be saved") >= 0, auth.lastError)
      compare(auth.loggedIn, false)
    }

    function test_signing_out_deletes_a_saved_sign_in_even_when_none_was_proved() {
      var auth = made()
      auth.logout()
      compare(calls("m365.signOut").length, 1, "a mailbox added again under the same address starts clean")
    }

    function test_a_removed_mailbox_forgets_its_sign_in_and_one_asked_before_the_backend_is_up_waits_for_it() {
      var auth = built()
      auth.restoreSession()
      answer(calls("m365.verify")[0], mailbox)
      backendStub.ready = false
      auth.forgetCredential()
      compare(auth.loggedIn, false, "the session is forgotten at once")
      compare(loggedOut.count, 1)
      compare(calls("m365.signOut").length, 0, "nothing can be sent yet")
      backendStub.ready = true
      tryVerify(function() { return calls("m365.signOut").length === 1 }, 2000, "sent when the backend is up")
      compare(calls("m365.signOut")[0].params, { accountId: root.account, clientId: root.client })
      compare(calls("m365.verify").length, 1, "and the mailbox is not restored")
    }

    function test_an_application_id_in_capitals_is_sent_as_the_backend_keys_it() {
      var auth = built()
      auth.clientId = "ABCDEF11-2222-3333-4444-55555555555F"
      compare(auth.effectiveClientId, "abcdef11-2222-3333-4444-55555555555f")
      auth.logout()
      compare(calls("m365.signOut")[0].params.clientId, "abcdef11-2222-3333-4444-55555555555f")
    }

    function test_a_request_that_found_the_sign_in_gone_signs_the_window_out_once() {
      var auth = built()
      auth.restoreSession()
      answer(calls("m365.verify")[0], mailbox)
      auth.noteSignedOut()
      compare(auth.loggedIn, false)
      compare(auth.checked, null)
      compare(auth.lastError, "Sign in to Microsoft 365 again")
      compare(unavailable.count, 1)
      auth.noteSignedOut()
      compare(unavailable.count, 1, "told once")
    }

    function test_another_mailbox_drops_what_was_in_the_air_and_has_its_own_session_to_restore() {
      var auth = made()
      codeShown(auth)
      polled(1)
      auth.accountId = "m365:bob@corp.example.test"
      compare(auth.loginBusy, false)
      compare(auth.userCode, "")
      answer(calls("m365.signInPoll")[0], { state: "signedIn" })
      wait(100)
      compare(auth.loggedIn, false)
      tryVerify(function() { return calls("m365.verify").length >= 1 }, 2000, "the new mailbox's session is looked for")
      compare(calls("m365.verify")[0].params, { accountId: "m365:bob@corp.example.test" })
    }
  }
}
