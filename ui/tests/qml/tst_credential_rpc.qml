import QtQuick
import QtTest
import "../../providers" as Providers

Item {
  id: root

  QtObject {
    id: credentials
    property bool backendCanStoreCredentials: true
    property var reads: []
    property int readCount: 0
    property var writes: []
    property var deletes: []
    property var pendingRead: null
    property var pendingWrites: []
    property bool deferWrites: false
    function reset() {
      reads = []; readCount = 0; writes = []; deletes = []; pendingRead = null
      pendingWrites = []; deferWrites = false
    }
    function credentialGet(kind, accountId, clientId, callback) {
      reads = reads.concat([{kind:kind,accountId:accountId,clientId:clientId}])
      readCount = reads.length
      pendingRead = callback
      return true
    }
    function credentialPut(kind, accountId, clientId, secret, callback) {
      writes = writes.concat([{kind:kind,accountId:accountId,clientId:clientId,secret:secret}])
      if (deferWrites) pendingWrites = pendingWrites.concat([callback])
      else callback(true, "")
      return true
    }
    function credentialDelete(kind, accountId, clientId, callback) {
      deletes = deletes.concat([{kind:kind,accountId:accountId,clientId:clientId}])
      callback(true, "")
      return true
    }
  }

  Component {
    id: jmapFactory
    Providers.JmapAuth {
      pluginDir: "/synthetic"
      platform: credentials
      accountId: "jmap:one@example.org"
      address: "one@example.org"
      settings: ({sessionUrl:"https://jmap.example.org/session",username:"one@example.org",
        authScheme:"basic",accountId:"mail-one"})
    }
  }

  Component {
    id: imapFactory
    Providers.ImapAuth {
      pluginDir: "/synthetic"
      platform: credentials
      accountId: "imap:one@example.org"
      settings: ({imapHost:"imap.example.org",imapPort:993,smtpHost:"smtp.example.org",
        smtpPort:465,username:"one@example.org",aliases:[],insecure:false})
    }
  }

  TestCase {
    name: "CredentialRpc"

    function init() { credentials.reset() }

    function test_lookup_uses_a_typed_request_and_preserves_secret_text() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      var answer = ""
      auth.withCredentials(function(value, error) { answer = value + "|" + error })
      compare(credentials.reads, [{kind:"imap-password",accountId:"imap:one@example.org",clientId:""}])
      var finish = credentials.pendingRead
      credentials.pendingRead = null
      finish("quotes '\" backslash \\ Unicode 你好\nline", "")
      compare(answer, "one@example.org:quotes '\" backslash \\ Unicode 你好\nline|")
    }

    function test_late_lookup_cannot_cross_an_account_change() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      var oldAnswer = ""
      auth.withCredentials(function(value, error) { oldAnswer = value + "|" + error })
      var finishOld = credentials.pendingRead
      auth.accountId = "imap:two@example.org"
      verify(oldAnswer.indexOf("mailbox changed") >= 0)
      var newAnswer = ""
      auth.withCredentials(function(value, error) { newAnswer = value + "|" + error })
      var finishNew = credentials.pendingRead
      finishOld("old-secret", "")
      compare(newAnswer, "")
      finishNew("new-secret", "")
      compare(newAnswer, "one@example.org:new-secret|")
      verify(oldAnswer.indexOf("new-secret") < 0)
      compare(auth.password, "new-secret")
    }

    function test_store_and_delete_are_data_not_process_arguments() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      verify(auth.signIn("$(touch /tmp/never-credential)\r\n<secret>"))
      auth.completeSignIn(true, "")
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].kind, "imap-password")
      compare(credentials.writes[0].secret, "$(touch /tmp/never-credential)\r\n<secret>")
      auth.logout()
      compare(credentials.deletes, [{kind:"imap-password",accountId:"imap:one@example.org",clientId:""}])
    }

    function test_store_failure_is_retryable_and_not_reported_as_missing() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      var answer = ""
      auth.withCredentials(function(value, error) { answer = value + "|" + error })
      credentials.pendingRead("", "credential_store_unavailable")
      verify(answer.indexOf("credential store is unavailable") >= 0)
      compare(auth.passwordChecked, false)
      auth.withCredentials(function() {})
      compare(credentials.reads.length, 2)
    }

    // The boot case: the keyring is not answering yet, the read fails, and
    // nothing else in the plugin will ask again — a mailbox that never signed
    // in is not being polled. Without a retry the mailbox stays disconnected
    // until the plugin is restarted, which is what a user sees as landing in
    // the add-mailbox view after logging in.
    function test_store_failure_is_tried_again_with_nobody_asking() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      auth.restoreSession()
      compare(credentials.reads.length, 1)
      compare(auth.credentialRetryArmed, false)

      credentials.pendingRead("", "credential_store_unavailable")
      compare(credentials.reads.length, 1)
      compare(auth.credentialRetryArmed, true)
      compare(auth.credentialRetryAttempt, 1)

      tryCompare(credentials, "readCount", 2, 8000)
      compare(auth.passwordChecked, false)
    }

    // A store that answers leaves nothing waiting behind it, and the next
    // outage starts its backoff from the beginning rather than from wherever
    // the last one stopped.
    function test_a_read_that_settles_leaves_no_retry_armed() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      auth.restoreSession()
      credentials.pendingRead("secret", "")
      compare(auth.credentialRetryArmed, false)
      compare(auth.credentialRetryAttempt, 0)
      compare(auth.passwordChecked, true)
    }

    // The whole safety argument for arming at all. A mailbox that was never
    // signed in answers "missing" on every read, and if that armed a retry
    // every such mailbox would poll the keyring for the life of the session.
    function test_a_missing_credential_arms_nothing() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      auth.restoreSession()
      credentials.pendingRead("", "credential_missing")
      compare(auth.credentialRetryArmed, false)
      compare(auth.passwordChecked, true)
    }

    // A refusal that stays refused is not worth repeating: a duplicate keyring
    // entry or a backend too old to hold credentials needs the user, and a
    // mailbox that looks busy forever hides that.
    function test_a_permanent_refusal_arms_nothing() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      auth.restoreSession()
      credentials.pendingRead("", "backend_needs_update")
      compare(auth.credentialRetryArmed, false)
    }

    // The wait grows, so a store that is down for a long time is not read
    // every five seconds until it comes back.
    function test_the_retry_backs_off_between_attempts() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      auth.restoreSession()
      credentials.pendingRead("", "credential_store_unavailable")
      compare(auth.credentialRetryInterval, 5000)
      compare(auth.credentialRetryAttempt, 1)

      // The second attempt, without waiting out the first.
      auth.startSecretLookup()
      compare(auth.credentialRetryArmed, false)
      credentials.pendingRead("", "credential_store_unavailable")
      compare(auth.credentialRetryInterval, 10000)
      compare(auth.credentialRetryAttempt, 2)
    }

    // The accounts Instantiator rebinds a surviving delegate rather than
    // destroying it, so a retry armed for the mailbox that just left would
    // otherwise fire against the one that took its place.
    function test_changing_the_mailbox_disarms_the_retry() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      auth.restoreSession()
      credentials.pendingRead("", "credential_store_unavailable")
      compare(auth.credentialRetryArmed, true)

      auth.accountId = "imap:two@example.org"
      compare(auth.credentialRetryArmed, false)
      compare(auth.credentialRetryAttempt, 0)
    }

    // What a user actually does when told "not connected" is retype the
    // password. A retry armed by the earlier failure must not then read the
    // keyring behind that sign-in: the read is not ordered against the write
    // it races, so it can hand back the stale password and overwrite the one
    // just verified against the server, with nothing reporting it.
    function test_signing_in_disarms_a_pending_retry() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      auth.restoreSession()
      credentials.pendingRead("", "credential_store_unavailable")
      compare(auth.credentialRetryArmed, true)

      verify(auth.signIn("verified-password"))
      auth.completeSignIn(true, "")
      compare(auth.credentialRetryArmed, false)
      compare(auth.credentialRetryAttempt, 0)
      compare(auth.password, "verified-password")
    }

    // Signing out deletes the credential, so a retry armed before that would
    // read an item that is gone and ask the user to sign in seconds later.
    function test_logout_disarms_a_pending_retry() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      auth.restoreSession()
      credentials.pendingRead("", "credential_store_unavailable")
      compare(auth.credentialRetryArmed, true)

      auth.logout()
      compare(auth.credentialRetryArmed, false)
      compare(auth.credentialRetryAttempt, 0)
    }

    function test_jmap_store_failure_arms_the_same_retry() {
      var auth = createTemporaryObject(jmapFactory, root)
      verify(auth)
      auth.restoreSession()
      compare(credentials.reads.length, 1)
      credentials.pendingRead("", "credential_store_unavailable")
      compare(auth.credentialRetryArmed, true)
      compare(auth.credentialRetryAttempt, 1)
      compare(auth.secretChecked, false)
    }

    function test_logout_waits_for_an_in_flight_imap_write_then_deletes() {
      credentials.deferWrites = true
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      verify(auth.signIn("secret"))
      auth.completeSignIn(true, "")
      compare(credentials.writes.length, 1)
      auth.logout()
      compare(credentials.deletes.length, 0)
      credentials.pendingWrites[0](true, "")
      compare(credentials.deletes,
        [{kind:"imap-password",accountId:"imap:one@example.org",clientId:""}])
    }

    function test_logout_waits_for_an_in_flight_jmap_write_then_deletes() {
      credentials.deferWrites = true
      var auth = createTemporaryObject(jmapFactory, root)
      verify(auth)
      verify(auth.signIn("secret"))
      auth.completeSignIn(true, {sessionUrl:"https://jmap.example.org/session",
        authScheme:"basic",accountId:"mail-one",canSend:true}, "", false)
      compare(credentials.writes.length, 1)
      auth.logout()
      compare(credentials.deletes.length, 0)
      credentials.pendingWrites[0](true, "")
      compare(credentials.deletes,
        [{kind:"jmap-secret",accountId:"jmap:one@example.org",clientId:""}])
    }
  }
}
