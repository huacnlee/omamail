import QtQuick
import QtQuick.Controls
import QtTest
import Quickshell
import qs.Commons
import "../../qml" as Standalone
import "../../../ui/providers" as Providers

TestCase {
  id: testCase
  name: "StandaloneComposition"
  when: windowShown
  width: 640
  height: 480

  HostFixture { id: host }

  Switch {
    id: styledSwitch
    visible: false
    checked: true
    palette.window: Color.background
    palette.windowText: Color.foreground
    palette.highlight: Color.accent
  }

  SpinBox {
    id: styledSpinBox
    visible: false
    editable: true
    palette.window: Color.background
    palette.windowText: Color.foreground
    palette.highlight: Color.accent
  }

  ToolTip {
    id: styledToolTip
    visible: false
    text: "Delayed help"
  }

  Item {
    id: tooltipTrigger
    x: 40
    y: 40
    width: 120
    height: 32
    ToolTip { id: positionedToolTip; visible: false; text: "Anchored help" }
  }

  Item {
    id: edgeTooltipTrigger
    x: -10
    y: testCase.height - height
    width: 24
    height: 16
    ToolTip { id: edgeToolTip; visible: false; text: "Edge anchored help" }
  }

  Component {
    id: compositionComponent
    Standalone.Main { nativeHost: host; nativeFileStore: host }
  }

  Component {
    id: gmailAuthComponent
    Providers.AuthManager {
      pluginDir: "/fixture/plugin"
      platform: credentialShell
      backend: null
      accountId: ""
    }
  }

  Standalone.StandaloneShell {
    id: credentialShell
    host: host
    fileStore: host
    manifest: ({id:"omamail"})
  }

  function init() { host.reset() }

  function test_standalone_controls_use_semantic_omamail_style() {
    verify(findChild(styledSwitch, "omamail-switch-knob"))
    var background = findChild(styledSpinBox, "omamail-spinbox-background")
    verify(background)
    verify(findChild(styledSpinBox, "omamail-spinbox-decrement"))
    verify(findChild(styledSpinBox, "omamail-spinbox-increment"))
    compare(background.radius, Style.cornerRadius)
    compare(String(styledSpinBox.palette.windowText), String(Color.foreground))
    compare(styledToolTip.delay, Style.tooltipDelay)
    var tooltipLabel = findChild(styledToolTip, "omamail-tooltip-label")
    var tooltipBackground = findChild(styledToolTip, "omamail-tooltip-background")
    verify(tooltipLabel)
    verify(tooltipBackground)
    compare(String(tooltipLabel.color), String(Color.popups.text))
    compare(String(tooltipBackground.color), String(Color.popups.background))
    compare(String(tooltipBackground.border.color), String(Color.popups.border))
    compare(tooltipBackground.radius, Style.cornerRadius)
  }

  function test_tooltip_is_anchored_below_the_trigger_not_the_pointer() {
    positionedToolTip.visible = true
    tryCompare(positionedToolTip, "opened", true, Style.tooltipDelay + 1000)
    verify(positionedToolTip.y >= tooltipTrigger.height)
    var anchoredX = positionedToolTip.x
    var anchoredY = positionedToolTip.y
    mouseMove(tooltipTrigger, 1, 1)
    wait(20)
    compare(positionedToolTip.x, anchoredX)
    compare(positionedToolTip.y, anchoredY)
    mouseMove(tooltipTrigger, tooltipTrigger.width - 1, tooltipTrigger.height - 1)
    wait(20)
    compare(positionedToolTip.x, anchoredX)
    compare(positionedToolTip.y, anchoredY)
    positionedToolTip.visible = false
    tryCompare(positionedToolTip, "opened", false)
  }

  function test_tooltip_flips_above_and_clamps_to_window_edges() {
    edgeToolTip.visible = true
    tryCompare(edgeToolTip, "opened", true, Style.tooltipDelay + 1000)
    var anchor = edgeTooltipTrigger.mapToItem(null, 0, 0)
    verify(anchor.x + edgeToolTip.x >= 0)
    verify(anchor.x + edgeToolTip.x + edgeToolTip.width <= testCase.width)
    verify(anchor.y + edgeToolTip.y + edgeToolTip.height < anchor.y)
    edgeToolTip.visible = false
    tryCompare(edgeToolTip, "opened", false)
  }

  function test_one_shared_service_and_app_with_standalone_capabilities() {
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    verify(composition.visible, "standalone composition must expose a native window")
    compare(composition.service.objectName, "standalone-service")
    compare(composition.app.objectName, "standalone-app")
    verify((composition.flags & Qt.FramelessWindowHint) !== 0)
    verify(composition.app.standaloneWindowChrome)
    var windowBorder = findChild(composition, "standalone-window-border")
    verify(windowBorder)
    compare(String(windowBorder.border.color), String(Color.border))
    verify(String(Color.border) !== String(composition.app.borderColor))
    compare(windowBorder.border.width,
      composition.app.borderWidth / Math.max(1, Screen.devicePixelRatio))
    verify(windowBorder.visible)
    var corners = {
      "top-left": Qt.SizeFDiagCursor, "top-right": Qt.SizeBDiagCursor,
      "bottom-left": Qt.SizeBDiagCursor, "bottom-right": Qt.SizeFDiagCursor
    }
    // Repeater delegates have a visual parent but no object parent, so
    // findChild cannot see them; the window's content lists them directly.
    function resizeCorner(name) {
      var items = composition.contentItem.children
      for (var i = 0; i < items.length; i++)
        if (items[i].objectName === "standalone-resize-corner-" + name) return items[i]
      return null
    }
    for (var name in corners) {
      var corner = resizeCorner(name)
      verify(corner, name)
      compare(corner.cursorShape, corners[name])
      verify(corner.visible)
      compare(corner.x, name.indexOf("right") >= 0 ? composition.width - corner.width : 0)
      compare(corner.y, name.indexOf("bottom") >= 0 ? composition.height - corner.height : 0)
    }
    composition.visibility = Window.Maximized
    compare(resizeCorner("top-left").visible, false)
    composition.visibility = Window.Windowed
    verify(findChild(composition, "app-title-bar-drag-area").enabled)
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
    compare(findChild(composition, "diagnostics-helper"), null)
    compare(findChild(composition, "agent-prompt"), null)
    compare(findChild(composition, "compose-agent"), null)
    compare(findChild(composition, "backend-diagnose").visible, false)
    compare(findChild(composition, "bar-settings").visible, false)
    compare(composition.service.capabilities.appearance, true)
    composition.app.openSettings()
    verify(findChild(composition, "appearance-settings").visible)
    compare(composition.service.appearance, "System")
    findChild(composition, "appearance-dark").clicked()
    compare(host.settings.appearance, "Dark")
    compare(composition.service.appearance, "Dark")
    compare(Color.dark, true)
    compare(String(Color.preferredAppearance), "dark")
    findChild(composition, "appearance-light").clicked()
    compare(Color.dark, false)
    compare(String(Color.background), "#fffcf0")
    findChild(composition, "appearance-system").clicked()
    compare(String(Color.preferredAppearance), "")
    var appMenu = findChild(composition, "app-menu")
    verify(appMenu)
    compare(appMenu.canQuit, true)
    appMenu.openAt(40, 40)
    wait(20)
    var quitRow = findChild(composition, "app-menu-quit")
    verify(quitRow)
    verify(quitRow.visible)
    quitRow.activated()
    compare(host.quitCalled, true)
  }

  function test_window_size_restores_and_is_saved_after_resize() {
    var path = "/fixture/config/omamail/window-size.json"
    host.files = ({})
    host.files[path] = JSON.stringify({width: 1000, height: 680})
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    compare(composition.width, 1000)
    compare(composition.height, 680)
    composition.width = 980
    composition.height = 710
    composition.scheduleWindowSizeSave()
    composition.saveWindowSize()
    var saved = JSON.parse(host.files[path])
    compare(saved.width, 980)
    compare(saved.height, 710)
    composition.destroy()
    wait(0)
    var restarted = createTemporaryObject(compositionComponent, testCase)
    verify(restarted)
    compare(restarted.width, 980)
    compare(restarted.height, 710)
  }

  function test_bad_window_size_uses_bounded_default() {
    var path = "/fixture/config/omamail/window-size.json"
    host.files = ({})
    host.files[path] = "{broken JSON"
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    compare(composition.width, Math.min(1024, Math.max(760, composition.availableWindowWidth)))
    compare(composition.height, Math.min(768, Math.max(520, composition.availableWindowHeight)))
    compare(composition.boundedWindowDimension(759, 1024, 760, 1920), 1024)
    compare(composition.boundedWindowDimension("768", 768, 520, 1080), 768)
    compare(composition.boundedWindowDimension(20000, 1024, 760, 1920), 1024)
    compare(composition.boundedWindowDimension(1600, 1024, 760, 1200), 1200)
  }

  function test_close_chord_shuts_the_window_through_the_host() {
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    verify(composition.app.opened)
    composition.requestActivate()
    tryVerify(function() { return composition.active })
    keySequence(StandardKey.Close)
    compare(composition.app.opened, false)
    compare(host.hidden, true)
    compare(host.quitCalled, false)
    // The Dock brings it back through the same door the launcher uses.
    host.reopenRequested()
    compare(composition.app.opened, true)
    verify(composition.visible)
  }

  function test_non_windowed_size_does_not_replace_saved_normal_size() {
    var path = "/fixture/config/omamail/window-size.json"
    host.files = ({})
    host.files[path] = JSON.stringify({width: 1000, height: 680})
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    composition.visibility = Window.Maximized
    composition.width = 1400
    composition.height = 850
    composition.saveWindowSize()
    compare(JSON.parse(host.files[path]), {width:1000, height:680})
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
    compare(findChild(composition, "notification-settings").visible, false)
    compare(findChild(composition, "bar-settings").visible, false)
    verify(composition.shell.hide("omamail"))
    compare(host.quitCalled, true)
    compare(host.hidden, false)
  }

  function test_close_hides_rather_than_quits_where_the_dock_can_reopen() {
    host.capabilities = ({agent:false,tray:false,mailto:false,notifications:false,reopen:true})
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    verify(composition.shell.hide("omamail"))
    compare(host.hidden, true)
    compare(host.quitCalled, false)
    host.reopenRequested()
    compare(composition.app.opened, true)
  }

  function test_notification_error_uses_a_valid_semantic_colour() {
    host.notificationError = "Notification permission was denied"
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    var label = findChild(composition, "notificationIntegrationError")
    verify(label)
    verify(label.color !== undefined)
    compare(String(label.color), String(composition.app.urgent))
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

  function test_cold_start_activation_opens_an_ordinary_window_if_registry_stalls() {
    host.pendingNotificationActivation = ({accountId:"imap:a@example.org",messageId:"7:INBOX"})
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    composition.service.accountsLoaded = false
    var fallback = findChild(composition, "activation-fallback")
    verify(fallback)
    fallback.interval = 1
    fallback.restart()
    tryCompare(composition.app, "opened", true)
    compare(host.pendingNotificationActivation,
      {accountId:"imap:a@example.org",messageId:"7:INBOX"})
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
    compare(host.files["/fixture/config/omamail/calendars.json"], "{}")
    verify(!composition.shell.writeConfig("../outside", "secret", function() {}))
    verify(!Object.prototype.hasOwnProperty.call(host.files, "/fixture/config/omamail/../outside"))
  }

  function test_google_client_is_saved_and_reloaded_through_standalone_store() {
    Quickshell.nativeHost = host
    Quickshell.fileStore = host
    var auth = createTemporaryObject(gmailAuthComponent, testCase)
    verify(auth)
    verify(auth.saveCredentials(
      "123-standalone.apps.googleusercontent.com\nGOCSPX-synthetic-secret"))
    tryCompare(auth, "credentialsWriteBusy", false)
    compare(auth.clientId, "123-standalone.apps.googleusercontent.com")
    compare(auth.credentials.clientSecret, "GOCSPX-synthetic-secret")
    var saved = JSON.parse(host.files["/fixture/config/omamail/credentials.json"])
    compare(saved.installed.client_id, "123-standalone.apps.googleusercontent.com")
    compare(saved.installed.client_secret, "GOCSPX-synthetic-secret")
  }


  function test_all_shared_clipboard_writes_cross_the_host_seam() {
    var composition = createTemporaryObject(compositionComponent, testCase)
    verify(composition)
    verify(composition.app.copyText("meeting room <A> & notes"))
    compare(host.copied, ["meeting room <A> & notes"])
    compare(findChild(composition, "clipboardProxy"), null)
  }
}
