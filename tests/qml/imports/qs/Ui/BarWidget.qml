import QtQuick

// What a bar widget is, as far as a test needs: an Item the bar gives a
// reference to itself and a settings object. Stubbed rather than imported
// because the real one reaches for the running bar's geometry.
//
// It has to exist for `BarWidget.qml` in the plugin root to be testable at
// all: without it the root type resolves to the plugin's own file of the same
// name, and QML reports the file as instantiated recursively.
Item {
  property QtObject bar: null
  property string moduleName: ""
  property var settings: ({})
  readonly property bool vertical: bar ? bar.vertical : false
  readonly property int barSize: 32
  readonly property color barForeground: bar && bar.barForeground
    ? bar.barForeground : Qt.rgba(1, 1, 1, 1)
}
