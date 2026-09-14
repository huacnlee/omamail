import QtQuick

QtObject {
  property var environmentValues: ({
    HOME: "/fixture/home",
    XDG_CONFIG_HOME: "/fixture/config",
    XDG_CACHE_HOME: "/fixture/cache",
    OMAMAIL_BIN: "/fixture/bin/omamail"
  })
  property var opened: []
  property var copied: []
  property var notifications: []
  property var files: ({})
  property var watched: ({})
  signal notificationActivated(string accountId, string messageId)
  signal changed(string path)
  signal failed(string path, string error)

  function reset() {
    opened = []
    copied = []
    notifications = []
    files = ({ "/fixture/existing": "saved" })
    watched = ({})
  }

  function environment(name) { return String(environmentValues[name] || "") }
  function openExternal(target) { opened = opened.concat([String(target)]); return true }
  function setClipboard(text) { copied = copied.concat([String(text)]); return true }
  function showNotification(id, title, body, accountId, messageId) {
    notifications = notifications.concat([{
      id: String(id), title: String(title), body: String(body),
      accountId: String(accountId), messageId: String(messageId)
    }])
    return true
  }
  function read(path) {
    var key = String(path)
    if (!Object.prototype.hasOwnProperty.call(files, key))
      return ({ ok: false, text: "", error: "missing" })
    return ({ ok: true, text: String(files[key]), error: "" })
  }
  function write(path, text, atomic) {
    var next = ({})
    var keys = Object.keys(files)
    for (var i = 0; i < keys.length; i++) next[keys[i]] = files[keys[i]]
    next[String(path)] = String(text)
    files = next
    return ({ ok: true, error: "", atomic: !!atomic })
  }
  function watch(path, enabled) {
    var next = ({})
    var keys = Object.keys(watched)
    for (var i = 0; i < keys.length; i++) next[keys[i]] = watched[keys[i]]
    next[String(path)] = !!enabled
    watched = next
  }
}
