pragma Singleton
import QtQuick

QtObject {
  property var notifications: []
  signal notificationActivated(string accountId, string messageId)
  function env(name) { return "" }
  function execDetached(command) {}
  function showNotification(id, title, body, accountId, messageId) {
    notifications = notifications.concat([{
      id: String(id), title: String(title), body: String(body),
      accountId: String(accountId), messageId: String(messageId)
    }])
    return true
  }
}
