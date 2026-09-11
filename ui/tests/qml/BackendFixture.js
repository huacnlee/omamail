.pragma library
.import "NativeDomainFixture.js" as NativeDomain

// Service owns the backend runtime, so tests exercising App actions must
// provide the same validated-runtime and completed-handshake state as the
// shell does before making those actions available.
function findPipe(item) {
  if (item.command && item.command[1] === "serve") return item
  var children = item.children || []
  for (var i = 0; i < children.length; i++) {
    var found = findPipe(children[i])
    if (found) return found
  }
  return null
}

var installed = []

function install(service) {
  var pipe = findPipe(service.backend)
  if (!pipe) throw new Error("No backend fixture pipe")
  for (var i = 0; i < installed.length; i++)
    if (installed[i].service === service) return installed[i].listener
  var listener = Qt.createQmlObject('import QtQuick; Connections { target: null; objectName: "native-domain-fixture"; property var handler; property var requests: []; property var answers: ({}); property var record: ({active:false,returnView:"",draft:null,parked:[]}); property int revision: 1; function onWrittenChanged() { handler(target.written) } }', service)
  var offset = pipe.written.length
  listener.handler = function(written) {
    var lines = written.slice(offset).split("\n")
    offset = written.length - lines[lines.length - 1].length
    for (var i = 0; i < lines.length - 1; i++) {
      var request = JSON.parse(lines[i])
      listener.requests = listener.requests.concat([request])
      var result = NativeDomain.answer(request.method, request.params || {})
      if (request.method === "compose.recoveryRead") result = {record:listener.record,revision:String(listener.revision)}
      if (request.method === "compose.recoverySave") {
        listener.record = request.params.record
        listener.revision++
        result = {record:listener.record,revision:String(listener.revision)}
      }
      if (request.method === "outbox.snapshot") result = {accountId:request.params.accountId,revision:0,entries:[]}
      if (Object.prototype.hasOwnProperty.call(listener.answers, request.method)) {
        var override = listener.answers[request.method]
        result = typeof override === "function" ? override(request.params || {}, request) : override
      }
      if (result !== undefined) respond(service, request, result)
    }
  }
  listener.target = pipe
  installed.push({service:service,listener:listener})
  return listener
}

function respond(service, request, result, error) {
  Qt.callLater(function() {
    var reply = {jsonrpc:"2.0",id:request.id}
    if (error) reply.error = error
    else reply.result = result
    service.backend.receive(JSON.stringify(reply))
  })
}

function markReady(service) {
  install(service)
  service.backendRuntime.requiredVersion = "0.0.0"
  service.backendRuntime.requiredApiVersion = 1
  service.backendRuntime.executable = "/synthetic/runtime/bin/omamail"
  service.backendRuntime.state = "ready"
  service.backend.connected = true
  service.backend.protocolInfo = { apiVersion: 1, protocol: 1, version: "0.0.0" }
}
