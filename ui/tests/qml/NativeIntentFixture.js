.pragma library
.import "BackendFixture.js" as BackendFixture

// Real native ledger; the loopback bridge admits only pure model RPC methods.
function backend(parent) {
  return Qt.createQmlObject('import QtQuick; import Quickshell; QtObject { id: bridge; signal notification(string method,var params); property bool ready: true; property int serial: 0; property var pending: []; property string endpoint: Quickshell.env("OMAMAIL_TEST_BACKEND_URL"); function call(method, params, callback) { if (method !== "providers.resolve" && method !== "model.intent" && method !== "model.apply" && method !== "model.unified" && method !== "agent.jobsProjection") { Qt.callLater(function(){callback(null,"unsupported_test_method")}); return } if (!endpoint) throw new Error("Run this suite through tests/run_qml_native.py"); var xhr = new XMLHttpRequest(); pending = pending.concat([xhr]); xhr.open("POST",endpoint); xhr.onreadystatechange = function() { if(xhr.readyState!==XMLHttpRequest.DONE || !bridge)return; bridge.pending=bridge.pending.filter(function(x){return x!==xhr}); if(xhr.status!==200){callback(null,"native_test_bridge_failed");return} var reply=JSON.parse(xhr.responseText); callback(reply.result,reply.error || "") }; xhr.send(JSON.stringify({jsonrpc:"2.0",id:++serial,method:method,params:params})); } }',parent)
}

function install(service) {
  var native = backend(service)
  var pipe = BackendFixture.findPipe(service.backend)
  if (!pipe) throw new Error("No backend fixture pipe")
  var listener = Qt.createQmlObject('import QtQuick; Connections { target:null; property var handler; function onWrittenChanged() {handler(target.written)} }', service)
  var offset=pipe.written.length
  listener.handler=function(written) {
    var lines=written.slice(offset).split("\n")
    offset=written.length-lines[lines.length-1].length
    for(var i=0;i<lines.length-1;i++) {
      var request=JSON.parse(lines[i])
      if(request.method!=="model.intent")continue
      forward(request)
    }
  }
  function forward(request) {
    native.call(request.method,request.params,function(result,error){BackendFixture.respond(service,request,result,error)})
  }
  listener.target=pipe
  return native
}
