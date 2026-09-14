import QtQuick
import QtQuick.Controls
import QtQuick.Window
import Quickshell
import Omamail.Native
import "../../ui" as Omamail

ApplicationWindow {
  id: root
  objectName: "standalone-composition"
  visible: mailApp.opened
  flags: Qt.Window | Qt.FramelessWindowHint
  title: "Omamail"
  color: mailApp.background
  width: 1280
  height: 900
  minimumWidth: 760
  minimumHeight: 520

  onVisibleChanged: {
    if (visible) {
      raise()
      requestActivate()
    }
  }

  property var nativeHost: NativeHost
  property var nativeFileStore: NativeFileStore
  readonly property alias shell: shellAdapter
  readonly property alias manifest: manifestAdapter
  readonly property alias service: mailService
  readonly property alias app: mailApp
  property var pendingActivation: null
  property bool initialOpenIssued: false
  property bool windowSizeLoaded: false
  property int normalWindowWidth: 1280
  property int normalWindowHeight: 900
  readonly property int availableWindowWidth: Screen.availableWidth > 0
    ? Math.floor(Screen.availableWidth) : 1280
  readonly property int availableWindowHeight: Screen.availableHeight > 0
    ? Math.floor(Screen.availableHeight) : 900

  function boundedWindowDimension(value, fallback, minimum, available) {
    if (typeof value !== "number" || !isFinite(value) || Math.floor(value) !== value
        || value < minimum || value > 16384)
      return Math.min(fallback, Math.max(minimum, available))
    return Math.min(value, Math.max(minimum, available))
  }

  function restoreWindowSize() {
    var saved = ({})
    var path = shellAdapter.configPath("window-size.json")
    if (path !== "" && root.nativeFileStore && typeof root.nativeFileStore.read === "function") {
      var result = root.nativeFileStore.read(path)
      if (result && result.ok === true) {
        try { saved = JSON.parse(String(result.text || "")) }
        catch (error) { saved = ({}) }
      }
    }
    normalWindowWidth = boundedWindowDimension(saved.width, 1280, minimumWidth,
      availableWindowWidth)
    normalWindowHeight = boundedWindowDimension(saved.height, 900, minimumHeight,
      availableWindowHeight)
    width = normalWindowWidth
    height = normalWindowHeight
    windowSizeLoaded = true
  }

  function scheduleWindowSizeSave() {
    if (!windowSizeLoaded || visibility !== Window.Windowed) return
    normalWindowWidth = Math.floor(width)
    normalWindowHeight = Math.floor(height)
    windowSizeSettling.restart()
  }

  function saveWindowSize() {
    windowSizeSettling.stop()
    if (!windowSizeLoaded || visibility !== Window.Windowed) return
    shellAdapter.writeConfig("window-size.json", JSON.stringify({
      width: normalWindowWidth,
      height: normalWindowHeight
    }), function(ok, error) {})
  }

  onWidthChanged: scheduleWindowSizeSave()
  onHeightChanged: scheduleWindowSizeSave()
  onClosing: saveWindowSize()

  Timer {
    id: windowSizeSettling
    objectName: "window-size-settling"
    interval: 500
    repeat: false
    onTriggered: root.saveWindowSize()
  }

  function openInitialWindow() {
    if (initialOpenIssued) return
    initialOpenIssued = true
    shellAdapter.summon(manifestAdapter.value.id, "{}")
  }

  function queueActivation(accountId, messageId) {
    var account = String(accountId || "")
    var message = String(messageId || "")
    if (account === "" || message === "") return
    pendingActivation = ({ accountId: account, messageId: message })
    routePendingActivation()
    if (pendingActivation && !mailService.accountsLoaded) activationFallback.restart()
  }

  function routePendingActivation() {
    if (!pendingActivation || !mailService.accountsLoaded) return
    activationFallback.stop()
    var target = pendingActivation
    pendingActivation = null
    // Use the account registry's validation path before acknowledging the
    // durable native route. A stale cold-start activation still opens the
    // ordinary window without navigating to its values.
    var accepted = mailService.openNotification(String(target.accountId), String(target.messageId))
    if (accepted) initialOpenIssued = true
    if (root.nativeHost && typeof root.nativeHost.takePendingNotificationActivation === "function")
      root.nativeHost.takePendingNotificationActivation()
    if (!accepted) openInitialWindow()
  }

  Timer {
    id: activationFallback
    objectName: "activation-fallback"
    interval: 5000
    repeat: false
    // Account storage may be temporarily unavailable. Never leave a cold
    // notification launch windowless; retain the durable route so a later
    // successful registry read can still validate and navigate it.
    onTriggered: root.openInitialWindow()
  }

  Binding { target: Quickshell; property: "nativeHost"; value: root.nativeHost }
  Binding { target: Quickshell; property: "fileStore"; value: root.nativeFileStore }

  StandaloneManifest {
    id: manifestAdapter
    source: root.nativeHost ? root.nativeHost.manifest : ({})
  }

  StandaloneShell {
    id: shellAdapter
    host: root.nativeHost
    fileStore: root.nativeFileStore
    manifest: manifestAdapter.value
    service: mailService
    app: mailApp
  }

  Omamail.Service {
    id: mailService
    objectName: "standalone-service"
    shell: shellAdapter
    manifest: manifestAdapter.value
    platform: shellAdapter
    initialSettings: root.nativeHost ? root.nativeHost.settings : ({})
  }

  Omamail.App {
    id: mailApp
    objectName: "standalone-app"
    width: root.width
    height: root.height
    shell: shellAdapter
    manifest: manifestAdapter.value
    service: mailService
    standaloneWindowChrome: true
  }

  Rectangle {
    id: windowBorder
    objectName: "standalone-window-border"
    anchors.fill: parent
    z: 1000000
    visible: root.visibility !== Window.Maximized
      && root.visibility !== Window.FullScreen
    color: Qt.rgba(mailApp.background.r, mailApp.background.g,
      mailApp.background.b, 0)
    border.width: mailApp.borderWidth
    border.color: mailApp.borderColor
    antialiasing: false
  }

  Connections {
    target: root.nativeHost
    ignoreUnknownSignals: true
    function onSettingsChanged() {
      if (root.nativeHost) mailService.applySettings(root.nativeHost.settings)
    }
  }

  Connections {
    target: mailService
    function onAccountsLoadedChanged() { root.routePendingActivation() }
  }

  Connections {
    target: Quickshell
    ignoreUnknownSignals: true
    function onNotificationActivated(accountId, messageId) {
      root.queueActivation(accountId, messageId)
    }
  }

  Component.onCompleted: {
    restoreWindowSize()
    var pending = root.nativeHost ? root.nativeHost.pendingNotificationActivation || ({}) : ({})
    if (String(pending.accountId || "") !== "" && String(pending.messageId || "") !== "")
      root.pendingActivation = ({ accountId: String(pending.accountId),
        messageId: String(pending.messageId) })
    if (root.pendingActivation) {
      root.routePendingActivation()
      if (root.pendingActivation) activationFallback.start()
    }
    else openInitialWindow()
  }
}
