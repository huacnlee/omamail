import QtQuick

Item {
  property var command: []
  property bool running: false
  property bool stdinEnabled: false
  property string jobMode: ""
  property var stdout: StdioCollector {}
  property var stderr: StdioCollector {}
  signal started()
  signal exited(int exitCode)

  function write(_value) {}
}
