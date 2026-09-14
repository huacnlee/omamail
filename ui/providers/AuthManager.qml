import QtQuick
import Quickshell
import Quickshell.Io

import "OAuth.js" as OAuth
import "Credentials.js" as Credentials

// Google sign-in and token storage. Nothing else in the plugin needs to know
// what a refresh token looks like: callers ask for `withAccessToken` and get a
// live bearer token or an error string.
//
// Where each secret lives, and why:
//   - the access token stays in this process and is never written anywhere
//   - the refresh token crosses the process boundary over stdin and is kept by
//     GNOME Keyring, keyed by client id so two Cloud projects cannot collide
//   - the OAuth client id and secret live in a 0600 file under ~/.config,
//     because shell.json — where plugin settings go — is world-readable
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir
  property var backend: null
  property var platform: null
  property int oauthPort: OAuth.DEFAULT_PORT
  property var scopes: OAuth.SCOPES

  // Which mailbox this manager signs in. An OAuth client belongs to a Cloud
  // project rather than to a mailbox, so two accounts may share one — the
  // keyring entry has to be keyed on both or they overwrite each other and one
  // gets signed out at random.
  property string accountId: ""

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string credentialsPath: platform && typeof platform.configPath === "function"
    ? platform.configPath("credentials.json") : Credentials.path(home)

  property var credentials: Credentials.effective("")
  property bool credentialsChecked: false
  property bool usingBuiltinClient: Credentials.hasBuiltin()
  readonly property bool credentialsPresent: Credentials.isConfigured(credentials)
  readonly property string clientId: credentials ? String(credentials.clientId || "") : ""
  readonly property string clientDescription: Credentials.describe(credentials)

  property string accessToken: ""
  property double accessTokenExpiresAt: 0
  property string grantedScope: ""
  property bool loggedIn: false
  property bool sessionChecked: false
  // True after the keyring yielded a refresh token, even while a temporary
  // network failure prevents it from becoming an access token. This is not a
  // signed-out account: the saved grant is still the route back to ready.
  property bool savedSessionPresent: false
  readonly property bool recoveringSession: savedSessionPresent && !loggedIn
  property int refreshRetryAttempt: 0
  property bool loginBusy: false
  property bool refreshBusy: false
  readonly property bool sessionBusy: refreshBusy || lookupRunning
  property string lastError: ""

  // Everything the sign-in needs that Omarchy does not guarantee is present.
  readonly property var requiredTools: []
  property var missingTools: []
  property bool toolsChecked: true
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

  property var tokenWaiters: []
  property string lookupPurpose: ""
  property bool lookupHandled: false
  // One lookup at a time, whichever of the two processes is carrying it.
  property bool credentialLookupBusy: false
  // The OAuth client file and the refresh-token keyring are two independent
  // stores. Keep their writes separate: saving credentials.json must not use
  // the token write's busy state (and the setup page observes this one).
  property bool credentialsWriteBusy: false
  property bool credentialWriteBusy: false
  readonly property bool lookupRunning: credentialLookupBusy
  property string credentialsWritePayload: ""

  property var signedInProfile: null
  property string nativeFlow: ""
  property bool callbackHandled: false
  property bool exchangingCode: false
  property var tokenRequest: null
  property int tokenRequestSerial: 0
  property bool logoutPendingClear: false
  property string loginHint: ""

  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)
  signal credentialsSaved()

  function safeError(value) {
    return OAuth.redact(String(value || ""))
  }

  function tokenIsFresh() {
    return accessToken !== "" && Date.now() + 60000 < accessTokenExpiresAt
  }

  function resetMemorySession() {
    signedInProfile = null
    accessToken = ""
    accessTokenExpiresAt = 0
    loggedIn = false
  }

  function invalidateAccessToken() {
    accessToken = ""
    accessTokenExpiresAt = 0
  }

  function finishWaiters(token, error) {
    var pending = tokenWaiters.slice()
    tokenWaiters = []
    for (var i = 0; i < pending.length; i++) {
      try { pending[i](token || "", safeError(error)) }
      catch (e) { /* consumers own their callback errors */ }
    }
  }

  // The only entry point the API transport uses. A refresh already in flight
  // is joined rather than duplicated, so a burst of requests after the token
  // expires produces one token call, not twenty.
  function withAccessToken(callback) {
    if (typeof callback !== "function") return
    if (tokenIsFresh()) {
      callback(accessToken, "")
      return
    }
    if (!credentialsPresent) {
      callback("", "Connect a Google Cloud OAuth client first")
      return
    }

    var next = tokenWaiters.slice()
    next.push(callback)
    tokenWaiters = next
    if (refreshBusy || lookupRunning) return

    lookupPurpose = "request"
    startSecretLookup()
  }

  function restoreSession() {
    sessionChecked = false
    if (!credentialsPresent) {
      savedSessionPresent = false
      sessionChecked = true
      resetMemorySession()
      return
    }
    if (lookupRunning || refreshBusy) return
    lookupPurpose = "restore"
    startSecretLookup()
  }

  // ------------------------------------------------------------ credentials

  function saveCredentials(text) {
    var result = Credentials.parse(text)
    if (!result.ok) {
      lastError = result.error
      return false
    }
    if (credentialsWriteBusy) return false
    lastError = ""
    credentialsWriteBusy = true
    credentialsWritePayload = Credentials.serialize(result.credentials)
    if (!platform || typeof platform.writeConfig !== "function") {
      credentialsWriteBusy = false
      credentialsWritePayload = ""
      lastError = "Could not save the OAuth client to " + credentialsPath
      return false
    }
    platform.writeConfig("credentials.json", credentialsWritePayload, function(ok, error) {
      root.credentialsWritePayload = ""
      root.credentialsWriteBusy = false
      if (!ok) {
        root.lastError = "Could not save the OAuth client to " + root.credentialsPath
        return
      }
      credentialsFile.reload()
      root.credentialsSaved()
    })
    return true
  }

  // The user's own client file wins; a client shipped with the plugin is the
  // fallback. Today nothing is shipped, so this resolves to the file or to
  // nothing at all — see Credentials.BUILTIN for why.
  function applyCredentials(raw) {
    var loaded = Credentials.effective(raw, accountId)
    usingBuiltinClient = Credentials.usingBuiltin(raw, accountId)
    var changed = String(loaded.clientId) !== String(credentials.clientId)
    credentials = loaded
    credentialsChecked = true
    if (changed) {
      // A different client means a different keyring entry and a different
      // grant; whatever is in memory belongs to the old one.
      resetMemorySession()
      savedSessionPresent = false
      refreshRetryAttempt = 0
      refreshRetry.stop()
      sessionChecked = false
      if (Credentials.isConfigured(loaded)) restoreSession()
      else sessionChecked = true
    }
  }

  // -------------------------------------------------------- credential store

  // Kept for account migration compatibility. Native credential APIs accept
  // only fully typed current keys, so no wildcard legacy lookup is attempted.
  property bool mayAdoptLegacyToken: true

  function startSecretLookup() {
    // Existing accounts are restored wholly inside the backend: the native
    // store returns the refresh token directly to the OAuth client and QML
    // receives only the resulting access token. The typed credential RPC is
    // for provider paths that still need the secret as request input.
    if (accountId !== "" && backend) {
      savedSessionPresent = true
      refreshWithToken("", lookupPurpose)
      lookupPurpose = ""
      return
    }
    if (!clientId || accountId === "" || !platform || typeof platform.credentialGet !== "function") {
      handleSecretLookup("")
      return
    }
    lookupHandled = false
    var boundAccount = accountId
    var boundClient = clientId
    credentialLookupBusy = true
    platform.credentialGet("google-refresh-token", boundAccount, boundClient, function(value, error) {
      root.credentialLookupBusy = false
      if (boundAccount !== root.accountId || boundClient !== root.clientId) return
      root.handleSecretLookup(error ? "" : value)
    })
  }

  function handleSecretLookup(raw) {
    if (lookupHandled) return
    lookupHandled = true
    var token = String(raw || "").trim()
    var purpose = lookupPurpose
    lookupPurpose = ""
    if (!token) {
      savedSessionPresent = false
      resetMemorySession()
      sessionChecked = true
      if (purpose === "request") finishWaiters("", "Sign in to Gmail first")
      return
    }
    savedSessionPresent = true
    refreshWithToken(token, purpose)
  }

  // Held only until this mailbox learns its own address, which the profile
  // fetch settles a second or two after signing in.
  //
  // Writing it immediately meant writing it under a name-less key, and any
  // other mailbox sharing the client could then find it — which is how a newly
  // added mailbox ended up restoring the session of one that already existed
  // and reporting itself as that address. Waiting costs a second and leaves the
  // keyring with nothing ambiguous in it.
  property string unnamedRefreshToken: ""

  onAccountIdChanged: {
    if (accountId === "" || unnamedRefreshToken === "") return
    var held = unnamedRefreshToken
    unnamedRefreshToken = ""
    storeRefreshToken(held)
  }

  function storeRefreshToken(refreshToken) {
    if (!refreshToken) return
    if (accountId === "") {
      unnamedRefreshToken = String(refreshToken)
      return
    }
    if (credentialWriteBusy || !platform || typeof platform.credentialPut !== "function") return
    var boundAccount = accountId
    var boundClient = clientId
    var token = String(refreshToken)
    credentialWriteBusy = true
    platform.credentialPut("google-refresh-token", boundAccount, boundClient, token, function(ok, error) {
      token = ""
      root.credentialWriteBusy = false
      if (!ok && boundAccount === root.accountId && boundClient === root.clientId)
        root.lastError = "Signed in, but the session could not be saved. You may need to sign in again after a restart"
      if (root.logoutPendingClear) {
        root.logoutPendingClear = false
        root.clearStoredToken()
      }
    })
  }

  function clearStoredToken(attributes) {
    if (!clientId || !accountId || !platform || typeof platform.credentialDelete !== "function") return
    platform.credentialDelete("google-refresh-token", accountId, clientId, function() {})
  }

  // ---------------------------------------------------------------- tokens

  // Native requests have a bounded deadline in the backend.
  function postTokenRequest(body, previousRefreshToken, callback) {
    var serial = ++tokenRequestSerial
    var request = { abort: function() { root.tokenRequestSerial++ } }
    tokenRequest = request
    if (!backend || !backend.ready) {
      callback(OAuth.parseTokenResponse(0, "", previousRefreshToken))
      return
    }
    if (!accountId) { callback(OAuth.parseTokenResponse(0, "", "")); return }
    backend.call("auth.token", { provider: "gmail", accountId: accountId, resource: "mail" }, function(result, error) {
      if (serial !== root.tokenRequestSerial) return
      root.tokenRequest = null
      var signedOut = error === "gmail_invalid_token" || error === "gmail_token_invalid" || error === "gmail_token_missing" || error === "gmail_unauthorized"
      callback(OAuth.parseTokenResponse(error ? 400 : 200,
        error ? JSON.stringify({ error: signedOut ? "invalid_grant" : "temporarily_unavailable" }) : JSON.stringify(result), ""))
    })
  }

  function refreshWithToken(refreshToken, purpose) {
    refreshBusy = true
    postTokenRequest(OAuth.formBody({
      client_id: clientId,
      client_secret: credentials.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    }), refreshToken, function(result) {
      refreshToken = ""
      root.refreshBusy = false
      root.sessionChecked = true
      if (!result.ok) {
        root.resetMemorySession()
        root.lastError = root.safeError(result.error)
        if (OAuth.refreshFailureDisposition(result) === "signed_out") {
          // A revoked or expired grant is never coming back. Dropping it here
          // means the panel offers "Sign in" instead of retrying forever.
          root.savedSessionPresent = false
          refreshRetry.stop()
          root.clearStoredToken()
        } else {
          // The keyring token is still valid evidence of a saved session. Keep
          // it and retry until the network can exchange it for an access token.
          root.scheduleRefreshRetry()
        }
        if (purpose === "request") root.finishWaiters("", root.lastError)
        else root.sessionUnavailable(root.lastError)
        return
      }
      root.acceptToken(result)
      root.finishWaiters(root.accessToken, "")
    })
  }

  function acceptToken(result) {
    accessToken = result.accessToken
    accessTokenExpiresAt = Date.now() + result.expiresIn * 1000
    if (result.scope) grantedScope = result.scope
    loggedIn = true
    savedSessionPresent = true
    refreshRetryAttempt = 0
    refreshRetry.stop()
    lastError = ""
    if (result.refreshToken) storeRefreshToken(result.refreshToken)
  }

  // ---------------------------------------------------------------- login

  function beginLogin() {
    if (loginBusy || refreshBusy) return
    if (!credentialsPresent) {
      lastError = "Connect a Google Cloud OAuth client first"
      return
    }
    if (platform && platform.canAccessCredentials === false) {
      lastError = "Install or update the mail backend before signing in"
      return
    }
    if (!toolsPresent && toolsChecked) {
      lastError = missingTools.length > 0 ? "Missing " + missingTools.join(", ")
        : "Install or update the mail backend before signing in"
      return
    }
    lastError = ""
    loginBusy = true
    callbackHandled = false
    exchangingCode = false
    if (!backend || !backend.ready) { failLogin("Mail backend unavailable"); return }
    var serial = ++tokenRequestSerial
    backend.call("auth.begin", { clientId: clientId, clientSecret: credentials.clientSecret,
      port: OAuth.normalizedPort(oauthPort), scopes: scopes, loginHint: loginHint }, function(result, error) {
      if (serial !== root.tokenRequestSerial || !root.loginBusy) {
        if (result && result.id) root.backend.call("auth.cancel", { id: result.id }, function() {})
        return
      }
      if (error) {
        root.failLogin(error === "auth_port_unavailable"
          ? "Could not listen on port " + OAuth.normalizedPort(root.oauthPort) + ". Close the other listener or change the port in settings"
          : "Could not start secure Google sign-in")
        return
      }
      root.nativeFlow = result.id
      if (root.platform && typeof root.platform.openExternal === "function")
        root.platform.openExternal(result.url)
      nativePoll.start()
      authTimeout.restart()
    })
  }

  function pollNativeLogin() {
    if (!nativeFlow || !loginBusy) return
    var flow = nativeFlow
    backend.call("auth.poll", { id: flow }, function(result, error) {
      if (flow !== root.nativeFlow) return
      if (error) {
        root.failLogin(error.message === "auth_missing_scope"
          ? "Google sign-in is missing permissions. Sign in again and leave every checkbox ticked"
          : (error.message === "auth_keyring_failed" ? "Could not save the Google session to the keyring. Please try again"
            : "Google sign-in failed. Please try again"))
        return
      }
      if (result.pending) { nativePoll.start(); return }
      root.nativeFlow = ""
      authTimeout.stop()
      root.signedInProfile = result.profile || null
      root.acceptSignIn(OAuth.parseTokenResponse(result.status, result.body, ""))
    })
  }

  function scheduleRefreshRetry() {
    if (!savedSessionPresent || refreshRetry.running) return
    refreshRetry.interval = OAuth.refreshRetryDelay(refreshRetryAttempt)
    refreshRetryAttempt++
    refreshRetry.start()
  }

  function acceptSignIn(result) {
      root.exchangingCode = false
      root.loginBusy = false
      if (!result.ok) {
        root.lastError = root.safeError(result.error)
        root.sessionUnavailable(root.lastError)
        return
      }
      // A user can untick individual permissions on Google's consent screen.
      // The resulting token works for reading and fails at the first archive,
      // which is a far worse experience than saying so now.
      var missing = OAuth.missingScopes(result.scope, root.scopes)
      if (missing.length > 0) {
        root.resetMemorySession()
        root.sessionChecked = true
        root.lastError = OAuth.missingScopeMessage(missing)
        root.finishWaiters("", root.lastError)
        root.sessionUnavailable(root.lastError)
        return
      }

      root.acceptToken(result)
      root.sessionChecked = true
      root.finishWaiters(root.accessToken, "")
      root.loginSucceeded()
  }

  function failLogin(reason, listenerAlreadyAnswered) {
    lastError = safeError(reason || "Google sign-in failed. Please try again")
    loginBusy = false
    exchangingCode = false
    authTimeout.stop()
    nativePoll.stop()
    stopNativeLogin()
    sessionUnavailable(lastError)
  }

  function cancelLogin() {
    authTimeout.stop()
    nativePoll.stop()
    stopNativeLogin()
    tokenRequestSerial++
    if (tokenRequest && tokenRequest.abort) tokenRequest.abort()
    tokenRequest = null
    refreshBusy = false
    loginBusy = false
    exchangingCode = false
    callbackHandled = false
  }

  function logout() {
    cancelLogin()
    refreshRetry.stop()
    refreshRetryAttempt = 0
    savedSessionPresent = false
    resetMemorySession()
    sessionChecked = true
    grantedScope = ""
    lastError = ""
    finishWaiters("", "Signed out")
    if (credentialWriteBusy) logoutPendingClear = true
    else clearStoredToken()
    loggedOut()
  }

  // ------------------------------------------------------------- processes

  FileView {
    id: credentialsFile
    path: root.credentialsPath
    watchChanges: true
    printErrors: false
    onLoaded: root.applyCredentials(text())
    onFileChanged: reload()
    // No file is the normal first-run state, not an error: fall through to
    // whatever client is built in.
    onLoadFailed: root.applyCredentials("")
  }

  function stopNativeLogin() {
    nativePoll.stop()
    if (nativeFlow && backend) backend.call("auth.cancel", { id: nativeFlow }, function() {})
    nativeFlow = ""
  }

  Timer {
    id: nativePoll
    interval: 500
    onTriggered: root.pollNativeLogin()
  }

  Timer {
    id: authTimeout
    interval: 180000
    onTriggered: root.failLogin("Google sign-in took too long. Please try again")
  }

  Timer {
    id: refreshRetry
    repeat: false
    onTriggered: root.restoreSession()
  }

  // Whether a legacy entry is there at all. The matches come back on stdout
  // and their attributes on stderr, so the two are counted apart and neither
  // is read as the other's.
  //
  // Counted line by line rather than collected: a search keyed on the client
  // alone loads every matching mailbox's token, and stdout carries all of
  // them. Nothing here needs a secret, only how many of each line there were,
  // so none is held.
}
