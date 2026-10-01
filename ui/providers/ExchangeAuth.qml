import QtQuick
import Quickshell.Io

import "ImapProtocol.js" as Imap
import "Exchange.js" as Exchange
import "MicrosoftOAuth.js" as Microsoft

// Exchange OAuth via Microsoft Device Flow.
// auth.microsoft.begin starts the flow AND spawns a Rust background task that polls
// Microsoft until the user authenticates, then pushes auth.microsoft.done to QML.
// The poll runs entirely in Rust — survives QML component recreation.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir
  property var backend: null
  property var platform: null
  property string accountId: ""
  property string configuredEmail: ""
  property var entrySettings: null

  readonly property string tenant: Microsoft.normalizeTenant(
    entrySettings ? (entrySettings.tenant || "organizations") : "organizations")
  readonly property string clientId: Microsoft.BUILTIN_CLIENT_ID
  readonly property var settings: Exchange.settings(configuredEmail, tenant, "")

  readonly property bool configured: configuredEmail !== ""
  readonly property bool credentialsPresent: configured
  readonly property string authMode: "oauth2"

  // Session state
  property string accessToken: ""
  property double accessTokenExpiresAt: 0
  property bool loggedIn: false
  property bool sessionChecked: false
  property bool savedSessionPresent: false
  property bool loginBusy: false
  property bool refreshBusy: false
  property string lastError: ""

  // Device flow display state — exposed for ExchangeSetupPage
  property string userCode: ""
  property string verificationUri: ""

  // Compatibility stubs
  property bool graphRoundBusy: false
  property bool graphConsentNeeded: false
  readonly property bool toolsChecked: true
  readonly property var missingTools: []
  readonly property bool toolsPresent: true
  readonly property bool recoveringSession: false

  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)

  // ---------------------------------------------------------------- helpers

  function errorMessage(error) {
    if (!error) return ""
    if (typeof error === "string") return error
    if (typeof error === "object" && error.message) return String(error.message)
    return JSON.stringify(error)
  }

  // ---------------------------------------------------------------- public API

  function beginLogin() {
    if (loginBusy) return
    // Cancel any in-progress session restore — explicit login takes priority
    refreshBusy = false

    if (!backend || !backend.ready) {
      lastError = "Mail backend not ready"
      sessionUnavailable(lastError)
      return
    }
    lastError = ""
    loginBusy = true
    userCode = ""
    verificationUri = ""

    var scopes = [
      "openid",
      "offline_access",
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "https://outlook.office.com/SMTP.Send"
    ]

    backend.call("auth.microsoft.begin", {
      tenant: tenant,
      scopes: scopes,
      accountId: accountId,
      clientId: clientId
    }, function(result, error) {
      if (error) {
        root.loginBusy = false
        root.lastError = "Could not start Microsoft sign-in: " + root.errorMessage(error)
        root.sessionUnavailable(root.lastError)
        return
      }
      root.userCode = String(result.userCode || "")
      root.verificationUri = String(result.verificationUri || "")

      // Open the browser for the user
      if (root.platform && typeof root.platform.openExternal === "function")
        root.platform.openExternal(root.verificationUri)

      // Rust backend now polls in a background task and pushes
      // auth.microsoft.done when the user completes sign-in.
    })
  }

  function cancelLogin() {
    loginBusy = false
    userCode = ""
    verificationUri = ""
    lastError = ""
  }

  function logout() {
    cancelLogin()
    accessToken = ""
    accessTokenExpiresAt = 0
    loggedIn = false
    savedSessionPresent = false
    sessionChecked = true
    lastError = ""
    if (accountId && backend && backend.ready)
      backend.call("auth.exchange.clear", { accountId: accountId }, function() {})
    loggedOut()
  }

  function restoreSession() {
    // Never interfere with an active login flow
    if (loginBusy) return
    sessionChecked = false
    if (!accountId || !backend || !backend.ready) {
      savedSessionPresent = false
      sessionChecked = true
      return
    }
    refreshBusy = true
    backend.call("auth.exchange.token", {
      accountId: accountId
    }, function(result, error) {
      root.refreshBusy = false
      root.sessionChecked = true
      if (error) {
        root.savedSessionPresent = false
        root.loggedIn = false
        return
      }
      var token = String((result && result.accessToken) ? result.accessToken : "")
      if (token !== "") {
        root.accessToken = token
        root.accessTokenExpiresAt = Date.now() + Number((result && result.expiresIn) ? result.expiresIn : 3600) * 1000
        root.loggedIn = true
        root.savedSessionPresent = true
        root.loginSucceeded()
      } else {
        root.savedSessionPresent = false
        root.loggedIn = false
      }
    })
  }

  function withAccessToken(callback) {
    if (typeof callback !== "function") return
    if (accessToken !== "" && Date.now() + 60000 < accessTokenExpiresAt) {
      callback(accessToken, "")
      return
    }
    if (!accountId || !backend || !backend.ready) {
      callback("", "Not signed in")
      return
    }
    backend.call("auth.exchange.token", {
      accountId: accountId
    }, function(result, error) {
      if (error) { callback("", root.errorMessage(error)); return }
      var token = String((result && result.accessToken) ? result.accessToken : "")
      if (token !== "") {
        root.accessToken = token
        root.accessTokenExpiresAt = Date.now() + Number((result && result.expiresIn) ? result.expiresIn : 3600) * 1000
      }
      callback(token, token === "" ? "No token" : "")
    })
  }

  // ---------------------------------------------------------------- backend push notification handler
  // Rust polls Microsoft in a background Tokio task and pushes auth.microsoft.done
  // when authentication completes. This survives QML component recreation.

  Connections {
    target: root.backend
    ignoreUnknownSignals: true

    function onNotification(method, params) {
      if (method !== "auth.microsoft.done") return
      if (!root.loginBusy) return

      if (params && params.error) {
        root.loginBusy = false
        root.userCode = ""
        root.verificationUri = ""
        root.lastError = "Microsoft sign-in failed: " + String(params.error)
        root.sessionUnavailable(root.lastError)
        return
      }

      var refreshToken = String((params && params.refreshToken) ? params.refreshToken : "")
      var accessTok = String((params && params.accessToken) ? params.accessToken : "")
      var expiresIn = Number((params && params.expiresIn) ? params.expiresIn : 3600)

      root.loginBusy = false
      root.userCode = ""
      root.verificationUri = ""
      root.accessToken = accessTok
      root.accessTokenExpiresAt = Date.now() + expiresIn * 1000
      root.loggedIn = true
      root.savedSessionPresent = true
      root.sessionChecked = true
      root.lastError = ""

      root.loginSucceeded()
    }
  }

  // ---------------------------------------------------------------- lifecycle

  onAccountIdChanged: {
    if (loginBusy || refreshBusy) return
    if (accountId !== "" && !loggedIn) restoreSession()
  }

  Component.onCompleted: {
    if (accountId !== "" && backend && backend.ready) restoreSession()
  }
}
