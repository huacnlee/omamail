import QtQuick
import "JmapProtocol.js" as Jmap

// The backend owns the socket, bounded event decoder, watchdog and reconnect
// backoff. This view only translates delivered changes into UI invalidations.
Item {
  id: root
  visible: false
  width: 0
  height: 0
  required property var client
  signal remoteChanged(var plan)
  signal secretRejected()

  readonly property bool wanted: !!client && !!client.auth && client.auth.loggedIn
    && !client.credentialsRejected && !!client.backend && client.backend.ready
  readonly property string template: client && client.session
    ? Jmap.eventSourceTemplate(client.session) : ""
  property string streamId: ""
  property int epoch: 0
  property bool opening: false
  property var openingHandle: null

  onWantedChanged: wanted ? begin() : stop()
  onTemplateChanged: { stop(); if (wanted) begin() }
  Component.onCompleted: if (wanted) begin()
  Component.onDestruction: stop()

  function stop() {
    epoch++
    opening = false
    if (openingHandle && client) client.abortRequest(openingHandle)
    openingHandle = null
    var previous = streamId
    streamId = ""
    if (previous !== "" && client && client.backend && client.backend.ready)
      client.backend.call("jmap.stream.close", { streamId: previous }, function() {})
  }

  function begin() {
    if (!wanted || opening || streamId !== "") return
    if (template === "") {
      opening = true
      client.ensureSession(function() { if (root) root.opening = false })
      return
    }
    opening = true
    var generation = epoch
    var id = "jmap-" + String(client.auth.accountId) + "-" + Date.now() + "-" + generation
    streamId = id
    openingHandle = client.nativeRequest("jmap.watch", { streamId: id }, function(result, failure) {
      if (!root) return
      if (generation !== root.epoch || !root.wanted) {
        root.client.backend.call("jmap.stream.close", { streamId: id }, function() {})
        return
      }
      root.opening = false
      root.openingHandle = null
      if (failure) { root.streamId = ""; return }
      root.streamId = id
      root.poll(generation)
    })
  }

  function poll(generation) {
    if (!wanted || streamId === "" || generation !== epoch) return
    client.backend.call("jmap.stream.poll", { streamId: streamId }, function(result, error) {
      if (!root || generation !== root.epoch) return
      if (error || !result || result.closed) { root.stop(); return }
      var events = result.events || []
      for (var i = 0; i < events.length; i++) {
        var event = events[i]
        if (event.kind === "rejected") { root.secretRejected(); root.stop(); return }
        if (event.kind === "connected") root.remoteChanged({ mail: true, mailboxes: true })
        if (event.kind === "change") root.remoteChanged(event.plan)
      }
      Qt.callLater(function() { if (root) root.poll(generation) })
    })
  }

}
