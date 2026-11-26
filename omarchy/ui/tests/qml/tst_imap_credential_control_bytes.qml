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

    function test_a_pasted_password_loses_only_its_trailing_line_break_data() {
      return [
        {tag: "CR", suffix: "\r"},
        {tag: "LF", suffix: "\n"},
        {tag: "CRLF", suffix: "\r\n"},
        {tag: "several line breaks", suffix: "\r\n\n"}
      ]
    }

    function test_a_pasted_password_loses_only_its_trailing_line_break(data) {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      var sent = ""
      auth.verifyRequested.connect(function(settings, value) { sent = value })
      verify(auth.signIn("app-password " + data.suffix))
      compare(sent, "one@example.org:app-password ")
      auth.completeSignIn(true, "")
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].secret, "app-password ")
    }

    function test_controls_are_refused_without_verification_or_storage_data() {
      var cases = []
      for (var byte = 0; byte < 32; byte++) {
        cases.push({tag: "embedded-" + byte, value: "before" + String.fromCharCode(byte) + "after"})
        if (byte !== 10 && byte !== 13)
          cases.push({tag: "trailing-" + byte, value: "password" + String.fromCharCode(byte)})
      }
      cases.push({tag: "embedded-DEL", value: "before\u007fafter"})
      cases.push({tag: "trailing-DEL", value: "password\u007f"})
      cases.push({tag: "internal-CRLF", value: "before\r\nafter\r\n"})
      return cases
    }

    function test_controls_are_refused_without_verification_or_storage(data) {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      var verifications = 0
      auth.verifyRequested.connect(function(settings, value) { verifications++ })
      verify(!auth.signIn(data.value))
      compare(auth.lastError, "The password contains a control character. Enter it again")
      compare(verifications, 0)
      compare(credentials.writes.length, 0)
      compare(auth.pendingPassword, "")
      compare(auth.loginBusy, false)
      compare(auth.password, "")
    }

    function test_clean_passwords_are_unchanged_data() {
      return [
        {tag: "plain", value: "app-password"},
        {tag: "spaces", value: " leading and trailing "},
        {tag: "Unicode", value: "päss密碼🔑"},
        {tag: "quotes and backslashes", value: "a\"'b\\c:$()"}
      ]
    }

    function test_clean_passwords_are_unchanged(data) {
      var auth = createTemporaryObject(imapFactory, root)
      verify(auth)
      var sent = ""
      auth.verifyRequested.connect(function(settings, value) { sent = value })
      verify(auth.signIn(data.value))
      compare(sent, "one@example.org:" + data.value)
      auth.completeSignIn(true, "")
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].secret, data.value)
    }

    function test_only_line_breaks_do_not_verify_or_store() {
      var auth = createTemporaryObject(imapFactory, root)
      var verifications = 0
      auth.verifyRequested.connect(function(settings, value) { verifications++ })
      verify(!auth.signIn("\r\n"))
      compare(auth.lastError, "Enter the password for this mailbox")
      compare(verifications, 0)
      compare(credentials.writes.length, 0)
    }
  }
}
