import QtQuick

QtObject {
  id: root

  property string splitMarker: "\n"
  property string pending: ""
  signal read(string line)

  function accept(value) {
    var chunk = String(value || "")
    if (splitMarker === "") {
      if (chunk !== "") read(chunk)
      return
    }
    pending += chunk
    var at = pending.indexOf(splitMarker)
    while (at >= 0) {
      var frame = pending.slice(0, at)
      pending = pending.slice(at + splitMarker.length)
      read(frame)
      at = pending.indexOf(splitMarker)
    }
  }

  function acceptLine(value) {
    var line = String(value || "")
    if (splitMarker !== "\n") {
      accept(line + "\n")
      return
    }
    if (line.slice(-1) === "\n") line = line.slice(0, -1)
    if (line.slice(-1) === "\r") line = line.slice(0, -1)
    read(line)
  }

  function finish() {
    if (pending === "") return
    var frame = pending
    pending = ""
    read(frame)
  }

  function reset() { pending = "" }
}
