import QtQuick
import QtQuick.Dialogs
import qs.Commons

QtObject {
  id: root

  required property var host
  required property var fileStore
  required property var manifest
  property var service: null
  property var app: null

  readonly property bool standalone: true
  readonly property string backendPath: String(host && host.backendPath || "")
  readonly property string calendarPalettePath: ""
  readonly property string notificationError: String(host && host.notificationError || "")
  readonly property var capabilities: ({
    agent: false,
    tray: false,
    mailto: false,
    notifications: !!host && !!host.capabilities
      && host.capabilities.notifications === true,
    reopen: !!host && !!host.capabilities && host.capabilities.reopen === true,
    // An installed Omarchy theme is the palette; the appearance setting only
    // has something to decide where the fallback palettes are in use.
    appearance: !Color.hasOmarchyTheme
  })

  property var fileCallback: null

  function updateEntryInline(pluginId, entry) {
    if (!host || typeof host.updateSettings !== "function") return false
    var next = ({})
    var value = entry || ({})
    for (var key in value) if (key !== "id") next[key] = value[key]
    return host.updateSettings(next)
  }

  function summon(pluginId, payload) {
    if (String(pluginId || "") !== String(manifest.id || "omamail") || !app) return false
    app.open(String(payload || "{}"))
    return true
  }

  function hide(pluginId) {
    if (String(pluginId || "") !== String(manifest.id || "omamail")) return false
    if (app && typeof app.close === "function") app.close()
    // With no tray, no actionable notification and no Dock to click there is
    // no route back to a hidden window. End the process so a launcher
    // invocation starts a reachable application again.
    if (!capabilities.tray && !capabilities.notifications && !capabilities.reopen
        && host && typeof host.quit === "function") host.quit()
    else if (host && typeof host.hide === "function") host.hide()
    return true
  }

  function quit() {
    if (!host || typeof host.quit !== "function") return false
    host.quit()
    return true
  }

  function openExternal(target) {
    return !!host && typeof host.openExternal === "function" && host.openExternal(String(target || ""))
  }

  function setClipboard(text) {
    return !!host && typeof host.setClipboard === "function" && host.setClipboard(String(text || ""))
  }

  function showNotification(id, title, body, accountId, messageId) {
    return !!host && typeof host.showNotification === "function"
      && host.showNotification(String(id), String(title), String(body),
        String(accountId), String(messageId))
  }

  function configPath(name) {
    return host && typeof host.configPath === "function" ? String(host.configPath(String(name || ""))) : ""
  }

  function cachePath(name) {
    return host && typeof host.cachePath === "function" ? String(host.cachePath(String(name || ""))) : ""
  }

  function writeConfig(name, text, callback) {
    var allowed = ["credentials.json", "window.json", "window-size.json", "calendars.json"]
    if (allowed.indexOf(String(name || "")) < 0 || !fileStore
        || typeof fileStore.write !== "function") {
      if (typeof callback === "function") callback(false, "Invalid configuration file")
      return false
    }
    var path = configPath(name)
    var result = path === "" ? ({ok:false,error:"Configuration path is unavailable"})
      : fileStore.write(path, String(text || ""), true)
    if (typeof callback === "function") callback(result && result.ok === true,
      result && result.error ? String(result.error) : "")
    return !!result && result.ok === true
  }

  function chooseFiles(callback) {
    if (fileCallback !== null) return false
    fileCallback = callback
    picker.open()
    return true
  }

  function clipboardAttachment(directory, callback) {
    if (typeof callback === "function") callback(({ok:false,error:"no-image"}))
    return true
  }

  property var pickerObject: FileDialog {
    id: picker
    title: "Choose files"
    fileMode: FileDialog.OpenFiles
    onAccepted: {
      var paths = []
      for (var i = 0; i < selectedFiles.length; i++) {
        var path = root.host && typeof root.host.localFilePath === "function"
          ? String(root.host.localFilePath(selectedFiles[i]) || "") : ""
        if (path !== "") paths.push(path)
      }
      var done = root.fileCallback
      root.fileCallback = null
      if (typeof done === "function") done(({ok:true,paths:paths}))
    }
    onRejected: {
      var done = root.fileCallback
      root.fileCallback = null
      if (typeof done === "function") done(({ok:false,error:"cancelled"}))
    }
  }
}
