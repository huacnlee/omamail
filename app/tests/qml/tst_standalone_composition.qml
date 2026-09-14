import QtQuick
import QtTest
import Quickshell
import "../../qml" as Standalone

TestCase {
  id: testCase
  name: "StandaloneComposition"
  when: windowShown
  width: 640
  height: 480

  HostFixture { id: host }

  Component {
    id: compositionComponent
    Standalone.Main { nativeHost: host; nativeFileStore: host }
  }

  function init() { host.reset() }

  function test_one_shared_service_and_app_with_standalone_capabilities() {
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    compare(composition.service.objectName, "standalone-service")
    compare(composition.app.objectName, "standalone-app")
    verify(composition.app.opened)
    compare(composition.service.capabilities.agent, false)
    compare(composition.service.capabilities.tray, false)
    compare(composition.service.capabilities.mailto, false)
    compare(composition.service.capabilities.notifications, true)
    compare(composition.service.settings.refreshIntervalSec, 333)
    compare(composition.service.settings.maxMessages, 17)
    compare(composition.service.notifyNewMail, false)
    compare(composition.service.backendRuntime.bundled, true)
    compare(composition.service.backendRuntime.canInstall, false)
    compare(composition.service.backendRuntime.executable, host.backendPath)
    tryCompare(composition.app, "backendUnavailable", true)
    compare(findChild(composition, "agent-runner"), null)
    compare(findChild(composition, "agent-prompt"), null)
    compare(findChild(composition, "compose-agent"), null)
  }

  function test_shell_persists_settings_and_routes_activation_payload() {
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    verify(composition.shell.updateEntryInline("omamail", {id:"omamail",maxMessages:42}))
    compare(host.settings, {maxMessages:42})

    var opened = ""
    var fakeApp = Qt.createQmlObject('import QtQuick; QtObject {'
      + ' property bool opened: false; property string payload: "";'
      + ' function open(value) { opened = true; payload = value }'
      + ' function close() { opened = false } }', testCase)
    composition.shell.app = fakeApp
    var payload = JSON.stringify({accountId:"imap:a@example.org",messageId:"7:INBOX"})
    verify(composition.shell.summon("omamail", payload))
    compare(fakeApp.payload, payload)
    verify(fakeApp.opened)
  }

  function test_plain_notification_text_crosses_native_boundary_once() {
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    verify(composition.shell.showNotification("a:7", "<img> & sender", "body <b>&",
      "a", "7"))
    compare(host.notifications.length, 1)
    compare(host.notifications[0].title, "<img> & sender")
    compare(host.notifications[0].body, "body <b>&")
    host.notificationError = "Notification permission was denied"
    compare(composition.service.notificationError, "Notification permission was denied")
  }

  function test_native_notification_capability_tracks_host_availability() {
    host.capabilities = ({agent:false,tray:false,mailto:false,notifications:false})
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    compare(composition.service.hasNotifications, false)
  }

  function test_cold_start_activation_is_consumed_once() {
    host.pendingNotificationActivation = ({accountId:"imap:a@example.org",messageId:"7:INBOX"})
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    composition.service.accountsLoaded = false
    compare(host.pendingNotificationActivation,
      {accountId:"imap:a@example.org",messageId:"7:INBOX"},
      "the native route remains durable until the registry can validate it")
    compare(composition.app.cursorId, "", "native values are not routed before registry validation")
    composition.service.accountList = ({version:1,accounts:[{
      id:"imap:a@example.org",email:"a@example.org",provider:"imap",
      imap:{imapHost:"imap.example.org",imapPort:993,smtpHost:"smtp.example.org",
        smtpPort:465,username:"a@example.org",aliases:[],insecure:false}
    }],activeId:"imap:a@example.org"})
    composition.service.accountsLoaded = true
    tryCompare(composition.app, "cursorId", "7:INBOX")
    compare(host.pendingNotificationActivation, {})
  }

  function test_live_activation_waits_for_registry_and_acknowledges_after_routing() {
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    composition.service.accountsLoaded = false
    host.activateNotification("imap:a@example.org", "8:INBOX")
    compare(host.pendingNotificationActivation,
      {accountId:"imap:a@example.org",messageId:"8:INBOX"})
    composition.service.accountList = ({version:1,accounts:[{
      id:"imap:a@example.org",email:"a@example.org",provider:"imap",
      imap:{imapHost:"imap.example.org",imapPort:993,smtpHost:"smtp.example.org",
        smtpPort:465,username:"a@example.org",aliases:[],insecure:false}
    }],activeId:"imap:a@example.org"})
    composition.service.accountsLoaded = true
    tryCompare(composition.app, "cursorId", "8:INBOX")
    compare(host.pendingNotificationActivation, {})
  }

  function test_cold_start_rejects_an_account_missing_from_the_registry() {
    host.pendingNotificationActivation = ({accountId:"imap:gone@example.org",messageId:"7:INBOX"})
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    composition.service.accountsLoaded = false
    composition.service.accountList = ({version:1,accounts:[{
      id:"imap:a@example.org",email:"a@example.org",provider:"imap",
      imap:{imapHost:"imap.example.org",imapPort:993,smtpHost:"smtp.example.org",
        smtpPort:465,username:"a@example.org",aliases:[],insecure:false}
    }],activeId:"imap:a@example.org"})
    composition.service.accountsLoaded = true
    tryCompare(composition.app, "opened", true)
    compare(composition.app.cursorId, "")
  }

  function test_host_paths_and_config_writes_reject_unlisted_names() {
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    var called = false
    verify(composition.shell.writeConfig("calendars.json", "{}", function(ok) { called = ok }))
    verify(called)
    compare(host.files["/fixture/config/Omamail/calendars.json"], "{}")
    verify(!composition.shell.writeConfig("../outside", "secret", function() {}))
    verify(!Object.prototype.hasOwnProperty.call(host.files, "/fixture/config/Omamail/../outside"))
  }
}
