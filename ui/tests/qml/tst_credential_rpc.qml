import QtQuick
import QtTest
import "../../providers" as Providers

Item {
  id: root

  QtObject {
    id: credentials
    property bool backendCanStoreCredentials: true
    property var reads: []
    property var writes: []
    property var deletes: []
    property var pendingRead: null
    property var pendingWrites: []
    property bool deferWrites: false
    function reset() {
      reads = []; writes = []; deletes = []; pendingRead = null
      pendingWrites = []; deferWrites = false
    }
    function credentialGet(kind, accountId, clientId, callback) {
      reads = reads.concat([{kind:kind,accountId:accountId,clientId:clientId}])
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
