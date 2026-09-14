pragma Singleton
import QtQuick

QtObject {
  id: root

  property var nativeHost: null
  property var fileStore: null
  signal notificationActivated(string accountId, string messageId)

  function env(name) {
    if (!nativeHost || typeof nativeHost.environment !== "function") return ""
    return String(nativeHost.environment(String(name)) || "")
  }

  function execDetached(command) {
    if (!nativeHost || !Array.isArray(command) || command.length !== 2) return false
    if (command[0] === "xdg-open" && typeof nativeHost.openExternal === "function")
      return !!nativeHost.openExternal(String(command[1]))
    if (command[0] === "wl-copy" && typeof nativeHost.setClipboard === "function")
      return !!nativeHost.setClipboard(String(command[1]))
    return false
  }

  function showNotification(id, title, body, accountId, messageId) {
    if (!nativeHost || typeof nativeHost.showNotification !== "function") return false
    return !!nativeHost.showNotification(String(id), String(title), String(body),
      String(accountId), String(messageId))
  }

  property Connections nativeConnections: Connections {
    target: root.nativeHost
    ignoreUnknownSignals: true
    function onNotificationActivated(accountId, messageId) {
      root.notificationActivated(String(accountId), String(messageId))
    }
  }
}
