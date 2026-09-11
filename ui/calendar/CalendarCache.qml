import QtQuick
import "Cache.js" as Cache

Item {
  id: root

  visible: false
  width: 0
  height: 0

  property string cacheName: "calendar"
  property var store: Cache.emptyStore()
  property bool loaded: false
  property var backend: null
  property int epoch: 0

  signal restored()

  function get(scope, startMs, endMs, sourceIds) {
    return Cache.eventsFor(store, scope, startMs, endMs, sourceIds)
  }

  function put(scope, startMs, endMs, events) {
    store = Cache.putRange(store, scope, startMs, endMs, events, Date.now())
    if (loaded) saveTimer.restart()
  }

  function restore() {
    var mine = ++epoch
    loaded = false
    store = Cache.emptyStore()
    if (!backend || !backend.ready) return
    backend.call("cache.calendarRead", { name: cacheName }, function(value,error) {
      if (!root || root.epoch !== mine) return
      root.store = error || !value ? Cache.emptyStore() : value
      root.loaded = true
      root.restored()
    })
  }
  Component.onCompleted: restore()
  onBackendChanged: restore()
  onCacheNameChanged: restore()
  Connections {
    target: root.backend
    ignoreUnknownSignals: true
    function onReadyChanged() { root.restore() }
  }
  Timer {
    id: saveTimer
    interval: 800
    onTriggered: {
      if (!root.loaded || !root.backend || !root.backend.ready) return
      root.backend.call("cache.calendarPut", { name: root.cacheName, store: root.store }, function() {})
    }
  }
}
