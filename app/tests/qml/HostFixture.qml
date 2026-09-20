import QtQuick

QtObject {
  property var manifest: ({
    id: "omamail", name: "Omamail", version: "0.10.1",
    barWidget: {defaults:{refreshIntervalSec:333,maxMessages:17,notifyNewMail:"On"}}
  })
  property var capabilities: ({agent:false,tray:false,mailto:false,notifications:true})
  property var settings: ({refreshIntervalSec:333,maxMessages:17,notifyNewMail:"Off"})
  property string backendPath: "/fixture/bin/omamail"
  property string notificationError: ""
  property bool hidden: false
  property bool quitCalled: false
  property var pendingNotificationActivation: ({})
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
  signal reopenRequested()
  signal closeRequested()
  signal changed(string path)
  signal failed(string path, string error)

  function reset() {
    capabilities = ({agent:false,tray:false,mailto:false,notifications:true})
    settings = ({refreshIntervalSec:333,maxMessages:17,notifyNewMail:"Off"})
    opened = []
    copied = []
    notifications = []
    notificationError = ""
    pendingNotificationActivation = ({})
    files = ({ "/fixture/existing": "saved" })
    watched = ({})
    hidden = false
    quitCalled = false
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
  function configPath(name) { return "/fixture/config/omamail/" + String(name) }
  function cachePath(name) { return "/fixture/cache/omamail/" + String(name) }
  function localFilePath(url) { return String(url).replace(/^file:\/\//, "") }
  function updateSettings(value) { settings = value; return true }
  function hide() { hidden = true }
  function quit() { quitCalled = true }
  function takePendingNotificationActivation() {
    var pending = pendingNotificationActivation
    pendingNotificationActivation = ({})
    return pending
  }
  function activateNotification(accountId, messageId) {
    pendingNotificationActivation = ({accountId:String(accountId),messageId:String(messageId)})
    notificationActivated(String(accountId), String(messageId))
  }
  function read(path) {
    var key = String(path)
    if (!Object.prototype.hasOwnProperty.call(files, key)) {
      // The native store announces a failed read as well as returning it.
      failed(key, "missing")
      return ({ ok: false, text: "", error: "missing" })
    }
    return ({ ok: true, text: String(files[key]), error: "" })
  }
  function exists(path) {
    var prefix = String(path || "") + "/"
    for (var key in files) if (key === path || key.indexOf(prefix) === 0) return true
    return false
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
