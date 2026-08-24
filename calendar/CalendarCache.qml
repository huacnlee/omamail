import QtQuick
import Quickshell
import Quickshell.Io
import "Cache.js" as Cache

Item {
  id: root

  visible: false
  width: 0
  height: 0

  property string cacheName: "calendar"
  property var store: Cache.emptyStore()
  property bool loaded: false
  readonly property string cacheHome: Quickshell.env("XDG_CACHE_HOME")
    || (Quickshell.env("HOME") + "/.cache")
  readonly property string directory: cacheHome + "/omamail"
  readonly property string path: directory + "/" + cacheName + ".json"

  signal restored()

  function get(scope, startMs, endMs, sourceIds) {
    return Cache.eventsFor(store, scope, startMs, endMs, sourceIds)
  }

  function put(scope, startMs, endMs, events) {
    store = Cache.putRange(store, scope, startMs, endMs, events, Date.now())
    if (loaded) saveTimer.restart()
  }

  Component.onCompleted: directoryMaker.running = true

  Process {
    id: directoryMaker
    command: ["sh", "-c", "umask 077; mkdir -p \"$1\" && chmod 700 \"$1\"", "sh",
      root.directory]
    onExited: cacheFile.reload()
  }

  FileView {
    id: cacheFile
    path: root.path
    atomicWrites: true
    printErrors: false
    onLoaded: {
      root.store = Cache.load(text())
      root.loaded = true
      root.restored()
    }
    onLoadFailed: {
      root.store = Cache.emptyStore()
      root.loaded = true
      root.restored()
    }
  }

  Timer {
    id: saveTimer
    interval: 800
    onTriggered: cacheFile.setText(Cache.serialize(root.store))
  }
}
