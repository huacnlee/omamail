import QtQuick
import QtTest
import "../../providers" as Providers
import "../../providers/MicrosoftOAuth.js" as Microsoft

// A token failure reaches the providers as the backend's error object, never
// as a bare string. Only Google's refusal of the grant signs the mailbox out,
// and no refusal deletes a grant; anything else keeps the saved session and
// retries.
Item {
  QtObject {
    id: fakePlatform
    property var deletes: []
    function credentialDelete(kind, accountId, clientId, callback) {
      deletes = deletes.concat([{kind:kind,accountId:accountId,clientId:clientId}])
      callback(true, "")
      return true
    }
  }
  QtObject {
    id: fakeBackend
    property bool ready: true
    property int apiVersion: 9
    property var failure: null
    property var calls: []
    // When set, answers wait in `pending` until the test delivers them.
    property bool deferred: false
    property var pending: []
    function call(method, params, callback) {
      calls = calls.concat([{method:method,params:params}])
      if (deferred) pending = pending.concat([callback])
      else callback(null, failure)
    }
  }
  Component {
    id: gmailFactory
    Providers.AuthManager {
      pluginDir: "/tmp/omamail-test"
      accountId: "alice@gmail.com"
      backend: fakeBackend
      platform: fakePlatform
      credentials: ({clientId:"123-abc.apps.googleusercontent.com",clientSecret:"synthetic"})
    }
  }
  Component {
    id: outlookFactory
    Providers.OutlookAuth {
      pluginDir: "/tmp/omamail-test"
      accountId: "outlook:alice@hotmail.com"
      configuredClientId: "12345678-1234-4abc-9def-1234567890ab"
      configuredEmail: "alice@hotmail.com"
      backend: fakeBackend
    }
  }

  function failWith(message, apiVersion) {
    fakePlatform.deletes = []
    fakeBackend.calls = []
    fakeBackend.pending = []
    fakeBackend.deferred = false
    fakeBackend.apiVersion = apiVersion === undefined ? 9 : apiVersion
    fakeBackend.failure = {code:-32000,message:message}
  }

  TestCase {
    name: "GmailSignedOut"

    function refreshFailing(message, apiVersion) {
      failWith(message, apiVersion)
      var auth = createTemporaryObject(gmailFactory, null)
      auth.savedSessionPresent = true
      auth.refreshWithToken("synthetic-refresh", "request")
      compare(fakeBackend.calls.length, 1)
      compare(fakeBackend.calls[0].method, "auth.token")
      compare(fakeBackend.calls[0].params.provider, "gmail")
      return auth
    }

    // A revoked grant signs the mailbox out and is kept: deleting it would
    // turn the next launch's refusal into a missing entry, which retries.
    function test_revoked_grant_asks_to_sign_in_and_is_kept() {
      var auth = refreshFailing("gmail_signed_out")
      compare(fakeBackend.calls[0].params,
        {provider:"gmail", accountId:"alice@gmail.com", resource:"mail"})
      compare(fakePlatform.deletes.length, 0)
      compare(auth.savedSessionPresent, false)
      compare(auth.refreshRetryAttempt, 0)
      compare(auth.lastError, "Google rejected the saved session. Sign in again")
    }

    // The review's sequence: a refresh asked under client A, credentials.json
    // switched to client B, and A's refusal arriving afterwards. It neither
    // deletes anything nor signs B out; B gets its own refresh.
    function test_late_refusal_after_a_client_change_is_ignored() {
      failWith("gmail_signed_out")
      fakeBackend.deferred = true
      var auth = createTemporaryObject(gmailFactory, null)
      var answers = []
      auth.withAccessToken(function(token, error) { answers.push(error) })
      compare(fakeBackend.calls.length, 1)
      var revokedA = fakeBackend.pending[0]
      auth.applyCredentials(JSON.stringify({installed:{
        client_id:"456-def.apps.googleusercontent.com", client_secret:"synthetic-b"}}))
      compare(auth.clientId, "456-def.apps.googleusercontent.com")
      compare(fakeBackend.calls.length, 2)
      revokedA(null, {code:-32000, message:"gmail_signed_out"})
      compare(fakePlatform.deletes.length, 0)
      compare(auth.savedSessionPresent, true)
      compare(answers.length, 0)
      fakeBackend.pending[1]({access_token:"synthetic-b-access", expires_in:3600}, null)
      compare(answers, [""])
      compare(auth.loggedIn, true)
      compare(fakePlatform.deletes.length, 0)
    }

    // A waiter whose client vanished from credentials.json is answered, not
    // left behind the abandoned request.
    function test_client_removed_during_refresh_answers_waiters() {
      failWith("gmail_signed_out")
      fakeBackend.deferred = true
      var auth = createTemporaryObject(gmailFactory, null)
      var answers = []
      auth.withAccessToken(function(token, error) { answers.push(error) })
      auth.applyCredentials("")
      compare(answers, ["Connect a Google Cloud OAuth client first"])
      fakeBackend.pending[0](null, {code:-32000, message:"gmail_signed_out"})
      compare(fakePlatform.deletes.length, 0)
      compare(answers.length, 1)
    }

    // Signing out deletes the current grant once; a refusal arriving after it
    // deletes nothing more.
    function test_refusal_after_sign_out_deletes_nothing_more() {
      failWith("gmail_signed_out")
      fakeBackend.deferred = true
      var auth = createTemporaryObject(gmailFactory, null)
      auth.savedSessionPresent = true
      auth.refreshWithToken("", "request")
      auth.logout()
      compare(fakePlatform.deletes, [{kind:"google-refresh-token", accountId:"alice@gmail.com",
        clientId:"123-abc.apps.googleusercontent.com"}])
      fakeBackend.pending[0](null, {code:-32000, message:"gmail_signed_out"})
      compare(fakePlatform.deletes.length, 1)
      compare(auth.refreshBusy, false)
    }

    function test_other_failures_keep_the_saved_session_data() {
      return [
        {tag:"network", message:"gmail_http_failed",
          error:"temporarily_unavailable"},
        {tag:"malformed answer", message:"gmail_invalid_token",
          error:"temporarily_unavailable"},
        {tag:"locked keyring", message:"gmail_keyring_failed",
          error:"temporarily_unavailable"},
        // A Secret Service with no default collection yet (a password
        // manager still closed) reads every entry as missing.
        {tag:"missing keyring entry", message:"gmail_token_missing",
          error:"temporarily_unavailable"},
        {tag:"unreadable keyring entry", message:"gmail_token_invalid",
          error:"temporarily_unavailable"},
        {tag:"revocation from an older backend", message:"gmail_signed_out", api:8,
          error:"temporarily_unavailable"},
        {tag:"refused client", message:"gmail_unauthorized",
          error:"Google rejected the OAuth client. Check the client ID and secret"}
      ]
    }
    function test_other_failures_keep_the_saved_session(data) {
      var auth = refreshFailing(data.message, data.api)
      compare(fakePlatform.deletes.length, 0)
      compare(auth.savedSessionPresent, true)
      compare(auth.refreshRetryAttempt, 1)
      compare(auth.lastError, data.error)
    }

    function test_busy_port_is_named() {
      failWith("auth_port_unavailable")
      var auth = createTemporaryObject(gmailFactory, null)
      auth.beginLogin()
      compare(fakeBackend.calls[0].method, "auth.begin")
      verify(auth.lastError.indexOf("Could not listen on port") === 0, auth.lastError)
    }
  }

  TestCase {
    name: "OutlookSignedOut"

    function refreshAnswer(message) {
      failWith(message)
      var auth = createTemporaryObject(outlookFactory, null)
      var answer = null
      auth.postForm(Microsoft.tokenUrlFor(auth.tenant),
        "grant_type=refresh_token&scope=offline_access", function(status, body) {
          answer = {status:status,body:JSON.parse(body)}
        })
      compare(fakeBackend.calls[0].method, "auth.token")
      compare(fakeBackend.calls[0].params.provider, "outlook")
      compare(answer.status, 400)
      return answer.body
    }

    function test_revoked_grant_is_invalid_grant() {
      compare(refreshAnswer("auth_signed_out").error, "invalid_grant")
    }
    function test_missing_consent_asks_for_interaction() {
      var body = refreshAnswer("auth_consent_required")
      compare(body.error, "interaction_required")
      compare(body.error_codes[0], 65001)
    }
    function test_other_failure_is_temporary() {
      compare(refreshAnswer("auth_refresh_failed").error, "temporarily_unavailable")
    }
  }
}
