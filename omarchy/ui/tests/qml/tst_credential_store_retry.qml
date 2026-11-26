import QtQuick
import QtTest
import "../../providers" as Providers

// A mailbox restored at login can ask the credential store before the password
// manager that owns it has finished starting or the database it serves has been
// unlocked. The store says it is unavailable, which is not the same answer as
// "this mailbox has no password": the second one stays true, the first changes
// a moment later. These pin the difference — the lookup is repeated, and it is
// repeated only while the store is the thing that failed.
Item {
  id: root

  QtObject {
    id: store
    property bool available: false
    property string errorCode: "credential_store_unavailable"
    property string value: "app-password"
    property int lookups: 0
    property var pendingCallback: null
    property bool delayed: false
    function reset() {
      available = false
      errorCode = "credential_store_unavailable"
      value = "app-password"
      lookups = 0
      pendingCallback = null
      delayed = false
    }
    function triggerPending() {
      if (typeof pendingCallback === "function") {
        var cb = pendingCallback
        pendingCallback = null
        if (!available) cb("", errorCode)
        else cb(value, "")
      }
    }
    function credentialGet(kind, accountId, clientId, callback) {
      lookups++
      if (delayed) {
        pendingCallback = callback
        return true
      }
      if (!available) {
        callback("", errorCode)
        return true
      }
      callback(value, "")
      return true
    }
    function credentialDelete(kind, accountId, clientId, callback) {
      if (typeof callback === "function") callback(true, "")
      return true
    }
  }

  QtObject {
    id: backendMock
    property bool ready: false
  }

  Component {
    id: imapFactory

    Providers.ImapAuth {
      pluginDir: "/synthetic"
      platform: store
      accountId: "imap:one@example.org"
      timeScale: 0.01
      settings: ({imapHost:"imap.example.org",imapPort:993,smtpHost:"smtp.example.org",
        smtpPort:465,username:"one@example.org",aliases:[],insecure:false})
    }
  }

  Component {
    id: jmapFactory

    Providers.JmapAuth {
      pluginDir: "/synthetic"
      platform: store
      accountId: "jmap:one@example.org"
      address: "one@example.org"
      timeScale: 0.01
      settings: ({sessionUrl:"https://jmap.example.org/session",username:"one@example.org",
        authScheme:"basic",accountId:"one"})
    }
  }

  Component {
    id: imapWithBackendFactory

    Providers.ImapAuth {
      pluginDir: "/synthetic"
      platform: store
      backend: backendMock
      accountId: "imap:delayed@example.org"
      timeScale: 0.01
      settings: ({imapHost:"imap.example.org",imapPort:993,smtpHost:"smtp.example.org",
        smtpPort:465,username:"delayed@example.org",aliases:[],insecure:false})
    }
  }

  SignalSpy { id: loginSpy; signalName: "loginSucceeded" }
  SignalSpy { id: logoutSpy; signalName: "loggedOut" }

  TestCase {
    name: "CredentialStoreRetry"

    function init() {
      store.reset()
      backendMock.ready = false
      loginSpy.target = null
      loginSpy.clear()
      logoutSpy.target = null
      logoutSpy.clear()
    }

    function test_an_unavailable_store_is_asked_again_by_an_imap_mailbox() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      compare(auth.recoveringSession, true)
      auth.restoreSession()
      compare(store.lookups, 1)
      compare(auth.loggedIn, false)
      compare(auth.recoveringSession, true)
      compare(auth.lastError, "The credential store is unavailable")

      // The store finishes starting, or the user unlocks it, before the
      // mailbox is looked at again.
      store.available = true
      tryVerify(function() { return auth.loggedIn }, 1000)
      verify(store.lookups >= 2)
      compare(auth.password, "app-password")
      compare(auth.lastError, "")
      compare(auth.recoveringSession, false)
      compare(auth.secretRetryAttempt, 0)
    }

    function test_an_unavailable_store_is_asked_again_by_a_jmap_mailbox() {
      var auth = createTemporaryObject(jmapFactory, root)
      verify(auth)
      compare(auth.recoveringSession, true)
      auth.restoreSession()
      compare(store.lookups, 1)
      compare(auth.loggedIn, false)
      compare(auth.recoveringSession, true)
      compare(auth.lastError, "The credential store is unavailable")

      store.available = true
      tryVerify(function() { return auth.loggedIn }, 1000)
      verify(store.lookups >= 2)
      compare(auth.secret, "app-password")
      compare(auth.lastError, "")
      compare(auth.recoveringSession, false)
      compare(auth.secretRetryAttempt, 0)
    }

    function test_a_missing_credential_is_not_asked_again() {
      store.available = true
      store.value = ""
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      auth.restoreSession()
      compare(store.lookups, 1)
      compare(auth.loggedIn, false)
      compare(auth.password, "")
      // No retry is scheduled: the answer will not change by itself.
      compare(auth.secretRetryAttempt, 0)
      compare(auth.recoveringSession, false)
    }

    function test_permanent_error_is_not_retried() {
      store.available = false
      store.errorCode = "backend_needs_update"
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      auth.restoreSession()
      compare(store.lookups, 1)
      compare(auth.loggedIn, false)
      compare(auth.lastError, "backend_needs_update")
      compare(auth.secretRetryAttempt, 0)
      compare(auth.recoveringSession, false)
    }

    function test_logout_cancels_retry_timer_and_discards_subsequent_keyring_unlock() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      loginSpy.target = auth
      logoutSpy.target = auth

      auth.restoreSession()
      compare(store.lookups, 1)
      compare(auth.loggedIn, false)
      compare(auth.recoveringSession, true)
      compare(auth.secretRetryAttempt, 1)

      // User logs out while retry is active
      auth.logout()
      compare(logoutSpy.count, 1)
      compare(auth.secretRetryAttempt, 0)
      compare(auth.recoveringSession, false)
      compare(auth.password, "")

      // Keyring unlocks later
      store.available = true
      store.value = "stolen-password"
      wait(150)

      // The signed-out account must not be repopulated or emit loginSucceeded
      compare(auth.loggedIn, false)
      compare(auth.password, "")
      compare(auth.recoveringSession, false)
      compare(loginSpy.count, 0)
    }

    function test_in_flight_signin_prevents_retry_clobbering_error() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      auth.restoreSession()
      compare(auth.secretRetryAttempt, 1)
      compare(auth.lastError, "The credential store is unavailable")

      // Manual sign-in begins while retry timer is running
      var started = auth.signIn("typed-password")
      verify(started)
      compare(auth.loginBusy, true)
      compare(auth.lastError, "")

      // Wait for timer to trigger while sign-in is busy; lastError must not be overwritten
      wait(100)
      compare(auth.loginBusy, true)
      compare(auth.lastError, "")

      // Server rejects the manual sign-in
      auth.completeSignIn(false, "Server rejected password")
      compare(auth.loginBusy, false)
      compare(auth.lastError, "Server rejected password")
    }

    function test_account_change_cancels_retry_and_discards_stale_callback() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      loginSpy.target = auth

      auth.restoreSession()
      compare(store.lookups, 1)
      compare(auth.loggedIn, false)
      compare(auth.recoveringSession, true)
      compare(auth.secretRetryAttempt, 1)

      // Account changes while retry is scheduled
      auth.accountId = "imap:two@example.org"
      compare(auth.secretRetryAttempt, 0)
      compare(auth.password, "")
      compare(auth.loggedIn, false)

      // Keyring unlocks later; previous retry timer was cancelled, so no lookup fires
      store.available = true
      store.value = "stale-password"
      wait(150)

      compare(auth.password, "")
      compare(auth.loggedIn, false)
      compare(loginSpy.count, 0)
    }

    function test_backend_not_ready_delays_lookup_until_ready() {
      backendMock.ready = false
      var auth = createTemporaryObject(imapWithBackendFactory, root)
      verify(auth)
      auth.restoreSession()
      // Backend was not ready: no lookup attempted yet, but restore is owed
      compare(store.lookups, 0)
      compare(auth.recoveringSession, true)

      // Backend comes up
      backendMock.ready = true
      compare(store.lookups, 1)
    }

    function test_manual_signin_supersedes_in_flight_lookup_and_clears_busy() {
      store.delayed = true
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)

      var waiterCalled = false
      var waiterError = ""
      auth.withCredentials(function(creds, err) {
        waiterCalled = true
        waiterError = err
      })

      auth.restoreSession()
      compare(store.lookups, 1)
      verify(store.pendingCallback !== null)

      var started = auth.signIn("typed-password")
      verify(started)
      compare(auth.loginBusy, true)
      verify(waiterCalled)
      compare(waiterError, "Manual sign-in in progress")

      store.triggerPending()
      compare(auth.password, "")

      auth.completeSignIn(false, "Server rejected password")
      compare(auth.loginBusy, false)
      compare(auth.lastError, "Server rejected password")

      store.delayed = false
      store.available = true
      store.value = "saved-password"
      auth.restoreSession()
      compare(store.lookups, 2)
      compare(auth.password, "saved-password")
      compare(auth.loggedIn, true)
    }

    function test_jmap_manual_signin_supersedes_in_flight_lookup_and_clears_busy() {
      store.delayed = true
      var auth = createTemporaryObject(jmapFactory, root)
      verify(auth)

      var waiterCalled = false
      var waiterError = ""
      auth.withCredentials(function(creds, err) {
        waiterCalled = true
        waiterError = err
      })

      auth.restoreSession()
      compare(store.lookups, 1)
      verify(store.pendingCallback !== null)

      var started = auth.signIn("typed-token", "one@example.org")
      verify(started)
      compare(auth.loginBusy, true)
      verify(waiterCalled)
      compare(waiterError, "Manual sign-in in progress")

      store.triggerPending()
      compare(auth.secret, "")

      auth.completeSignIn(false, null, "Unauthorized", false)
      compare(auth.loginBusy, false)
      compare(auth.lastError, "Unauthorized")

      store.delayed = false
      store.available = true
      store.value = "saved-token"
      auth.restoreSession()
      compare(store.lookups, 2)
      compare(auth.secret, "saved-token")
      compare(auth.loggedIn, true)
    }
  }
}
