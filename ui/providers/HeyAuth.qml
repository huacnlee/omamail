import QtQuick

// The backend supervises the official HEY CLI; that CLI owns its credentials.
Item {
  id: root
  visible: false
  width: 0
  height: 0
  required property string pluginDir
  property var backend: null
  property string accountId: ""
  property string heyPath: ""
  readonly property var requiredTools: ["hey"]
  property var missingTools: ["hey"]
  property bool toolsChecked: false
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0
  readonly property bool credentialsPresent: toolsPresent
  property bool loggedIn: false
  property bool statusChecked: false
  property bool loginBusy: false
  property bool sessionBusy: false
  property string lastError: ""
  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)
  signal credentialsSaved()

  function safeError(value) { return String(value || "") }
  function request(method, callback) {
    if (!backend || !backend.ready) {
      Qt.callLater(function() { callback(null, "Mail backend unavailable") })
      return
    }
    backend.call(method, {}, function(result, error) {
      callback(result, error ? "HEY could not complete this request" : "")
    })
  }
  function restoreSession() {
    if (!toolsPresent || sessionBusy) return
    sessionBusy = true
    request("hey.status", function(result, error) {
      root.sessionBusy = false
      root.statusChecked = true
      var before = root.loggedIn
      root.loggedIn = !error && result && result.authenticated === true
      if (root.loggedIn) {
        root.lastError = ""
        if (!before) root.loginSucceeded()
      } else if (!root.loginBusy) root.sessionUnavailable("Sign in to HEY")
    })
  }
  function beginLogin() {
    if (!toolsPresent || loginBusy) return
    lastError = ""
    loginBusy = true
    request("hey.loginStart", function(result, error) {
      if (error) { root.loginBusy = false; root.lastError = error }
      else loginPoll.start()
    })
  }
  function cancelLogin() {
    loginPoll.stop()
    loginBusy = false
    request("hey.loginCancel", function(result, error) {})
  }
  function signIn(secret) { return false }
  function logout() {
    cancelLogin()
    request("hey.logout", function(result, error) {
      if (error) { root.lastError = error; return }
      root.loggedIn = false
      root.statusChecked = true
      root.loggedOut()
    })
  }
  function invalidateAccessToken() { restoreSession() }
  function reportAuthFailure() { restoreSession() }
  function recheck() { probe() }
  function probe() {
    if (!backend || !backend.ready) return
    request("hey.probe", function(result, error) {
      root.heyPath = !error && result ? String(result.program || "") : ""
      root.missingTools = root.heyPath === "" ? ["hey"] : []
      root.toolsChecked = true
      root.restoreSession()
    })
  }
  onBackendChanged: probe()
  Component.onCompleted: probe()
  Connections {
    target: root.backend
    function onReadyChanged() { if (root.backend.ready) root.probe() }
  }
  Timer {
    id: loginPoll
    interval: 500
    repeat: false
    onTriggered: root.request("hey.loginPoll", function(result, error) {
      if (error || !result || !result.running) {
        root.loginBusy = false
        root.lastError = error
        root.restoreSession()
      } else loginPoll.start()
    })
  }
}
