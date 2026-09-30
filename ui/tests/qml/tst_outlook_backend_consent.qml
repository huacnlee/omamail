import QtQuick
import QtTest
import "../../providers" as Providers
import "../../providers/MicrosoftOAuth.js" as Microsoft
import "../../components" as Components
import "../../calendar" as Calendar

// Exercise the real postForm RPC adapter. The provider fixture supplies the
// backend's {code, message} error envelope, not a raw Microsoft response.
Item {
  QtObject {
    id: fixture
    property bool ready: true
    property var calls: []
    property var writes: []
    property var deletes: []
    property string failure: "auth_consent_required"
    property bool hold: false
    property var pending: null
    function call(method, params, callback) {
      calls = calls.concat([{method: method, params: params}])
      if (method === "auth.store") {
        fixture.credentialPut("outlook-refresh-token", params.accountId, params.clientId, params.token, function() {})
        callback({saved: true}, null)
        return
      }
      if (method === "auth.clear") {
        fixture.credentialDelete("outlook-refresh-token", params.accountId, params.clientId, function() {})
        callback({cleared: true}, null)
        return
      }
      if (method === "calendar.request" || method === "calendar.discover") {
        if (hold) { pending = callback; return }
        callback(null, {code: -32000, message: failure})
        return
      }
      if (method === "auth.token") {
        if (hold) { pending = callback; return }
        if (params.resource === "graph") {
          callback(null, {code: -32000, message: failure})
          return
        }
        callback({access_token: "mail-token", expires_in: 3600, scope: Microsoft.SCOPES.join(" ")}, null)
        return
      }
      if (method === "auth.form" && params.endpoint === "device") {
        callback({status: 200, body: JSON.stringify({device_code: "synthetic-device",
          user_code: "SYNTHETIC", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5})}, null)
        return
      }
      if (method === "auth.form" && params.endpoint === "token") {
        callback({status: 200, body: JSON.stringify({access_token: "graph-token",
          refresh_token: "graph-refresh-token", expires_in: 3600, scope: Microsoft.GRAPH_SCOPES.join(" ")})}, null)
        return
      }
      callback({}, null)
    }
    function credentialPut(kind, accountId, clientId, secret, callback) {
      writes = writes.concat([{kind: kind, accountId: accountId, clientId: clientId, secret: secret}])
      callback(true, "")
    }
    function credentialDelete(kind, accountId, clientId, callback) {
      deletes = deletes.concat([{kind: kind, accountId: accountId, clientId: clientId}])
      callback(true, "")
    }
  }
  Component {
    id: authFactory
    Providers.OutlookAuth {
      pluginDir: "/tmp/omamail-test"
      accountId: "outlook:alice@example.test"
      configuredEmail: "alice@example.test"
      configuredClientId: "12345678-1234-4abc-9def-1234567890ab"
      backend: fixture
      platform: fixture
    }
  }
  Component {
    id: serviceFactory
    QtObject {
      property var auth
      property var backend: fixture
      property bool backendCanDiscoverCalendars: true
      property var accountSummaries: [{id: "outlook:alice@example.test", calendarProvider: "microsoft", signedIn: true}]
      function findAccount(accountId) {
        return accountId === auth.accountId ? {providerId: "outlook", auth: auth} : null
      }
      property string accountAddress: "alice@example.test"
      property bool backendCanCheckMicrosoftConnection: true
      function cancelSignIn() { auth.cancelLogin() }
      function configureCurrentAccountAndSignInOAuth(values) { auth.beginLogin() }
    }
  }
  Component {
    id: pageFactory
    Components.OutlookSetupPage {
      textColor: Qt.rgba(0, 0, 0, 1)
      dimColor: Qt.rgba(0.5, 0.5, 0.5, 1)
      dangerColor: Qt.rgba(1, 0, 0, 1)
      accentColor: Qt.rgba(0, 0, 1, 1)
      panelFontFamily: "Sans"
      width: 500
    }
  }
  Component {
    id: calendarFactory
    Calendar.CalendarController { pluginDir: "/tmp/omamail-test" }
  }
  TestCase {
    name: "OutlookBackendConsent"
    function fresh() {
      fixture.hold = false
      fixture.pending = null
      fixture.failure = "auth_consent_required"
      var auth = createTemporaryObject(authFactory, parent)
      wait(1)
      auth.cancelLogin()
      auth.accessToken = "mail-token"
      auth.accessTokenExpiresAt = Date.now() + 3600000
      auth.loggedIn = true
      auth.savedSessionPresent = true
      fixture.calls = []; fixture.writes = []; fixture.deletes = []
      return auth
    }
    function test_backend_consent_offers_graph_code_and_keeps_its_refresh_token() {
      var auth = fresh()
      var service = createTemporaryObject(serviceFactory, parent, {auth: auth})
      var page = createTemporaryObject(pageFactory, parent, {service: service})
      var button = findChild(page, "outlook-sign-in")
      compare(button.visible, false)
      var error = ""
      auth.withGraphToken(function(token, reason) { error = reason })
      compare(fixture.calls.length, 1)
      compare(fixture.calls[0].method, "auth.token")
      compare(fixture.calls[0].params.resource, "graph")
      compare(auth.graphConsentNeeded, true)
      compare(auth.loggedIn, true)
      compare(auth.accessToken, "mail-token")
      compare(fixture.deletes.length, 0)
      verify(error.indexOf("Graph needs its own consent") >= 0, error)
      compare(button.visible, true)
      compare(button.text, "Allow Microsoft Graph...")
      button.clicked()
      compare(auth.devicePurpose, "graph")
      compare(auth.graphRoundBusy, true)
      var body = decodeURIComponent(fixture.calls[1].params.body)
      verify(body.indexOf("graph.microsoft.com") >= 0)
      verify(body.indexOf("offline_access") >= 0)
      verify(body.indexOf("outlook.office.com") < 0)
      auth.pollDeviceCode()
      compare(auth.graphConsentNeeded, false)
      compare(auth.graphRoundBusy, false)
      compare(auth.graphAccessToken, "graph-token")
      compare(auth.accessToken, "mail-token")
      compare(auth.loggedIn, true)
      compare(button.visible, false)
      compare(fixture.writes.length, 1)
      compare(fixture.writes[0].secret, "graph-refresh-token")
      compare(fixture.writes[0].kind, "outlook-refresh-token")
      compare(fixture.writes[0].accountId, auth.accountId)
      compare(fixture.writes[0].clientId, auth.clientId)
      compare(fixture.deletes.length, 0)
    }
    function test_graph_device_grant_uses_the_serialized_backend_store() {
      var auth = fresh()
      auth.acceptGraphSignIn({accessToken: "graph-token", refreshToken: "device-graph-refresh",
        expiresIn: 3600, scope: Microsoft.GRAPH_SCOPES.join(" ")})
      compare(fixture.calls.length, 1)
      compare(fixture.calls[0].method, "auth.store")
      compare(fixture.calls[0].params.accountId, auth.accountId)
      compare(fixture.calls[0].params.clientId, auth.clientId)
      compare(fixture.calls[0].params.token, "device-graph-refresh")
      compare(fixture.writes[0].secret, "device-graph-refresh")
    }
    function test_logout_uses_the_same_serialized_backend_lane() {
      var auth = fresh()
      auth.logout()
      compare(fixture.calls[fixture.calls.length - 1].method, "auth.clear")
      compare(fixture.deletes.length, 1)
    }
    function test_native_calendar_requests_offer_consent_data() {
      return [{tag: "listing", operation: "list"}, {tag: "discovery", operation: "discover"}]
    }
    function test_native_calendar_requests_offer_consent(data) {
      var auth = fresh()
      var service = createTemporaryObject(serviceFactory, parent, {auth: auth})
      var controller = createTemporaryObject(calendarFactory, parent, {service: service})
      var error = ""
      if (data.operation === "discover") {
        verify(controller.discoverAccountCalendars(auth.accountId))
        error = controller.discoveryError
      } else {
        controller.nativeRequest({kind: "microsoft", accountId: auth.accountId}, "list", {},
          function(result, reason) { error = reason })
      }
      compare(auth.graphConsentNeeded, true)
      compare(auth.loggedIn, true)
      compare(auth.accessToken, "mail-token")
      compare(fixture.deletes.length, 0)
      verify(error.indexOf("Allow Microsoft Graph") >= 0, error)
    }
    function test_native_calendar_late_consent_is_bound_to_the_session_data() {
      return [{tag: "account", change: "account"}, {tag: "client", change: "client"},
        {tag: "tenant", change: "tenant"}, {tag: "logout", change: "logout"},
        {tag: "new grant", change: "grant"}]
    }
    function test_native_calendar_late_consent_is_bound_to_the_session(data) {
      var auth = fresh()
      var service = createTemporaryObject(serviceFactory, parent, {auth: auth})
      var controller = createTemporaryObject(calendarFactory, parent, {service: service})
      fixture.hold = true
      controller.nativeRequest({kind: "microsoft", accountId: auth.accountId}, "list", {}, function() {})
      var pending = fixture.pending
      if (data.change === "account") auth.accountId = "outlook:bob@example.test"
      if (data.change === "client") auth.configuredClientId = "87654321-4321-4abc-9def-1234567890ab"
      if (data.change === "tenant") auth.entrySettings = {tenant: "organizations"}
      if (data.change === "logout") auth.logout()
      if (data.change === "grant") auth.acceptGraphToken({accessToken: "new-graph", expiresIn: 3600})
      pending(null, {code: -32000, message: "auth_consent_required"})
      compare(auth.graphConsentNeeded, false)
    }
    function test_other_backend_refusals_do_not_offer_graph_consent_data() {
      return [{tag: "revoked", reason: "auth_signed_out"},
        {tag: "transient", reason: "auth_refresh_failed"},
        {tag: "malformed", reason: "auth_invalid_response"},
        {tag: "keyring", reason: "auth_keyring_failed"}]
    }
    function test_other_backend_refusals_do_not_offer_graph_consent(data) {
      var auth = fresh()
      fixture.failure = data.reason
      var error = ""
      auth.withGraphToken(function(token, reason) { error = reason })
      compare(auth.graphConsentNeeded, false)
      compare(auth.loggedIn, true)
      compare(fixture.deletes.length, 0)
      verify(error !== "")
      if (data.reason === "auth_signed_out") verify(error.indexOf("Sign in again") >= 0, error)
    }
    function test_late_consent_after_account_change_does_not_touch_the_new_session() {
      var auth = fresh()
      fixture.hold = true
      var answers = []
      auth.withGraphToken(function(token, reason) { answers.push({token: token, reason: reason}) })
      var pending = fixture.pending
      auth.accountId = "outlook:bob@example.test"
      pending(null, {code: -32000, message: "auth_consent_required"})
      compare(auth.graphConsentNeeded, false)
      compare(answers.length, 1)
      compare(answers[0].token, "")
      compare(fixture.writes.length, 0)
      compare(fixture.deletes.length, 0)
    }
  }
}
