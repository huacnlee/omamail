pragma Singleton
import QtQuick

QtObject {
  property var notifications: []
  // A test that reads files through FileView supplies a store; none is the
  // stub's old behaviour, a file that never loads.
  property var fileStore: null
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
