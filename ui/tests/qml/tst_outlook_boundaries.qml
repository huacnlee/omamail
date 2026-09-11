import QtQuick
import QtTest
import "transports.js" as Transports
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
      Transports.install(host.api)
      host.auth.accessToken = "synthetic-outlook-token"
      host.auth.accessTokenExpiresAt = Date.now() + 3600000
      return host
    }
    function assertRequest(host, method) {
      var requests = Transports.transports(host.api)
      compare(requests.length, 1)
      var request = requests[0]
      compare(request.method, method)
      compare(request.params.accountId, "outlook:alice@hotmail.com")
      compare(request.params.settings, undefined)
      compare(request.params.credential, undefined)
      compare(request.params.oauth, undefined)
      compare(request.params.url, undefined)
      verify(JSON.stringify(request.params).indexOf("synthetic-outlook-token") < 0,
        "the UI never forwards an access token or destination; Rust resolves the saved account")
    }
    function test_saved_settings_cannot_redirect_outlook_bearer() {
      var host = readyHost()
      host.api.getLabelCounts("INBOX", function() {})
      assertRequest(host, "imap.count")
    }
    function test_saved_settings_cannot_redirect_smtp_bearer() {
      var host = readyHost()
      var raw = "From: alice@hotmail.com\r\nTo: bob@example.com\r\nSubject: Test\r\n\r\nSynthetic body"
      host.api.sendMessage({ raw: Mail.encodeBase64Url(raw) }, function() {})
      assertRequest(host, "imap.send")
      compare(host.auth.settings.insecure, false, "SMTP requires STARTTLS")
    }
    function test_saved_settings_cannot_redirect_append_bearer() {
      var host = readyHost()
      host.api.saveDraft({raw:Mail.encodeBase64Url("Subject: Test\r\n\r\nBody")}, function() {})
      assertRequest(host, "imap.saveDraft")
    }
    function test_settings_reload_cannot_redirect_bearer_or_username() {
      var host = readyHost()
      host.imapSettings = ({ imapHost: "other.example", imapPort: 143,
        smtpHost: "other.example", smtpPort: 25, insecure: true,
        username: "other@example.com" })
      host.api.getLabelCounts("INBOX", function() {})
      assertRequest(host, "imap.count")
    }
    function test_unsaved_generic_imap_verification_supplies_only_explicit_input() {
      var host = readyHost()
      host.providerId = "imap"
      wait(1)
      Transports.install(host.api)
      var settings = {imapHost:"imap.example.org",imapPort:993,username:"new@example.org",insecure:false}
      host.api.verifyCredentials(settings, "new@example.org:synthetic-password", function() {})
      var requests = Transports.transports(host.api)
      compare(requests.length, 1)
      compare(requests[0].method, "imap.folders")
      compare(requests[0].params.accountId, undefined,
        "an unsaved sign-in must not resolve a different saved account")
      compare(JSON.stringify(requests[0].params.settings), JSON.stringify(settings))
      compare(requests[0].params.credential, "new@example.org:synthetic-password")
      compare(requests[0].params.oauth, false)
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
