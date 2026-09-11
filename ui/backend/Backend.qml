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

  function parseMessage(raw, callback) {
    Upload.parse(raw, function(method, params, done) {
      root.call(method, params, done)
    }, function() { return root.ready }, callback)
  }

  function putBodyCache(accountId, id, body, callback) {
    Upload.putBody(accountId, id, body, function(method, params, done) {
      root.call(method, params, done)
    }, function() { return root.ready }, callback)
  }

  function call(method, params, callback) {
    // Keep each physical frame small even for Unicode-heavy MIME/JSON data.
    if (JSON.stringify(params).length > 200000) {
      var alive = true
      Upload.request(method, params, function(nextMethod, nextParams, done) {
        // A cancelled upload must never reach its eventual domain operation.
        // Permit cleanup of bytes already staged by the backend.
        if (!alive && nextMethod !== "upload.discard") {
          done(null, {code:-32010,message:"Request cancelled"})
          return
        }
        root.request(nextMethod, nextParams, done, false)
      }, function() { return root.ready }, function(result, error) {
        if (!alive) return
        alive = false
        if (typeof callback === "function") callback(result, error)
      })
      return {cancel:function() { alive = false }}
    }
    request(method, params, callback, false)
  }

  function request(method, params, callback, internal) {
    var done = typeof callback === "function" ? callback : function() {}
    var message = Compatibility.dispatchError(
      connected, ready, stopping, method, internal)
    if (message !== null) {
      done(null, { code: -32010, message: message })
      return
    }
    if (Object.keys(pending).length >= 64) {
      done(null, { code: -32011, message: "Too many pending requests" })
      return
    }
    var id = "qml-" + (++sequence)
    var next = Object.assign({}, pending)
    var operation = method === "request.upload" && params ? params.method : method
    var timeout = operation === "agent.context" ? 65000 : 30000
    next[id] = { callback: done, deadline: Date.now() + timeout }
    pending = next
    child.write(Wire.request(id, method, params))
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
    var count = Object.keys(pending).length
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
    pending = ({})
    connected = false
    protocolInfo = null
    failure = message
    for (var id in previous)
      previous[id].callback(null, { code: -32010, message: message })
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
    entry.callback(reply.result, reply.error || null)
    maybeRequestQuit()
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
        if (error || !Compatibility.accepts(info, root.expectedVersion, root.expectedApiVersion))
          root.stopForFailure("Incompatible backend")
        else root.protocolInfo = info
      }, true)
    }
    onExited: function(exitCode) {
      var clean = Compatibility.isCleanShutdown(
        root.stopping, root.quitRequested, Object.keys(root.pending).length,
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
