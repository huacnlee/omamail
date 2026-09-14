import QtQuick
import Quickshell
import Omamail.Native
import "../../ui" as Omamail

Item {
  id: root
  objectName: "standalone-composition"

  property var nativeHost: NativeHost
  property var nativeFileStore: NativeFileStore
  readonly property alias shell: shellAdapter
  readonly property alias manifest: manifestAdapter
  readonly property alias service: mailService
  readonly property alias app: mailApp
  property var pendingActivation: null
  property bool initialOpenIssued: false

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
  }

  function routePendingActivation() {
    if (!pendingActivation || !mailService.accountsLoaded) return
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
    shell: shellAdapter
    manifest: manifestAdapter.value
    service: mailService
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
    var pending = root.nativeHost ? root.nativeHost.pendingNotificationActivation || ({}) : ({})
    if (String(pending.accountId || "") !== "" && String(pending.messageId || "") !== "")
      root.pendingActivation = ({ accountId: String(pending.accountId),
        messageId: String(pending.messageId) })
    if (root.pendingActivation) root.routePendingActivation()
    else openInitialWindow()
  }
}
