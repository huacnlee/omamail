import QtQuick
import Quickshell.Io
import "Wire.js" as Wire
import "Upload.js" as Upload
import "Chunks.js" as Chunks

Item {
  id: root
  required property string executable
  readonly property bool ready: connected && protocolInfo !== null
  property bool connected: false
  property var protocolInfo: null
  property var pending: ({})
  property int sequence: 0
  property string failure: ""
  property var responseTransfer: null

  function parseMessage(raw, callback) {
    Upload.parse(raw, function(method, params, done) {
      root.call(method, params, done)
    }, function() { return root.connected }, callback)
  }

  function call(method, params, callback) {
    if (!connected) {
      callback(null, { code: -32010, message: "Backend unavailable" })
      return
    }
    if (Object.keys(pending).length >= 64) {
      callback(null, { code: -32011, message: "Too many pending requests" })
      return
    }
    var id = "qml-" + (++sequence)
    var next = Object.assign({}, pending)
    next[id] = { callback: callback, deadline: Date.now() + 30000 }
    pending = next
    child.write(Wire.request(id, method, params))
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
    var decoded = Chunks.accept(responseTransfer, line)
    responseTransfer = decoded.state
    if (!decoded.error && decoded.line === null) return
    var reply = decoded.error ? null : Wire.response(decoded.line)
    if (!reply) {
      failPending("Invalid backend response")
      child.running = false
      return
    }
    var entry = pending[reply.id]
    if (!entry) return
    var next = Object.assign({}, pending)
    delete next[reply.id]
    pending = next
    entry.callback(reply.result, reply.error || null)
  }

  Timer {
    interval: 1000
    repeat: true
    running: root.connected
    onTriggered: {
      var now = Date.now()
      if (root.responseTransfer && now - root.responseTransfer.started >= 30000) {
        root.failPending("Backend response timed out")
        child.running = false
        return
      }
      for (var id in root.pending) {
        if (root.pending[id].deadline <= now) {
          root.failPending("Backend request timed out")
          child.running = false
          return
        }
      }
    }
  }

  Process {
    id: child
    command: [root.executable, "--backend"]
    running: root.executable !== ""
    stdinEnabled: true
    stdout: SplitParser { onRead: data => root.receive(data) }
    onStarted: {
      root.connected = true
      root.failure = ""
      root.call("system.info", {}, function(info, error) {
        if (error || !info || info.protocol !== 1) {
          root.failPending("Unsupported backend protocol")
          child.running = false
        } else root.protocolInfo = info
      })
    }
    onExited: root.failPending("Backend stopped")
  }
}
