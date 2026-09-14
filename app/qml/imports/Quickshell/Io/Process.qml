import QtQuick
import Quickshell

Item {
  id: root
  visible: false

  property var command: []
  property bool running: false
  property bool stdinEnabled: false
  property string jobMode: ""
  property var stdout: StdioCollector {}
  property var stderr: StdioCollector {}
  property var nativeProcess: null
  readonly property string written: ""
  property bool _syncingRunning: false

  signal started()
  signal exited(int exitCode)

  function createNativeProcess() {
    if (nativeProcess) return nativeProcess
    try {
      nativeProcess = Qt.createQmlObject(
        "import Omamail.Native 1.0; NativeProcess {}", root, "standalone-native-process")
    } catch (error) {
      console.warn("Unable to create native process: " + error)
    }
    return nativeProcess
  }

  function isNotificationCommand() {
    if (!Array.isArray(command) || command.length !== 7) return false
    var suffix = "/scripts/notify-mail.py"
    var program = String(command[1])
    return String(command[0]) === "python3"
      && program.slice(program.length - suffix.length) === suffix
      && String(command[4]) === "--"
  }

  function startNotification() {
    var accountId = String(root["targetAccountId"] || "")
    var messageId = String(root["messageId"] || "")
    var accepted = Quickshell.showNotification(accountId + ":" + messageId,
      command[5], command[6], accountId, messageId)
    started()
    Qt.callLater(function() {
      root._syncingRunning = true
      root.running = false
      root._syncingRunning = false
      root.exited(accepted ? 0 : 1)
    })
  }

  function syncNative() {
    if (!running || _syncingRunning) return
    resetSink(stdout)
    resetSink(stderr)
    if (isNotificationCommand()) {
      startNotification()
      return
    }
    var process = createNativeProcess()
    if (!process) {
      Qt.callLater(function() {
        root._syncingRunning = true
        root.running = false
        root._syncingRunning = false
        root.exited(-1)
      })
      return
    }
    process.command = command
    process.stdinEnabled = stdinEnabled
    process.running = true
  }

  function write(value) {
    var process = createNativeProcess()
    if (process && typeof process.write === "function") process.write(String(value || ""))
  }

  function terminate() {
    if (nativeProcess && typeof nativeProcess.terminate === "function") nativeProcess.terminate()
  }

  function deliver(sink, line) {
    if (!sink) return
    if (typeof sink.acceptLine === "function") sink.acceptLine(String(line || ""))
    else if (typeof sink.accept === "function") sink.accept(String(line || ""))
  }

  function finish(sink) {
    if (sink && typeof sink.finish === "function") sink.finish()
  }

  function resetSink(sink) {
    if (sink && typeof sink.reset === "function") sink.reset()
  }

  onRunningChanged: {
    if (_syncingRunning) return
    if (running) syncNative()
    else if (nativeProcess && nativeProcess.running) terminate()
  }
  onCommandChanged: {
    if (nativeProcess && !nativeProcess.running) nativeProcess.command = command
  }
  onStdinEnabledChanged: {
    if (nativeProcess && !nativeProcess.running) nativeProcess.stdinEnabled = stdinEnabled
  }
  onNativeProcessChanged: {
    if (nativeProcess) {
      nativeProcess.command = command
      nativeProcess.stdinEnabled = stdinEnabled
    }
  }

  Connections {
    target: root.nativeProcess
    ignoreUnknownSignals: true
    function onStarted() { root.started() }
    function onExited(exitCode) {
      root.finish(root.stdout)
      root.finish(root.stderr)
      root._syncingRunning = true
      root.running = false
      root._syncingRunning = false
      root.exited(exitCode)
    }
    function onStdoutLine(line) { root.deliver(root.stdout, line) }
    function onStderrLine(line) { root.deliver(root.stderr, line) }
    function onRunningChanged() {
      if (!root.nativeProcess || root.nativeProcess.running === root.running) return
      root._syncingRunning = true
      root.running = root.nativeProcess.running
      root._syncingRunning = false
    }
  }
}
