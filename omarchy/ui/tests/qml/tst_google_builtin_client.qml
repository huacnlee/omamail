import QtQuick
import QtTest
import "../../providers" as Providers

// A release backend reports the Google client it was built with; AuthManager
// falls back to it only when the user has configured no client of their own.
Item {
  Component {
    id: backendFactory
    QtObject {
      property bool ready: false
      property int apiVersion: 9
      property var reply: ({ clientId: "", clientSecret: "" })
      property var calls: []
      function call(method, params, done) {
        calls = calls.concat([{ method: method, params: params }])
        if (method === "auth.builtinClient") done(reply, null)
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
    name: "GoogleBuiltinClient"

    readonly property string shippedId: "999-shipped.apps.googleusercontent.com"
    readonly property string ownFile: JSON.stringify({ installed: {
      client_id: "123-own.apps.googleusercontent.com", client_secret: "own" } })

    function builtinCalls(backend) {
      return backend.calls.filter(function(entry) { return entry.method === "auth.builtinClient" })
    }

    function test_shipped_client_is_used_once_the_backend_reports_it() {
      var backend = createTemporaryObject(backendFactory, parent,
        { reply: { clientId: shippedId, clientSecret: "GOCSPX-shipped" } })
      var auth = createTemporaryObject(authFactory, parent, { backend: backend })
      auth.applyCredentials("")
      verify(!auth.credentialsPresent, "nothing is known before the backend answers")
      backend.ready = true
      compare(builtinCalls(backend).length, 1)
      compare(builtinCalls(backend)[0].params, {})
      verify(auth.credentialsPresent)
      verify(auth.usingBuiltinClient)
      compare(auth.clientId, shippedId)
      compare(auth.credentials.clientSecret, "GOCSPX-shipped")
      backend.ready = false
      backend.ready = true
      compare(builtinCalls(backend).length, 1, "asked once per manager")
    }

    function test_backend_already_ready_is_asked_on_creation() {
      var backend = createTemporaryObject(backendFactory, parent,
        { ready: true, reply: { clientId: shippedId, clientSecret: "s" } })
      var auth = createTemporaryObject(authFactory, parent, { backend: backend })
      compare(builtinCalls(backend).length, 1)
      verify(!auth.credentialsPresent, "the client file has not been read yet")
      auth.applyCredentials("")
      compare(auth.clientId, shippedId)
    }

    function test_own_client_wins_over_the_shipped_one() {
      var backend = createTemporaryObject(backendFactory, parent,
        { ready: true, reply: { clientId: shippedId, clientSecret: "s" } })
      var auth = createTemporaryObject(authFactory, parent, { backend: backend })
      auth.applyCredentials(ownFile)
      compare(auth.clientId, "123-own.apps.googleusercontent.com")
      verify(!auth.usingBuiltinClient)
    }

    function test_development_and_older_backends_ship_nothing() {
      var empty = createTemporaryObject(backendFactory, parent, { ready: true })
      var auth = createTemporaryObject(authFactory, parent, { backend: empty })
      auth.applyCredentials("")
      verify(!auth.credentialsPresent)
      verify(!auth.usingBuiltinClient)

      var older = createTemporaryObject(backendFactory, parent, { ready: true, apiVersion: 8 })
      var olderAuth = createTemporaryObject(authFactory, parent, { backend: older })
      olderAuth.applyCredentials("")
      compare(builtinCalls(older).length, 0, "API 8 has no auth.builtinClient")
      verify(!olderAuth.credentialsPresent)
    }

    function test_malformed_reply_is_no_client() {
      var backend = createTemporaryObject(backendFactory, parent,
        { ready: true, reply: { clientId: shippedId + "\n", clientSecret: "s" } })
      var auth = createTemporaryObject(authFactory, parent, { backend: backend })
      auth.applyCredentials("")
      verify(!auth.credentialsPresent)
    }
  }
}
