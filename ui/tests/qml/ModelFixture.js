.pragma library
.import "../../account/Unified.js" as Unified
.import "BackendFixture.js" as BackendFixture

// The old pure JS rules are the oracle at the RPC boundary. Native parity
// tests exercise the Rust implementation; this fixture tests Service wiring.
function unified(params) {
  var capabilities = {}
  var names = ["archive", "spam", "star", "labels", "web", "move", "conversations"]
  for (var i = 0; i < names.length; i++)
    capabilities[names[i]] = Unified.everyMailboxCan(params.abilities, names[i])
  return {
    messages: Unified.mergeMessages(params.sources),
    totalUnread: Unified.totalUnread(params.summaries),
    mailboxes: Unified.sharedMailboxRows(params.abilities),
    capabilities: capabilities,
    loading: Unified.anyLoading(params.states),
    loaded: Unified.allLoaded(params.states),
    hasMore: Unified.anyHasMore(params.states),
    serverSearchLoading: Unified.anyServerSearchLoading(params.states),
    error: Unified.firstError(params.states)
  }
}

function findPipe(item) {
  if (item.command && item.command[1] === "serve") return item
  var children = item.children || []
  for (var i = 0; i < children.length; i++) {
    var found = findPipe(children[i])
    if (found) return found
  }
  return null
}

function install(service) {
  var pipe = findPipe(service.backend)
  if (!pipe) throw new Error("No backend pipe")
  var offset = pipe.written.length
  var listener = Qt.createQmlObject('import QtQuick; Connections { property var handler; function onWrittenChanged() { handler(target.written) } }', service)
  listener.handler = function(written) {
    var lines = written.slice(offset).split("\n")
    offset = written.length - lines[lines.length - 1].length
    for (var i = 0; i < lines.length - 1; i++) {
      var request = JSON.parse(lines[i])
      if (request.method === "model.unified")
        service.backend.receive(JSON.stringify({jsonrpc:"2.0",id:request.id,result:unified(request.params)}))
    }
  }
  listener.target = pipe
  BackendFixture.markReady(service)
}
