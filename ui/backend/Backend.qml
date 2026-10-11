import QtQuick
import Quickshell.Io
import "Wire.js" as Wire
import "Upload.js" as Upload
import "Chunks.js" as Chunks
import "Compatibility.js" as Compatibility

Item {
  id: root
  required property string executable
  required property string expectedVersion
  property int expectedApiVersion: 0
  // The step the checkout is ahead of the pin by, if any: `needsUpdate` says
  // the connected binary lacks it, and a call to one of its methods is
  // refused here rather than sent to a binary that never heard of it.
  property int latestApiVersion: 0
  property var unreleasedMethods: []
  readonly property int apiVersion: Compatibility.connectedApiVersion(protocolInfo)
  readonly property bool needsUpdate: ready && Compatibility.needsUpdate(protocolInfo, latestApiVersion)
  property bool launchEnabled: true
  onLaunchEnabledChanged: Qt.callLater(reconcileProcess)
  onExecutableChanged: Qt.callLater(reconcileProcess)

  function reconcileProcess() {
    if (!launchEnabled || executable === "") {
      failPending("Backend unavailable")
      child.running = false
    } else if (!child.running && !stopping) {
      failure = ""
      child.running = true
    }
  }
  readonly property bool ready: launchEnabled && connected && protocolInfo !== null && !stopping
  readonly property bool stopping: shutdownStarted
  property bool connected: false
  property var protocolInfo: null
  property var pending: ({})
  property var queued: []
  property bool draining: false
  property var uploadQueue: Upload.makeQueue(function() {
    root.stopForFailure("Backend upload cleanup failed")
  })
  property int sequence: 0
  property string failure: ""
  property var responseTransfer: null
  property bool shutdownStarted: false
  property bool shutdownFinished: false
  property bool quitRequested: false
  property var shutdownCallbacks: []
  property var shutdownError: null
  property var shutdownFailure: null

  signal shutdownComplete(var error)
  signal notification(string method, var params)
  signal requestFailed(string method, var error)

  function parseMessage(raw, callback) {
    return Upload.parse(raw, function(method, params, done) {
      return root.call(method, params, done)
    }, function() { return root.ready }, callback, uploadQueue)
  }

  function putBodyCache(accountId, id, body, callback) {
    return Upload.putBody(accountId, id, body, function(method, params, done) {
      return root.call(method, params, done)
    }, function() { return root.ready }, callback, uploadQueue)
  }

  function call(method, params, callback) {
    // Keep each physical frame small even for Unicode-heavy MIME/JSON data.
    if (JSON.stringify(params).length > 200000) {
      return Upload.request(method, params, function(nextMethod, nextParams, done) {
        return root.request(nextMethod, nextParams, done, false)
      }, function() { return root.ready }, callback, uploadQueue)
    }
    return request(method, params, callback, false)
  }

  function request(method, params, callback, internal) {
    var operation = method === "request.upload" && params ? params.method : method
    var done = function(result, error) {
      if (error) root.requestFailed(operation, error)
      if (typeof callback === "function") callback(result, error)
    }
    var message = Compatibility.dispatchError(
      connected, ready, stopping, method, internal)
    if (message !== null) {
      done(null, { code: -32010, message: message })
      return
    }
    var refusal = Compatibility.unreleasedRefusal(operation, unreleasedMethods, needsUpdate)
    if (refusal !== null) {
      done(null, refusal)
      return
    }
    var id = "qml-" + (++sequence)
    // Snapshot the payload now, just as an immediately written request did.
    // The caller may reuse or mutate its model while this frame is waiting.
    var entry = { id: id, frame: Wire.request(id, method, params),
      callback: done, operation: operation, cancelled: false }
    queued.push(entry)
    drainRequests()
    var handle = { withdraw: function() {
      var index = root.queued.indexOf(entry)
      if (index < 0) return false
      entry.cancelled = true
      root.queued.splice(index, 1)
      entry.frame = null
      root.maybeRequestQuit()
      return true
    } }
    handle.cancel = function() { handle.withdraw(); entry.cancelled = true }
    return handle
  }

  // Only sent frames occupy a slot or start their request deadline. New work
  // joins the tail even from a response callback, so a busy account cannot
  // repeatedly jump ahead of the other accounts already waiting.
  function drainRequests() {
    if (draining || !connected) return
    draining = true
    try {
      while (queued.length > 0 && Object.keys(pending).length < 64 && connected) {
        var entry = queued.shift()
        var next = Object.assign({}, pending)
        var timeout = entry.operation === "agent.context" ? 65000 : 30000
        entry.deadline = Date.now() + timeout
        next[entry.id] = entry
        pending = next
        child.write(entry.frame)
        entry.frame = null
      }
    } finally { draining = false }
  }

  function shutdown(callback) {
    if (typeof callback === "function") {
      if (shutdownFinished) {
        callback(shutdownError)
        return
      }
      var callbacks = shutdownCallbacks.slice()
      callbacks.push(callback)
      shutdownCallbacks = callbacks
    }
    if (shutdownStarted) return
    shutdownStarted = true
    shutdownDeadline.restart()
    uploadQueue.fail({ code: -32010, message: "Backend is shutting down" })
    if (!connected) {
      // A configured process may be between construction and onStarted. Let
      // that signal enter the internal quit path; the deadline still bounds it.
      if (child.running) return
      finishShutdown(null)
      return
    }
    maybeRequestQuit()
  }

  function maybeRequestQuit() {
    var count = Object.keys(pending).length + queued.length
    if (!Compatibility.shouldRequestQuit(stopping, count, quitRequested)) return
    // A failure may have disconnected the process while the response callback
    // was running. onExited (or the confirmation deadline) owns that result;
    // this drain tail must never turn it into a clean shutdown.
    if (!connected) return
    quitRequested = true
    request("system.quit", {}, function(result, error) {
      if (error || !result || result.quitReady !== true) {
        stopForFailure("Backend shutdown failed")
      }
    }, true)
  }

  function finishShutdown(error) {
    if (shutdownFinished) return
    shutdownDeadline.stop()
    stopConfirmationDeadline.stop()
    shutdownError = error || null
    shutdownFinished = true
    connected = false
    protocolInfo = null
    responseTransfer = null
    var callbacks = shutdownCallbacks
    shutdownCallbacks = []
    for (var i = 0; i < callbacks.length; i++) callbacks[i](shutdownError)
    shutdownComplete(shutdownError)
  }

  function stopForFailure(message) {
    if (shutdownStarted) {
      if (shutdownFailure === null)
        shutdownFailure = { code: -32010, message: message }
      stopConfirmationDeadline.restart()
    }
    failPending(message)
    child.running = false
  }

  function failPending(message) {
    responseTransfer = null
    var previous = pending
    var waiting = queued
    pending = ({})
    queued = []
    connected = false
    protocolInfo = null
    failure = message
    var error = { code: -32010, message: message }
    uploadQueue.fail(error)
    for (var id in previous)
      failEntry(previous[id], error)
    for (var i = 0; i < waiting.length; i++)
      failEntry(waiting[i], error)
  }

  // A receiver may have disappeared while its request was waiting. One
  // callback must not strand the remaining queue or interrupt process stop.
  function failEntry(entry, error) {
    if (entry.cancelled) return
    try { entry.callback(null, error) }
    catch (failure) { console.warn("Backend request callback failed") }
  }

  function receive(line) {
    var decoded = Chunks.decode(responseTransfer, line)
    responseTransfer = decoded.state
    if (!decoded.error && decoded.line === null) return
    var event = decoded.error ? null : Wire.notificationValue(decoded.value)
    if (event) {
      if (ready && !stopping) notification(event.method, event.params)
      return
    }
    var reply = decoded.error ? null : Wire.responseValue(decoded.value)
    if (!reply) {
      stopForFailure("Invalid backend response")
      return
    }
    if (!Object.prototype.hasOwnProperty.call(pending, reply.id)) return
    var entry = pending[reply.id]
    if (!entry) return
    var next = Object.assign({}, pending)
    delete next[reply.id]
    pending = next
    try {
      if (!entry.cancelled) entry.callback(reply.result, reply.error || null)
    } finally {
      drainRequests()
      maybeRequestQuit()
    }
  }

  Timer {
    interval: 1000
    repeat: true
    running: root.connected
    onTriggered: {
      var now = Date.now()
      if (root.responseTransfer && now - root.responseTransfer.started >= 30000) {
        root.stopForFailure("Backend response timed out")
        return
      }
      for (var id in root.pending) {
        if (root.pending[id].deadline <= now) {
          root.stopForFailure("Backend request timed out")
          return
        }
      }
    }
  }

  Timer {
    id: shutdownDeadline
    interval: 5000
    repeat: false
    onTriggered: root.stopForFailure("Backend shutdown timed out")
  }

  Timer {
    id: stopConfirmationDeadline
    interval: 1000
    repeat: false
    onTriggered: {
      root.failure = "Backend stop was not confirmed"
      root.finishShutdown({ code: -32010, message: root.failure })
    }
  }

  Process {
    id: child
    command: [root.executable, "serve"]
    running: root.launchEnabled && root.executable !== ""
    stdinEnabled: true
    stdout: SplitParser { onRead: data => root.receive(data) }
    onStarted: {
      if (!root.launchEnabled) {
        root.stopForFailure("Backend unavailable")
        return
      }
      root.connected = true
      if (root.stopping) {
        root.maybeRequestQuit()
        return
      }
      root.failure = ""
      root.request("system.info", {}, function(info, error) {
        if (error || !Compatibility.accepts(info, root.expectedVersion, root.expectedApiVersion, root.latestApiVersion))
          root.stopForFailure("Incompatible backend")
        else root.protocolInfo = info
      }, true)
    }
    onExited: function(exitCode) {
      var clean = Compatibility.isCleanShutdown(
        root.stopping, root.quitRequested, Object.keys(root.pending).length + root.queued.length,
        root.shutdownFailure !== null, exitCode)
      child.running = false
      if (clean) {
        root.connected = false
        root.protocolInfo = null
        root.responseTransfer = null
        root.finishShutdown(null)
        return
      }
      var message = root.failure || "Backend stopped"
      root.failPending(message)
      if (root.stopping)
        root.finishShutdown(root.shutdownFailure
          || { code: -32010, message: message })
    }
  }
}
