import QtQuick
import QtTest
import "../../providers" as Providers
import "../../providers/MicrosoftOAuth.js" as Microsoft

// A token failure reaches the providers as the backend's error object, never
// as a bare string. Only a dead grant may clear the stored refresh token;
// anything else keeps the saved session and retries.
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
    property var failure: null
    property var calls: []
    function call(method, params, callback) {
      calls = calls.concat([{method:method,params:params}])
      callback(null, failure)
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

  function failWith(message) {
    fakePlatform.deletes = []
    fakeBackend.calls = []
    fakeBackend.failure = {code:-32000,message:message}
  }

  TestCase {
    name: "GmailSignedOut"

    function refreshFailing(message) {
      failWith(message)
      var auth = createTemporaryObject(gmailFactory, null)
      auth.savedSessionPresent = true
      auth.refreshWithToken("synthetic-refresh", "request")
      compare(fakeBackend.calls.length, 1)
      compare(fakeBackend.calls[0].method, "auth.token")
      compare(fakeBackend.calls[0].params.provider, "gmail")
      return auth
    }

    function test_dead_grant_clears_the_stored_token_data() {
      return [
        {tag:"revoked grant", message:"gmail_signed_out"},
        {tag:"corrupt keyring secret", message:"gmail_token_invalid"},
        {tag:"missing keyring secret", message:"gmail_token_missing"}
      ]
    }
    function test_dead_grant_clears_the_stored_token(data) {
      var auth = refreshFailing(data.message)
      compare(fakePlatform.deletes.length, 1)
      compare(fakePlatform.deletes[0].kind, "google-refresh-token")
      compare(auth.savedSessionPresent, false)
      compare(auth.refreshRetryAttempt, 0)
      compare(auth.lastError, "Google rejected the saved session. Sign in again")
    }

    function test_other_failures_keep_the_saved_session_data() {
      return [
        {tag:"network", message:"gmail_http_failed",
          error:"temporarily_unavailable"},
        {tag:"malformed answer", message:"gmail_invalid_token",
          error:"temporarily_unavailable"},
        {tag:"locked keyring", message:"gmail_keyring_failed",
          error:"temporarily_unavailable"},
        {tag:"refused client", message:"gmail_unauthorized",
          error:"Google rejected the OAuth client. Check the client ID and secret"}
      ]
    }
    function test_other_failures_keep_the_saved_session(data) {
      var auth = refreshFailing(data.message)
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
