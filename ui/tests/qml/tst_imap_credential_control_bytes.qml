import QtQuick
import QtTest
import "../../providers" as Providers

Item {
  id: root

  QtObject {
    id: credentials
    property bool backendCanStoreCredentials: true
    property var writes: []
    function reset() { writes = [] }
    function credentialGet(kind, accountId, clientId, callback) {
      return true
    }
    function credentialPut(kind, accountId, clientId, secret, callback) {
      writes = writes.concat([{kind:kind,accountId:accountId,clientId:clientId,secret:secret}])
      callback(true, "")
      return true
    }
    function credentialDelete(kind, accountId, clientId, callback) {
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
    name: "ImapCredentialControlBytes"

    function init() { credentials.reset() }

    function test_a_pasted_password_loses_its_control_bytes() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      var sent = ""
      auth.verifyRequested.connect(function(settings, value) { sent = value })
      verify(auth.signIn("app-password\r\nwith\ttabs\u0007and more"))
      compare(sent, "one@example.org:app-passwordwithtabsand more")
      auth.completeSignIn(true, "")
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].secret, "app-passwordwithtabsand more")
    }

    function test_a_clean_password_is_unchanged() {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      var sent = ""
      auth.verifyRequested.connect(function(settings, value) { sent = value })
      verify(auth.signIn("app-password"))
      compare(sent, "one@example.org:app-password")
      auth.completeSignIn(true, "")
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].secret, "app-password")
    }
  }
}
