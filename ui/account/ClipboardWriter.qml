import QtQuick
import Quickshell.Io

// Text onto the clipboard, for text that must not be on a command line. The
// standalone host's native clipboard takes it directly; otherwise it reaches
// wl-copy on stdin. Not argv: any process on the machine can read a command
// line while it runs, and what is copied here is a sign-in code, which is a
// credential while it lasts.
//
// `done(ok)` is told whether the text actually reached the clipboard, so a
// caller says "Copied" only when it was. One copy at a time: a newer copy
// stops the older one, whose answer is then dropped, so the clipboard ends up
// holding the last text asked for rather than whichever wl-copy finished last.
Item {
  id: root
  visible: false

  property var current: null

  function copy(text, done, platform) {
    var value = String(text)
    if (platform && typeof platform.setClipboard === "function") {
      var ok = !!platform.setClipboard(value)
      if (typeof done === "function") done(ok)
      return ok
    }
    if (root.current) {
      var previous = root.current
      root.current = null
      previous.done = null
      previous.running = false
    }
    var writer = writerComponent.createObject(root, { payload: value, done: done || null })
    if (!writer) {
      if (typeof done === "function") done(false)
      return false
    }
    root.current = writer
    writer.running = true
    return true
  }

  function finished(writer, ok) {
    if (root.current === writer) root.current = null
    var done = writer.done
    writer.done = null
    if (typeof done === "function") done(ok)
    writer.destroy()
  }

  property Component writerComponent: Component {
    Process {
      id: writer
      property string payload: ""
      property var done: null
      property bool begun: false
      command: ["wl-copy"]
      stdinEnabled: true
      // Closing stdin is what tells wl-copy the text is complete.
      onStarted: { begun = true; write(payload); stdinEnabled = false }
      onExited: function(exitCode) { root.finished(writer, exitCode === 0) }
      // A process that never started never exits either: no wl-copy, or one
      // stopped by a newer copy before it ran.
      onRunningChanged: if (!running && !begun) root.finished(writer, false)
    }
  }
}
