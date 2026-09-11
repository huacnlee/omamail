import QtQuick
import QtTest
import "../../providers" as Providers

// The Microsoft sign-in against a Microsoft that is a script: one resource
// per request, and consent for Graph as a second code.
Item {
  Component {
    id: factory
    Providers.OutlookAuth {
      pluginDir: "/tmp/omamail-test"
      accountId: "outlook:alice@example.test"
      configuredClientId: "12345678-1234-4abc-9def-1234567890ab"
      configuredEmail: "alice@example.test"
      entrySettings: ({ tenant: "organizations", send: "graph" })
      property var requests: []
      // Whether this client has been consented for Graph, which the Graph
      // sign-in grants; whether the person declines the code on screen.
      property bool graphConsented: false
      property bool declineCode: false
      // Who entered the second code, when not the mailbox's own account;
      // whether the Graph check after the mail sign-in is left unanswered.
      property string codeEnteredAs: ""
      property string codeEnteredOid: ""
      // What the Graph exchange grants when not the full scope; whether the
      // saved Graph session is dead.
      property string partialGrant: ""
      // What the second code itself grants when not the full scope.
      property string partialCodeGrant: ""
      // Microsoft lists Graph's scopes short; a mail refresh, or a Graph
      // exchange, left unanswered until the test answers it.
      property bool shortScopes: false
      property bool deferMailRefresh: false
      property bool deferGraphExchange: false
      property var deferred: null
      property bool deferGraphCheck: false
      property var refusals: []
      onGraphRefused: function(reason) { refusals = refusals.concat([reason]) }
      function idToken(name, oid) {
        var claims = { preferred_username: name, tid: "tenant-1", oid: oid }
        return "h." + Qt.btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + ".s"
      }
      function graphIdToken() {
        var name = codeEnteredAs !== "" ? codeEnteredAs : "alice@example.test"
        var oid = codeEnteredOid !== "" ? codeEnteredOid : (codeEnteredAs !== "" ? "oid-" + codeEnteredAs : "oid-alice")
        return idToken(name, oid)
      }
      // Whether the saved session is dead: a bad grant of the other kind.
      property bool deadSession: false
      property string lastDeviceScope: ""
      property int successes: 0
      property int unavailable: 0
      onLoginSucceeded: successes++
      onSessionUnavailable: unavailable++
      function fields(body) {
        var out = {}
        var pairs = String(body).split("&")
        for (var i = 0; i < pairs.length; i++) {
          var pair = pairs[i].split("=")
          out[decodeURIComponent(pair[0])] = decodeURIComponent((pair[1] || "").replace(/\+/g, " "))
        }
        return out
      }
      function mailScopes() { return "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send" }
      function graphScopes() {
        return shortScopes ? "Mail.Send Calendars.ReadWrite openid profile email"
          : "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite"
      }
      function postForm(url, body, callback) {
        var params = fields(body)
        requests = requests.concat([{ url: url, scope: String(params.scope || ""), grant: String(params.grant_type || "") }])
        var scope = String(params.scope || "")
        var forGraph = scope.indexOf("graph.microsoft.com") >= 0
        if (forGraph && scope.indexOf("outlook.office.com") >= 0) {
          callback(400, JSON.stringify({ error: "invalid_request",
            error_description: "AADSTS28000: scope contains more than one resource" }))
          return
        }
        if (url.indexOf("/devicecode") >= 0) {
          lastDeviceScope = scope
          callback(200, JSON.stringify({ device_code: "device-" + requests.length,
            user_code: "CODE" + requests.length, verification_uri: "https://login.microsoft.com/device",
            expires_in: 900, interval: 5 }))
          return
        }
        if (params.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
          if (declineCode) {
            callback(400, JSON.stringify({ error: "authorization_declined" }))
            return
          }
          var graphCode = lastDeviceScope.indexOf("graph.microsoft.com") >= 0
          if (graphCode) graphConsented = true
          callback(200, JSON.stringify({ access_token: graphCode ? "graph-token" : "mail-token",
            refresh_token: graphCode ? "refresh-graph" : "refresh-mail", expires_in: 3600,
            scope: graphCode ? (partialCodeGrant !== "" ? partialCodeGrant : graphScopes()) : mailScopes(),
            id_token: graphCode ? graphIdToken() : idToken("alice@example.test", "oid-alice") }))
          return
        }
        if (params.grant_type === "refresh_token") {
          if (deadSession) {
            callback(400, JSON.stringify({ error: "invalid_grant", error_description: "AADSTS70000: expired" }))
            return
          }
          if (forGraph && deferGraphCheck) return
          if ((forGraph && deferGraphExchange) || (!forGraph && deferMailRefresh)) {
            deferred = callback
            return
          }
          if (forGraph && !graphConsented) {
            callback(400, JSON.stringify({ error: "invalid_grant", suberror: "consent_required",
              error_codes: [65001], error_description: "AADSTS65001: not consented" }))
            return
          }
          callback(200, JSON.stringify({ access_token: forGraph ? "graph-token" : "mail-token",
            refresh_token: "refresh-rotated", expires_in: 3600,
            scope: forGraph ? (partialGrant !== "" ? partialGrant : graphScopes()) : mailScopes(),
            id_token: forGraph ? "" : idToken("alice@example.test", "oid-alice") }))
          return
        }
        callback(400, "{}")
      }
    }
  }
  TestCase {
    name: "OutlookGraphConsent"
    function fresh(settings) {
      var auth = createTemporaryObject(factory, parent, settings || {})
      verify(auth !== null)
      wait(1)
      auth.cancelLogin()
      auth.requests = []
      return auth
    }
    function grants(auth) {
      var out = []
      for (var i = 0; i < auth.requests.length; i++) out.push(auth.requests[i].grant || auth.requests[i].url.replace(/.*\//, ""))
      return out
    }
    // The mail half of a sign-in: the code, the token, the mailbox verified.
    function signInForMail(auth) {
      auth.beginLogin()
      compare(auth.devicePurpose, "mail")
      verify(auth.requests[0].url.indexOf("/devicecode") >= 0)
      verify(auth.requests[0].scope.indexOf("IMAP.AccessAsUser.All") >= 0)
      verify(auth.requests[0].scope.indexOf("graph.microsoft.com") < 0,
        "the device-code request names the mail resource alone")
      auth.pollDeviceCode()
      compare(auth.userCode, "", "the code entered is not shown while the mailbox is verified")
      auth.completeSignIn(true, "", auth.sessionGeneration)
      compare(auth.loggedIn, true)
      compare(auth.accessToken, "mail-token")
    }
    function mailScopesText() { return "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send" }
    function lookupProcess(auth) {
      for (var i = 0; i < auth.children.length; i++) {
        var child = auth.children[i]
        // The one Graph asked for, not the session restore a fresh object
        // starts and `cancelLogin` let go of.
        if (child.command && child.command[0] === "secret-tool" && child.command[1] === "lookup"
            && child.purpose === "graph" && child.running) return child
      }
      fail("No pending keyring lookup for Graph")
    }

    function test_a_mailbox_that_sends_by_smtp_signs_in_with_one_code() {
      var auth = fresh({ entrySettings: { tenant: "organizations", send: "" } })
      signInForMail(auth)
      compare(auth.successes, 1)
      compare(auth.loginBusy, false)
      compare(auth.requests.length, 2, "no Graph exchange is tried")
    }

    function test_graph_send_asks_a_second_code_when_consent_is_missing() {
      var auth = fresh()
      signInForMail(auth)
      compare(auth.successes, 0, "the sign-in waits for Graph")
      compare(auth.loginBusy, true)
      compare(grants(auth)[2], "refresh_token")
      verify(auth.requests[2].scope.indexOf("graph.microsoft.com") >= 0)
      verify(auth.requests[2].scope.indexOf("outlook.office.com") < 0)
      compare(auth.devicePurpose, "graph")
      compare(auth.graphConsentNeeded, true)
      verify(auth.requests[3].url.indexOf("/devicecode") >= 0)
      verify(auth.requests[3].scope.indexOf("offline_access") >= 0)
      verify(auth.requests[3].scope.indexOf("openid") >= 0)
      verify(auth.requests[3].scope.indexOf("Mail.Send") >= 0)
      verify(auth.requests[3].scope.indexOf("Calendars.ReadWrite") >= 0)
      verify(auth.requests[3].scope.indexOf("outlook.office.com") < 0)
      compare(auth.userCode, "CODE4")
      auth.pollDeviceCode()
      compare(auth.successes, 1)
      compare(auth.loginBusy, false)
      compare(auth.devicePurpose, "mail")
      compare(auth.graphConsentNeeded, false)
      compare(auth.graphAccessToken, "graph-token")
      compare(auth.accessToken, "mail-token", "the mail token stands")
      compare(auth.unavailable, 0)
      var got = ""
      auth.withGraphToken(function(token, error) { got = token + "|" + error })
      compare(got, "graph-token|")
    }

    function test_graph_send_signs_in_with_one_code_where_consent_stands() {
      var auth = fresh({ graphConsented: true })
      signInForMail(auth)
      compare(auth.successes, 1)
      compare(auth.loginBusy, false)
      compare(auth.requests.length, 3, "the exchange, and no second code")
      compare(auth.graphAccessToken, "graph-token")
    }

    function test_declining_the_second_code_keeps_the_mail_sign_in() {
      var auth = fresh()
      signInForMail(auth)
      compare(auth.devicePurpose, "graph")
      auth.declineCode = true
      auth.pollDeviceCode()
      compare(auth.loginBusy, false)
      compare(auth.loggedIn, true)
      compare(auth.successes, 1, "the mail sign-in is in")
      compare(auth.unavailable, 0, "the account is not told its session is gone")
      compare(auth.graphConsentNeeded, true, "and the settings page still offers Graph")
      compare(auth.lastError, "", "the mailbox's own error is not Graph's")
      compare(auth.refusals.length, 1)
      verify(auth.refusals[0].indexOf("cancelled") >= 0, auth.refusals[0])
      verify(auth.refusals[0].indexOf("admin approval") >= 0, auth.refusals[0])
    }

    function test_cancelling_the_graph_check_keeps_the_mail_sign_in() {
      var auth = fresh({ deferGraphCheck: true })
      signInForMail(auth)
      compare(auth.loginBusy, true, "the check is under way")
      compare(auth.successes, 0)
      var graphError = ""
      auth.withGraphToken(function(token, error) { graphError = error })
      auth.cancelLogin()
      compare(auth.loggedIn, true)
      compare(auth.successes, 1, "the mail half is in and is said so")
      compare(auth.loginBusy, false)
      compare(graphError, "Sign-in cancelled")
    }

    function test_a_graph_waiter_parked_behind_a_failed_sign_in_is_answered() {
      var auth = fresh({ entrySettings: { tenant: "organizations", send: "" } })
      auth.beginLogin()
      var graphError = ""
      auth.withGraphToken(function(token, error) { graphError = error })
      compare(graphError, "", "parked behind the sign-in")
      auth.declineCode = true
      auth.pollDeviceCode()
      compare(auth.loginBusy, false)
      compare(auth.loggedIn, false)
      compare(auth.unavailable, 1)
      verify(graphError !== "", "answered by what ended the sign-in")
    }

    function test_the_second_code_entered_as_another_account_is_refused() {
      var auth = fresh({ codeEnteredAs: "bob@example.test" })
      signInForMail(auth)
      compare(auth.devicePurpose, "graph")
      auth.pollDeviceCode()
      compare(auth.graphAccessToken, "", "not filed as the mailbox's")
      compare(auth.loggedIn, true)
      compare(auth.accessToken, "mail-token")
      compare(auth.successes, 1)
      compare(auth.graphConsentNeeded, true)
      compare(auth.refusals.length, 1)
      verify(auth.refusals[0].indexOf("bob@example.test") >= 0, auth.refusals[0])
      compare(auth.keyringJobs.length + (auth.keyringJob ? 1 : 0), 1, "the mail token's store alone")
    }

    function test_graph_scopes_listed_short_are_a_full_grant() {
      var auth = fresh({ graphConsented: true, shortScopes: true })
      signInForMail(auth)
      compare(auth.successes, 1)
      compare(auth.requests.length, 3, "no second code for a grant Microsoft lists short")
      compare(auth.graphAccessToken, "graph-token")
      compare(auth.graphConsentNeeded, false)
    }

    function test_a_partial_grant_keeps_the_refresh_token_it_came_with() {
      var auth = fresh({ graphConsented: true, partialGrant: "https://graph.microsoft.com/User.Read" })
      signInForMail(auth)
      compare(auth.devicePurpose, "graph")
      var stored = []
      if (auth.keyringJob) stored.push(auth.keyringJob.token)
      for (var i = 0; i < auth.keyringJobs.length; i++) stored.push(auth.keyringJobs[i].token)
      compare(stored, ["refresh-mail", "refresh-rotated"], "the rotated token is not dropped for want of a scope")
    }

    function test_cancelling_a_settings_graph_round_leaves_the_mail_session_alone() {
      var auth = fresh({ entrySettings: { tenant: "organizations", send: "" }, deferMailRefresh: true })
      auth.accessToken = "mail-token"
      auth.accessTokenExpiresAt = Date.now() + 3600000
      auth.loggedIn = true
      auth.graphConsentNeeded = true
      auth.beginLogin()
      compare(auth.graphRoundBusy, true)
      compare(auth.loginBusy, false)
      // The mail token ages out under the code; a refresh goes out.
      auth.accessTokenExpiresAt = Date.now()
      var mailAnswer = ""
      auth.withCredentials(function(token, error) { mailAnswer = token + "|" + error })
      var lookup = null
      for (var i = 0; i < auth.children.length; i++) {
        var child = auth.children[i]
        if (child.command && child.command[0] === "secret-tool" && child.command[1] === "lookup"
            && child.purpose === "session" && child.running) lookup = child
      }
      verify(lookup !== null, "the mail session's own lookup")
      lookup.stdout.text = "refresh-mail\n"
      lookup.running = false
      lookup.exited(0)
      compare(auth.refreshBusy, true)
      verify(auth.deferred !== null)
      auth.cancelLogin()
      compare(auth.graphRoundBusy, false)
      compare(auth.deviceCode, "")
      compare(auth.refreshBusy, true, "the refresh in flight is not touched")
      compare(mailAnswer, "", "nor its waiter")
      compare(auth.loggedIn, true)
      var answer = auth.deferred
      auth.deferred = null
      answer(200, JSON.stringify({ access_token: "mail-token-2", refresh_token: "refresh-mail-2", expires_in: 3600,
        scope: mailScopesText() }))
      compare(mailAnswer, "mail-token-2|")
      compare(auth.refreshBusy, false)
    }

    function test_signing_out_under_a_settings_code_with_a_refresh_in_flight_frees_the_sign_in() {
      var auth = fresh({ entrySettings: { tenant: "organizations", send: "" }, deferMailRefresh: true })
      auth.accessToken = "mail-token"
      auth.accessTokenExpiresAt = Date.now() + 3600000
      auth.loggedIn = true
      auth.graphConsentNeeded = true
      auth.beginLogin()
      compare(auth.graphRoundBusy, true)
      auth.accessTokenExpiresAt = Date.now()
      auth.withCredentials(function(token, error) {})
      for (var i = 0; i < auth.children.length; i++) {
        var child = auth.children[i]
        if (child.command && child.command[0] === "secret-tool" && child.command[1] === "lookup"
            && child.purpose === "session" && child.running) {
          child.stdout.text = "refresh-mail\n"
          child.running = false
          child.exited(0)
        }
      }
      compare(auth.refreshBusy, true, "a mail refresh is out under the code")
      auth.logout()
      compare(auth.graphRoundBusy, false)
      compare(auth.refreshBusy, false, "signing out is everything's cancel")
      compare(auth.loggedIn, false)
      auth.sessionEnabled = true
      auth.requests = []
      auth.beginLogin()
      compare(auth.devicePurpose, "mail")
      compare(auth.requests.length, 1, "a sign-in can start again")
    }

    function test_a_second_code_issued_without_the_permission_keeps_its_refresh_token() {
      var auth = fresh({ partialCodeGrant: "https://graph.microsoft.com/User.Read" })
      signInForMail(auth)
      compare(auth.devicePurpose, "graph")
      auth.pollDeviceCode()
      compare(auth.graphAccessToken, "")
      compare(auth.refusals.length, 1)
      var stored = []
      if (auth.keyringJob) stored.push(auth.keyringJob.token)
      for (var i = 0; i < auth.keyringJobs.length; i++) stored.push(auth.keyringJobs[i].token)
      verify(stored.indexOf("refresh-graph") >= 0, "the code's refresh token is the live one: " + JSON.stringify(stored))
      compare(auth.loggedIn, true)
    }

    function test_a_refusal_answered_after_a_grant_does_not_ask_again() {
      var auth = fresh({ entrySettings: { tenant: "organizations", send: "" }, deferGraphExchange: true })
      auth.accessToken = "mail-token"
      auth.accessTokenExpiresAt = Date.now() + 3600000
      auth.loggedIn = true
      var answer = ""
      auth.withGraphToken(function(token, error) { answer = token + "|" + error })
      var lookup = lookupProcess(auth)
      lookup.stdout.text = "refresh-mail\n"
      lookup.running = false
      lookup.exited(0)
      verify(auth.deferred !== null, "the exchange is out")
      // Meanwhile the code is entered from the settings page.
      auth.graphConsentNeeded = true
      auth.beginLogin()
      compare(auth.devicePurpose, "graph")
      auth.pollDeviceCode()
      compare(auth.graphAccessToken, "graph-token")
      compare(auth.graphConsentNeeded, false)
      compare(answer, "graph-token|", "the waiter has its token from the code")
      var late = auth.deferred
      auth.deferred = null
      late(400, JSON.stringify({ error: "invalid_grant", suberror: "consent_required", error_codes: [65001] }))
      compare(auth.graphConsentNeeded, false, "a refusal of a token since replaced changes nothing")
    }

    function test_a_saved_session_not_restored_yet_signs_in_for_mail_first() {
      var auth = fresh({ entrySettings: { tenant: "organizations", send: "" } })
      auth.graphConsentNeeded = true
      auth.savedSessionPresent = true
      auth.loggedIn = false
      auth.beginLogin()
      compare(auth.devicePurpose, "mail")
      verify(auth.requests[0].scope.indexOf("outlook.office.com") >= 0)
    }

    function test_cancelling_the_second_code_keeps_the_mail_sign_in() {
      var auth = fresh()
      signInForMail(auth)
      var graphError = ""
      auth.withGraphToken(function(token, error) { graphError = error })
      auth.cancelLogin()
      compare(auth.loggedIn, true)
      compare(auth.successes, 1)
      compare(auth.loginBusy, false)
      compare(auth.devicePurpose, "mail")
      compare(graphError, "Sign-in cancelled")
    }

    function test_an_exchange_refused_for_consent_makes_the_next_sign_in_graphs() {
      var auth = fresh({ entrySettings: { tenant: "organizations", send: "" } })
      auth.accessToken = "mail-token"
      auth.accessTokenExpiresAt = Date.now() + 3600000
      auth.loggedIn = true
      var answer = ""
      auth.withGraphToken(function(token, error) { answer = token + "|" + error })
      var lookup = lookupProcess(auth)
      lookup.stdout.text = "refresh-mail\n"
      lookup.running = false
      lookup.exited(0)
      verify(answer.indexOf("|Microsoft Graph needs its own consent") === 0, answer)
      compare(auth.graphConsentNeeded, true)
      compare(auth.loggedIn, true)
      auth.requests = []
      auth.beginLogin()
      compare(auth.devicePurpose, "graph")
      compare(auth.loginBusy, false, "the mailbox stays in service")
      compare(auth.graphRoundBusy, true)
      var asked = JSON.stringify(auth.requests)
      verify(auth.requests[0].url.indexOf("/devicecode") >= 0, asked)
      verify(auth.requests[0].scope.indexOf("graph.microsoft.com") >= 0, asked)
      verify(auth.requests[0].scope.indexOf("outlook.office.com") < 0, asked)
      auth.pollDeviceCode()
      compare(auth.loginBusy, false)
      compare(auth.graphRoundBusy, false)
      compare(auth.graphConsentNeeded, false)
      compare(auth.graphAccessToken, "graph-token")
      compare(auth.accessToken, "mail-token")
      compare(auth.successes, 0, "a Graph sign-in alone is not a mailbox sign-in")
      answer = ""
      auth.withGraphToken(function(token, error) { answer = token + "|" + error })
      compare(answer, "graph-token|")
    }

    function test_a_dead_session_is_not_mistaken_for_missing_consent() {
      var auth = fresh({ entrySettings: { tenant: "organizations", send: "" } })
      auth.accessToken = "mail-token"
      auth.accessTokenExpiresAt = Date.now() + 3600000
      auth.loggedIn = true
      auth.deadSession = true
      var answer = ""
      auth.withGraphToken(function(token, error) { answer = error })
      var lookup = lookupProcess(auth)
      lookup.stdout.text = "refresh-mail\n"
      lookup.running = false
      lookup.exited(0)
      compare(auth.graphConsentNeeded, false)
      verify(answer !== "")
      verify(answer.indexOf("Mail.Send") < 0, "a dead session is not a missing permission: " + answer)
      verify(answer.indexOf("Sign in again") >= 0, answer)
    }

    function test_a_graph_token_issued_without_the_permission_asks_the_second_code() {
      var auth = fresh({ graphConsented: true, partialGrant: "https://graph.microsoft.com/User.Read" })
      signInForMail(auth)
      compare(auth.devicePurpose, "graph", "what the exchange did not grant, the code collects")
      compare(auth.graphConsentNeeded, true)
      auth.partialGrant = ""
      auth.pollDeviceCode()
      compare(auth.successes, 1)
      compare(auth.graphAccessToken, "graph-token")
    }

    function test_the_same_account_under_another_name_is_accepted() {
      var auth = fresh({ codeEnteredAs: "alice@contoso.onmicrosoft.com", codeEnteredOid: "oid-alice" })
      signInForMail(auth)
      compare(auth.accountKey, "tenant-1/oid-alice", "the mail sign-in's id token names the account")
      auth.pollDeviceCode()
      compare(auth.graphAccessToken, "graph-token")
      compare(auth.refusals.length, 0)
    }

    function test_another_account_under_the_same_name_is_refused() {
      var auth = fresh({ codeEnteredAs: "alice@example.test", codeEnteredOid: "oid-someone-else" })
      signInForMail(auth)
      auth.pollDeviceCode()
      compare(auth.graphAccessToken, "")
      compare(auth.refusals.length, 1)
      verify(auth.refusals[0].indexOf("not alice@example.test") >= 0, auth.refusals[0])
    }

    function test_signing_out_forgets_what_graph_said() {
      var auth = fresh()
      auth.graphConsentNeeded = true
      auth.logout()
      compare(auth.graphConsentNeeded, false)
    }

    // Work parked on a Graph token belongs to the mailbox that parked it. When
    // the window is pointed at another account the waiter is answered there
    // and then, and the exchange still in flight — now the other account's —
    // never reaches it.
    function test_a_graph_waiter_queued_before_an_account_switch_gets_no_token() {
      var auth = fresh({ graphConsented: true, deferGraphExchange: true })
      var answers = []
      auth.graphWaiters = [function(token, error) { answers.push({ token: token, error: error }) }]
      auth.handleGraphLookup("refresh-alice", auth.sessionContext())
      compare(answers.length, 0, "the exchange is still out")
      verify(auth.deferred !== null, "and its answer is held by the fixture")

      auth.accountId = "outlook:bob@example.test"
      compare(answers.length, 1, "the switch answers what was waiting")
      compare(answers[0].token, "", "and never hands it a token")
      verify(answers[0].error !== "")

      var release = auth.deferred
      auth.deferred = null
      release(200, JSON.stringify({ access_token: "bob-graph-token", refresh_token: "refresh-bob",
        expires_in: 3600, scope: "https://graph.microsoft.com/Mail.Send" }))
      compare(answers.length, 1, "the exchange that landed after the switch says nothing to it")
      compare(auth.graphAccessToken, "", "and is not filed under the mailbox that replaced it")
    }

    // The same, for a sign-out rather than a switch: the waiter is answered
    // once, by the sign-out, and the late exchange adds nothing.
    function test_a_graph_waiter_is_answered_once_by_a_sign_out() {
      var auth = fresh({ graphConsented: true, deferGraphExchange: true })
      var answers = []
      auth.graphWaiters = [function(token, error) { answers.push({ token: token, error: error }) }]
      auth.handleGraphLookup("refresh-alice", auth.sessionContext())
      auth.logout()
      compare(answers.length, 1)
      compare(answers[0].token, "")

      var release = auth.deferred
      auth.deferred = null
      release(200, JSON.stringify({ access_token: "graph-token", refresh_token: "refresh-rotated",
        expires_in: 3600, scope: "https://graph.microsoft.com/Mail.Send" }))
      compare(answers.length, 1)
      compare(auth.graphAccessToken, "")
    }
  }
}
