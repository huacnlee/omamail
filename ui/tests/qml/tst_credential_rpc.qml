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
    function reset() { reads = []; writes = []; deletes = []; pendingRead = null }
    function credentialGet(kind, accountId, clientId, callback) {
      reads = reads.concat([{kind:kind,accountId:accountId,clientId:clientId}])
      pendingRead = callback
      return true
    }
    function credentialPut(kind, accountId, clientId, secret, callback) {
      writes = writes.concat([{kind:kind,accountId:accountId,clientId:clientId,secret:secret}])
      callback(true, "")
      return true
    }
    function credentialDelete(kind, accountId, clientId, callback) {
      deletes = deletes.concat([{kind:kind,accountId:accountId,clientId:clientId}])
      callback(true, "")
      return true
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
      var called = 0
      auth.withCredentials(function() { called++ })
      var finish = credentials.pendingRead
      auth.accountId = "imap:two@example.org"
      finish("old-secret", "")
      compare(called, 0)
      compare(auth.password, "")
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
  }
}
