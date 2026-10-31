import QtQuick
import QtTest
import "../../components" as Mail

Item {
  id: fixture
  width: 820
  height: 1100

  QtObject { id: fakeBackend; property bool ready: true }
  QtObject {
    id: fakeAuth
    property var backend: fakeBackend
    property bool credentialsPresent: false
    property bool loggedIn: false
    property bool loginBusy: false
    property bool refreshBusy: false
    property bool sessionBusy: false
    property bool credentialsWriteBusy: false
    property bool toolsChecked: true
    property var missingTools: []
    property string accountId: ""
    property string clientId: ""
    property string clientDescription: "Personal app"
    property string credentialsPath: "/synthetic/credentials.json"
    property string lastError: ""
    property var credentials: ({})
    signal credentialsSaved()
    function reloadCredentials() {}
    function saveCredentials(text) { credentialsWriteBusy = true }
  }
  QtObject {
    id: fakeService
    property var auth: fakeAuth
    property string pluginDir: "/synthetic/omamail"
    property string accountName: ""
    property string accountEmail: ""
    property string signInProgress: ""
    property bool standalone: false
    property int accountCount: 2
    property int signIns: 0
    property int cancellations: 0
    function configureCurrentAccount(values) {
      if (values.email !== undefined) fakeAuth.accountId = values.email
      if (values.label !== undefined) accountName = values.label
      return true
    }
    function signIn() { signIns++; fakeAuth.loginBusy = true }
    function cancelSignIn() { cancellations++; fakeAuth.loginBusy = false }
    function openProviderWebsite(id) {}
    function signOut() { fakeAuth.loggedIn = false }
  }
  Component {
    id: pageComponent
    Mail.SetupPage {
      width: 760
      service: fakeService
      textColor: Qt.rgba(0.93, 0.93, 0.93, 1)
      dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
      dangerColor: Qt.rgba(0.93, 0.4, 0.4, 1)
      accentColor: Qt.rgba(0.53, 0.67, 1, 1)
      panelFontFamily: "monospace"
      accountCount: 2
    }
  }
  TestCase {
    name: "GoogleSignupFlow"
    when: windowShown
    property var page: null
    property var personal: null
    function item(name) {
      var result = findChild(page, name)
      verify(result !== null, name)
      return result
    }
    function finishProcess(process, code) { process.running = false; process.exited(code) }
    function checked(missing) {
      var process = item("google-check-process")
      process.stdout.read(JSON.stringify({event: "preflight", missingTools: missing || [], browser: "edge"}))
      finishProcess(process, 0)
    }
    function connect() {
      checked([])
      item("google-setup-email").text = "owner@example.com"
      personal.start()
      verify(item("google-setup-process").running)
    }
    function configured() {
      fakeAuth.credentials = {personal: true, ownerEmail: "owner@example.com", clientId: "123-test.apps.googleusercontent.com"}
      fakeAuth.clientId = fakeAuth.credentials.clientId
      fakeAuth.credentialsPresent = true
    }
    function init() {
      fakeAuth.credentialsPresent = false; fakeAuth.loggedIn = false; fakeAuth.loginBusy = false
      fakeAuth.refreshBusy = false; fakeAuth.sessionBusy = false; fakeAuth.credentialsWriteBusy = false
      fakeAuth.accountId = ""; fakeAuth.clientId = ""; fakeAuth.credentials = {}; fakeAuth.lastError = ""
      fakeService.accountEmail = ""; fakeService.accountName = ""; fakeService.signIns = 0; fakeService.cancellations = 0
      fakeBackend.ready = true
      page = createTemporaryObject(pageComponent, fixture)
      verify(page !== null)
      personal = item("google-personal-setup")
    }
    function test_empty_and_invalid_addresses_cannot_launch_setup() {
      checked([])
      verify(!item("google-setup-start").enabled)
      item("google-setup-email").text = "not-an-address"
      personal.start()
      verify(!item("google-setup-process").running)
      item("google-setup-email").text = "owner@example.com"
      verify(item("google-setup-start").enabled)
      verify(!item("google-setup-profile").visible)
    }
    function test_provisioning_locks_conflicting_controls_and_keeps_cancel() {
      connect()
      verify(page.busy)
      var names = ["google-setup-start", "google-setup-email", "google-setup-browser",
        "google-setup-profile-toggle", "google-setup-mode", "account-name-field"]
      for (var i = 0; i < names.length; i++) verify(!item(names[i]).enabled, names[i])
      verify(item("google-setup-cancel").visible && item("google-setup-cancel").enabled)
      personal.start()
      compare(fakeService.signIns, 0)
      // A client file can become visible before the helper exits. Do not
      // collapse the active step and hide its cancel button during that gap.
      configured()
      verify(item("google-setup-cancel").visible)
      verify(!item("google-sign-in").enabled)
      compare(fakeService.signIns, 0)
    }
    function test_cancel_waits_for_exit_and_does_not_report_failure() {
      connect()
      personal.cancel()
      verify(personal.stopping)
      verify(!item("google-setup-start").enabled)
      verify(!item("google-setup-cancel").enabled)
      finishProcess(item("google-setup-process"), 130)
      verify(!personal.busy)
      compare(personal.error, "")
      verify(personal.progress.indexOf("cancelled") >= 0)
      verify(item("google-setup-start").enabled)
      compare(fakeService.signIns, 0)
    }
    function test_failure_unlocks_retry_without_opening_google_permissions() {
      connect()
      var process = item("google-setup-process")
      process.stdout.read(JSON.stringify({event: "error", message: "Could not complete setup"}))
      finishProcess(process, 1)
      verify(!page.busy)
      compare(personal.error, "Could not complete setup")
      verify(item("google-setup-start").enabled)
      verify(item("google-setup-mode").enabled)
      compare(fakeService.signIns, 0)
    }
    function test_installer_stays_locked_until_terminal_work_finishes() {
      checked(["uv"])
      personal.installTools()
      var process = item("google-tools-process")
      verify(process.running)
      verify(page.busy)
      verify(!page.canLeave)
      verify(!page.prepareToLeave())
      verify(!item("google-setup-install").enabled)
      verify(!item("google-setup-check").enabled)
      verify(!item("google-setup-mode").enabled)
      personal.checkTools()
      verify(!item("google-check-process").running)
      finishProcess(process, 0)
      tryVerify(function() { return item("google-check-process").running })
      checked([])
      verify(!page.busy)
      verify(page.canLeave)
      verify(!item("google-setup-install").visible)
    }
    function test_handoff_and_consent_are_one_locked_flow() {
      connect()
      configured()
      var process = item("google-setup-process")
      process.stdout.read(JSON.stringify({event: "done"}))
      finishProcess(process, 0)
      compare(page.pendingGoogleAccount, "owner@example.com")
      verify(page.busy)
      verify(!item("google-sign-in").enabled)
      page.signInNamed()
      compare(fakeService.signIns, 0)
      tryCompare(fakeService, "signIns", 1)
      verify(fakeAuth.loginBusy)
      verify(!item("google-client-change").enabled)
      verify(!item("google-sign-in").enabled)
      verify(item("google-sign-in-cancel").visible)
      page.cancelConnection()
      compare(fakeService.cancellations, 1)
      compare(page.pendingGoogleAccount, "")
      verify(!page.busy)
      verify(item("google-sign-in").enabled)
    }
    function test_back_cancels_work_and_never_launches_consent_afterwards() {
      connect()
      verify(page.prepareToLeave())
      verify(personal.stopping)
      var process = item("google-setup-process")
      process.stdout.read(JSON.stringify({event: "done"}))
      finishProcess(process, 0)
      compare(fakeService.signIns, 0)
      compare(page.pendingGoogleAccount, "")
      verify(!personal.completed)
    }
    function test_backend_unavailable_and_refresh_block_manual_sign_in() {
      configured()
      fakeAuth.accountId = "owner@example.com"
      fakeBackend.ready = false
      page.signInNamed()
      compare(fakeService.signIns, 0)
      verify(!item("google-sign-in").enabled)
      fakeBackend.ready = true
      fakeAuth.refreshBusy = true
      page.signInNamed()
      compare(fakeService.signIns, 0)
      verify(!item("google-client-change").enabled)
      fakeAuth.refreshBusy = false
      verify(item("google-sign-in").enabled)
    }
    function test_manual_save_locks_fields_and_navigation_until_write_finishes() {
      page.manualSetup = true
      item("google-client-save").clicked()
      verify(fakeAuth.credentialsWriteBusy)
      verify(page.busy)
      verify(!page.canLeave)
      verify(!item("google-client-save").enabled)
      verify(!item("google-setup-mode").enabled)
      fakeAuth.credentialsWriteBusy = false
      verify(page.canLeave)
    }
    function test_connected_has_no_connect_or_consent_action() {
      configured()
      fakeAuth.accountId = "owner@example.com"; fakeAuth.loggedIn = true
      fakeService.accountEmail = "owner@example.com"
      verify(!item("google-sign-in").visible)
      verify(!item("google-setup-start").visible)
      page.signInNamed()
      compare(fakeService.signIns, 0)
    }
  }
}
