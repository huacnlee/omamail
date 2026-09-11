import QtQuick
import QtTest
import "../../providers" as Providers

Item {
  Component {
    id: factory
    Providers.OutlookAuth {
      pluginDir: "/tmp/omamail-test"
      accountId: "outlook:alice@hotmail.com"
      configuredClientId: "12345678-1234-4abc-9def-1234567890ab"
      configuredEmail: "alice@hotmail.com"
      property int reviewRefreshRequests: 0
      property int reviewResponseStatus: 200
      property bool deferResponse: false
      property var responseCallback: null
      function postForm(url, body, callback) {
        reviewRefreshRequests++
        if (deferResponse) {
          responseCallback = callback
          return
        }
        if (reviewResponseStatus !== 200) {
          callback(reviewResponseStatus, JSON.stringify({ error: "invalid_grant" }))
          return
        }
        callback(200, JSON.stringify({
          access_token: "synthetic-access-alice",
          refresh_token: "synthetic-refresh-alice",
          expires_in: 3600
        }))
      }
    }
  }
  TestCase {
    name: "OutlookSecurityReview"
    function startLookup() {
      var auth = createTemporaryObject(factory, parent)
      verify(auth !== null)
      wait(1)
      auth.restoreSession()
      compare(auth.sessionBusy, true)
      return auth
    }
    function lookupProcess(auth) {
      for (var i = 0; i < auth.children.length; i++) {
        var child = auth.children[i]
        if (child.command && child.command[0] === "secret-tool"
            && child.command[1] === "lookup") return child
      }
      fail("No pending keyring lookup")
    }
    function deliverLookup(auth) {
      var process = lookupProcess(auth)
      process.stdout.text = "synthetic-refresh-alice\n"
      process.running = false
      process.exited(0)
    }
    function finishJob(auth) {
      for (var i = 0; i < auth.children.length; i++) {
        var child = auth.children[i]
        if (child.command && (child.command[0] === "/tmp/omamail-test/scripts/keyring-store.sh"
            || child.command[1] === "clear")) {
          var command = child.command.slice()
          child.started()
          child.running = false
          child.exited(0)
          return command
        }
      }
      fail("No keyring write/clear in progress")
    }
    function test_current_lookup_delivers_token_and_stores_for_its_account() {
      var auth = startLookup()
      var calls = 0
      auth.withCredentials(function(token, error) {
        compare(token, "synthetic-access-alice")
        compare(error, "")
        calls++
      })
      deliverLookup(auth)
      compare(calls, 1)
      compare(auth.loggedIn, true)
      var command = finishJob(auth)
      compare(command[command.length - 1], "outlook:alice@hotmail.com")
      compare(auth.keyringJob, null)
    }
    function test_logout_must_discard_pending_keyring_result() {
      var auth = startLookup()
      auth.logout()
      compare(auth.loggedIn, false)
      deliverLookup(auth)
      compare(auth.loggedIn, false, "A late lookup must not resurrect the session")
      compare(auth.reviewRefreshRequests, 0,
        "A completed lookup must not refresh credentials after logout")
      compare(auth.loggedIn, false)
    }
    function test_account_change_must_discard_old_lookup() {
      var auth = startLookup()
      auth.accountId = "outlook:bob@hotmail.com"
      auth.configuredEmail = "bob@hotmail.com"
      deliverLookup(auth)
      compare(auth.keyringJob, null, "Alice's refreshed token must not be queued for Bob's keyring entry")
      compare(auth.reviewRefreshRequests, 0,
        "Alice's lookup must not start a refresh in Bob's account")
    }
    function test_logout_must_clear_current_account() {
      var auth = startLookup()
      // Finish the old lookup without a saved session, then reuse the host.
      var lookup = lookupProcess(auth)
      lookup.stdout.text = ""
      lookup.running = false
      lookup.exited(1)
      auth.accountId = "outlook:bob@hotmail.com"
      auth.configuredEmail = "bob@hotmail.com"
      auth.logout()
      for (var i = 0; i < auth.children.length; i++) {
        var child = auth.children[i]
        if (child.command && child.command[1] === "clear") {
          compare(child.command[child.command.length - 1], "outlook:bob@hotmail.com",
            "Sign-out must clear Bob's token, not Alice's previous lookup key")
          return
        }
      }
      fail("No keyring clear requested")
    }
    function test_failed_restore_must_complete_waiting_requests() {
      var auth = startLookup()
      auth.reviewResponseStatus = 400
      var called = 0
      auth.withCredentials(function(token, error) { called++ })
      deliverLookup(auth)
      compare(called, 1, "A request queued behind restore must receive its authentication failure")
      compare(auth.tokenWaiters.length, 0)
    }
    function test_empty_lookup_completes_all_waiting_requests() {
      var auth = startLookup()
      var calls = 0
      for (var i = 0; i < 2; i++) auth.withCredentials(function(token, error) {
        compare(token, "")
        verify(error !== "")
        calls++
      })
      var lookup = lookupProcess(auth)
      lookup.running = false
      lookup.exited(1)
      compare(calls, 2)
      compare(auth.tokenWaiters.length, 0)
    }
    function test_waiter_signout_prevents_token_delivery_to_remaining_waiters() {
      var auth = startLookup()
      var calls = 0
      auth.withCredentials(function(token, error) {
        compare(token, "synthetic-access-alice")
        auth.logout()
        calls++
      })
      auth.withCredentials(function(token, error) {
        compare(token, "")
        verify(error !== "")
        calls++
      })
      deliverLookup(auth)
      compare(calls, 2)
      compare(auth.loggedIn, false)
    }
    function test_logout_discards_late_http_response() {
      var auth = startLookup()
      auth.deferResponse = true
      deliverLookup(auth)
      verify(auth.refreshBusy)
      var respond = auth.responseCallback
      auth.logout()
      respond(200, JSON.stringify({ access_token: "stale", refresh_token: "stale" }))
      compare(auth.loggedIn, false)
      compare(auth.accessToken, "")
      compare(auth.keyringJob.kind, "clear")
      compare(auth.keyringJobs.length, 0)
      var called = 0
      auth.withCredentials(function(token, error) { compare(token, ""); called++ })
      compare(called, 1)
      compare(auth.reviewRefreshRequests, 1)
    }
    function test_client_change_discards_late_http_response() {
      var auth = startLookup()
      auth.deferResponse = true
      deliverLookup(auth)
      var respond = auth.responseCallback
      auth.configuredClientId = "87654321-1234-4abc-9def-1234567890ab"
      respond(200, JSON.stringify({ access_token: "stale", refresh_token: "stale" }))
      compare(auth.loggedIn, false)
      compare(auth.keyringJob, null)
    }
    function test_store_then_logout_then_account_change_clears_original_key() {
      var auth = startLookup()
      deliverLookup(auth)
      compare(auth.keyringJob.kind, "store")
      auth.logout()
      compare(auth.keyringJobs.length, 1)
      auth.accountId = "outlook:bob@hotmail.com"
      auth.configuredEmail = "bob@hotmail.com"
      var stored = finishJob(auth)
      compare(stored[stored.length - 1], "outlook:alice@hotmail.com")
      compare(auth.keyringJob.kind, "clear")
      var cleared = finishJob(auth)
      compare(cleared[cleared.length - 1], "outlook:alice@hotmail.com")
      compare(auth.keyringJob, null)
    }
    function test_two_logouts_do_not_drop_second_clear() {
      var auth = startLookup()
      auth.logout()
      auth.accountId = "outlook:bob@hotmail.com"
      auth.configuredEmail = "bob@hotmail.com"
      auth.logout()
      compare(auth.keyringJobs.length, 1)
      var first = finishJob(auth)
      var second = finishJob(auth)
      compare(first[first.length - 1], "outlook:alice@hotmail.com")
      compare(second[second.length - 1], "outlook:bob@hotmail.com")
    }
    function test_old_lookup_cannot_clear_replacement_lookup() {
      var auth = startLookup()
      var old = lookupProcess(auth)
      auth.accountId = "outlook:bob@hotmail.com"
      auth.configuredEmail = "bob@hotmail.com"
      wait(1)
      var current = auth.lookupProcess
      verify(current !== null && current !== old)
      old.stdout.text = "synthetic-refresh-alice"
      old.running = false
      old.exited(0)
      compare(auth.lookupProcess, current)
      compare(auth.reviewRefreshRequests, 0)
    }
    function test_verification_from_previous_signin_cannot_accept_new_token() {
      var auth = startLookup()
      var oldGeneration = auth.sessionGeneration
      auth.cancelLogin()
      auth.loginBusy = true
      auth.pendingAccessToken = "new-access"
      auth.pendingRefreshToken = "new-refresh"
      auth.pendingExpiresIn = 3600
      auth.completeSignIn(true, "", oldGeneration)
      compare(auth.loggedIn, false)
      compare(auth.keyringJob, null)
      auth.completeSignIn(true, "", auth.sessionGeneration)
      compare(auth.loggedIn, true)
      compare(auth.accessToken, "new-access")
    }
  }
}
