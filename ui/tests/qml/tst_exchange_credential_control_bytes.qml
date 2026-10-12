import QtQuick
import QtTest
import "../../providers" as Providers

// A pasted Exchange password, as IMAP's: the line breaks a paste ends with are
// not part of it, and any other control character refuses it before the server
// is asked or the keyring written. What is checked is what is saved.
Item {
  id: root

  QtObject {
    id: credentials
    property bool backendCanStoreCredentials: true
    property var writes: []
    property var deletes: []
    function reset() { writes = []; deletes = [] }
    function credentialGet(kind, accountId, clientId, callback) {
      return true
    }
    function credentialPut(kind, accountId, clientId, secret, callback) {
      writes = writes.concat([{kind:kind,accountId:accountId,clientId:clientId,secret:secret}])
      callback(true, "")
      return true
    }
    function credentialDelete(kind, accountId, clientId, callback) {
      deletes = deletes.concat([{kind:kind,accountId:accountId}])
      callback(true, "")
      return true
    }
  }

  Component {
    id: exchangeFactory
    Providers.ExchangeAuth {
      pluginDir: "/synthetic"
      platform: credentials
      accountId: "exchange:jane@corp.example.test"
      address: "jane@corp.example.test"
      settings: ({ewsUrl:"https://corp.example.test/EWS/Exchange.asmx",username:"CORP\\jane",authScheme:"auto"})
    }
  }

  TestCase {
    name: "ExchangeCredentialControlBytes"

    function init() { credentials.reset() }

    function test_a_pasted_password_loses_only_its_trailing_line_break_data() {
      return [
        {tag: "CR", suffix: "\r"},
        {tag: "LF", suffix: "\n"},
        {tag: "CRLF", suffix: "\r\n"},
        {tag: "several line breaks", suffix: "\r\n\n"},
        {tag: "LF then CR", suffix: "\n\r"}
      ]
    }

    function test_a_pasted_password_loses_only_its_trailing_line_break(data) {
      var auth = createTemporaryObject(exchangeFactory, root)
      verify(auth)
      var sent = null
      auth.verifyRequested.connect(function(settings, address, value) { sent = value })
      verify(auth.signIn("app-password " + data.suffix))
      compare(sent, "app-password ")
      auth.completeSignIn(true, {scheme: "ntlm"}, "")
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].kind, "exchange-password")
      compare(credentials.writes[0].secret, "app-password ")
      compare(auth.loggedIn, true)
    }

    // Only the line breaks at the end are a paste's. One inside the password,
    // or before it, is a control character like any other.
    function test_controls_are_refused_without_verification_or_storage_data() {
      var cases = []
      for (var byte = 0; byte < 32; byte++) {
        cases.push({tag: "embedded-" + byte, value: "before" + String.fromCharCode(byte) + "after"})
        if (byte !== 10 && byte !== 13)
          cases.push({tag: "trailing-" + byte, value: "password" + String.fromCharCode(byte)})
      }
      cases.push({tag: "embedded-DEL", value: "before\u007fafter"})
      cases.push({tag: "trailing-DEL", value: "password\u007f"})
      // The backend refuses every Unicode control, C1 included, so the form does.
      cases.push({tag: "embedded-C1-first", value: "before\u0080after"})
      cases.push({tag: "embedded-NEL", value: "before\u0085after"})
      cases.push({tag: "trailing-C1-last", value: "password\u009f"})
      cases.push({tag: "internal-CRLF", value: "before\r\nafter\r\n"})
      cases.push({tag: "leading-LF", value: "\npassword"})
      cases.push({tag: "tab-before-the-break", value: "password\t\r\n"})
      return cases
    }

    function test_controls_are_refused_without_verification_or_storage(data) {
      var auth = createTemporaryObject(exchangeFactory, root)
      verify(auth)
      var verifications = 0
      auth.verifyRequested.connect(function(settings, address, value) { verifications++ })
      verify(!auth.signIn(data.value))
      compare(auth.lastError, "The password contains a control character. Enter it again")
      compare(verifications, 0)
      compare(credentials.writes.length, 0)
      compare(credentials.deletes.length, 0)
      compare(auth.pending, "")
      compare(auth.loginBusy, false)
      compare(auth.signIns, 0)
      compare(auth.loggedIn, false)
    }

    function test_clean_passwords_are_unchanged_data() {
      return [
        {tag: "plain", value: "app-password"},
        {tag: "spaces", value: " leading and trailing "},
        {tag: "Unicode", value: "päss密碼🔑"},
        {tag: "past the controls", value: " nbsp "},
        {tag: "quotes and backslashes", value: "a\"'b\\c:$()"}
      ]
    }

    function test_clean_passwords_are_unchanged(data) {
      var auth = createTemporaryObject(exchangeFactory, root)
      verify(auth)
      var sent = null
      auth.verifyRequested.connect(function(settings, address, value) { sent = value })
      verify(auth.signIn(data.value))
      compare(sent, data.value)
      auth.completeSignIn(true, {scheme: "ntlm"}, "")
      compare(credentials.writes.length, 1)
      compare(credentials.writes[0].secret, data.value)
    }

    function test_only_line_breaks_do_not_verify_or_store_data() {
      return [{tag: "LF", value: "\n"}, {tag: "CRLF", value: "\r\n"}, {tag: "several", value: "\r\n\n\r"}]
    }

    function test_only_line_breaks_do_not_verify_or_store(data) {
      var auth = createTemporaryObject(exchangeFactory, root)
      var verifications = 0
      auth.verifyRequested.connect(function(settings, address, value) { verifications++ })
      verify(!auth.signIn(data.value))
      compare(auth.lastError, "Enter the password for this mailbox")
      compare(verifications, 0)
      compare(credentials.writes.length, 0)
    }
  }
}
