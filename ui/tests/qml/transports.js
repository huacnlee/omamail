.pragma library

// The stubbed transport, read back from the client that made a request.
//
// Under `tests/qml/imports` a `Process` is an `Item` that never exits on its
// own, so every request a JMAP client makes lands among its children and
// stays there until a test answers it. These are the four questions every
// such test asks: which processes the client holds, which are new since a
// moment ago, what one of them asked for, and how to answer it.

// Every transport process the client holds. `requestLine` is the property
// only a transport carries.
function transports(client) {
  var out = []
  var kids = client ? client.data : null
  var count = kids ? kids.length : 0
  for (var i = 0; i < count; i++) {
    var kid = kids[i]
    if (kid && kid.hasOwnProperty("requestLine")) out.push(kid)
  }
  return out
}

function newSince(client, before) {
  var now = transports(client)
  var out = []
  for (var i = 0; i < now.length; i++) {
    if (before.indexOf(now[i]) < 0) out.push(now[i])
  }
  return out
}

// What a request asked for, read back out of the line the client wrote for
// the transport script: the verb, then base64 fields — the URL, the scheme,
// the username, the secret, and for a call its body.
function requested(process) {
  var fields = String(process.requestLine).split(" ")
  var decoded = []
  for (var i = 1; i < fields.length; i++) decoded.push(fields[i] === "-" ? "" : Qt.atob(fields[i]))
  return {
    verb: fields[0],
    url: decoded.length > 0 ? decoded[0] : "",
    scheme: decoded.length > 1 ? decoded[1] : "",
    fields: decoded
  }
}

// A reply with this status and JSON body (or none), in the four lines the
// transport script writes: curl's exit, the status line, the body and stderr,
// the last two base64.
function answer(process, status, body) {
  var text = body === undefined || body === null ? "" : Qt.btoa(JSON.stringify(body))
  process.stdout.text = ["0", String(status) + " ", text, ""].join("\n")
  process.exited(0)
}

function answerText(process, status, body) {
  process.stdout.text = ["0", String(status) + " ", Qt.btoa(String(body || "")), ""].join("\n")
  process.exited(0)
}
