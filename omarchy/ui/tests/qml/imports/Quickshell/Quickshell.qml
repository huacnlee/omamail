pragma Singleton
import QtQuick

QtObject {
  property var notifications: []
  signal notificationActivated(string accountId, string messageId)
  function env(name) { return "" }
  property var detachedCommands: []
  function execDetached(command) {
    detachedCommands = detachedCommands.concat([command.slice()])
    return true
  }
  function showNotification(id, title, body, accountId, messageId) {
    notifications = notifications.concat([{
      id: String(id), title: String(title), body: String(body),
      accountId: String(accountId), messageId: String(messageId)
    }])
    return true
  }
}
