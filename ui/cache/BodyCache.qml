import QtQuick

// Rust owns private body files, bounded reads, atomic writes and LRU eviction.
Item {
  id: root
  visible: false
  width: 0
  height: 0
  required property string pluginDir
  property var backend: null
  property string accountId: ""
  property bool nativeWriteBusy: false
  property var writeQueue: []

  function read(id, callback) {
    if (!backend || !backend.ready) {
      if (typeof callback === "function") callback(null)
      return
    }
    var account = accountId
    backend.call("cache.bodyRead", { accountId: account, id: String(id || "") }, function(body, error) {
      if (typeof callback === "function") callback(!root || root.accountId !== account || error ? null : body)
    })
  }

  function touch(id) {
    if (backend && backend.ready)
      backend.call("cache.bodyTouch", { accountId: accountId, id: String(id || "") }, function() {})
  }

  function put(id, body) {
    if (!backend || !backend.ready) return
    var jobs = writeQueue.filter(function(job) { return job.clear === true })
    jobs.push({ accountId: accountId, id: String(id || ""), body: body })
    writeQueue = jobs
    drainNative()
  }

  function clear() {
    if (!backend || !backend.ready) return
    writeQueue = [{ accountId: accountId, clear: true }]
    drainNative()
  }

  Connections {
    target: root.backend
    ignoreUnknownSignals: true
    function onReadyChanged() { root.drainNative() }
  }

  function drainNative() {
    if (!backend || !backend.ready || nativeWriteBusy || writeQueue.length === 0) return
    var job = writeQueue[0]
    writeQueue = writeQueue.slice(1)
    nativeWriteBusy = true
    function done() {
      if (!root) return
      root.nativeWriteBusy = false
      root.drainNative()
    }
    if (job.clear)
      backend.call("cache.bodyClear", { accountId: job.accountId }, done)
    else
      backend.putBodyCache(job.accountId, job.id, job.body, done)
  }

}
