import QtQuick
import QtTest
import "../../account" as Account
import "../../components" as Components
import "../../message/Message.js" as Mail

Item {
  Component {
    id: hostFactory
    Account.MailAccount {
      pluginDir: "/tmp/omamail-test"
      providerId: "outlook"
      accountId: "outlook:alice@hotmail.com"
      configuredEmail: "alice@hotmail.com"
      oauthClientId: "12345678-1234-4abc-9def-1234567890ab"
      imapSettings: ({ imapHost: "127.0.0.1", imapPort: 1143,
        smtpHost: "127.0.0.1", smtpPort: 1025, insecure: true,
        username: "alice@hotmail.com" })
    }
  }
  Component {
    id: pageFactory
    Components.OutlookSetupPage {
      service: null
      textColor: Qt.rgba(0, 0, 0, 1)
      dimColor: Qt.rgba(0.5, 0.5, 0.5, 1)
      dangerColor: Qt.rgba(1, 0, 0, 1)
      accentColor: Qt.rgba(0, 0, 1, 1)
      panelFontFamily: "Sans"
      width: 500
    }
  }
  Component {
    id: serviceFactory
    QtObject {
      property var auth
      property string accountAddress: "alice@hotmail.com"
      property int starts: 0
      function cancelSignIn() { auth.cancelLogin() }
      function configureCurrentAccountAndSignInOAuth(values) { starts++ }
    }
  }
  TestCase {
    name: "OutlookBoundaryReview"
    function readyHost() {
      var host = createTemporaryObject(hostFactory, parent)
      verify(host !== null)
      wait(1)
      host.auth.cancelLogin()
      host.auth.accessToken = "synthetic-outlook-token"
      host.auth.accessTokenExpiresAt = Date.now() + 3600000
      return host
    }
    function assertRequest(handle, mode, url) {
      verify(handle.process !== null)
      var fields = handle.process.requestLine.split(" ")
      compare(fields[0], mode)
      compare(Mail.bytesToLatin1(Mail.base64ToBytes(fields[2])), "alice@hotmail.com")
      compare(Mail.bytesToLatin1(Mail.base64ToBytes(fields[3])), "synthetic-outlook-token")
      compare(Mail.bytesToLatin1(Mail.base64ToBytes(fields[1])), url,
        "Microsoft's bearer token must not be offered to an unrelated origin")
    }
    function test_saved_settings_cannot_redirect_outlook_bearer() {
      var host = readyHost()
      var handle = host.api.run("", ["NOOP"], function() {})
      assertRequest(handle, "imap-oauth", "imaps://outlook.office365.com:993")
    }
    function test_saved_settings_cannot_redirect_smtp_bearer() {
      var host = readyHost()
      var raw = "From: alice@hotmail.com\r\nTo: bob@example.com\r\nSubject: Test\r\n\r\nSynthetic body"
      var handle = host.api.sendMessage({ raw: Mail.encodeBase64Url(raw) }, function() {})
      assertRequest(handle, "smtp-oauth", "smtp://smtp-mail.outlook.com:587")
      compare(host.auth.settings.insecure, false, "SMTP requires STARTTLS")
    }
    function test_saved_settings_cannot_redirect_append_bearer() {
      var host = readyHost()
      var handle = host.api.appendMessage("Drafts", "Subject: Test\r\n\r\nBody", "draft", "Failed", function() {})
      assertRequest(handle, "imap-append-oauth", "imaps://outlook.office365.com:993/Drafts")
    }
    function test_settings_reload_cannot_redirect_bearer_or_username() {
      var host = readyHost()
      host.imapSettings = ({ imapHost: "other.example", imapPort: 143,
        smtpHost: "other.example", smtpPort: 25, insecure: true,
        username: "other@example.com" })
      assertRequest(host.api.run("", ["NOOP"], function() {}),
        "imap-oauth", "imaps://outlook.office365.com:993")
    }
    function test_generic_imap_keeps_configured_servers() {
      var host = readyHost()
      host.providerId = "imap"
      wait(1)
      compare(host.auth.settings.imapHost, "127.0.0.1")
      compare(host.auth.settings.smtpHost, "127.0.0.1")
    }
    function test_authentication_errors_are_plain_text() {
      var page = createTemporaryObject(pageFactory, parent)
      verify(page !== null)
      var label = findChild(page, "outlook-error")
      verify(label !== null)
      compare(label.textFormat, Text.PlainText,
        "Server error messages must not be interpreted as resource-bearing HTML")
    }
    function test_cancel_matches_google_signin_and_allows_retry() {
      var host = readyHost()
      var service = createTemporaryObject(serviceFactory, parent, { auth: host.auth })
      var page = createTemporaryObject(pageFactory, parent, { service: service })
      verify(page !== null)
      var signIn = findChild(page, "outlook-sign-in")
      var cancel = findChild(page, "outlook-cancel-sign-in")
      compare(cancel.visible, false)
      host.auth.loginBusy = true
      host.auth.userCode = "SYNTHETIC"
      host.auth.deviceCode = "synthetic-device"
      compare(cancel.visible, true)
      compare(signIn.enabled, false)
      compare(signIn.text, "Sign in with Microsoft...")
      page.signIn()
      compare(service.starts, 0, "Enter must not start a second flow while busy")
      cancel.clicked()
      compare(host.auth.loginBusy, false)
      compare(host.auth.deviceCode, "")
      compare(host.auth.userCode, "")
      compare(cancel.visible, false)
      compare(signIn.enabled, true)
      page.signIn()
      compare(service.starts, 1)
    }
    function test_graph_consent_is_offered_while_signed_in() {
      var host = readyHost()
      var service = createTemporaryObject(serviceFactory, parent, { auth: host.auth })
      var page = createTemporaryObject(pageFactory, parent, { service: service })
      var signIn = findChild(page, "outlook-sign-in")
      host.auth.loggedIn = true
      compare(signIn.visible, false, "a signed-in mailbox has nothing to sign in to")
      host.auth.graphConsentNeeded = true
      compare(signIn.visible, true)
      compare(signIn.text, "Allow Microsoft Graph...")
      host.auth.loggedIn = false
      compare(signIn.text, "Sign in with Microsoft...",
        "signed out, the button is the sign-in whatever Graph said")
      host.auth.loggedIn = true
      compare(signIn.enabled, true)
      host.auth.refreshBusy = true
      compare(signIn.enabled, false, "not offered while a refresh is under way, which would make it do nothing")
    }
  }
}
