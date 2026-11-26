import QtQuick
import QtTest
import "../../providers" as Providers

// A completed browser callback does not prove that the native token exchange
// or the Gmail profile read succeeded. The setup page must name the part that
// did not answer instead of asking the user to repeat a consent that worked.
Item {
  Component {
    id: backendFactory
    QtObject {
      property bool ready: true
      property int apiVersion: 10
      property string nextError: ""
      function call(method, params, done) {
        if (method === "auth.builtinClient") done({ clientId: "", clientSecret: "" }, null)
        else if (method === "auth.poll") done(null, { code: -32000, message: nextError })
        else if (done) done({ cancelled: true }, null)
      }
    }
  }
  Component {
    id: authFactory
    Providers.AuthManager {
      pluginDir: "/synthetic/plugin"
      accountId: "ada@example.org"
    }
  }

  TestCase {
    name: "GoogleSignInErrors"

    function poll(auth, backend, code) {
      backend.nextError = code
      auth.lastError = ""
      auth.loginBusy = true
      auth.nativeFlow = "synthetic-flow"
      auth.pollNativeLogin()
      return auth.lastError
    }

    function test_network_failures_name_what_could_not_be_reached() {
      var backend = createTemporaryObject(backendFactory, parent)
      var auth = createTemporaryObject(authFactory, parent, { backend: backend })
      var cases = [
        ["auth_transport_failed", "Could not reach Google's sign-in service"],
        ["auth_timeout", "Google sign-in did not finish in time"],
        ["gmail_http_failed", "Google accepted the sign-in, but Gmail could not be reached"],
        ["gmail_timeout", "Google accepted the sign-in, but Gmail did not answer in time"]
      ]
      for (var i = 0; i < cases.length; i++) {
        var error = poll(auth, backend, cases[i][0])
        verify(error.indexOf(cases[i][1]) >= 0, cases[i][0] + ": " + error)
        verify(error !== "Google sign-in failed. Please try again",
          cases[i][0] + " must not fall back to the generic message")
      }
    }

    function test_network_failures_say_that_a_proxy_is_not_used() {
      var backend = createTemporaryObject(backendFactory, parent)
      var auth = createTemporaryObject(authFactory, parent, { backend: backend })
      var codes = ["auth_transport_failed", "auth_timeout", "gmail_http_failed", "gmail_timeout"]
      for (var i = 0; i < codes.length; i++) {
        var error = poll(auth, backend, codes[i])
        verify(error.indexOf("do not use an HTTP proxy") >= 0, codes[i] + ": " + error)
      }
    }

    function test_consent_and_keyring_failures_keep_their_own_sentences() {
      var backend = createTemporaryObject(backendFactory, parent)
      var auth = createTemporaryObject(authFactory, parent, { backend: backend })
      verify(poll(auth, backend, "auth_missing_scope").indexOf("leave every checkbox ticked") >= 0)
      verify(poll(auth, backend, "auth_keyring_failed").indexOf("Could not save the Google session") >= 0)
      verify(poll(auth, backend, "gmail_forbidden").indexOf("Workspace admin settings") >= 0)
    }

    function test_unknown_failure_keeps_the_generic_message() {
      var backend = createTemporaryObject(backendFactory, parent)
      var auth = createTemporaryObject(authFactory, parent, { backend: backend })
      compare(poll(auth, backend, "no_such_code"), "Google sign-in failed. Please try again")
    }
  }
}
